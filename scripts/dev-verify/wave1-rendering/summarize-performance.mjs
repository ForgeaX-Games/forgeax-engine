#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const directory = resolve(process.argv[2] ?? 'artifacts/wave1-rendering');
const quantiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries(
    [
      ['p50', 0.5],
      ['p95', 0.95],
    ].map(([name, q]) => [name, sorted[Math.ceil((sorted.length - 1) * q)] / 1e6]),
  );
};
const runs = [];
const names = (await readdir(directory)).sort();
for (const name of names) {
  if (!name.endsWith('.json') && !name.endsWith('.json.gz')) continue;
  if (name.endsWith('.json') && names.includes(`${name}.gz`)) continue;
  const artifactBytes = await readFile(resolve(directory, name));
  const bytes = name.endsWith('.gz') ? gunzipSync(artifactBytes) : artifactBytes;
  const report = JSON.parse(bytes);
  if (report.performanceTiming === undefined) continue;
  const frames = report.performanceTiming.timingFrames.slice(120, 180);
  if (frames.length !== 60) throw new Error(`${name}: expected ordinals 121-180`);
  const union = [];
  const perPass = new Map();
  for (const frame of frames) {
    if (frame.droppedPassCount !== 0 || frame.executedPassCount !== frame.measuredPassCount) {
      throw new Error(`${name}: incomplete pass timing evidence`);
    }
    const intervals = frame.passes.map((pass) => [
      BigInt(pass.beginningTick),
      BigInt(pass.endTick),
    ]);
    intervals.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (intervals.length === 0) throw new Error(`${name}: empty timing frame`);
    let [begin, end] = intervals[0];
    let total = 0n;
    for (const [nextBegin, nextEnd] of intervals.slice(1)) {
      if (nextEnd < nextBegin) throw new Error(`${name}: reversed GPU interval`);
      if (nextBegin > end) {
        total += end - begin;
        begin = nextBegin;
        end = nextEnd;
      } else if (nextEnd > end) end = nextEnd;
    }
    union.push(Number(total + end - begin));
    for (const pass of frame.passes) {
      const values = perPass.get(pass.passName) ?? [];
      values.push(pass.durationNanoseconds);
      perPass.set(pass.passName, values);
    }
  }
  runs.push({
    file: name,
    decodedSha256: createHash('sha256').update(bytes).digest('hex'),
    artifactSha256: createHash('sha256').update(artifactBytes).digest('hex'),
    source: report.sourceSha,
    shaderIdentity: report.shaderIdentity,
    adapter: report.adapter,
    host: report.host,
    scene: report.sceneFixture,
    antialias: report.antialias,
    sampleFrames: 60,
    firstOrdinal: 121,
    lastOrdinal: 180,
    unionMs: quantiles(union),
    passIntervalMs: Object.fromEntries(
      [...perPass].map(([key, values]) => [key, quantiles(values)]),
    ),
    gpuErrors: report.uncapturedGpuErrors,
    errors: report.errorCodes,
  });
}
await writeFile(
  resolve(directory, 'performance-summary.json'),
  `${JSON.stringify(
    {
      method:
        'Union of raw GPU timestamp intervals, not additive or exclusive pass costs. Fixed ordinals 121-180; ceil((n-1)*q) percentile index.',
      runs,
    },
    null,
    2,
  )}\n`,
);
for (const run of runs) console.log(`${run.file}: ${JSON.stringify(run.unionMs)}`);
