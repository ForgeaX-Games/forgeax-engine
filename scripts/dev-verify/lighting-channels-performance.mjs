import { readFile, writeFile } from 'node:fs/promises';

const [referencePath, channelsPath, outputPath] = process.argv.slice(2);
if (!referencePath || !channelsPath || !outputPath)
  throw new Error(
    'Usage: node lighting-channels-performance.mjs <reference/raw.json> <channels/raw.json> <comparison.json>',
  );
const reference = JSON.parse(await readFile(referencePath, 'utf8'));
const channels = JSON.parse(await readFile(channelsPath, 'utf8'));
const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
const key = (row) => `${row.size}/${row.path}/${row.shadows}`;
const groups = (document) => Map.groupBy(document.windows, key);
const referenceGroups = groups(reference),
  channelGroups = groups(channels);
for (const field of [
  'cpu',
  'platform',
  'node',
  'nodeEnvironment',
  'ci',
  'adapter',
  'timestampQuery',
  'harnessSha256',
])
  if (JSON.stringify(reference.hardware[field]) !== JSON.stringify(channels.hardware[field]))
    throw new Error(`unmatched performance hardware: ${field}`);
for (const document of [reference, channels]) {
  if (document.rounds !== 3 || document.samples !== 60 || document.warmup !== 30)
    throw new Error('fixed performance window changed');
  for (const row of document.windows) {
    if (
      row.frames.length !== 60 ||
      row.frames.some(
        (frame) =>
          !Number.isFinite(frame.cpuMs) ||
          frame.cpuMs < 0 ||
          !Number.isFinite(frame.completedMs) ||
          frame.completedMs < frame.cpuMs,
      )
    )
      throw new Error(`incomplete CPU window: ${row.name}`);
  }
}
const comparisons = [];
for (const [workload, baseline] of referenceGroups) {
  if (baseline.length !== 3) throw new Error(`missing reference round: ${workload}`);
  if (new Set(baseline.map((row) => row.round)).size !== 3)
    throw new Error(`duplicate reference round: ${workload}`);
  const rows = channelGroups.get(workload);
  if (!rows || rows.length !== 9) throw new Error(`missing channel variant/round: ${workload}`);
  const cpuReference = percentile(
    baseline.flatMap((row) => row.frames.map((frame) => frame.cpuMs)),
    0.95,
  );
  const budgetMs = Math.max(cpuReference * 0.1, 0.1);
  const referenceFrames = baseline.flatMap((row) => row.frames);
  const hasOuter = (frames) =>
    frames.every((frame) => Number.isFinite(frame.nativeOuterNs) && frame.nativeOuterNs > 0);
  const nativeReferenceP95Ns = hasOuter(referenceFrames)
    ? percentile(
        referenceFrames.map((frame) => frame.nativeOuterNs),
        0.95,
      )
    : null;
  const nativeBudgetNs =
    nativeReferenceP95Ns === null ? null : Math.max(nativeReferenceP95Ns * 0.1, 100_000);
  const variants = [];
  for (const variant of ['default', 'all-match', 'sparse']) {
    const selected = rows.filter((row) => row.variant === variant);
    if (selected.length !== 3) throw new Error(`missing ${variant}: ${workload}`);
    if (new Set(selected.map((row) => row.round)).size !== 3)
      throw new Error(`duplicate ${variant} round: ${workload}`);
    const frames = selected.flatMap((row) => row.frames);
    const cpuP95 = percentile(
      frames.map((frame) => frame.cpuMs),
      0.95,
    );
    const gpuFrames = frames.filter(
      (frame) => frame.intervals !== null && frame.intervals.envelopeNanoseconds > 0,
    );
    const timingStatuses = Object.fromEntries(
      [...Map.groupBy(frames, (frame) => frame.timing?.status ?? 'missing')].map(
        ([status, group]) => [status, group.length],
      ),
    );
    const gcOverlap = frames.map((frame) =>
      (channels.gc ?? []).reduce(
        (sum, entry) =>
          sum +
          Math.max(
            0,
            Math.min(frame.began + frame.cpuMs, entry.began + entry.duration) -
              Math.max(frame.began, entry.began),
          ),
        0,
      ),
    );
    variants.push({
      variant,
      cpuP50: percentile(
        frames.map((frame) => frame.cpuMs),
        0.5,
      ),
      cpuP95,
      cpuDeltaMs: cpuP95 - cpuReference,
      cpuBudgetMs: budgetMs,
      cpuBudget:
        variant === 'sparse'
          ? 'not-applicable'
          : cpuP95 - cpuReference <= budgetMs
            ? 'PASS'
            : 'FAIL',
      completedP95: percentile(
        frames.map((frame) => frame.completedMs),
        0.95,
      ),
      gpuNonzeroFrames: gpuFrames.length,
      drawCpuP95: percentile(
        frames.map((frame) => frame.drawCpuMs),
        0.95,
      ),
      timingStatuses,
      gcDiagnostic:
        channels.gc === undefined
          ? null
          : {
              framesWithGc: gcOverlap.filter((duration) => duration > 0).length,
              overlapP95Ms: percentile(gcOverlap, 0.95),
              policy: 'diagnostic only; full CPU samples and frozen budget are unchanged',
            },
      gpuEnvelopeP95Ns:
        gpuFrames.length === frames.length
          ? percentile(
              gpuFrames.map((frame) => frame.intervals.envelopeNanoseconds),
              0.95,
            )
          : null,
      gpuIntervals:
        gpuFrames.length === frames.length
          ? Object.fromEntries(
              [
                'sumNanoseconds',
                'unionNanoseconds',
                'overlapNanoseconds',
                'envelopeNanoseconds',
              ].map((field) => [
                field,
                {
                  p50: percentile(
                    gpuFrames.map((frame) => frame.intervals[field]),
                    0.5,
                  ),
                  p95: percentile(
                    gpuFrames.map((frame) => frame.intervals[field]),
                    0.95,
                  ),
                },
              ]),
            )
          : null,
      nativeOuterNonzeroFrames: frames.filter(
        (frame) => Number.isFinite(frame.nativeOuterNs) && frame.nativeOuterNs > 0,
      ).length,
      nativeOuterP50Ns: hasOuter(frames)
        ? percentile(
            frames.map((frame) => frame.nativeOuterNs),
            0.5,
          )
        : null,
      nativeOuterP95Ns: hasOuter(frames)
        ? percentile(
            frames.map((frame) => frame.nativeOuterNs),
            0.95,
          )
        : null,
      nativeOuterBudgetNs: nativeBudgetNs,
      nativeOuterBudget:
        variant === 'sparse'
          ? 'not-applicable'
          : nativeReferenceP95Ns === null || nativeBudgetNs === null || !hasOuter(frames)
            ? 'unavailable'
            : percentile(
                  frames.map((frame) => frame.nativeOuterNs),
                  0.95,
                ) -
                  nativeReferenceP95Ns <=
                nativeBudgetNs
              ? 'PASS'
              : 'FAIL',
      rounds: selected.map((row) => ({
        round: row.round,
        cpuP50: row.cpuP50,
        cpuP95: row.cpuP95,
        gpuEnvelopeP95Ns: row.gpuEnvelopeP95Ns,
        processMemory: row.processMemory,
        hostLoadAverage: row.hostLoadAverage ?? null,
        inspection: row.inspection,
        ownerPhases: row.profile.phases,
        profileCompleteness: row.profile.completeness,
      })),
    });
  }
  comparisons.push({ workload, cpuReferenceP95: cpuReference, nativeReferenceP95Ns, variants });
}
if (comparisons.length !== 8 || channelGroups.size !== referenceGroups.size)
  throw new Error('fixed workload roster changed');
const cpuBudget = comparisons.some((row) =>
  row.variants.some((variant) => variant.cpuBudget === 'FAIL'),
)
  ? 'FAIL'
  : 'PASS';
const nativeOuterBudget = comparisons.some((row) =>
  row.variants.some((variant) => variant.nativeOuterBudget === 'FAIL'),
)
  ? 'FAIL'
  : comparisons.some((row) =>
        row.variants.some((variant) => variant.nativeOuterBudget === 'unavailable'),
      )
    ? 'unavailable'
    : 'PASS';
await writeFile(
  outputPath,
  JSON.stringify(
    {
      reference: referencePath,
      channels: channelsPath,
      hardware: { reference: reference.hardware, channels: channels.hardware },
      acceptance: {
        cpuBudget,
        nativeOuterBudget,
      },
      accounting:
        'Pass interval sum, union, overlap and envelope remain in the raw frames. Envelope is not native outer timing. Zero/unavailable queries are not GPU speedups.',
      comparisons,
    },
    null,
    2,
  ),
);
if (cpuBudget === 'FAIL' || nativeOuterBudget === 'FAIL') process.exitCode = 1;
