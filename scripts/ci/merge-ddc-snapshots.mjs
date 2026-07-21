#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function value(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const snapshotsDir = resolve(value('--snapshots-dir') ?? 'ddc-snapshots');
const outputDir = resolve(value('--out-dir') ?? 'ddc-merged');
const shardCount = Number(value('--shard-count') ?? 3);
const cacheHit = process.argv.includes('--cache-hit');
mkdirSync(outputDir, { recursive: true });
let availableSnapshots = 0;
if (!cacheHit) {
  for (let index = 0; index < shardCount; index++) {
    const source = join(snapshotsDir, String(index));
    if (!existsSync(source)) continue;
    availableSnapshots++;
    for (const entry of readdirSync(source)) {
      cpSync(join(source, entry), join(outputDir, entry), { recursive: true, force: true });
    }
  }
}
const status = {
  outcome: cacheHit ? 'skipped' : availableSnapshots === shardCount ? 'saved' : 'partial',
  availableSnapshots,
  shardCount,
  nextRunWouldHit: cacheHit || availableSnapshots > 0,
};
writeFileSync(join(outputDir, 'ddc-warm-status.json'), JSON.stringify(status, null, 2));
process.stdout.write(`${JSON.stringify(status)}\n`);
