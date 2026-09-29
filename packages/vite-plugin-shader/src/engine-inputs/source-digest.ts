import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Records which engine WGSL sources produced a packaged shader profile. */
export const PACKAGED_SOURCE_RECORD = 'source.json';

export interface PackagedSourceRecord {
  readonly shaderSourceDigest: string;
}

function collectWgsl(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectWgsl(path, files);
    else if (entry.isFile() && entry.name.endsWith('.wgsl')) files.push(path);
  }
}

/**
 * SHA-256 over every `*.wgsl` under `root`, keyed by POSIX-relative path so the
 * producer and any consumer checkout agree. `undefined` when `root` holds no
 * WGSL, i.e. there is no source to compare against.
 */
export function engineShaderSourceDigest(root: string): string | undefined {
  const files: string[] = [];
  try {
    collectWgsl(root, files);
  } catch {
    return undefined;
  }
  if (files.length === 0) return undefined;
  const hash = createHash('sha256');
  const rows = files.map((path) => [relative(root, path).split(sep).join('/'), path] as const);
  rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  for (const [name, path] of rows) {
    hash.update(name).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}
