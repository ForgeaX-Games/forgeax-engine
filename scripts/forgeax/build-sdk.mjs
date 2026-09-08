import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  artifact,
  assertNoRetiredPackageFiles,
  fetchWithRetry,
  filesUnder,
  normalizePackageArchive,
  normalizePnpmStore,
  SDK_CAPABILITIES,
  SDK_MANIFEST_VERSION,
  SDK_RESOURCE_ALLOWLIST,
  SDK_SOURCE_EXCLUDED_PATHS,
  SDK_SOURCE_FORMAT,
  SDK_SOURCE_ROOT,
  SDK_SOURCE_WASM,
  SDK_TEMPLATE_RESOURCE_ALLOWLIST,
  SDK_TEMPLATES,
  sdkResourceManifest,
  sdkTemplateResourceManifest,
  sha256,
  stable,
  streamFile,
} from './sdk-lib.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const args = process.argv.slice(2);
const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const packageManager = rootPackage.packageManager;
const packageManagerMatch = /^pnpm@(\d+)\.(\d+)\.(\d+)$/.exec(
  typeof packageManager === 'string' ? packageManager : '',
);
if (packageManagerMatch === null) throw new Error('sdk-package-manager-invalid');
const pnpmVersion = packageManagerMatch.slice(1).join('.');
const pnpmStoreFormat = `v${packageManagerMatch[1]}`;
const version = value('--version') ?? `0.0.0-dev.${await git(['rev-parse', '--short=12', 'HEAD'])}`;
const outputRoot = resolve(root, value('--output') ?? 'artifacts/sdk');
const stage = resolve(outputRoot, 'forgeax-sdk');
const archive = resolve(outputRoot, `forgeax-sdk-v${version}.zip`);
const sourceRoot = resolve(stage, SDK_SOURCE_ROOT);
const pnpmMetadataCache = resolve(outputRoot, '.pnpm-metadata-cache');
const npmRoot = resolve(outputRoot, 'npm');
const packageArchives = resolve(npmRoot, 'packages');
const canonicalKitPackageRoot = resolve(root, 'packages/preview/assets/canonical-kit');
const canonicalKitSource = resolve(
  root,
  'forgeax-engine-assets/demo-assets/template-game-default/sky.hdr',
);
const canonicalKitMeta = `${canonicalKitSource}.meta.json`;
const canonicalKitRoot = resolve(outputRoot, '.canonical-kit');

function value(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function run(file, commandArgs, options = {}) {
  const { env, ...rest } = options;
  return execFileAsync(file, commandArgs, {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    ...rest,
    env: { ...process.env, CI: process.env.CI ?? 'true', ...env },
  });
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

async function archiveEngineSource(destination) {
  const sourceArchive = resolve(outputRoot, '.sdk-engine-source.tar');
  await run('git', ['archive', '--format=tar', `--output=${sourceArchive}`, 'HEAD']);
  try {
    await run('tar', ['-xf', sourceArchive, '-C', destination]);
  } finally {
    await rm(sourceArchive, { force: true });
  }
}

async function copySdkResources(destination, sourceOverrides = new Map()) {
  for (const entry of SDK_RESOURCE_ALLOWLIST) {
    const overrideRoot = sourceOverrides.get(entry.id);
    for (const file of entry.files) {
      const source =
        overrideRoot === undefined
          ? resolve(root, entry.sourceRoot, file)
          : resolve(overrideRoot, file);
      try {
        await readFile(source);
      } catch (error) {
        throw new Error(`sdk-resource-allowlist-missing: ${entry.id}/${file}`, { cause: error });
      }
      const target = resolve(destination, entry.sourceRoot, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }
    const resourceRoot = resolve(destination, entry.sourceRoot);
    const actual = (await filesUnder(resourceRoot))
      .map((path) => relative(resourceRoot, path).split(sep).join('/'))
      .sort();
    const expected = [...entry.files].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`sdk-resource-allowlist-drift: ${entry.id}`);
    }
  }
}

async function copySdkTemplateResources(destination) {
  for (const entry of SDK_TEMPLATE_RESOURCE_ALLOWLIST) {
    for (const file of entry.files) {
      const source = resolve(root, entry.sourceRoot, file);
      try {
        await readFile(source);
      } catch (error) {
        throw new Error(`sdk-template-resource-missing: ${entry.id}/${file}`, { cause: error });
      }
      const target = resolve(destination, entry.destinationRoot, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target);
    }
    const resourceRoot = resolve(destination, entry.destinationRoot);
    const actual = (await filesUnder(resourceRoot))
      .map((path) => relative(resourceRoot, path).split(sep).join('/'))
      .sort();
    const expected = [...entry.files].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`sdk-template-resource-allowlist-drift: ${entry.id}`);
    }
  }
}

const status = await git(['status', '--porcelain']);
if (status !== '' && !args.includes('--allow-dirty')) {
  throw new Error('sdk-dirty-checkout: commit or stash all changes before building the SDK');
}
await run('node', ['scripts/forgeax/check-engine-skills.mjs']);
const licenseReport = stable(
  // Fail before the expensive Engine/template build when the contributor
  // workspace or its pnpm store cannot produce the authoritative notice set.
  // Cross-platform optional children can lack pnpm store index rows for the
  // current host; their parent package license remains in this notice set.
  JSON.parse(
    (await run('corepack', [packageManager, 'licenses', 'list', '--json', '--no-optional'])).stdout,
  ),
);
const engineCommit = await git(['rev-parse', 'HEAD']);
await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(stage, 'packages'), { recursive: true });
await mkdir(resolve(stage, 'store', 'pnpm'), { recursive: true });
await mkdir(resolve(stage, 'templates'), { recursive: true });
await mkdir(resolve(stage, 'skills'), { recursive: true });
await mkdir(resolve(stage, 'schemas'), { recursive: true });
await mkdir(resolve(stage, 'docs'), { recursive: true });
await mkdir(resolve(stage, 'licenses'), { recursive: true });
await mkdir(resolve(stage, 'toolchain', 'wasm'), { recursive: true });
await mkdir(packageArchives, { recursive: true });
await mkdir(sourceRoot, { recursive: true });

await run('node', ['scripts/clean-build-outputs.mjs']);
await run('pnpm', ['build:engine'], {
  // Keep the contributor checkout's package-owned canonical receipt stable.
  // The public SDK variant is materialized into canonicalKitRoot below and
  // overlaid only while the preview package is packed.
  env: {
    ...process.env,
    FORGEAX_SDK_BUILD: '0',
    FORGEAX_CANONICAL_KIT_OUTPUT: canonicalKitRoot,
  },
});
await run(
  'node',
  [
    'packages/preview/scripts/build-canonical-kit.mjs',
    canonicalKitSource,
    canonicalKitMeta,
    canonicalKitRoot,
  ],
  {
    env: { ...process.env, FORGEAX_SDK_BUILD: '1' },
  },
);
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
await run('pnpm', [
  'exec',
  'tsc',
  '-b',
  '--force',
  'packages/tool-runtime',
  'packages/devkit',
  'packages/project',
]);
const { createMigrationRoster } = await import(
  pathToFileURL(resolve(root, 'packages/devkit/dist/index.mjs')).href
);
const packageMigrationRoster = {
  schemaVersion: '2.0.0',
  operations: createMigrationRoster().map((entry) => entry.operation),
  source: 'packages/devkit/src/tools/migration.ts',
};

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
    (manifest.name !== '@forgeax/engine' && !manifest.name.startsWith('@forgeax/engine-'))
  )
    continue;
  publicPackages.push({
    name: manifest.name,
    version,
    directory: entry.name,
    root: dirname(packagePath),
  });
}
publicPackages.sort((a, b) => a.name.localeCompare(b.name));

// wasm-pack emits pkg/.gitignore; npm pack applies nested ignores even when
// pkg is declared in files, so remove this generated control file first.
await Promise.all(
  publicPackages.map((entry) => rm(resolve(entry.root, 'pkg', '.gitignore'), { force: true })),
);

const canonicalKitBackupRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-canonical-kit-'));
const canonicalKitBackup = resolve(canonicalKitBackupRoot, 'canonical-kit');
await cp(canonicalKitPackageRoot, canonicalKitBackup, { recursive: true });
try {
  await rm(canonicalKitPackageRoot, { recursive: true, force: true });
  await cp(canonicalKitRoot, canonicalKitPackageRoot, { recursive: true });
  for (const entry of publicPackages) {
    await run('pnpm', ['--filter', entry.name, 'pack', '--pack-destination', packageArchives]);
  }
} finally {
  await rm(canonicalKitPackageRoot, { recursive: true, force: true });
  await cp(canonicalKitBackup, canonicalKitPackageRoot, { recursive: true });
  await rm(canonicalKitBackupRoot, { recursive: true, force: true });
}
for (const path of (await filesUnder(packageArchives)).filter((entry) => entry.endsWith('.tgz'))) {
  const { stdout } = await run('tar', ['-xOf', path, 'package/package.json']);
  const manifest = JSON.parse(stdout);
  const { stdout: archiveList } = await run('tar', ['-tzf', path]);
  assertNoRetiredPackageFiles(manifest.name, archiveList.trim().split('\n'));
  await normalizePackageArchive(path, execFileAsync, { releaseVersion: version });
  const releaseName = `${manifest.name.slice(1).replace('/', '-')}-${version}.tgz`;
  await rename(path, resolve(packageArchives, releaseName));
}

const tarballs = new Map();
for (const path of (await filesUnder(packageArchives)).filter((entry) => entry.endsWith('.tgz'))) {
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
for (const entry of publicPackages) {
  const archiveEntry = tarballs.get(entry.name);
  if (archiveEntry === undefined) throw new Error(`sdk-package-archive-missing: ${entry.name}`);
  const destination = resolve(stage, 'packages', entry.directory);
  await mkdir(destination, { recursive: true });
  await run('tar', ['-xzf', archiveEntry.path, '-C', destination, '--strip-components=1']);
}

function npmTarballUrl(name, version) {
  const slash = name.indexOf('/');
  const packageName = slash >= 0 ? name.slice(slash + 1) : name;
  return `https://registry.npmjs.org/${name}/-/${packageName}-${version}.tgz`;
}

async function normalizeTemplateLockfile(template) {
  const lockfilePath = resolve(template, 'pnpm-lock.yaml');
  let lockfile = await readFile(lockfilePath, 'utf8');
  for (const item of tarballs.values()) {
    const localUrl = `http://127.0.0.1:${port}/tarballs/${engineCommit}/${basename(item.path)}`;
    lockfile = lockfile.replaceAll(localUrl, npmTarballUrl(item.name, item.version));
  }
  await writeFile(lockfilePath, lockfile);
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
  const upstream = await fetchWithRetry(`https://registry.npmjs.org${url}`, {
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

const dependencies = { '@forgeax/engine': version };
try {
  for (const sdkTemplate of SDK_TEMPLATES) {
    const sourceTemplate = resolve(root, sdkTemplate.sourceRoot);
    const template = resolve(stage, sdkTemplate.sourceRoot);
    await cp(sourceTemplate, template, {
      recursive: true,
      filter: (source) => {
        const path = relative(sourceTemplate, source).split(sep).join('/');
        return path !== 'AGENTS.md' && !/(^|\/)(node_modules|dist|\.forgeax)(\/|$)/.test(path);
      },
    });
    for (const path of (await filesUnder(template)).filter((entry) =>
      /\.[cm]?[jt]sx?$/.test(entry),
    )) {
      const source = await readFile(path, 'utf8');
      const migrated = source.replace(
        /@forgeax\/engine-([a-z0-9-]+)/g,
        (_match, member) => `@forgeax/engine/${member}`,
      );
      if (migrated !== source) await writeFile(path, migrated);
    }
    await cp(resolve(root, 'templates', 'AGENTS.md'), resolve(template, 'AGENTS.md'));
    await cp(
      resolve(root, 'templates', 'pnpm-workspace.yaml'),
      resolve(template, 'pnpm-workspace.yaml'),
    );
    const sourceTemplateManifest = JSON.parse(
      await readFile(resolve(template, 'package.json'), 'utf8'),
    );
    const templateManifest = {
      name: sourceTemplateManifest.name,
      version: sourceTemplateManifest.version,
      private: true,
      type: 'module',
      license: sourceTemplateManifest.license,
      packageManager,
      scripts: {
        dev: 'forgeax dev',
        build: 'forgeax build',
        package: 'forgeax package',
        serve: 'forgeax serve',
        preview: 'forgeax preview',
        doctor: 'forgeax doctor',
        test: 'forgeax test',
      },
      forgeax: sourceTemplateManifest.forgeax,
      dependencies,
      devDependencies: {
        '@types/node': '20.19.40',
        '@webgpu/types': '0.1.71',
        tsx: '4.23.1',
        typescript: '6.0.3',
        vitest: '4.1.11',
      },
    };
    await writeFile(
      resolve(template, 'package.json'),
      `${JSON.stringify(templateManifest, null, 2)}\n`,
    );
    await run(
      'corepack',
      [
        packageManager,
        'install',
        '--child-concurrency=1',
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
    // The local registry is only a build-time transport. Published templates
    // must carry canonical npm tarball URLs so the npm carrier can install
    // online; the ZIP's immutable store supplies those same integrities
    // offline under the generated lockfile trust boundary and complete packaged store.
    await normalizeTemplateLockfile(template);
    await rm(resolve(template, 'node_modules'), { recursive: true, force: true });
  }
} finally {
  await new Promise((accept, reject) =>
    registry.close((error) => (error === undefined ? accept() : reject(error))),
  );
}
await copySdkTemplateResources(stage);
await rm(pnpmMetadataCache, { recursive: true, force: true });
await rm(resolve(stage, 'store', 'pnpm', pnpmStoreFormat, 'projects'), {
  recursive: true,
  force: true,
});
await normalizePnpmStore(resolve(stage, 'store', 'pnpm'), pnpmStoreFormat);
await mkdir(resolve(stage, 'bin'), { recursive: true });
await cp(
  resolve(root, 'packages', 'devkit', 'dist', 'sdk-cli.mjs'),
  resolve(stage, 'bin', 'forgeax.mjs'),
);
await writeFile(
  resolve(stage, 'bin', 'forgeax'),
  '#!/bin/sh\nexec node "$(dirname "$0")/forgeax.mjs" "$@"\n',
);
await chmod(resolve(stage, 'bin', 'forgeax'), 0o755);
await writeFile(
  resolve(stage, 'bin', 'forgeax.cmd'),
  '@echo off\r\nnode "%~dp0forgeax.mjs" %*\r\n',
);
await writeFile(
  resolve(stage, 'docs', 'TOOL-MIGRATION-ROSTER.json'),
  `${JSON.stringify(packageMigrationRoster, null, 2)}\n`,
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
const sdkSkillIds = (await readdir(resolve(root, 'skills'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
for (const id of sdkSkillIds) {
  try {
    await readFile(resolve(root, 'skills', id, 'SKILL.md'));
  } catch (error) {
    throw new Error(`sdk-skill-entry-missing: ${id}/SKILL.md`, { cause: error });
  }
  await cp(resolve(root, 'skills', id), resolve(stage, 'skills', id), { recursive: true });
}
await archiveEngineSource(sourceRoot);
await copySdkTemplateResources(sourceRoot);
await Promise.all(
  SDK_SOURCE_WASM.flatMap((entry) =>
    entry.files.map(async (file) => {
      const source = resolve(root, entry.root, file);
      const destination = resolve(sourceRoot, entry.root, file);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination);
    }),
  ),
);
await copySdkResources(sourceRoot, new Map([['preview-canonical-kit', canonicalKitRoot]]));
await Promise.all(
  SDK_SOURCE_EXCLUDED_PATHS.map((path) =>
    rm(resolve(sourceRoot, path), { recursive: true, force: true }),
  ),
);
await writeFile(
  resolve(sourceRoot, '.forgeax-public-distribution'),
  'This marker selects the public SDK source install and build path.\n',
);
await Promise.all([
  cp(resolve(root, 'skills', 'forgeax-engine-sdk', 'SDK-README.md'), resolve(stage, 'README.md')),
  cp(resolve(root, 'skills', 'forgeax-engine-sdk', 'SDK-AGENTS.md'), resolve(stage, 'AGENTS.md')),
  cp(resolve(root, 'skills', 'forgeax-engine-sdk', 'SDK-CLAUDE.md'), resolve(stage, 'CLAUDE.md')),
]);
await writeFile(
  resolve(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: '@forgeax/engine-sdk-root',
      version,
      private: true,
      packageManager,
      engines: { node: '>=22.13.0' },
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  resolve(stage, 'licenses', 'THIRD_PARTY_NOTICES.json'),
  `${JSON.stringify(licenseReport, null, 2)}\n`,
);
const packageRows = [];
for (const item of publicPackages) {
  const packageRoot = resolve(stage, 'packages', item.directory);
  const packageFiles = await filesUnder(packageRoot);
  packageRows.push({
    name: item.name,
    version: item.version,
    root: `packages/${item.directory}`,
    fileCount: packageFiles.length,
    byteCount: (
      await Promise.all(packageFiles.map(async (path) => (await readFile(path)).byteLength))
    ).reduce((sum, bytes) => sum + bytes, 0),
  });
}
const skillRows = [];
for (const id of sdkSkillIds) {
  const skillRoot = resolve(stage, 'skills', id);
  const skillFiles = await filesUnder(skillRoot);
  skillRows.push({
    id,
    root: `skills/${id}`,
    fileCount: skillFiles.length,
    byteCount: (
      await Promise.all(skillFiles.map(async (path) => (await readFile(path)).byteLength))
    ).reduce((sum, bytes) => sum + bytes, 0),
  });
}
const sourceRows = await Promise.all(
  (await filesUnder(sourceRoot)).map((path) => artifact(stage, path)),
);
const source = {
  root: SDK_SOURCE_ROOT,
  format: SDK_SOURCE_FORMAT,
  excluded: [...SDK_SOURCE_EXCLUDED_PATHS],
  fileCount: sourceRows.length,
  byteCount: sourceRows.reduce((sum, row) => sum + row.bytes, 0),
  prebuiltWasm: SDK_SOURCE_WASM.map(({ package: packageName, root: packageRoot, files }) => ({
    package: packageName,
    root: packageRoot,
    files: [...files],
  })),
};
const artifactPaths = (await filesUnder(stage)).filter(
  (path) => !path.endsWith('/sdk-manifest.json'),
);
const artifacts = await Promise.all(artifactPaths.map((path) => artifact(stage, path)));
const sdkManifest = {
  schemaVersion: SDK_MANIFEST_VERSION,
  sdkVersion: version,
  engineCommit,
  requirements: { node: '>=22.13.0', pnpm: pnpmVersion, pnpmStoreFormat },
  capabilities: SDK_CAPABILITIES,
  packages: packageRows,
  templates: SDK_TEMPLATES.map(({ id, sourceRoot: templateRoot, default: isDefault }) => ({
    id,
    root: templateRoot,
    default: isDefault,
  })),
  skills: skillRows,
  resources: sdkResourceManifest(),
  templateResources: sdkTemplateResourceManifest(),
  source,
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

const carrierWorktree = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-carrier-'));
const carrierPackage = resolve(carrierWorktree, 'package');
const carrierArchive = resolve(npmRoot, `forgeax-engine-sdk-${version}.tgz`);
try {
  await mkdir(carrierPackage, { recursive: true });
  const carrierSdkRoot = resolve(carrierPackage, 'sdk');
  await cp(stage, carrierSdkRoot, { recursive: true });
  // The ZIP is the offline product and keeps the normalized pnpm store. The
  // npm carrier is the smaller online bootstrap surface; games install the
  // exact locked packages from the registry when this store is absent.
  await rm(resolve(carrierSdkRoot, 'store'), { recursive: true, force: true });
  const carrierManifestPath = resolve(carrierSdkRoot, 'sdk-manifest.json');
  const carrierManifest = JSON.parse(await readFile(carrierManifestPath, 'utf8'));
  carrierManifest.artifacts = carrierManifest.artifacts.filter(
    ({ path }) => !path.startsWith('store/'),
  );
  await writeFile(carrierManifestPath, `${JSON.stringify(carrierManifest, null, 2)}\n`);
  await writeFile(
    resolve(carrierPackage, 'package.json'),
    `${JSON.stringify(
      {
        name: '@forgeax/engine-sdk',
        version,
        license: 'Apache-2.0',
        description: 'On-demand ForgeaX SDK carrier for the forgeax CLI.',
        homepage: 'https://forgeax.github.io/download/engine-ai.md',
        repository: {
          type: 'git',
          url: 'https://github.com/ForgeaX-Games/forgeax-engine.git',
          directory: 'skills/forgeax-engine-sdk',
        },
        keywords: ['forgeax', 'game-engine', 'game-sdk', 'webgpu'],
        engines: { node: '>=22.13.0' },
        files: ['README.md', 'sdk'],
      },
      null,
      2,
    )}\n`,
  );
  await cp(resolve(stage, 'README.md'), resolve(carrierPackage, 'README.md'));
  await run('tar', ['-czf', carrierArchive, '-C', carrierWorktree, 'package']);
  await normalizePackageArchive(carrierArchive, execFileAsync, { releaseVersion: version });
} finally {
  await rm(carrierWorktree, { recursive: true, force: true });
}

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
  npm: {
    packageArchives,
    packageCount: tarballs.size,
    sdkCarrier: carrierArchive,
  },
  capabilities: SDK_CAPABILITIES,
};
await writeFile(
  resolve(outputRoot, 'sdk-build-result.json'),
  `${JSON.stringify(result, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(result)}\n`);
