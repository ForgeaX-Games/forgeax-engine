import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  artifact,
  filesUnder,
  normalizePackageArchive,
  normalizePnpmStore,
  SDK_CAPABILITIES,
  sha256,
  stable,
  streamFile,
} from './sdk-lib.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const args = process.argv.slice(2);
const version = value('--version') ?? `0.0.0-dev.${await git(['rev-parse', '--short=12', 'HEAD'])}`;
const outputRoot = resolve(root, value('--output') ?? 'artifacts/sdk');
const stage = resolve(outputRoot, 'forgeax-sdk');
const archive = resolve(outputRoot, `forgeax-sdk-v${version}.zip`);
const pnpmMetadataCache = resolve(outputRoot, '.pnpm-metadata-cache');

function value(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function run(file, commandArgs, options = {}) {
  return execFileAsync(file, commandArgs, { cwd: root, maxBuffer: 64 * 1024 * 1024, ...options });
}

async function git(commandArgs) {
  return (await run('git', commandArgs)).stdout.trim();
}

async function zipWithInputs(commandArgs, cwd, inputs) {
  await new Promise((accept, reject) => {
    const child = spawn('zip', commandArgs, { cwd, stdio: ['pipe', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? accept() : reject(new Error(`zip exited ${code}`))));
    child.stdin.end(inputs);
  });
}

const status = await git(['status', '--porcelain']);
if (status !== '' && !args.includes('--allow-dirty')) {
  throw new Error('sdk-dirty-checkout: commit or stash all changes before building the SDK');
}
const engineCommit = await git(['rev-parse', 'HEAD']);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(stage, 'packages'), { recursive: true });
await mkdir(resolve(stage, 'store', 'pnpm'), { recursive: true });
await mkdir(resolve(stage, 'templates'), { recursive: true });
await mkdir(resolve(stage, 'schemas'), { recursive: true });
await mkdir(resolve(stage, 'docs'), { recursive: true });
await mkdir(resolve(stage, 'licenses'), { recursive: true });
await mkdir(resolve(stage, 'toolchain', 'wasm'), { recursive: true });

await run('pnpm', ['build:engine']);
const shaderReleaseRoot = resolve(root, 'shared-build-inputs-release');
await rm(shaderReleaseRoot, { recursive: true, force: true });
for (const profile of [
  ['base-base'],
  ['point-base', '--point-shadows'],
  ['base-ssao', '--hdrp-ssao'],
  ['point-ssao', '--point-shadows', '--hdrp-ssao'],
]) {
  const [name, ...flags] = profile;
  await run(
    'node',
    ['scripts/build-shared-inputs.mjs', '--out', `shared-build-inputs-release/${name}`, ...flags],
    { env: { ...process.env, FORGEAX_ENGINE_SHADER_SOURCE_BUILD: '1' } },
  );
}
await run('node', ['scripts/forgeax/prepare-shader-release-inputs.mjs']);
await rm(shaderReleaseRoot, { recursive: true, force: true });
await run('pnpm', ['exec', 'tsc', '-b', '--force', 'packages/devkit', 'packages/engine-project']);

const publicPackages = [];
for (const entry of await readdir(resolve(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packagePath = resolve(root, 'packages', entry.name, 'package.json');
  try {
    await readFile(packagePath);
  } catch {
    continue;
  }
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  if (
    manifest.private === true ||
    typeof manifest.name !== 'string' ||
    !manifest.name.startsWith('@forgeax/engine-')
  )
    continue;
  publicPackages.push({
    name: manifest.name,
    version: manifest.version,
    root: dirname(packagePath),
  });
}
publicPackages.sort((a, b) => a.name.localeCompare(b.name));

for (const entry of publicPackages) {
  await run('pnpm', [
    '--filter',
    entry.name,
    'pack',
    '--pack-destination',
    resolve(stage, 'packages'),
  ]);
}
for (const path of (await filesUnder(resolve(stage, 'packages'))).filter((entry) =>
  entry.endsWith('.tgz'),
)) {
  await normalizePackageArchive(path, execFileAsync);
}

const tarballs = new Map();
for (const path of (await filesUnder(resolve(stage, 'packages'))).filter((entry) =>
  entry.endsWith('.tgz'),
)) {
  const { stdout } = await run('tar', ['-xOf', path, 'package/package.json']);
  const manifest = JSON.parse(stdout);
  const bytes = await readFile(path);
  tarballs.set(manifest.name, {
    path,
    name: manifest.name,
    version: manifest.version,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  });
}

const registry = createServer(async (request, response) => {
  const url = request.url ?? '/';
  if (url.startsWith('/tarballs/')) {
    const item = [...tarballs.values()].find((entry) => basename(entry.path) === basename(url));
    if (item === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    streamFile(item.path, response);
    return;
  }
  const name = decodeURIComponent(url.slice(1));
  const item = tarballs.get(name);
  if (item !== undefined) {
    const address = registry.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const body = JSON.stringify({
      name,
      'dist-tags': { latest: item.version },
      versions: {
        [item.version]: {
          ...JSON.parse((await run('tar', ['-xOf', item.path, 'package/package.json'])).stdout),
          dist: {
            tarball: `http://127.0.0.1:${port}/tarballs/${engineCommit}/${basename(item.path)}`,
            integrity: item.integrity,
            shasum: item.shasum,
          },
        },
      },
    });
    response.writeHead(200, { 'content-type': 'application/json' }).end(body);
    return;
  }
  const upstream = await fetch(`https://registry.npmjs.org${url}`, {
    headers: { accept: request.headers.accept ?? 'application/json' },
  });
  const headers = Object.fromEntries(
    [...upstream.headers.entries()].filter(
      ([name]) =>
        name !== 'content-encoding' && name !== 'content-length' && name !== 'transfer-encoding',
    ),
  );
  response.writeHead(upstream.status, headers);
  response.end(Buffer.from(await upstream.arrayBuffer()));
});
const registryPort = 40_000 + (Number.parseInt(engineCommit.slice(0, 8), 16) % 20_000);
await new Promise((accept) => registry.listen(registryPort, '127.0.0.1', accept));
const address = registry.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;

const template = resolve(stage, 'templates', 'game-default');
await cp(resolve(root, 'templates', 'sdk-game-default'), template, {
  recursive: true,
  filter: (source) => !/(^|\/)(node_modules|dist|\.forgeax|AGENTS\.md|FORGE\.md)$/.test(source),
});
const sourceTemplateManifest = JSON.parse(
  await readFile(resolve(template, 'package.json'), 'utf8'),
);
const dependencies = Object.fromEntries(
  publicPackages
    .filter((entry) => entry.name !== '@forgeax/engine-devkit')
    .map((entry) => [entry.name, entry.version]),
);
const templateManifest = {
  name: sourceTemplateManifest.name,
  version: sourceTemplateManifest.version,
  private: true,
  type: 'module',
  license: sourceTemplateManifest.license,
  packageManager: 'pnpm@10.33.2',
  scripts: {
    dev: 'forgeax dev',
    build: 'forgeax build',
    preview: 'forgeax preview',
    doctor: 'forgeax doctor',
    test: 'forgeax test',
  },
  forgeax: sourceTemplateManifest.forgeax,
  dependencies,
  devDependencies: {
    '@forgeax/engine-devkit': tarballs.get('@forgeax/engine-devkit').version,
    '@webgpu/types': '0.1.71',
    tsx: '4.23.1',
    vitest: '4.1.5',
  },
  pnpm: {
    onlyBuiltDependencies: [
      '@forgeax/engine-codec',
      '@forgeax/engine-fbx',
      '@forgeax/engine-wgpu-wasm',
      'esbuild',
    ],
  },
};
await writeFile(
  resolve(template, 'package.json'),
  `${JSON.stringify(templateManifest, null, 2)}\n`,
);
try {
  await run(
    'corepack',
    [
      'pnpm@10.33.2',
      '--ignore-workspace',
      'install',
      '--registry',
      `http://127.0.0.1:${port}`,
      '--store-dir',
      resolve(stage, 'store', 'pnpm'),
    ],
    {
      cwd: template,
      env: { ...process.env, XDG_CACHE_HOME: pnpmMetadataCache },
    },
  );
} finally {
  await new Promise((accept, reject) =>
    registry.close((error) => (error === undefined ? accept() : reject(error))),
  );
}
await rm(pnpmMetadataCache, { recursive: true, force: true });
await rm(resolve(template, 'node_modules'), { recursive: true, force: true });
await rm(resolve(stage, 'store', 'pnpm', 'v10', 'projects'), { recursive: true, force: true });
await normalizePnpmStore(resolve(stage, 'store', 'pnpm'));
await mkdir(resolve(stage, 'bin'), { recursive: true });
await cp(
  resolve(root, 'packages', 'devkit', 'dist', 'sdk-cli.mjs'),
  resolve(stage, 'bin', 'forgeax.mjs'),
);
await writeFile(
  resolve(stage, 'bin', 'forgeax'),
  '#!/bin/sh\nexec node "$(dirname "$0")/forgeax.mjs" "$@"\n',
);
await writeFile(
  resolve(stage, 'bin', 'forgeax.cmd'),
  '@echo off\r\nnode "%~dp0forgeax.mjs" %*\r\n',
);

await Promise.all([
  cp(
    resolve(root, 'sdk-manifest.schema.json'),
    resolve(stage, 'schemas', 'sdk-manifest.schema.json'),
  ),
  cp(
    resolve(root, 'forgeax-dist.schema.json'),
    resolve(stage, 'schemas', 'forgeax-dist.schema.json'),
  ),
  cp(resolve(root, 'packages', 'devkit', 'README.md'), resolve(stage, 'docs', 'DEVKIT.md')),
  cp(resolve(root, 'LICENSE'), resolve(stage, 'licenses', 'ForgeaX-Apache-2.0.txt')),
  cp(
    resolve(root, 'packages', 'codec', 'pkg', 'basis_transcoder.wasm'),
    resolve(stage, 'toolchain', 'wasm', 'basis_transcoder.wasm'),
  ),
  cp(
    resolve(root, 'packages', 'codec', 'pkg', 'encode', 'basis_encoder.wasm'),
    resolve(stage, 'toolchain', 'wasm', 'basis_encoder.wasm'),
  ),
  cp(
    resolve(root, 'packages', 'fbx', 'pkg', 'fbx-wasm.wasm'),
    resolve(stage, 'toolchain', 'wasm', 'fbx-wasm.wasm'),
  ),
  cp(
    resolve(root, 'packages', 'wgpu-wasm', 'pkg', 'wgpu_wasm_bg.wasm'),
    resolve(stage, 'toolchain', 'wasm', 'wgpu_wasm_bg.wasm'),
  ),
]);
const licenseReport = stable(
  JSON.parse((await run('pnpm', ['licenses', 'list', '--json'])).stdout),
);
await writeFile(
  resolve(stage, 'licenses', 'THIRD_PARTY_NOTICES.json'),
  `${JSON.stringify(licenseReport, null, 2)}\n`,
);
const packageRows = [];
for (const item of [...tarballs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  packageRows.push({
    name: item.name,
    version: item.version,
    ...(await artifact(stage, item.path)),
  });
}
const artifactPaths = (await filesUnder(stage)).filter(
  (path) => !path.endsWith('/sdk-manifest.json'),
);
const artifacts = await Promise.all(artifactPaths.map((path) => artifact(stage, path)));
const sdkManifest = {
  schemaVersion: '1.0.0',
  sdkVersion: version,
  engineCommit,
  requirements: { node: '>=22.13.0', pnpm: '>=10.33.0 <11', pnpmStoreFormat: 'v10' },
  capabilities: SDK_CAPABILITIES,
  packages: packageRows,
  artifacts,
};
await writeFile(resolve(stage, 'sdk-manifest.json'), `${JSON.stringify(sdkManifest, null, 2)}\n`);
const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `forgeax-sdk-v${version}`,
  documentNamespace: `https://github.com/ForgeaX-Games/forgeax-engine/releases/${engineCommit}`,
  packages: packageRows.map((entry, index) => ({
    SPDXID: `SPDXRef-Package-${index}`,
    name: entry.name,
    versionInfo: entry.version,
    downloadLocation: 'NOASSERTION',
  })),
};
await writeFile(
  resolve(outputRoot, `forgeax-sdk-v${version}.spdx.json`),
  `${JSON.stringify(sbom, null, 2)}\n`,
);
await writeFile(
  resolve(outputRoot, `forgeax-sdk-v${version}.provenance.json`),
  `${JSON.stringify({ schemaVersion: '1.0.0', engineCommit, sdkVersion: version, builder: 'scripts/forgeax/build-sdk.mjs' }, null, 2)}\n`,
);

for (const path of await filesUnder(stage)) {
  await (await import('node:fs/promises')).utimes(path, 315532800, 315532800);
}
const zipEntries = (await filesUnder(stage))
  .map((path) => relative(outputRoot, path).split(sep).join('/'))
  .sort();
await writeFile(resolve(outputRoot, '.sdk-zip-inputs'), `${zipEntries.join('\n')}\n`);
await zipWithInputs(['-X', '-q', archive, '-@'], outputRoot, `${zipEntries.join('\n')}\n`);
const archiveBytes = await readFile(archive);
const digest = sha256(archiveBytes);
await writeFile(resolve(outputRoot, 'SHA256SUMS'), `${digest}  ${basename(archive)}\n`);
const result = {
  ok: true,
  archive,
  sha256: digest,
  engineCommit,
  sdkVersion: version,
  capabilities: SDK_CAPABILITIES,
};
await writeFile(
  resolve(outputRoot, 'sdk-build-result.json'),
  `${JSON.stringify(result, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(result)}\n`);
