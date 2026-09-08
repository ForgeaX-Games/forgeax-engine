import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function findWebkitRoot(root) {
  const start = resolve(root);
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (entry.isFile() && entry.name === 'real-capture-manifest.json') return dirname(candidate);
      if (entry.isDirectory()) {
        const found = walk(candidate);
        if (found !== null) return found;
      }
    }
    return null;
  }
  const found = walk(start);
  if (found === null)
    throw new Error(`WebKit artifact has no real-capture-manifest.json under ${start}`);
  return found;
}

export function mergeDirectoryContents(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (existsSync(to)) throw new Error(`corpus merge collision at ${to}`);
    cpSync(from, to, { recursive: entry.isDirectory() });
  }
}

export function findShardArtifactDirectories(root, shardCount) {
  const shards = new Map();
  for (const entry of readdirSync(resolve(root), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(
      /^deferred-membership-real-corpus-shard-(\d+)-a\d+(?:-retry-\d+-a\d+)?$/,
    );
    if (match === null) continue;
    const shardIndex = Number(match[1]);
    if (shardIndex >= shardCount)
      throw new Error(`unexpected deferred membership shard artifact index ${shardIndex}`);
    if (shards.has(shardIndex))
      throw new Error(`duplicate deferred membership shard artifact index ${shardIndex}`);
    shards.set(shardIndex, join(resolve(root), entry.name));
  }
  const missing = Array.from({ length: shardCount }, (_, index) => index).filter(
    (index) => !shards.has(index),
  );
  if (missing.length > 0)
    throw new Error(`missing deferred membership shard artifacts: ${missing.join(', ')}`);
  return Array.from({ length: shardCount }, (_, index) => shards.get(index));
}
