import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

export const SDK_MANIFEST_VERSION = '1.6.0';
export const SDK_SOURCE_ROOT = 'source/engine';
export const SDK_SOURCE_FORMAT = 'git-archive-public-snapshot';
export const SDK_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'empty', sourceRoot: 'templates/game-empty', default: true }),
  Object.freeze({ id: 'game-3d', sourceRoot: 'templates/game-3d', default: false }),
]);
export const SDK_SOURCE_EXCLUDED_PATHS = Object.freeze(['.gitmodules', 'forgeax-engine-assets']);
export const SDK_RETIRED_PACKAGE_FILES = Object.freeze({
  '@forgeax/engine-vite-plugin-pack': Object.freeze([
    'dist/runtime.d.ts',
    'dist/runtime.d.ts.map',
    'dist/runtime.mjs',
    'dist/runtime.mjs.map',
  ]),
});
// This is the only non-code resource closure copied from the contributor
// checkout into the public source snapshot. Keep paths relative to the Engine
// source root and built package root; never add a private repository path.
export const SDK_RESOURCE_ALLOWLIST = Object.freeze([
  Object.freeze({
    id: 'preview-canonical-kit',
    package: '@forgeax/engine-preview',
    sourceRoot: 'packages/preview/assets/canonical-kit',
    packageRoot: 'assets/canonical-kit',
    files: Object.freeze(['cook-receipt.json', 'sky.hdr', 'sky.hdr.meta.json']),
  }),
]);
// SDK templates are source-complete. game-3d generates every asset from
// ScriptablePack authoring sources, so no contributor-only template resource
// closure is copied into either the ZIP or public source snapshot.
export const SDK_TEMPLATE_RESOURCE_ALLOWLIST = Object.freeze([]);
export const SDK_SOURCE_WASM = Object.freeze([
  Object.freeze({
    package: '@forgeax/engine-wgpu-wasm',
    root: 'packages/wgpu-wasm/pkg',
    files: Object.freeze([
      'package.json',
      'provenance.json',
      'README.md',
      'wgpu_wasm.d.ts',
      'wgpu_wasm.js',
      'wgpu_wasm_bg.wasm',
      'wgpu_wasm_bg.wasm.d.ts',
    ]),
  }),
  Object.freeze({
    package: '@forgeax/engine-fbx',
    root: 'packages/fbx/pkg',
    files: Object.freeze(['fbx-wasm.mjs', 'fbx-wasm.wasm']),
  }),
  Object.freeze({
    package: '@forgeax/engine-codec',
    root: 'packages/codec/pkg',
    files: Object.freeze([
      'basis_transcoder.mjs',
      'basis_transcoder.wasm',
      'encode/basis_encoder.mjs',
      'encode/basis_encoder.wasm',
    ]),
  }),
]);

export const SDK_CAPABILITIES = Object.freeze([
  'app',
  'render',
  'assets',
  'shader',
  'physics',
  'audio',
  'vfx',
  'ui',
  'debug',
]);

export function sdkResourceManifest() {
  return SDK_RESOURCE_ALLOWLIST.map(
    ({ id, package: packageName, sourceRoot, packageRoot, files }) => ({
      id,
      package: packageName,
      sourceRoot,
      packageRoot,
      files: [...files],
    }),
  );
}

export function sdkTemplateResourceManifest() {
  return SDK_TEMPLATE_RESOURCE_ALLOWLIST.map(({ id, destinationRoot, files }) => ({
    id,
    root: destinationRoot,
    files: [...files],
  }));
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertNoRetiredPackageFiles(packageName, files) {
  const retired = SDK_RETIRED_PACKAGE_FILES[packageName] ?? [];
  const normalized = new Set(files.map((path) => path.replace(/^package\//, '')));
  const leaked = retired.filter((path) => normalized.has(path));
  if (leaked.length > 0) {
    throw new Error(`sdk-retired-package-file: ${packageName}: ${leaked.join(', ')}`);
  }
}

export async function filesUnder(root, directory = root) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const info = await lstat(path);
    if (info.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (info.isFile()) files.push(path);
    else if (info.isSymbolicLink()) throw new Error(`sdk-symlink-not-portable: ${path}`);
  }
  return files;
}

export async function artifact(root, path) {
  const bytes = await readFile(path);
  return {
    path: relative(root, path).split(sep).join('/'),
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

export function streamFile(path, response) {
  createReadStream(path).pipe(response);
}

export async function fetchWithRetry(input, init, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((accept) => setTimeout(accept, attempt * 250));
      }
    }
  }
  throw lastError;
}

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function stablePackageManifest(manifest) {
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const value = manifest[section];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    manifest[section] = Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return manifest;
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function writeString(header, offset, width, value) {
  header.write(value, offset, Math.min(width, Buffer.byteLength(value)), 'utf8');
}

function tarHeader(path, bytes, mode, type = '0') {
  const segments = path.split('/');
  let name = path;
  const prefixSegments = [];
  while (Buffer.byteLength(name) > 100 && segments.length > 1) {
    prefixSegments.push(segments.shift());
    name = segments.join('/');
  }
  const prefix = prefixSegments.join('/');
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
    throw new Error(`sdk-package-path-too-long: ${path}`);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeString(header, 100, 8, octal(mode, 8));
  writeString(header, 108, 8, octal(0, 8));
  writeString(header, 116, 8, octal(0, 8));
  writeString(header, 124, 12, octal(bytes.byteLength, 12));
  writeString(header, 136, 12, octal(499_162_500, 12));
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function paxPathRecord(path) {
  const body = ` path=${path}\n`;
  let length = Buffer.byteLength(body) + 2;
  for (;;) {
    const record = `${length}${body}`;
    const bytes = Buffer.from(record);
    if (bytes.byteLength === length) return bytes;
    length = bytes.byteLength;
  }
}

function appendTarEntry(blocks, header, bytes) {
  blocks.push(header, bytes);
  const padding = (512 - (bytes.byteLength % 512)) % 512;
  if (padding > 0) blocks.push(Buffer.alloc(padding));
}

export async function normalizePackageArchive(path, execFileAsync, options = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-package-'));
  try {
    await execFileAsync('tar', ['-xzf', path, '-C', root]);
    const manifestPath = resolve(root, 'package', 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (options.releaseVersion !== undefined) {
      manifest.version = options.releaseVersion;
      for (const section of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]) {
        const dependencies = manifest[section];
        if (
          dependencies === null ||
          typeof dependencies !== 'object' ||
          Array.isArray(dependencies)
        )
          continue;
        for (const name of Object.keys(dependencies)) {
          if (name === '@forgeax/engine-runtime' || name.startsWith('@forgeax/engine-')) {
            dependencies[name] = options.releaseVersion;
          }
        }
      }
    }
    stablePackageManifest(manifest);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const blocks = [];
    let fileIndex = 0;
    for (const file of await filesUnder(root)) {
      const bytes = await readFile(file);
      const info = await lstat(file);
      const archivePath = relative(root, file).split(sep).join('/');
      const mode = (info.mode & 0o111) === 0 ? 0o644 : 0o755;
      try {
        appendTarEntry(blocks, tarHeader(archivePath, bytes, mode), bytes);
      } catch (cause) {
        if (!(cause instanceof Error) || !cause.message.startsWith('sdk-package-path-too-long:')) {
          throw cause;
        }
        const pax = paxPathRecord(archivePath);
        appendTarEntry(blocks, tarHeader(`PaxHeaders/${fileIndex}`, pax, 0o644, 'x'), pax);
        appendTarEntry(blocks, tarHeader(`package/.pax-${fileIndex}`, bytes, mode), bytes);
      }
      fileIndex += 1;
    }
    blocks.push(Buffer.alloc(1024));
    const compressed = gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
    compressed[9] = 0xff;
    await writeFile(path, compressed);
    await chmod(path, 0o644);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function withoutVolatileStoreTime(value) {
  if (Array.isArray(value)) return value.map(withoutVolatileStoreTime);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'checkedAt' ? 0 : withoutVolatileStoreTime(child),
    ]),
  );
}

function containsStoreDiff(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value === null || typeof value !== 'object') return true;
  return Object.values(value).some(containsStoreDiff);
}

function withoutEmptySideEffects(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const sideEffects = value.sideEffects;
  if (sideEffects === null || typeof sideEffects !== 'object' || Array.isArray(sideEffects)) {
    return value;
  }
  const retained = Object.fromEntries(
    Object.entries(sideEffects).filter(([, diff]) => containsStoreDiff(diff)),
  );
  if (Object.keys(retained).length === 0) {
    const { sideEffects: _emptySideEffects, ...withoutSideEffects } = value;
    return withoutSideEffects;
  }
  return { ...value, sideEffects: retained };
}

export async function normalizePnpmStore(storeRoot, storeFormat = 'v11') {
  const indexRoot = resolve(storeRoot, storeFormat, 'index');
  let indexFiles;
  try {
    indexFiles = await filesUnder(indexRoot);
  } catch (cause) {
    if (
      cause === null ||
      typeof cause !== 'object' ||
      !('code' in cause) ||
      cause.code !== 'ENOENT'
    ) {
      throw cause;
    }
    // pnpm 11 replaces the JSON index directory with a SQLite index.db.
    // Its binary page layout is owned by pnpm; do not rewrite it in place.
    await readFile(resolve(storeRoot, storeFormat, 'index.db'));
    return;
  }
  for (const path of indexFiles) {
    if (!path.endsWith('.json')) continue;
    const value = stable(
      withoutEmptySideEffects(withoutVolatileStoreTime(JSON.parse(await readFile(path, 'utf8')))),
    );
    await writeFile(path, `${JSON.stringify(value)}\n`);
  }
}
