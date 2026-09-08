import { execFile, spawn } from 'node:child_process';
import { constants, rmSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import { chromium } from 'playwright';
import {
  artifact,
  assertNoRetiredPackageFiles,
  filesUnder,
  SDK_CAPABILITIES,
  SDK_MANIFEST_VERSION,
  SDK_SOURCE_EXCLUDED_PATHS,
  SDK_SOURCE_FORMAT,
  SDK_TEMPLATES,
  sdkResourceManifest,
  sdkTemplateResourceManifest,
  sha256,
} from './sdk-lib.mjs';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const index = args.indexOf('--archive');
if (index < 0 || args[index + 1] === undefined)
  throw new Error('Usage: pnpm sdk:verify --archive <path>');
const archive = resolve(args[index + 1]);
const unpackRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-verify-'));
let unpackRootRemoved = false;
const removeUnpackRoot = () => {
  if (unpackRootRemoved) return;
  unpackRootRemoved = true;
  rmSync(unpackRoot, { force: true, recursive: true });
};
process.once('exit', removeUnpackRoot);
process.once('SIGINT', () => {
  removeUnpackRoot();
  process.exit(130);
});
process.once('SIGTERM', () => {
  removeUnpackRoot();
  process.exit(143);
});
await execFileAsync('unzip', ['-q', archive, '-d', unpackRoot]);
const sdkRoot = resolve(unpackRoot, 'forgeax-sdk');
const manifest = JSON.parse(await readFile(resolve(sdkRoot, 'sdk-manifest.json'), 'utf8'));
const schema = JSON.parse(
  await readFile(resolve(sdkRoot, 'schemas', 'sdk-manifest.schema.json'), 'utf8'),
);
const validate = new Ajv2020({ allErrors: true }).compile(schema);
if (!validate(manifest)) throw new Error(`sdk-manifest-schema: ${JSON.stringify(validate.errors)}`);
if (manifest.schemaVersion !== SDK_MANIFEST_VERSION) throw new Error('sdk-manifest-version');
if (JSON.stringify(manifest.capabilities) !== JSON.stringify(SDK_CAPABILITIES))
  throw new Error('sdk-capability-closure');
for (const expected of manifest.artifacts) {
  const actual = await artifact(sdkRoot, resolve(sdkRoot, expected.path));
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
    throw new Error(`sdk-artifact-mismatch: ${expected.path}`);
}
const files = await filesUnder(sdkRoot);
if (files.length !== manifest.artifacts.length + 1) throw new Error('sdk-unmanifested-artifact');
if ((await filesUnder(resolve(sdkRoot, 'packages'))).some((path) => path.endsWith('.tgz')))
  throw new Error('sdk-package-archive-leaked');
for (const entry of manifest.packages) {
  const packageRoot = resolve(sdkRoot, entry.root);
  if (!contained(sdkRoot, packageRoot)) throw new Error(`sdk-package-path: ${entry.name}`);
  const packageManifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  if (packageManifest.name !== entry.name || packageManifest.version !== entry.version)
    throw new Error(`sdk-package-identity: ${entry.name}`);
  try {
    await readFile(resolve(packageRoot, 'package', 'package.json'));
    throw new Error(`sdk-package-wrapper-leaked: ${entry.name}`);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('sdk-package-wrapper-leaked'))
      throw cause;
  }
  const packageFiles = await filesUnder(packageRoot);
  assertNoRetiredPackageFiles(
    entry.name,
    packageFiles.map((path) => relative(packageRoot, path).split(sep).join('/')),
  );
  if (packageFiles.length !== entry.fileCount)
    throw new Error(`sdk-package-file-count: ${entry.name}`);
  const byteCount = (
    await Promise.all(packageFiles.map(async (path) => (await readFile(path)).byteLength))
  ).reduce((sum, bytes) => sum + bytes, 0);
  if (byteCount !== entry.byteCount) throw new Error(`sdk-package-byte-count: ${entry.name}`);
  const prefix = `${entry.root}/`;
  if (
    manifest.artifacts.filter((artifactEntry) => artifactEntry.path.startsWith(prefix)).length !==
    entry.fileCount
  )
    throw new Error(`sdk-package-artifact-closure: ${entry.name}`);
}
const archivedSkillIds = (await readdir(resolve(sdkRoot, 'skills'), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(archivedSkillIds) !== JSON.stringify(manifest.skills.map((entry) => entry.id)))
  throw new Error('sdk-skill-manifest');
for (const entry of manifest.skills) {
  const skillRoot = resolve(sdkRoot, entry.root);
  if (!contained(sdkRoot, skillRoot) || basename(skillRoot) !== entry.id)
    throw new Error(`sdk-skill-path: ${entry.id}`);
  await readFile(resolve(skillRoot, 'SKILL.md'));
  const skillFiles = await filesUnder(skillRoot);
  if (skillFiles.length !== entry.fileCount) throw new Error(`sdk-skill-file-count: ${entry.id}`);
  const byteCount = (
    await Promise.all(skillFiles.map(async (path) => (await readFile(path)).byteLength))
  ).reduce((sum, bytes) => sum + bytes, 0);
  if (byteCount !== entry.byteCount) throw new Error(`sdk-skill-byte-count: ${entry.id}`);
  if (
    manifest.artifacts.filter((artifactEntry) => artifactEntry.path.startsWith(`${entry.root}/`))
      .length !== entry.fileCount
  )
    throw new Error(`sdk-skill-artifact-closure: ${entry.id}`);
}
try {
  await access(resolve(sdkRoot, 'docs', 'guides'));
  throw new Error('sdk-legacy-guide-surface');
} catch (cause) {
  if (cause instanceof Error && cause.message === 'sdk-legacy-guide-surface') throw cause;
}
const expectedTemplates = SDK_TEMPLATES.map(({ id, sourceRoot: root, default: isDefault }) => ({
  id,
  root,
  default: isDefault,
}));
if (JSON.stringify(manifest.templates) !== JSON.stringify(expectedTemplates))
  throw new Error('sdk-template-manifest');
if (manifest.templates.filter((entry) => entry.default).length !== 1)
  throw new Error('sdk-default-template-count');
const sourceRoot = resolve(sdkRoot, manifest.source.root);
const sourcePackage = JSON.parse(await readFile(resolve(sourceRoot, 'package.json'), 'utf8'));
const sourcePackageManager = sourcePackage.packageManager;
const sdkPackage = JSON.parse(await readFile(resolve(sdkRoot, 'package.json'), 'utf8'));
if (sdkPackage.packageManager !== sourcePackageManager)
  throw new Error('sdk-root-package-manager-mismatch');
if (typeof sourcePackageManager !== 'string' || !sourcePackageManager.startsWith('pnpm@')) {
  throw new Error('sdk-source-package-manager');
}
const sourcePrefix = `${manifest.source.root}/`;
const sourceArtifacts = manifest.artifacts.filter((entry) => entry.path.startsWith(sourcePrefix));
if (sourceArtifacts.length !== manifest.source.fileCount) throw new Error('sdk-source-file-count');
if (sourceArtifacts.reduce((sum, entry) => sum + entry.bytes, 0) !== manifest.source.byteCount)
  throw new Error('sdk-source-byte-count');
if (manifest.source.format !== SDK_SOURCE_FORMAT) throw new Error('sdk-source-format');
if (JSON.stringify(manifest.source.excluded) !== JSON.stringify(SDK_SOURCE_EXCLUDED_PATHS))
  throw new Error('sdk-source-exclusions');
if (sourceArtifacts.some((entry) => /(^|\/)(node_modules|\.git)(\/|$)/.test(entry.path)))
  throw new Error('sdk-source-unportable-tree');
if (
  sourceArtifacts.some(
    (entry) =>
      entry.path === `${sourcePrefix}.gitmodules` ||
      entry.path.startsWith(`${sourcePrefix}forgeax-engine-assets/`),
  )
)
  throw new Error('sdk-source-private-dependency');

function contained(parent, child) {
  const childPath = relative(parent, child);
  return (
    childPath !== '' &&
    childPath !== '..' &&
    !childPath.startsWith(`..${sep}`) &&
    !childPath.startsWith(sep)
  );
}

const expectedResources = sdkResourceManifest();
if (JSON.stringify(manifest.resources) !== JSON.stringify(expectedResources))
  throw new Error('sdk-resource-allowlist-manifest');
for (const resource of manifest.resources) {
  const resourceRoot = resolve(sourceRoot, resource.sourceRoot);
  if (!contained(sourceRoot, resourceRoot))
    throw new Error(`sdk-resource-source-path: ${resource.id}`);
  const actualFiles = (await filesUnder(resourceRoot))
    .map((path) => relative(resourceRoot, path).split(sep).join('/'))
    .sort();
  const expectedFiles = [...resource.files].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))
    throw new Error(`sdk-resource-allowlist-drift: ${resource.id}`);
  for (const file of resource.files) {
    const path = resolve(resourceRoot, file);
    if (!contained(resourceRoot, path)) throw new Error(`sdk-resource-source-path: ${resource.id}`);
    await readFile(path);
    const artifactPath = `${manifest.source.root}/${resource.sourceRoot}/${file}`;
    if (!manifest.artifacts.some((entry) => entry.path === artifactPath))
      throw new Error(`sdk-resource-unmanifested: ${artifactPath}`);
  }
  const packageEntry = manifest.packages.find((entry) => entry.name === resource.package);
  if (packageEntry === undefined) throw new Error(`sdk-resource-package-missing: ${resource.id}`);
  const packageArchive = resolve(sdkRoot, packageEntry.root);
  if (!contained(sdkRoot, packageArchive))
    throw new Error(`sdk-resource-package-path: ${resource.id}`);
  const packageRootParts = resource.packageRoot.split('/');
  if (resource.packageRoot.startsWith('/') || packageRootParts.includes('..'))
    throw new Error(`sdk-resource-package-path: ${resource.id}`);
  const packageResourceRoot = resolve(packageArchive, resource.packageRoot);
  if (!contained(packageArchive, packageResourceRoot))
    throw new Error(`sdk-resource-package-path: ${resource.id}`);
  const listing = (await filesUnder(packageResourceRoot))
    .map((path) => relative(packageResourceRoot, path).split(sep).join('/'))
    .sort();
  if (JSON.stringify(listing) !== JSON.stringify(expectedFiles))
    throw new Error(`sdk-resource-package-drift: ${resource.id}`);
}

const expectedTemplateResources = sdkTemplateResourceManifest();
if (JSON.stringify(manifest.templateResources) !== JSON.stringify(expectedTemplateResources))
  throw new Error('sdk-template-resource-allowlist-manifest');
for (const resource of manifest.templateResources) {
  const sourceResourceRoot = resolve(sourceRoot, resource.root);
  const archiveResourceRoot = resolve(sdkRoot, resource.root);
  if (!contained(sourceRoot, sourceResourceRoot) || !contained(sdkRoot, archiveResourceRoot))
    throw new Error(`sdk-template-resource-path: ${resource.id}`);
  const expectedFiles = [...resource.files].sort();
  for (const [resourceRoot, artifactPrefix] of [
    [sourceResourceRoot, `${manifest.source.root}/${resource.root}`],
    [archiveResourceRoot, resource.root],
  ]) {
    const actualFiles = (await filesUnder(resourceRoot))
      .map((path) => relative(resourceRoot, path).split(sep).join('/'))
      .sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles))
      throw new Error(`sdk-template-resource-allowlist-drift: ${resource.id}`);
    for (const file of resource.files) {
      const path = resolve(resourceRoot, file);
      if (!contained(resourceRoot, path))
        throw new Error(`sdk-template-resource-path: ${resource.id}`);
      await readFile(path);
      if (!manifest.artifacts.some((entry) => entry.path === `${artifactPrefix}/${file}`))
        throw new Error(`sdk-template-resource-unmanifested: ${artifactPrefix}/${file}`);
    }
  }
}

for (const path of [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'bin/forgeax.mjs',
  'skills/forgeax-engine-assets/SKILL.md',
  'skills/forgeax-engine-cli/SKILL.md',
  'skills/forgeax-engine-rhi-debug/SKILL.md',
  'skills/forgeax-engine-sdk/references/feature-catalog.md',
  'templates/game-empty/AGENTS.md',
  'templates/game-empty/README.md',
  'templates/game-empty/package.json',
  'templates/game-3d/README.md',
  'templates/game-3d/package.json',
]) {
  await readFile(resolve(sdkRoot, path));
}
const forgeaxBin = resolve(sdkRoot, 'bin', 'forgeax');
if (process.platform !== 'win32') {
  await access(forgeaxBin, constants.X_OK);
  const help = await execFileAsync(forgeaxBin, ['--help'], { env: process.env });
  if (!help.stdout.includes('Usage: forgeax new')) throw new Error('sdk-cli-help');
}
for (const path of [
  '.forgeax-public-distribution',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'rules/forgeax-engine-usage.md',
  'skills/forgeax-engine-cli/SKILL.md',
  'skills/forgeax-engine-sdk/SKILL.md',
]) {
  await readFile(resolve(sourceRoot, path));
}
for (const entry of manifest.source.prebuiltWasm) {
  const packageRoot = resolve(sourceRoot, entry.root);
  if (!contained(sourceRoot, packageRoot))
    throw new Error(`sdk-source-wasm-path: ${entry.package}`);
  for (const file of entry.files) {
    const path = resolve(packageRoot, file);
    if (!contained(packageRoot, path)) throw new Error(`sdk-source-wasm-path: ${entry.package}`);
    await readFile(path);
    const artifactPath = `${manifest.source.root}/${entry.root}/${file}`;
    if (!manifest.artifacts.some((artifactEntry) => artifactEntry.path === artifactPath))
      throw new Error(`sdk-source-wasm-unmanifested: ${artifactPath}`);
  }
}
const checkPath = resolve(dirname(archive), 'SHA256SUMS');
const checksums = await readFile(checkPath, 'utf8');
const digest = sha256(await readFile(archive));
if (!checksums.includes(`${digest}  ${basename(archive)}`)) throw new Error('sdk-archive-checksum');
const project = resolve(unpackRoot, 'game');
const toolBin = resolve(unpackRoot, 'tool-bin');
await mkdir(toolBin);
const pnpmShim = resolve(toolBin, 'pnpm');
await writeFile(pnpmShim, `#!/bin/sh\nexec corepack ${sourcePackageManager} "$@"\n`);
await chmod(pnpmShim, 0o755);
const offlineEnv = {
  ...process.env,
  PATH: `${toolBin}:${process.env.PATH ?? ''}`,
  FORGEAX_SDK_ROOT: sdkRoot,
  npm_config_offline: 'true',
  CI: 'true',
};
const initializedSdk = await execFileAsync(
  'node',
  [resolve(sdkRoot, 'bin', 'forgeax.mjs'), 'init', '--json'],
  {
    cwd: sdkRoot,
    env: offlineEnv,
    maxBuffer: 64 * 1024 * 1024,
  },
);
const initializedSdkEnvelope = JSON.parse(initializedSdk.stdout.trim());
if (
  initializedSdkEnvelope.value?.onboarding?.read?.join('\n') !==
  [
    resolve(sdkRoot, 'AGENTS.md'),
    resolve(sdkRoot, 'skills/forgeax-engine-sdk/SKILL.md'),
    resolve(sdkRoot, 'skills/forgeax-engine-sdk/references/feature-catalog.md'),
  ].join('\n')
) {
  throw new Error('sdk-init-agent-onboarding');
}
const forbiddenProject = resolve(sdkRoot, 'game');
let forbiddenResult;
try {
  await execFileAsync(
    'node',
    [resolve(sdkRoot, 'bin', 'forgeax.mjs'), 'new', forbiddenProject, '--json'],
    { env: offlineEnv, maxBuffer: 64 * 1024 * 1024 },
  );
} catch (cause) {
  const stdout =
    typeof cause === 'object' && cause !== null && 'stdout' in cause ? String(cause.stdout) : '';
  try {
    forbiddenResult = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`sdk-project-target-guard-output: ${stdout}`);
  }
}
if (forbiddenResult?.error?.code !== 'project-target-inside-sdk')
  throw new Error(`sdk-project-target-guard: ${JSON.stringify(forbiddenResult)}`);
let forbiddenProjectExists = true;
try {
  await access(forbiddenProject);
} catch {
  forbiddenProjectExists = false;
}
if (forbiddenProjectExists) throw new Error('sdk-project-target-guard-mutated-sdk');
const createdProject = await execFileAsync(
  'node',
  [resolve(sdkRoot, 'bin', 'forgeax.mjs'), 'new', project, '--json'],
  {
    env: offlineEnv,
    maxBuffer: 64 * 1024 * 1024,
  },
);
const createdProjectEnvelope = JSON.parse(createdProject.stdout.trim());
if (
  createdProjectEnvelope.value?.onboarding?.read?.join('\n') !==
  [
    resolve(project, 'AGENTS.md'),
    resolve(project, 'skills/forgeax-engine-sdk/SKILL.md'),
    resolve(project, 'skills/forgeax-engine-sdk/references/feature-catalog.md'),
  ].join('\n')
) {
  throw new Error('sdk-new-agent-onboarding');
}
if (createdProjectEnvelope.value?.sdkUpdate?.status !== 'skipped')
  throw new Error('sdk-new-update-check-offline');
await readFile(resolve(project, 'skills/forgeax-engine-sdk/references/feature-catalog.md'));
const projectWorkspace = await readFile(resolve(project, 'pnpm-workspace.yaml'), 'utf8');
if (!projectWorkspace.includes('trustLockfile: true'))
  throw new Error('sdk-game-lockfile-trust-missing');
if (!projectWorkspace.includes('verifyDepsBeforeRun: warn'))
  throw new Error('sdk-game-run-install-policy-missing');
if (!projectWorkspace.includes('enableGlobalVirtualStore: false'))
  throw new Error('sdk-game-virtual-store-policy-missing');
const projectManifestPath = resolve(project, 'forge.json');
const projectManifest = JSON.parse(await readFile(projectManifestPath, 'utf8'));
const defaultSceneGuid = projectManifest.defaultScene;
const projectScopeId = projectManifest.id;
if (typeof defaultSceneGuid !== 'string' || typeof projectScopeId !== 'string')
  throw new Error('sdk-template-manifest-identity');
if (
  projectManifest.entry !== 'src/main.ts' ||
  !projectManifest.plugins?.some((entry) => entry.name === './src/main.ts')
) {
  throw new Error('sdk-empty-source-layout-manifest');
}
await readFile(resolve(project, 'src', 'main.ts'));
await readFile(resolve(project, 'src', '__tests__', 'starter.test.ts'));
for (const retiredPath of ['main.ts', '__tests__']) {
  let exists = true;
  try {
    await access(resolve(project, retiredPath));
  } catch (cause) {
    if (cause?.code === 'ENOENT') exists = false;
    else throw cause;
  }
  if (exists) throw new Error(`sdk-empty-source-layout-retired: ${retiredPath}`);
}
const projectPackagePath = resolve(project, 'package.json');
const projectPackage = JSON.parse(await readFile(projectPackagePath, 'utf8'));
projectPackage.name = '@acceptance/renamed-game';
await writeFile(projectPackagePath, `${JSON.stringify(projectPackage, null, 2)}\n`);
const interactiveLocalEnv = { ...offlineEnv, CI: '' };
const renamedProjectDoctor = await execFileAsync('pnpm', ['exec', 'forgeax', 'doctor', '--json'], {
  cwd: project,
  env: interactiveLocalEnv,
  maxBuffer: 64 * 1024 * 1024,
});
if (renamedProjectDoctor.stderr.includes('node_modules are out of sync'))
  throw new Error('sdk-game-first-command-dependency-drift');
const helpResult = await execFileAsync(
  'node',
  [resolve(sdkRoot, 'bin', 'forgeax.mjs'), 'dev', '--help'],
  {
    cwd: project,
    env: interactiveLocalEnv,
    maxBuffer: 64 * 1024 * 1024,
  },
);
if (!helpResult.stdout.includes('Usage: forgeax')) throw new Error('sdk-dev-help-output');
await execFileAsync('pnpm', ['exec', 'forgeax', 'skill', 'verify', '--json'], {
  cwd: project,
  env: offlineEnv,
  maxBuffer: 64 * 1024 * 1024,
});
for (const script of ['doctor', 'test', 'build']) {
  await execFileAsync('pnpm', ['run', script, '--', '--json'], {
    cwd: project,
    env: offlineEnv,
    maxBuffer: 128 * 1024 * 1024,
  });
}

const staticOutput = resolve(unpackRoot, 'static-game');
await execFileAsync(
  'pnpm',
  ['run', 'build', '--', '--base', '/games/forgeax-sdk-game/', '--out-dir', staticOutput, '--json'],
  {
    cwd: project,
    env: offlineEnv,
    maxBuffer: 128 * 1024 * 1024,
  },
);
const staticManifest = JSON.parse(
  await readFile(resolve(staticOutput, 'forgeax-dist.json'), 'utf8'),
);
if (
  staticManifest.base !== '/games/forgeax-sdk-game/' ||
  staticManifest.project?.id !== projectScopeId ||
  !Array.isArray(staticManifest.artifacts) ||
  !staticManifest.artifacts.some((entry) => entry.path === 'index.html') ||
  !staticManifest.artifacts.some((entry) => entry.path === 'pack-index.json') ||
  !staticManifest.artifacts.some((entry) => entry.path === 'shaders/manifest.json')
) {
  throw new Error('sdk-static-build-output-closure');
}

const builtCatalog = JSON.parse(
  await readFile(resolve(project, 'dist', 'pack-index.json'), 'utf8'),
);
const defaultSceneEntry = Array.isArray(builtCatalog)
  ? builtCatalog.find((entry) => entry.guid === defaultSceneGuid)
  : undefined;
if (
  defaultSceneEntry?.kind !== 'scene' ||
  defaultSceneEntry.lifecycle !== 'current' ||
  typeof defaultSceneEntry.packageUrl !== 'string'
) {
  throw new Error('sdk-scriptable-pack-build-closure');
}
const defaultScenePackage = JSON.parse(
  await readFile(
    resolve(project, 'dist', defaultSceneEntry.packageUrl.replace(/^\/+/, '')),
    'utf8',
  ),
);
if (
  !Array.isArray(defaultScenePackage.assets) ||
  !defaultScenePackage.assets.some(
    (asset) => asset.guid === defaultSceneGuid && asset.kind === 'scene',
  )
) {
  throw new Error('sdk-scriptable-pack-package');
}
const generatedHost = await readFile(resolve(project, '.forgeax', 'generated', 'main.ts'), 'utf8');
if (
  !generatedHost.includes('assets.loadByGuid<SceneAsset>(assets.parseGuid(defaultSceneGuid))') ||
  !generatedHost.includes("app.world.allocSharedRef('SceneAsset', loaded.value)") ||
  !generatedHost.includes('assets.instantiate<SceneAsset>(handle, app.world)')
) {
  throw new Error('sdk-default-scene-runtime-closure');
}

function spawnProjectServer(command, cwd) {
  const detached = process.platform !== 'win32';
  return spawn('pnpm', ['run', command, '--', '--json', '--port', '0'], {
    cwd,
    env: offlineEnv,
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function verifyDev() {
  const detached = process.platform !== 'win32';
  const child = spawnProjectServer('dev', project);
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
    let envelope;
    while (Date.now() < deadline) {
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const candidate = JSON.parse(line);
          if (candidate.command === 'dev') envelope = candidate;
        } catch {}
      }
      if (envelope !== undefined) break;
      if (child.exitCode !== null) throw new Error(`sdk-dev-exited: ${stderr}`);
      await new Promise((accept) => setTimeout(accept, 100));
    }
    if (envelope?.ok !== true) throw new Error(`sdk-dev-not-ready: ${stdout}\n${stderr}`);
    const url = envelope.value?.urls?.local?.[0] ?? envelope.value?.urls?.network?.[0];
    if (typeof url !== 'string') throw new Error('sdk-dev-url-missing');
    const catalogUrl = new URL(
      `/__pack/scopes/${encodeURIComponent(projectScopeId)}/1/catalog.json`,
      url,
    ).toString();
    const catalogDeadline = Date.now() + 30_000;
    let snapshot;
    while (Date.now() < catalogDeadline) {
      try {
        const response = await fetch(catalogUrl);
        if (response.ok) {
          const candidate = await response.json();
          if (candidate.authority === 'authoritative') {
            snapshot = candidate;
            break;
          }
        }
      } catch {}
      await new Promise((accept) => setTimeout(accept, 100));
    }
    if (
      snapshot === undefined ||
      !Array.isArray(snapshot.entries) ||
      !snapshot.entries.some((entry) => entry.guid === defaultSceneGuid && entry.kind === 'scene')
    ) {
      throw new Error(`sdk-scriptable-pack-dev-catalog: ${catalogUrl}`);
    }
    return { url, catalogUrl, defaultSceneGuid };
  } finally {
    if (child.exitCode === null) {
      if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    }
    await exited;
  }
}

const devEvidence = await verifyDev();

async function verifyPreview() {
  const detached = process.platform !== 'win32';
  const child = spawnProjectServer('preview', project);
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
    let envelope;
    while (Date.now() < deadline) {
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const candidate = JSON.parse(line);
          if (candidate.command === 'preview') envelope = candidate;
        } catch {}
      }
      if (envelope !== undefined) break;
      if (child.exitCode !== null) throw new Error(`sdk-preview-exited: ${stderr}`);
      await new Promise((accept) => setTimeout(accept, 100));
    }
    if (envelope?.ok !== true) throw new Error(`sdk-preview-not-ready: ${stdout}\n${stderr}`);
    const url = envelope.value?.urls?.local?.[0] ?? envelope.value?.urls?.network?.[0];
    if (typeof url !== 'string') throw new Error('sdk-preview-url-missing');
    const response = await fetch(url);
    const html = await response.text();
    if (!response.ok || !html.includes('<canvas id="app"'))
      throw new Error('sdk-preview-static-closure');
    return url;
  } finally {
    if (child.exitCode === null) {
      if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    }
    await exited;
  }
}

const previewUrl = await verifyPreview();

async function verifySelectedTemplate() {
  const selectedProject = resolve(unpackRoot, 'game-3d');
  await execFileAsync(
    'node',
    [
      resolve(sdkRoot, 'bin', 'forgeax.mjs'),
      'new',
      selectedProject,
      '--template',
      'game-3d',
      '--json',
    ],
    { env: offlineEnv, maxBuffer: 64 * 1024 * 1024 },
  );
  const selectedManifest = JSON.parse(
    await readFile(resolve(selectedProject, 'forge.json'), 'utf8'),
  );
  if (selectedManifest.id !== 'template-game-3d') throw new Error('sdk-template-selection');
  await execFileAsync('pnpm', ['exec', 'forgeax', 'skill', 'verify', '--json'], {
    cwd: selectedProject,
    env: offlineEnv,
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const script of ['doctor', 'test', 'build']) {
    await execFileAsync('pnpm', ['run', script, '--', '--json'], {
      cwd: selectedProject,
      env: offlineEnv,
      maxBuffer: 128 * 1024 * 1024,
    });
  }
  const browser = await verifyProjectBrowser(selectedProject);
  return {
    id: 'game-3d',
    project: selectedProject,
    commands: ['new', 'skill.verify', 'doctor', 'test', 'build', 'dev'],
    browser,
  };
}

async function verifyProjectBrowser(projectRoot) {
  const detached = process.platform !== 'win32';
  const child = spawnProjectServer('dev', projectRoot);
  const exited = new Promise((accept) => child.once('exit', accept));
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  let browser;
  try {
    const deadline = Date.now() + 30_000;
    let envelope;
    while (Date.now() < deadline) {
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const candidate = JSON.parse(line);
          if (candidate.command === 'dev') envelope = candidate;
        } catch {}
      }
      if (envelope !== undefined) break;
      if (child.exitCode !== null) throw new Error(`sdk-selected-dev-exited: ${stderr}`);
      await new Promise((accept) => setTimeout(accept, 100));
    }
    if (envelope?.ok !== true) throw new Error(`sdk-selected-dev-not-ready: ${stdout}\n${stderr}`);
    const url = envelope.value?.urls?.local?.[0] ?? envelope.value?.urls?.network?.[0];
    if (typeof url !== 'string') throw new Error('sdk-selected-dev-url-missing');
    const chromeChannel = process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome';
    const chromeArgs = [
      '--disable-features=MacAppCodeSignClone',
      '--enable-unsafe-webgpu',
      '--ignore-gpu-blocklist',
    ];
    // Hosted Linux runners have no physical display/GPU. Match the repository's
    // proven Chrome Beta + lavapipe/Xvfb lane so the SDK template smoke checks
    // the real WebGPU compositor instead of silently accepting a static canvas.
    if (chromeChannel === 'chrome-beta') {
      chromeArgs.push(
        '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--use-vulkan=swiftshader',
        '--use-angle=swiftshader',
        '--disable-vulkan-surface',
        '--disable-gpu-driver-bug-workarounds',
        '--disable-dawn-features=disallow_unsafe_apis',
        '--autoplay-policy=no-user-gesture-required',
      );
    }
    browser = await chromium.launch({
      headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
      channel: chromeChannel,
      args: chromeArgs,
    });
    const page = await browser.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const failedResponses = [];
    page.on('pageerror', (error) => pageErrors.push(error.stack ?? String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failedResponses.push({ status: response.status(), url: response.url() });
      }
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    try {
      await page.waitForFunction(
        () => {
          const canvas = document.querySelector('canvas');
          return (canvas?.width ?? 0) > 0 && (canvas?.height ?? 0) > 0;
        },
        undefined,
        { timeout: 30_000, polling: 100 },
      );
    } catch (cause) {
      throw new Error(
        `sdk-selected-browser-not-ready: ${JSON.stringify({ pageErrors, consoleErrors, failedResponses })}`,
        { cause },
      );
    }
    try {
      await page.waitForFunction(
        () => Number(document.documentElement.dataset.forgeaxFrameSubmitted) > 0,
        undefined,
        { timeout: 120_000, polling: 100 },
      );
    } catch (cause) {
      throw new Error('sdk-selected-render-frame-not-submitted', { cause });
    }
    const runtime = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const frameId = Number(document.documentElement.dataset.forgeaxFrameSubmitted);
      return {
        canvas: { width: canvas?.width ?? 0, height: canvas?.height ?? 0 },
        engineFrameId: Number.isSafeInteger(frameId) && frameId > 0 ? frameId : null,
      };
    });
    // Canvas dimensions become non-zero before the first asset-backed frame.
    // On a CPU-only runner that gap can be several seconds (HDR/mesh cooking
    // is still in flight), so a merely stable screenshot would incorrectly
    // bless the initial flat clear colour as the baseline. Wait for actual
    // compositor pixels before stabilising and sending input.
    const baseline = await stableScreenshot(page);
    await page.locator('canvas').click({ position: { x: 32, y: 32 } });
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1_000);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(250);
    const moved = await canvasScreenshot(page);
    const changedPixelRatio = await compareScreenshots(page, baseline, moved);
    if (changedPixelRatio < 0.01) {
      throw new Error(`sdk-selected-third-person-static: ${JSON.stringify({ changedPixelRatio })}`);
    }
    if (pageErrors.length > 0 || consoleErrors.length > 0 || failedResponses.length > 0) {
      throw new Error(
        `sdk-selected-browser-errors: ${JSON.stringify({ pageErrors, consoleErrors, failedResponses })}`,
      );
    }
    return { url, runtime, changedPixelRatio, pageErrors: 0, consoleErrors: 0 };
  } finally {
    if (browser !== undefined) await browser.close();
    if (child.exitCode === null) {
      if (detached && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    }
    await exited;
  }
}

async function stableScreenshot(page) {
  let previous = await waitForRenderedScreenshot(page);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.waitForTimeout(250);
    const next = await canvasScreenshot(page);
    const changedPixelRatio = await compareScreenshots(page, previous, next);
    if (changedPixelRatio < 0.002) return next;
    previous = next;
  }
  throw new Error('sdk-selected-third-person-baseline-unstable');
}

async function canvasScreenshot(page) {
  return page.locator('canvas').first().screenshot({ type: 'png' });
}

async function waitForRenderedScreenshot(page) {
  const deadline = Date.now() + 120_000;
  let lastWitness;
  while (Date.now() < deadline) {
    const screenshot = await canvasScreenshot(page);
    lastWitness = await page.evaluate(async (base64) => {
      const image = new Image();
      await new Promise((resolveImage, rejectImage) => {
        image.onload = resolveImage;
        image.onerror = () => rejectImage(new Error('sdk-selected-screenshot-decode'));
        image.src = `data:image/png;base64,${base64}`;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('sdk-selected-screenshot-context');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const stride = Math.max(4, Math.floor(pixels.length / (4096 * 4)) * 4);
      let min = 255;
      let max = 0;
      let samples = 0;
      const histogram = new Uint32Array(16);
      for (let offset = 0; offset + 2 < pixels.length; offset += stride) {
        const luma = Math.round(
          (54 * pixels[offset] + 183 * pixels[offset + 1] + 19 * pixels[offset + 2]) / 256,
        );
        min = Math.min(min, luma);
        max = Math.max(max, luma);
        histogram[Math.min(15, Math.floor(luma / 16))] += 1;
        samples += 1;
      }
      const dominant = histogram.reduce((largest, count) => Math.max(largest, count), 0);
      const varying = samples - dominant;
      return {
        width: image.width,
        height: image.height,
        samples,
        lumaRange: max - min,
        varying,
        rendered:
          max - min >= 8 && varying >= Math.min(samples, Math.max(8, Math.ceil(samples * 0.002))),
      };
    }, screenshot.toString('base64'));
    if (lastWitness.rendered) return screenshot;
    await page.waitForTimeout(250);
  }
  throw new Error(`sdk-selected-third-person-render-timeout: ${JSON.stringify(lastWitness)}`);
}

async function compareScreenshots(page, baseline, moved) {
  return page.evaluate(
    async ({ baselineBase64, movedBase64 }) => {
      const decode = (base64) =>
        new Promise((resolveImage, rejectImage) => {
          const image = new Image();
          image.onload = () => resolveImage(image);
          image.onerror = () => rejectImage(new Error('sdk-selected-screenshot-decode'));
          image.src = `data:image/png;base64,${base64}`;
        });
      const [before, after] = await Promise.all([decode(baselineBase64), decode(movedBase64)]);
      if (before.width !== after.width || before.height !== after.height) {
        throw new Error('sdk-selected-screenshot-size-changed');
      }
      const canvas = document.createElement('canvas');
      canvas.width = before.width;
      canvas.height = before.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('sdk-selected-screenshot-context');
      context.drawImage(before, 0, 0);
      const beforePixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(after, 0, 0);
      const afterPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let changed = 0;
      for (let offset = 0; offset < beforePixels.length; offset += 4) {
        const delta =
          Math.abs((beforePixels[offset] ?? 0) - (afterPixels[offset] ?? 0)) +
          Math.abs((beforePixels[offset + 1] ?? 0) - (afterPixels[offset + 1] ?? 0)) +
          Math.abs((beforePixels[offset + 2] ?? 0) - (afterPixels[offset + 2] ?? 0));
        if (delta > 24) changed += 1;
      }
      return changed / (canvas.width * canvas.height);
    },
    {
      baselineBase64: baseline.toString('base64'),
      movedBase64: moved.toString('base64'),
    },
  );
}

const selectedTemplateEvidence = await verifySelectedTemplate();
for (const expected of manifest.artifacts.filter((entry) => entry.path.startsWith('store/'))) {
  const actual = await artifact(sdkRoot, resolve(sdkRoot, expected.path));
  // pnpm 11's SQLite store index is a runtime cache, not package content. A
  // first offline install can update its journal/normalised metadata even
  // when every package file and integrity record remains unchanged. Keep the
  // immutable archive check for the store payloads, but do not reject that
  // expected consumer-side index hydration.
  if (expected.path.endsWith('/index.db')) continue;
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(`sdk-consumer-mutated-store: ${expected.path}`);
  }
}

async function verifySourceTemplate() {
  const sourceEnv = { ...offlineEnv, PATH: process.env.PATH ?? '' };
  delete sourceEnv.FORGEAX_SDK_ROOT;
  delete sourceEnv.npm_config_offline;
  const sourcePnpm = (args, options) =>
    execFileAsync('corepack', [sourcePackageManager, ...args], options);
  const sourceSmokeDir = resolve(unpackRoot, 'source-template-smoke');
  await sourcePnpm(['install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: sourceRoot,
    env: sourceEnv,
    maxBuffer: 128 * 1024 * 1024,
  });
  await sourcePnpm(['build:engine'], {
    cwd: sourceRoot,
    env: sourceEnv,
    maxBuffer: 128 * 1024 * 1024,
  });
  await sourcePnpm(['build:app', 'preview'], {
    cwd: sourceRoot,
    env: sourceEnv,
    maxBuffer: 128 * 1024 * 1024,
  });
  await sourcePnpm(['--filter', '@forgeax/preview', 'smoke:templates'], {
    cwd: sourceRoot,
    env: {
      ...sourceEnv,
      FORGEAX_TEMPLATE_SMOKE_DIR: sourceSmokeDir,
      FORGEAX_TEMPLATE_SMOKE_PORT: '5287',
      FORGEAX_TEMPLATE_SMOKE_SLUGS: SDK_TEMPLATES.map((entry) => basename(entry.sourceRoot)).join(
        ',',
      ),
    },
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(await readFile(resolve(sourceSmokeDir, 'report.json'), 'utf8'));
}

const sourceTemplateEvidence = await verifySourceTemplate();
for (const entry of SDK_TEMPLATES) {
  const slug = basename(entry.sourceRoot);
  const evidence = sourceTemplateEvidence.templates?.find((template) => template.slug === slug);
  if (
    evidence === undefined ||
    evidence.status !== 'passed' ||
    evidence.consoleErrors.length !== 0 ||
    evidence.pageErrors.length !== 0
  ) {
    throw new Error(`sdk-template-browser-errors:${slug}: ${JSON.stringify(evidence)}`);
  }
}
const result = {
  ok: true,
  archive,
  sha256: digest,
  sdkVersion: manifest.sdkVersion,
  engineCommit: manifest.engineCommit,
  capabilities: manifest.capabilities,
  source: manifest.source,
  offlineProject: project,
  projectTargetProtection: {
    code: forbiddenResult.error.code,
    sdkRoot,
    rejectedTarget: forbiddenProject,
  },
  projectLayout: {
    entry: projectManifest.entry,
    starterTest: 'src/__tests__/starter.test.ts',
    retiredRootPaths: ['main.ts', '__tests__'],
  },
  commands: ['new', 'skill.verify', 'doctor', 'test', 'build', 'dev', 'preview'],
  scriptablePack: {
    defaultSceneGuid,
    build: { packageUrl: defaultSceneEntry.packageUrl },
    dev: devEvidence,
  },
  selectedTemplate: selectedTemplateEvidence,
  sourceTemplate: sourceTemplateEvidence,
  staticBuild: {
    output: staticOutput,
    base: staticManifest.base,
    artifacts: staticManifest.artifacts.length,
  },
  previewUrl,
};
await writeFile(
  resolve(dirname(archive), 'sdk-verify-result.json'),
  `${JSON.stringify(result, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(result)}\n`);
