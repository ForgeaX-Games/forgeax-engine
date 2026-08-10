#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function normalizedRelativePath(root, path) {
  const value = relative(root, path).split(sep).join('/');
  if (value === '..' || value.startsWith('../'))
    throw new Error(`fingerprint input escapes root: ${path}`);
  return value || '.';
}

function collectEntries(root, inputPath, entries) {
  const absolutePath = resolve(root, inputPath);
  const path = normalizedRelativePath(root, absolutePath);
  const stat = lstatSync(absolutePath);
  if (stat.isDirectory()) {
    entries.set(path, { kind: 'directory', path, value: Buffer.alloc(0) });
    for (const child of readdirSync(absolutePath))
      collectEntries(root, resolve(absolutePath, child), entries);
    return;
  }
  if (stat.isSymbolicLink()) {
    entries.set(path, { kind: 'symlink', path, value: Buffer.from(readlinkSync(absolutePath)) });
    return;
  }
  if (!stat.isFile()) throw new Error(`unsupported fingerprint input: ${absolutePath}`);
  entries.set(path, { kind: 'file', path, value: readFileSync(absolutePath) });
}

function updateField(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash.update(String(bytes.length));
  hash.update(':');
  hash.update(bytes);
  hash.update('\0');
}

export function fingerprintEntries(entries) {
  const hash = createHash('sha256');
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    updateField(hash, entry.kind);
    updateField(hash, entry.path);
    updateField(hash, entry.value);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function fingerprintFiles(rootPath, inputPaths) {
  const root = resolve(rootPath);
  const entries = new Map();
  for (const inputPath of inputPaths) collectEntries(root, inputPath, entries);
  return fingerprintEntries(entries.values());
}

export function fingerprintValue(value) {
  return fingerprintEntries([
    { kind: 'value', path: 'canonical.json', value: Buffer.from(JSON.stringify(value)) },
  ]);
}

export function isFingerprint(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  if (rootIndex === -1 || !args[rootIndex + 1])
    throw new Error('usage: fingerprint.mjs --root <root> <path>...');
  const root = args[rootIndex + 1];
  const paths = args.filter((_, index) => index !== rootIndex && index !== rootIndex + 1);
  if (paths.length === 0) throw new Error('at least one fingerprint path is required');
  process.stdout.write(`${fingerprintFiles(root, paths)}\n`);
}
