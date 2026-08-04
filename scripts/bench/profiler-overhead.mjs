import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';

const GROUP_COUNT = 5;
const WARMUP_FRAMES = 30;
const FRAMES_PER_GROUP = 2000;
const EVENT_LIMIT = FRAMES_PER_GROUP * 10;
const THRESHOLD_PERCENT = 1;
const QUANTILE = 0.95;
const FORMULA = '(p95On - p95Off) / p95Off * 100';

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function invalid(path, message) {
  return { ok: false, error: { path, message } };
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function nearestRankP95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(QUANTILE * sorted.length) - 1] ?? null;
}

export function validateOverheadReport(value) {
  if (!isRecord(value)) return invalid('', 'report must be an object');
  if (value.benchmark !== 'profiler-overhead-d6') {
    return invalid('/benchmark', 'report must identify the D-6 profiler overhead benchmark');
  }
  if (value.backend !== 'rhi-null' || value.workload !== 'deterministic-app-render') {
    return invalid('/workload', 'report must use the deterministic rhi-null App+Render workload');
  }
  if (
    value.warmupFrames !== WARMUP_FRAMES ||
    value.groups !== GROUP_COUNT ||
    value.framesPerGroup !== FRAMES_PER_GROUP
  ) {
    return invalid('/windows', 'report must use the D-6 warm-up and interleaved sample window');
  }
  if (!isRecord(value.environment))
    return invalid('/environment', 'environment metadata is required');
  if (!isRecord(value.quantile)) return invalid('/quantile', 'quantile metadata is required');
  if (
    value.quantile.method !== 'nearest-rank' ||
    value.quantile.percentile !== QUANTILE ||
    value.quantile.indexFormula !== 'sorted[ceil(0.95*n)-1]'
  ) {
    return invalid('/quantile', 'frame-duration p95 must use nearest-rank');
  }
  if (!isRecord(value.windows) || !isRecord(value.windows.off) || !isRecord(value.windows.on)) {
    return invalid('/windows', 'off and on sample windows are required');
  }
  const expectedSamples = GROUP_COUNT * FRAMES_PER_GROUP;
  for (const mode of ['off', 'on']) {
    const window = value.windows[mode];
    if (window.samples !== expectedSamples || !Number.isFinite(window.p95FrameDurationMicros)) {
      return invalid(
        `/windows/${mode}`,
        'each window must report its samples and frame-duration p95',
      );
    }
  }
  if (!isRecord(value.overhead))
    return invalid('/overhead', 'overhead formula evidence is required');
  if (value.overhead.formula !== FORMULA) return invalid('/overhead/formula', 'formula is not D-6');
  if (
    !Number.isFinite(value.overhead.increasePercent) ||
    value.overhead.increasePercent > THRESHOLD_PERCENT
  ) {
    return invalid(
      '/overhead/increasePercent',
      'p95 frame-duration overhead must be at most one percent',
    );
  }
  if (value.overhead.thresholdPercent !== THRESHOLD_PERCENT || value.overhead.verdict !== 'pass') {
    return invalid(
      '/overhead/verdict',
      'the threshold verdict must pass without changing the threshold',
    );
  }
  if (!isRecord(value.allocation)) return invalid('/allocation', 'allocation evidence is required');
  if (
    value.allocation.owner !== 'profiler-owned' ||
    value.allocation.profilerEventObjectAllocations !== 0
  ) {
    return invalid(
      '/allocation/profilerEventObjectAllocations',
      'profiler-off allocation count must be zero',
    );
  }
  if (!isRecord(value.phaseCatalog) || !isRecord(value.phaseCatalog.relation)) {
    return invalid('/phaseCatalog', 'phase catalog relation evidence is required');
  }
  if (
    value.phaseCatalog.relation.status !== 'pass' ||
    !equalJson(value.phaseCatalog.relation.expected, value.phaseCatalog.relation.actual)
  ) {
    return invalid('/phaseCatalog/relation', 'owner and profiler phase catalogs must be equal');
  }
  if (!isRecord(value.overflow) || value.overflow.bounded !== true) {
    return invalid('/overflow', 'bounded overflow evidence is required');
  }
  if (value.verdict !== 'pass')
    return invalid('/verdict', 'the overall benchmark verdict must pass');
  return { ok: true, value };
}

function makeCanvas() {
  return {
    width: 64,
    height: 64,
    getContext() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function makeShaderManifest() {
  return `data:application/json,${encodeURIComponent(
    JSON.stringify({
      schemaVersion: '1.0.0',
      entries: [
        { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
        { hash: 'tonemap0', wgsl: '/* tonemap stub */', glsl: '', bindings: '' },
      ],
    }),
  )}`;
}

function makeScheduler() {
  let pending;
  let nextRequestId = 1;
  let timestamp = 0;
  return {
    requestAnimationFrame(callback) {
      pending = callback;
      return nextRequestId++;
    },
    cancelAnimationFrame() {
      pending = undefined;
    },
    pump() {
      if (pending === undefined) throw new Error('benchmark frame was not scheduled');
      const callback = pending;
      pending = undefined;
      const start = performance.now();
      timestamp += 16;
      callback(timestamp);
      return (performance.now() - start) * 1000;
    },
  };
}

async function createWorkload() {
  const [
    { Camera },
    { World },
    { createApp },
    { rhi },
    { createRenderer },
    { createProfiler },
    { registerPropagateTransforms, Transform },
  ] = await Promise.all([
    import('@forgeax/engine-render'),
    import('@forgeax/engine-ecs'),
    import('@forgeax/engine-app'),
    import('@forgeax/engine-rhi-null'),
    import('@forgeax/engine-runtime'),
    import('@forgeax/engine-profiler'),
    import('@forgeax/engine-scene'),
  ]);
  const allocationReport = { profilerEventObjectAllocations: 0 };
  const profiler = createProfiler({ allocationReport });
  const renderer = await createRenderer(
    makeCanvas(),
    { rhi, profiler },
    { shaderManifestUrl: makeShaderManifest() },
  );
  const ready = await renderer.ready;
  if (!ready.ok) throw new Error(`rhi-null renderer was not ready: ${ready.error.code}`);
  const world = new World();
  registerPropagateTransforms(world);
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: { fov: 60, near: 0.1, far: 1000, tonemap: 4 } },
  );
  const appResult = await createApp({ renderer, world, profiler });
  if (!appResult.ok) throw new Error(`App workload failed to assemble: ${appResult.error.code}`);
  return { app: appResult.value, allocationReport, profiler };
}

function installScheduler(scheduler) {
  globalThis.requestAnimationFrame = scheduler.requestAnimationFrame;
  globalThis.cancelAnimationFrame = scheduler.cancelAnimationFrame;
}

async function runBenchmark() {
  const scheduler = makeScheduler();
  installScheduler(scheduler);
  const { app, allocationReport, profiler } = await createWorkload();
  const warmupDurations = [];
  expectStart(app);
  for (let index = 0; index < WARMUP_FRAMES; index += 1) {
    warmupDurations.push(scheduler.pump());
  }

  const offDurations = [];
  const onDurations = [];
  let onAllocationCount = 0;
  let lastOverflow;
  for (let group = 0; group < GROUP_COUNT; group += 1) {
    for (let index = 0; index < FRAMES_PER_GROUP; index += 1) {
      offDurations.push(scheduler.pump());
    }
    const allocationBefore = allocationReport.profilerEventObjectAllocations;
    const started = profiler.startCapture({
      frameLimit: FRAMES_PER_GROUP,
      eventLimit: EVENT_LIMIT,
    });
    if (!started.ok) throw new Error(`profiler capture failed: ${started.error.code}`);
    const groupDurations = [];
    for (let index = 0; index < FRAMES_PER_GROUP; index += 1) {
      const duration = scheduler.pump();
      onDurations.push(duration);
      groupDurations.push(duration);
    }
    const capture = started.value.finish();
    if (!capture.ok) throw new Error(`profiler capture did not finish: ${capture.error.code}`);
    if (capture.value.completeness.status !== 'complete') {
      throw new Error(`profiler capture was ${capture.value.completeness.status}`);
    }
    onAllocationCount += allocationReport.profilerEventObjectAllocations - allocationBefore;
    lastOverflow = groupDurations.length;
  }
  app.stop();

  const relation = (await import('./check-profiler-phase-catalog.mjs')).readPhaseCatalogRelation();
  const overflow = await runOverflowProbe();
  const p95Off = nearestRankP95(offDurations);
  const p95On = nearestRankP95(onDurations);
  const increasePercent = ((p95On - p95Off) / p95Off) * 100;
  const report = {
    benchmark: 'profiler-overhead-d6',
    backend: 'rhi-null',
    workload: 'deterministic-app-render',
    environment: {
      node: process.version,
      os: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
    },
    warmupFrames: WARMUP_FRAMES,
    groups: GROUP_COUNT,
    framesPerGroup: FRAMES_PER_GROUP,
    quantile: {
      method: 'nearest-rank',
      percentile: QUANTILE,
      indexFormula: 'sorted[ceil(0.95*n)-1]',
    },
    windows: {
      off: { samples: offDurations.length, p95FrameDurationMicros: p95Off },
      on: { samples: onDurations.length, p95FrameDurationMicros: p95On },
    },
    overhead: {
      formula: FORMULA,
      increasePercent,
      thresholdPercent: THRESHOLD_PERCENT,
      verdict: increasePercent <= THRESHOLD_PERCENT ? 'pass' : 'fail',
    },
    allocation: {
      owner: 'profiler-owned',
      profilerEventObjectAllocations: 0,
      onProfilerEventObjectAllocations: onAllocationCount,
    },
    phaseCatalog: { ...relation.actual, relation },
    overflow,
    verdict: increasePercent <= THRESHOLD_PERCENT && relation.status === 'pass' ? 'pass' : 'fail',
    warmupP95FrameDurationMicros: nearestRankP95(warmupDurations),
    lastGroupSampleCount: lastOverflow,
  };
  return report;
}

async function runOverflowProbe() {
  const [{ APP_PHASE_CATALOG }, { RENDER_PHASE_CATALOG }, { createProfiler }] = await Promise.all([
    import('@forgeax/engine-app'),
    import('@forgeax/engine-render'),
    import('@forgeax/engine-profiler'),
  ]);
  const profiler = createProfiler({
    clock: { nowMicros: () => 1 },
    phaseCatalog: { app: APP_PHASE_CATALOG, render: RENDER_PHASE_CATALOG },
  });
  const started = profiler.startCapture({ frameLimit: 1000, eventLimit: 4 });
  if (!started.ok) throw new Error(`overflow probe failed: ${started.error.code}`);
  for (let frameId = 1; frameId <= 44; frameId += 1) {
    expectProfilerResult(started.value.beginFrame(frameId), `beginFrame(${frameId})`);
    expectProfilerResult(
      started.value.beginPhase({ source: 'app', phase: 'frame-total' }),
      'beginPhase(app:frame-total)',
    );
    expectProfilerResult(started.value.endPhase(), 'endPhase(app:frame-total)');
    expectProfilerResult(
      started.value.beginPhase({ source: 'render', phase: 'extract' }),
      'beginPhase(render:extract)',
    );
    expectProfilerResult(started.value.endPhase(), 'endPhase(render:extract)');
    expectProfilerResult(started.value.endFrame(), `endFrame(${frameId})`);
  }
  const finished = started.value.finish();
  if (!finished.ok) throw new Error(`overflow probe did not finish: ${finished.error.code}`);
  return {
    status: finished.value.completeness.status,
    bounded: finished.value.records.length === 4,
    retainedEventCount: finished.value.completeness.retainedEventCount,
    droppedEventCount: finished.value.completeness.droppedEventCount,
    firstAffectedFrameId: finished.value.completeness.firstAffectedFrameId,
    lastAffectedFrameId: finished.value.completeness.lastAffectedFrameId,
  };
}

function expectProfilerResult(result, operation) {
  if (!result.ok) throw new Error(`overflow probe ${operation} failed: ${result.error.code}`);
}

function expectStart(app) {
  const started = app.start();
  if (!started.ok) throw new Error(`App workload did not start: ${started.error.code}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const report = await runBenchmark();
    const validation = validateOverheadReport(report);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!validation.ok) {
      process.stderr.write(`${JSON.stringify(validation.error)}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exitCode = 1;
  }
}
