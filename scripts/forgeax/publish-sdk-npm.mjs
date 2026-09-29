import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { validateCandidate } from './sdk-candidate.mjs';
import {
  fetchWithRetry,
  mapConcurrent,
  SDK_TEMPLATES,
  streamFile,
  waitForNpmPublications,
} from './sdk-lib.mjs';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const candidatePath = value('--candidate');
const output = resolve(root, candidatePath ?? value('--output') ?? 'artifacts/sdk');
const version = value('--version');
const checkOnly = args.includes('--check-only');
if (version === undefined) throw new Error('npm-release-version-missing');
if (candidatePath !== undefined && checkOnly) throw new Error('npm-candidate-check-only-invalid');
const tag = value('--tag') ?? (version.includes('-') ? 'next' : 'latest');
const packageRoot = resolve(output, 'npm', 'packages');
const carrierPath = resolve(output, 'npm', `forgeax-engine-sdk-${version}.tgz`);
const buildResult = JSON.parse(await readFile(resolve(output, 'sdk-build-result.json'), 'utf8'));
if (buildResult.ok !== true || buildResult.sdkVersion !== version) {
  throw new Error('npm-sdk-build-result-mismatch');
}
const candidate =
  candidatePath === undefined
    ? undefined
    : await validateCandidate({
        candidateRoot: output,
        expectedVersion: version,
        expectedEngineCommit: buildResult.engineCommit,
      });

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

if (candidate !== undefined) {
  const relativePath = (path) => relative(output, path).split(sep).join('/');
  const actualOrder = ordered.map(({ path }) => relativePath(path));
  const expectedOrder = candidate.npmPackages.map(({ path }) => path);
  if (JSON.stringify(actualOrder) !== JSON.stringify(expectedOrder)) {
    throw new Error('npm-candidate-package-order-mismatch');
  }
}

function npmTarballUrl(name, packageVersion) {
  const packageName = name.slice(name.indexOf('/') + 1);
  return `https://registry.npmjs.org/${name}/-/${packageName}-${packageVersion}.tgz`;
}

async function waitForDev(project, packageManager, env) {
  let endpoint;
  let failure;
  let devUrl;
  try {
    const { stdout } = await execFileAsync('corepack', [packageManager, 'run', 'dev', '--json'], {
      cwd: project,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    const envelope = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? '{}');
    const value = envelope.value?.value ?? envelope.value;
    if (
      envelope.ok !== true ||
      envelope.command !== 'dev start' ||
      typeof value?.endpoint !== 'string'
    ) {
      throw new Error(`npm-carrier-dev-start: ${stdout}`);
    }
    endpoint = value.endpoint;
    const response = await fetch(`${endpoint}/status`);
    assert(response.ok, `npm-carrier-dev-status-${response.status}`);
    const status = await response.json();
    const url = status?.value?.url;
    assert(
      status?.value?.phase === 'ready' && typeof url === 'string',
      'npm-carrier-dev-not-ready',
    );
    const page = await fetch(url);
    assert(page.ok, `npm-carrier-dev-http-${page.status}`);
    devUrl = url;
  } catch (cause) {
    failure = cause;
  }
  try {
    // A failed start can still own a live daemon. Read its discovery record
    // before any temporary-project cleanup, including when execFile rejects.
    if (endpoint === undefined) {
      try {
        const session = JSON.parse(
          await readFile(resolve(project, '.forgeax/dev-session.json'), 'utf8'),
        );
        endpoint = session.endpoint;
      } catch (cause) {
        if (cause?.code !== 'ENOENT') throw cause;
      }
    }
    if (endpoint !== undefined) {
      const stopped = await fetch(`${endpoint}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert(stopped.ok, `npm-carrier-dev-stop-${stopped.status}`);
    }
  } catch (cleanup) {
    failure =
      failure === undefined
        ? cleanup
        : new AggregateError([failure, cleanup], 'npm-carrier-dev-cleanup');
  }
  if (failure !== undefined) throw failure;
  return devUrl;
}

async function verifyGamePackage(project, packageManager, env, output) {
  const packageResult = await execFileAsync(
    'corepack',
    [packageManager, 'exec', 'forgeax', 'project', 'package', '--output', output, '--json'],
    { cwd: project, env, maxBuffer: 128 * 1024 * 1024 },
  );
  const entries = (await execFileAsync('unzip', ['-Z1', output])).stdout
    .split(/\r?\n/)
    .filter((entry) => entry.length > 0);
  const documents = ['README.md', 'docs/feedback.md'];
  for (const document of documents) {
    if (!entries.includes(document)) throw new Error(`npm-game-package-document: ${document}`);
    const source = await readFile(resolve(project, document), 'utf8');
    const archived = await execFileAsync('unzip', ['-p', output, document], {
      maxBuffer: 16 * 1024 * 1024,
    });
    if (archived.stdout !== source) throw new Error(`npm-game-package-document-drift: ${document}`);
  }
  const envelope = JSON.parse(packageResult.stdout.trim().split(/\r?\n/).at(-1) ?? '{}');
  if (JSON.stringify(envelope.value?.documents) !== JSON.stringify(documents))
    throw new Error('npm-game-package-document-report');
  return { output, documents };
}

async function verifyCarrierConsumer() {
  let passed = false;
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
    pnpm_config_registry: registryUrl,
    npm_config_registry: registryUrl,
    NPM_CONFIG_REGISTRY: registryUrl,
  };
  const templates = [];
  try {
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
    for (const { id: template } of SDK_TEMPLATES) {
      const lockfilePath = resolve(sdkRoot, 'templates', template, 'pnpm-lock.yaml');
      let lockfile = await readFile(lockfilePath, 'utf8');
      for (const item of packageArchives) {
        lockfile = lockfile.replaceAll(
          npmTarballUrl(item.manifest.name, version),
          `${registryUrl}tarballs/${basename(item.path)}`,
        );
      }
      await writeFile(lockfilePath, lockfile);
    }
    await execFileAsync(
      'node',
      [resolve(sdkRoot, 'bin', 'forgeax.mjs'), 'project', 'init', '--json'],
      {
        cwd: sdkRoot,
        env,
        maxBuffer: 128 * 1024 * 1024,
      },
    );
    for (const { id: template } of SDK_TEMPLATES) {
      const project = resolve(temporaryRoot, template);
      await execFileAsync(
        'node',
        [
          resolve(sdkRoot, 'bin', 'forgeax.mjs'),
          'project',
          'new',
          project,
          '--template',
          template,
          '--json',
        ],
        { cwd: sdkRoot, env, maxBuffer: 128 * 1024 * 1024 },
      );
      for (const script of ['doctor', 'test', 'build']) {
        await execFileAsync('corepack', [packageManager, 'run', script, '--json'], {
          cwd: project,
          env,
          maxBuffer: 128 * 1024 * 1024,
        });
      }
      await execFileAsync('corepack', [packageManager, 'run', 'typecheck', '--pretty', 'false'], {
        cwd: project,
        env,
        maxBuffer: 128 * 1024 * 1024,
      });
      const packageEvidence = await verifyGamePackage(
        project,
        packageManager,
        env,
        resolve(temporaryRoot, `${template}-game-web.zip`),
      );
      const devUrl = await waitForDev(project, packageManager, env);
      templates.push({
        id: template,
        commands: [
          'project new',
          'project check',
          'project test',
          'typecheck',
          'project build',
          'project package',
          'dev start',
        ],
        package: packageEvidence,
        devUrl,
      });
    }
    passed = true;
    return { commands: ['sdk install', 'project init'], templates };
  } finally {
    if (passed)
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    else process.stderr.write(`npm carrier failure evidence: ${temporaryRoot}\n`);
    await new Promise((accept, reject) =>
      registry.close((error) => (error === undefined ? accept() : reject(error))),
    );
  }
}

async function ensureDistTag(item) {
  const response = await fetchWithRetry(
    `https://registry.npmjs.org/-/package/${encodeURIComponent(item.manifest.name)}/dist-tags`,
    { headers: { accept: 'application/json', 'cache-control': 'no-cache' } },
  );
  if (!response.ok) throw new Error(`npm-dist-tags-probe-failed: ${item.manifest.name}`);
  const tags = await response.json();
  if (tags[tag] === version) return 'verified';
  await execFileAsync('npm', ['dist-tag', 'add', `${item.manifest.name}@${version}`, tag], {
    env: { ...process.env },
    maxBuffer: 16 * 1024 * 1024,
  });
  return 'updated';
}

const carrierConsumer =
  candidate === undefined
    ? await verifyCarrierConsumer()
    : { status: 'skipped', reason: 'sealed-candidate', candidateId: candidate.candidateId };
async function publishItem(item) {
  if (checkOnly) {
    return { name: item.manifest.name, version, integrity: item.integrity, status: 'checked' };
  }
  const startedAt = Date.now();
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(item.manifest.name)}/${encodeURIComponent(version)}`;
  const current = await fetchWithRetry(registryUrl, {
    headers: { accept: 'application/json' },
  });
  let entry;
  if (current.ok) {
    const metadata = await current.json();
    if (metadata.dist?.integrity !== item.integrity) {
      throw new Error(`npm-version-already-published-with-different-bytes: ${item.manifest.name}`);
    }
    const distTagStatus = await ensureDistTag(item);
    entry = {
      name: item.manifest.name,
      version,
      integrity: item.integrity,
      status: 'existing',
      distTagStatus,
    };
  } else {
    if (current.status !== 404) throw new Error(`npm-registry-probe-failed: ${item.manifest.name}`);
    await execFileAsync('npm', ['publish', item.path, '--access', 'public', '--tag', tag], {
      env: { ...process.env },
      maxBuffer: 16 * 1024 * 1024,
    });
    entry = { name: item.manifest.name, version, integrity: item.integrity, status: 'published' };
  }
  process.stderr.write(
    `npm ${entry.status} ${item.manifest.name}@${version} in ${Date.now() - startedAt}ms\n`,
  );
  return entry;
}

// Registry publication is dominated by per-request latency, so focused
// packages publish through a bounded pool. The umbrella and carrier stay
// strictly after them: `@forgeax/engine@version` must never resolve before
// every dependency it pins exists on the registry.
const report = await mapConcurrent(ordered.slice(0, -2), publishItem, 8);
for (const item of ordered.slice(-2)) report.push(await publishItem(item));
const registry = checkOnly
  ? undefined
  : await waitForNpmPublications(
      ordered.map((item) => ({
        name: item.manifest.name,
        version,
        integrity: item.integrity,
      })),
      { tag },
    );
process.stdout.write(
  `${JSON.stringify({ ok: true, version, tag, packageCount: packageArchives.length, carrier: basename(carrierPath), carrierConsumer, registry, packages: report })}\n`,
);
