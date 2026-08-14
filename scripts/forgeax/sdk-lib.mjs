import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

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

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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

function tarHeader(path, bytes, mode) {
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
  header[156] = 0x30;
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

export async function normalizePackageArchive(path, execFileAsync) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-package-'));
  try {
    await execFileAsync('tar', ['-xzf', path, '-C', root]);
    const manifestPath = resolve(root, 'package', 'package.json');
    const manifest = stablePackageManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const blocks = [];
    for (const file of await filesUnder(root)) {
      const bytes = await readFile(file);
      const info = await lstat(file);
      const archivePath = relative(root, file).split(sep).join('/');
      const mode = (info.mode & 0o111) === 0 ? 0o644 : 0o755;
      blocks.push(tarHeader(archivePath, bytes, mode), bytes);
      const padding = (512 - (bytes.byteLength % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding));
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

export async function normalizePnpmStore(storeRoot) {
  const indexRoot = resolve(storeRoot, 'v10', 'index');
  for (const path of await filesUnder(indexRoot)) {
    if (!path.endsWith('.json')) continue;
    const value = stable(withoutVolatileStoreTime(JSON.parse(await readFile(path, 'utf8'))));
    await writeFile(path, `${JSON.stringify(value)}\n`);
  }
}
