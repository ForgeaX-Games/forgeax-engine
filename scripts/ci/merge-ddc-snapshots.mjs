#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const snapshotsDir = resolve(value('--snapshots-dir') ?? 'ddc-snapshots');
const outputDir = resolve(value('--out-dir') ?? 'ddc-merged');
const shardCount = Number(value('--shard-count') ?? 3);
const cacheHit = process.argv.includes('--cache-hit');

function fail(code, detail = {}) {
  process.stdout.write(`${JSON.stringify({ code, ...detail })}\n`);
  process.exit(1);
}

if (!Number.isInteger(shardCount) || shardCount < 1) {
  fail('ci-ddc-shard-count-invalid', { shardCount });
}

// A cache hit keeps the restored output intact. A miss owns the generated
// directory, so clear it before collecting snapshots and cannot retain stale
// entries when a later run is partial.
if (!cacheHit) rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
let availableSnapshots = 0;
const snapshotSources = [];
const entryOwners = new Map();
if (!cacheHit) {
  for (let index = 0; index < shardCount; index++) {
    const source = join(snapshotsDir, String(index));
    if (!existsSync(source)) continue;
    availableSnapshots++;
    let sourceEntries;
    try {
      sourceEntries = readdirSync(source, { withFileTypes: true });
    } catch {
      fail('ci-ddc-snapshot-shard-invalid', { shard: index });
    }
    const entriesDirectory = join(source, 'entries');
    const entryDirectories = existsSync(entriesDirectory)
      ? readdirSync(entriesDirectory, { withFileTypes: true })
      : [];
    for (const entry of entryDirectories) {
      if (!entry.isDirectory()) {
        fail('ci-ddc-snapshot-entry-invalid', { shard: index, entry: entry.name });
      }
      const owner = entryOwners.get(entry.name);
      if (owner !== undefined) {
        fail('ci-ddc-snapshot-entry-duplicate', {
          entry: entry.name,
          shards: [owner, index],
        });
      }
      const entryPath = join(entriesDirectory, entry.name);
      const missing = ['receipt.json', 'integrity.json'].filter(
        (file) => !existsSync(join(entryPath, file)),
      );
      if (missing.length > 0) {
        fail('ci-ddc-snapshot-entry-incomplete', {
          shard: index,
          entry: entry.name,
          missing,
        });
      }
      entryOwners.set(entry.name, index);
    }
    snapshotSources.push({ index, source, sourceEntries });
  }

  for (const { source, sourceEntries } of snapshotSources) {
    for (const entry of sourceEntries) {
      if (entry.name === 'entries' || /^(?:staging|lease|attempt|head)$/.test(entry.name)) continue;
      if (entry.name === 'ddc-warm-status.json') continue;
      cpSync(join(source, entry.name), join(outputDir, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }
  for (const { source } of snapshotSources) {
    const entriesDirectory = join(source, 'entries');
    if (!existsSync(entriesDirectory)) continue;
    for (const entry of readdirSync(entriesDirectory).sort()) {
      cpSync(join(entriesDirectory, entry), join(outputDir, 'entries', entry), {
        recursive: true,
        force: false,
      });
    }
  }
}
const status = {
  outcome: cacheHit ? 'skipped' : availableSnapshots === shardCount ? 'saved' : 'partial',
  availableSnapshots,
  shardCount,
  nextRunWouldHit: cacheHit || availableSnapshots === shardCount,
};
writeFileSync(join(outputDir, 'ddc-warm-status.json'), JSON.stringify(status, null, 2));
process.stdout.write(`${JSON.stringify(status)}\n`);
