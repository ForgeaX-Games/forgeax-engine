import { createApp } from '@forgeax/engine-app';
import type { ProfileCapture } from '@forgeax/engine-profiler';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
const output = document.querySelector<HTMLPreElement>('#execution-report');
const summary = document.querySelector<HTMLParagraphElement>('#execution-summary');
const rebuildButton = document.querySelector<HTMLButtonElement>('#rebuild');
if (canvas === null || output === null || summary === null || rebuildButton === null) {
  throw new Error('execution demo DOM is incomplete');
}
const params = new URL(location.href).searchParams;
const tierParam = params.get('tier');
const requestedTier = tierParam === 'main-serial' || tierParam === 'shared'
  ? tierParam
  : 'engine-worker';
const bootstrap = new URL('/assets/shared-bootstrap.js', location.href);
if (params.get('fault') === '1') bootstrap.searchParams.set('fault', '1');
const profiler = params.get('profile') === '1'
  ? (await import('@forgeax/engine-profiler')).createProfiler()
  : undefined;
if (profiler !== undefined) {
  const captureStarted = profiler.startCapture({ frameLimit: 400, eventLimit: 2_000 });
  if (!captureStarted.ok) throw captureStarted.error;
}

const created = await createApp(
  canvas,
  {
    execution: {
      tier: requestedTier,
      bootstrap,
      startupTimeoutMs: 15_000,
      frameTimeoutMs: 5_000,
    },
    ...(profiler === undefined ? {} : { profiler }),
  },
  forgeaxBundlerAdapter(),
);

if (!created.ok) {
  output.dataset.status = 'failed';
  output.textContent = JSON.stringify({
    code: 'code' in created.error ? created.error.code : created.error.name,
    message: created.error.message,
    ...('detail' in created.error ? { detail: created.error.detail } : {}),
  });
  throw created.error;
}

const app = created.value;
const diagnostics = globalThis as {
  __forgeaxExecutionReport?: () => ReturnType<typeof app.execution.report>;
  __forgeaxExecutionFrameSamples?: readonly number[];
  __forgeaxExecutionCapture?: () => ProfileCapture;
};
diagnostics.__forgeaxExecutionReport = () => app.execution.report();
if (profiler !== undefined) {
  diagnostics.__forgeaxExecutionCapture = () => {
    const stopped = app.stop();
    if (!stopped.ok) throw stopped.error;
    const capture = profiler.latestCapture();
    if (capture === undefined) throw new Error('execution profile capture is unavailable');
    return capture;
  };
}
const start = app.start();
if (!start.ok) throw start.error;

let rebuilding = false;
let previousReportSamples = 0;
let previousFrameAt = 0;
let publishedFrames = 0;
const frameSamples: number[] = [];
rebuildButton.addEventListener('click', () => {
  if (rebuilding) return;
  rebuilding = true;
  rebuildButton.disabled = true;
  void app.execution.rebuild().then((result) => {
    rebuilding = false;
    rebuildButton.disabled = false;
    if (!result.ok) throw result.error;
    const restarted = app.start();
    if (!restarted.ok) throw restarted.error;
  });
});

const publish = (): void => {
  publishedFrames += 1;
  const report = app.execution.report();
  const reportSamples = report.performance.hostFrameMs?.samples ?? 0;
  if (reportSamples > previousReportSamples) {
    const now = performance.now();
    if (previousFrameAt > 0) frameSamples.push(now - previousFrameAt);
    previousFrameAt = now;
    previousReportSamples = reportSamples;
    diagnostics.__forgeaxExecutionFrameSamples = frameSamples;
  }
  summary.textContent = report.fault === null
    ? `Engine: ${report.engine.health}`
    : `Engine: ${report.engine.health} | Fault: ${report.fault.code}`;
  output.dataset.status = report.engine.health;
  output.textContent = JSON.stringify(report, null, 2);
  rebuildButton.hidden = report.world.health !== 'poisoned';
  if (
    report.engine.health === 'running' &&
    (report.performance.engineUpdateMs !== null ||
      (report.actualTier === 'main-serial' && publishedFrames >= 2))
  ) {
    (globalThis as { __forgeaxExecutionReady?: boolean }).__forgeaxExecutionReady = true;
  }
  requestAnimationFrame(publish);
};
publish();
