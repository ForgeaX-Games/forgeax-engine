import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fetchWithRetry, streamFile } from './sdk-lib.mjs';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, value('--output') ?? 'artifacts/sdk');
const version = value('--version');
const checkOnly = args.includes('--check-only');
if (version === undefined) throw new Error('npm-release-version-missing');
const tag = value('--tag') ?? (version.includes('-') ? 'next' : 'latest');
const packageRoot = resolve(output, 'npm', 'packages');
const carrierPath = resolve(output, 'npm', `forgeax-engine-sdk-${version}.tgz`);
const buildResult = JSON.parse(await readFile(resolve(output, 'sdk-build-result.json'), 'utf8'));
if (buildResult.ok !== true || buildResult.sdkVersion !== version) {
  throw new Error('npm-sdk-build-result-mismatch');
}

async function archive(path) {
  const { stdout } = await execFileAsync('tar', ['-xOf', path, 'package/package.json'], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const bytes = await readFile(path);
  return {
    path,
    manifest: JSON.parse(stdout),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  };
}

const packageArchives = await Promise.all(
  (await readdir(packageRoot))
    .filter((name) => name.endsWith('.tgz'))
    .sort()
    .map((name) => archive(resolve(packageRoot, name))),
);
const carrier = await archive(carrierPath);
const { stdout: carrierManifestText } = await execFileAsync(
  'tar',
  ['-xOf', carrierPath, 'package/sdk/sdk-manifest.json'],
  { maxBuffer: 64 * 1024 * 1024 },
);
const carrierSdkManifest = JSON.parse(carrierManifestText);
if (
  carrierSdkManifest.sdkVersion !== version ||
  carrierSdkManifest.engineCommit !== buildResult.engineCommit
) {
  throw new Error('npm-sdk-carrier-identity-mismatch');
}
if (
  !Array.isArray(carrierSdkManifest.artifacts) ||
  carrierSdkManifest.artifacts.some(({ path }) => path.startsWith('store/'))
) {
  throw new Error('npm-sdk-carrier-store-manifest');
}
const { stdout: carrierEntries } = await execFileAsync('tar', ['-tzf', carrierPath], {
  maxBuffer: 64 * 1024 * 1024,
});
if (carrierEntries.split('\n').some((entry) => entry.startsWith('package/sdk/store/'))) {
  throw new Error('npm-sdk-carrier-store-present');
}
if (!carrierEntries.split('\n').some((entry) => entry === 'package/README.md')) {
  throw new Error('npm-sdk-carrier-readme-missing');
}
const names = new Set(packageArchives.map(({ manifest }) => manifest.name));
if (!names.has('@forgeax/engine')) throw new Error('npm-umbrella-package-missing');
if (carrier.manifest.name !== '@forgeax/engine-sdk') throw new Error('npm-sdk-carrier-name');
for (const item of [...packageArchives, carrier]) {
  if (item.manifest.version !== version) {
    throw new Error(`npm-package-version-mismatch: ${item.manifest.name}`);
  }
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries(item.manifest[section] ?? {})) {
      if (
        (name === '@forgeax/engine' || name.startsWith('@forgeax/engine-')) &&
        range !== version
      ) {
        throw new Error(
          `npm-internal-dependency-version-mismatch: ${item.manifest.name} -> ${name}`,
        );
      }
    }
  }
}
const umbrella = packageArchives.find(({ manifest }) => manifest.name === '@forgeax/engine');
const umbrellaDependencies = new Set(Object.keys(umbrella.manifest.dependencies ?? {}));
for (const name of names) {
  if (name !== '@forgeax/engine' && !umbrellaDependencies.has(name)) {
    throw new Error(`npm-umbrella-dependency-missing: ${name}`);
  }
}

const ordered = [
  ...packageArchives
    .filter(({ manifest }) => manifest.name !== '@forgeax/engine')
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)),
  umbrella,
  carrier,
];

function npmTarballUrl(name, packageVersion) {
  const packageName = name.slice(name.indexOf('/') + 1);
  return `https://registry.npmjs.org/${name}/-/${packageName}-${packageVersion}.tgz`;
}

async function waitForDev(project, packageManager, env) {
  const detached = process.platform !== 'win32';
  const child = spawn('corepack', [packageManager, 'run', 'dev', '--', '--json', '--port', '0'], {
    cwd: project,
    env,
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((accept) => child.once('exit', accept));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const envelope = JSON.parse(line);
          if (envelope.command !== 'dev' || envelope.ok !== true) continue;
          const url = envelope.value?.urls?.local?.[0] ?? envelope.value?.urls?.network?.[0];
          if (typeof url !== 'string') throw new Error('npm-carrier-dev-url-missing');
          const response = await fetch(url);
          if (!response.ok) throw new Error(`npm-carrier-dev-http-${response.status}`);
          return url;
        } catch (cause) {
          if (cause instanceof SyntaxError) continue;
          throw cause;
        }
      }
      if (child.exitCode !== null) {
        throw new Error(`npm-carrier-dev-exited: ${stdout}\n${stderr}`);
      }
      await new Promise((accept) => setTimeout(accept, 100));
    }
    throw new Error(`npm-carrier-dev-not-ready: ${stdout}\n${stderr}`);
  } finally {
    if (child.exitCode === null) {
      if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    }
    await exited;
  }
}

async function verifyCarrierConsumer() {
  const archives = new Map([...packageArchives, carrier].map((item) => [item.manifest.name, item]));
  const registry = createServer(async (request, response) => {
    try {
      const url = request.url ?? '/';
      if (url.startsWith('/tarballs/')) {
        const item = [...archives.values()].find(
          (candidate) => basename(candidate.path) === basename(url),
        );
        if (item === undefined) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        streamFile(item.path, response);
        return;
      }
      const name = decodeURIComponent(url.slice(1).split('?', 1)[0]);
      const item = archives.get(name);
      if (item !== undefined) {
        const address = registry.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            name,
            'dist-tags': { latest: version },
            versions: {
              [version]: {
                ...item.manifest,
                dist: {
                  tarball: `http://127.0.0.1:${port}/tarballs/${basename(item.path)}`,
                  integrity: item.integrity,
                  shasum: item.shasum,
                },
              },
            },
          }),
        );
        return;
      }
      const upstream = await fetchWithRetry(`https://registry.npmjs.org${url}`, {
        headers: { accept: request.headers.accept ?? 'application/json' },
      });
      const headers = Object.fromEntries(
        [...upstream.headers.entries()].filter(
          ([header]) =>
            header !== 'content-encoding' &&
            header !== 'content-length' &&
            header !== 'transfer-encoding',
        ),
      );
      response.writeHead(upstream.status, headers);
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (cause) {
      response.writeHead(502).end(cause instanceof Error ? cause.message : String(cause));
    }
  });
  await new Promise((accept) => registry.listen(0, '127.0.0.1', accept));
  const address = registry.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const registryUrl = `http://127.0.0.1:${port}/`;
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-npm-carrier-'));
  const sdkRoot = resolve(temporaryRoot, 'sdk');
  const packageManager = JSON.parse(
    await readFile(resolve(root, 'package.json'), 'utf8'),
  ).packageManager;
  const env = {
    ...process.env,
    CI: 'true',
    FORGEAX_DISABLE_UPDATE_CHECK: '1',
    npm_config_registry: registryUrl,
    NPM_CONFIG_REGISTRY: registryUrl,
  };
  const templates = [];
  try {
    await writeFile(resolve(temporaryRoot, '.npmrc'), `registry=${registryUrl}\n`);
    await execFileAsync(
      'corepack',
      [
        packageManager,
        'dlx',
        `@forgeax/engine@${version}`,
        'sdk',
        'install',
        sdkRoot,
        '--version',
        version,
        '--json',
      ],
      { cwd: temporaryRoot, env, maxBuffer: 64 * 1024 * 1024 },
    );
    for (const template of ['game-empty', 'game-3d']) {
      const lockfilePath = resolve(sdkRoot, 'templates', template, 'pnpm-lock.yaml');
      let lockfile = await readFile(lockfilePath, 'utf8');
      for (const item of packageArchives) {
        lockfile = lockfile.replaceAll(
          npmTarballUrl(item.manifest.name, version),
          `${registryUrl}tarballs/${basename(item.path)}`,
        );
      }
      await writeFile(lockfilePath, lockfile);
      await writeFile(
        resolve(sdkRoot, 'templates', template, '.npmrc'),
        `${await readFile(resolve(sdkRoot, 'templates', template, '.npmrc'), 'utf8')}registry=${registryUrl}\n`,
      );
    }
    await execFileAsync('node', [resolve(sdkRoot, 'bin', 'forgeax.mjs'), 'init', '--json'], {
      cwd: sdkRoot,
      env,
      maxBuffer: 128 * 1024 * 1024,
    });
    for (const template of ['empty', 'game-3d']) {
      const project = resolve(temporaryRoot, template);
      await execFileAsync(
        'node',
        [resolve(sdkRoot, 'bin', 'forgeax.mjs'), 'new', project, '--template', template, '--json'],
        { cwd: sdkRoot, env, maxBuffer: 128 * 1024 * 1024 },
      );
      for (const script of ['doctor', 'test', 'build']) {
        await execFileAsync('corepack', [packageManager, 'run', script, '--', '--json'], {
          cwd: project,
          env,
          maxBuffer: 128 * 1024 * 1024,
        });
      }
      const devUrl = await waitForDev(project, packageManager, env);
      templates.push({ id: template, commands: ['new', 'doctor', 'test', 'build', 'dev'], devUrl });
    }
    return { commands: ['sdk.install', 'init'], templates };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    await new Promise((accept, reject) =>
      registry.close((error) => (error === undefined ? accept() : reject(error))),
    );
  }
}

const carrierConsumer = await verifyCarrierConsumer();
const report = [];
for (const item of ordered) {
  if (checkOnly) {
    report.push({
      name: item.manifest.name,
      version,
      integrity: item.integrity,
      status: 'checked',
    });
    continue;
  }
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(item.manifest.name)}/${encodeURIComponent(version)}`;
  const current = await fetchWithRetry(registryUrl, {
    headers: { accept: 'application/json' },
  });
  if (current.ok) {
    const metadata = await current.json();
    if (metadata.dist?.integrity !== item.integrity) {
      throw new Error(`npm-version-already-published-with-different-bytes: ${item.manifest.name}`);
    }
    report.push({
      name: item.manifest.name,
      version,
      integrity: item.integrity,
      status: 'existing',
    });
    continue;
  }
  if (current.status !== 404) throw new Error(`npm-registry-probe-failed: ${item.manifest.name}`);
  await execFileAsync('npm', ['publish', item.path, '--access', 'public', '--tag', tag], {
    env: { ...process.env },
    maxBuffer: 16 * 1024 * 1024,
  });
  report.push({
    name: item.manifest.name,
    version,
    integrity: item.integrity,
    status: 'published',
  });
}
process.stdout.write(
  `${JSON.stringify({ ok: true, version, tag, packageCount: packageArchives.length, carrier: basename(carrierPath), carrierConsumer, packages: report })}\n`,
);
