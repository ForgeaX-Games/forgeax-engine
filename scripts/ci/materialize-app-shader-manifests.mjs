#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function fail(code, detail) {
  process.stdout.write(`${JSON.stringify({ code, ...detail })}\n`);
  process.exit(1);
}

const root = resolve(argument('--root', '.'));
const requestedSharedInputManifest = argument(
  '--shared-input-manifest',
  'shared-app-inputs/manifest.json',
);
const requestedSharedInputManifestPath = resolve(root, requestedSharedInputManifest);
// A single artifact downloaded to `--path .` is intentionally extracted at the
// archive's common root (`manifest.json`, `shaders/...`). App-shard downloads
// use `--path shared-app-inputs` and retain the producer directory. Accept both
// layouts so consumers do not need a second artifact transfer just to restore
// a projection file.
const sharedInputManifestCandidates = [
  requestedSharedInputManifestPath,
  resolve(root, 'manifest.json'),
].filter((path, index, paths) => paths.indexOf(path) === index);
const sharedInputManifestPath = sharedInputManifestCandidates.find((path) => existsSync(path));
if (!sharedInputManifestPath) {
  fail('ci-app-shader-manifest-shared-input-missing', {
    manifest: requestedSharedInputManifest,
    candidates: sharedInputManifestCandidates.map((path) => relative(root, path)),
  });
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(sharedInputManifestPath, 'utf8'));
} catch {
  fail('ci-app-shader-manifest-shared-input-invalid', {
    manifest: relative(root, sharedInputManifestPath),
    expected: 'valid JSON in the shared-app-inputs manifest',
  });
}

const sourceRelative = manifest?.payload?.engineShaderManifest;
if (
  manifest?.schemaVersion !== 1 ||
  manifest?.producer !== 'shared-app-inputs' ||
  typeof sourceRelative !== 'string'
) {
  fail('ci-app-shader-manifest-shared-input-invalid', {
    manifest: relative(root, sharedInputManifestPath),
    expected: 'catalog-only shared-app-inputs manifest with engineShaderManifest',
  });
}
const sourceCandidates = [
  resolve(root, sourceRelative),
  // When the archive is extracted at `.`, the producer's common directory is
  // stripped from every path. The manifest keeps its producer-relative path,
  // so resolve the same payload relative to the extracted manifest directory.
  resolve(dirname(sharedInputManifestPath), sourceRelative.replace(/^shared-app-inputs\//, '')),
].filter((path, index, paths) => paths.indexOf(path) === index);
const source = sourceCandidates.find((path) => existsSync(path));
const sourceRoot = source ? relative(root, source).split('\\').join('/') : '';
if (
  !source ||
  sourceRoot.length === 0 ||
  sourceRoot === '..' ||
  sourceRoot.startsWith('../') ||
  sourceRoot.includes('/../') ||
  !existsSync(source)
) {
  fail('ci-app-shader-manifest-shared-input-missing', {
    manifest: relative(root, sharedInputManifestPath),
    expected: 'engine shader manifest contained by the repository root',
  });
}

if (relative(root, sharedInputManifestPath).split('\\').join('/') === 'manifest.json') {
  // Read-only consumers download the combined artifact at `.`, so upload-artifact
  // strips the producer directory. Restore the contract path locally without
  // downloading the shared archive a second time.
  const canonicalManifest = join(root, 'shared-app-inputs', 'manifest.json');
  const canonicalShaderManifest = join(root, 'shared-app-inputs', 'shaders', 'manifest.json');
  mkdirSync(dirname(canonicalManifest), { recursive: true });
  mkdirSync(dirname(canonicalShaderManifest), { recursive: true });
  cpSync(sharedInputManifestPath, canonicalManifest);
  cpSync(source, canonicalShaderManifest);
  // The combined artifact is extracted at the repository root for read-only
  // consumers. Its root manifest is only the transport entry point; the
  // canonical copy above is the contract path and keeps the generated file
  // outside repository-wide source checks such as Biome.
  unlinkSync(sharedInputManifestPath);
}

function appDistDirectories(directory, relativeDirectory = '') {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const next = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const manifestPath = join(directory, entry.name, 'package.json');
    if (existsSync(manifestPath)) {
      let packageManifest;
      try {
        packageManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        continue;
      }
      if (typeof packageManifest.scripts?.build === 'string') {
        const dist = join(directory, entry.name, 'dist');
        // The shard transfer inventory can contain only Pack carriers. When an
        // app has no carrier of its own, its dist directory is absent even
        // though its smoke still reads the shared shader manifest. Discover
        // from the source package roster so that a projection-only app is not
        // silently skipped.
        result.push({ dist, app: next });
        continue;
      }
    }
    result.push(...appDistDirectories(join(directory, entry.name), next));
  }
  return result;
}

const appsRoot = join(root, 'apps');
if (!existsSync(appsRoot)) fail('ci-app-shader-manifest-apps-missing', { appsRoot });

const materialized = [];
for (const { dist, app } of appDistDirectories(appsRoot)) {
  const target = join(dist, 'shaders', 'manifest.json');
  if (existsSync(target)) continue;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target);
  materialized.push({ app, path: relative(root, target).split('\\').join('/') });
}

materialized.sort((left, right) => left.path.localeCompare(right.path));
process.stdout.write(
  `${JSON.stringify({ status: 'success', source: sourceRoot, materialized })}\n`,
);
