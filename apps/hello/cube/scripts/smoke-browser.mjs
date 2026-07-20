// smoke-browser.mjs -- feat-20260617-rhi-debug-layered-browser-capture (M4 / w22)
//
// Playwright e2e for the RHI-debug browser capture path on apps/hello/cube.
// Spawns a local vite dev server with FORGEAX_ENGINE_RHI_DEBUG=1, drives headed
// Chrome with WebGPU, calls `window.__forgeax.captureFrame(1)`, and asserts the
// returned object carries { runId, tapePath, reportPath } and that the two
// on-disk artefacts (.forgeax-debug/<runId>/frame-0.{tape.bin,report.json})
// exist with a parseable report (AC-08).
//
// Why a separate script (not the dawn smoke): smoke-dawn.mjs walks
// createRenderer + a hand-built World and never touches the create-app guard,
// the vite-plugin-rhi-debug POST /__forgeax-debug/tape endpoint, or the
// browser capture-browser round-trip. The captureFrame affordance only exists
// when (a) the demo bootstraps via createApp (hello-cube main.ts does, M4 /
// w22) AND (b) FORGEAX_ENGINE_RHI_DEBUG=1 reaches the guard via the vite plugin
// define + the spawned env. Only the browser path exercises
// JSON.stringify(tape) -> fetch(POST) -> assembleReport -> fs write.
//
// Invocation: `FORGEAX_ENGINE_RHI_DEBUG=1 pnpm -F @forgeax/hello-cube smoke:browser`
// (the script sets the env on the spawned vite itself, so a bare
// `pnpm -F @forgeax/hello-cube smoke:browser` also works).
//
// Exit codes:
//   0 = green (captureFrame returned 3 fields AND both artefacts exist + parse)
//   1 = red (regression detected)
//   2 = harness error (vite did not boot / playwright launch failed)
//
// Local-only gate today; CI inclusion gated on a Chrome-with-WebGPU runner
// (plan-strategy §5.2 / OOS, mirrors apps/hello/skin/scripts/smoke-browser.mjs).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/hello/cube/scripts -> apps/hello/cube -> apps/hello -> apps -> repo root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
// apps/hello/cube/scripts -> apps/hello/cube. `pnpm -F @forgeax/hello-cube dev`
// runs vite with cwd = this package dir, so the dev endpoint writes
// .forgeax-debug/<runId> relative to APP_DIR (not REPO_ROOT).
const APP_DIR = resolve(HERE, '..');

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-cube', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '1' },
});
let portUrl = null;
viteProc.stdout.on('data', (chunk) => {
  const s = chunk.toString();
  process.stdout.write(`[vite] ${s}`);
  const m = s.match(/Local:\s+(http:\/\/[^\s]+)/);
  if (m) portUrl = m[1];
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

const deadline = Date.now() + 30000;
while (!portUrl && Date.now() < deadline) await sleep(200);
if (!portUrl) {
  console.error('FAIL: vite did not become ready in 30s');
  viteProc.kill();
  process.exit(2);
}
console.log(`[smoke-browser] using ${portUrl}`);

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--ignore-gpu-blocklist',
    ],
  });
} catch (e) {
  console.error(`FAIL: could not launch headed Chrome with WebGPU: ${e?.message ?? e}`);
  viteProc.kill('SIGTERM');
  process.exit(2);
}

const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`CONSOLE-ERR: ${msg.text()}`);
});

await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
// Let the rAF loop run a few frames so the recorder has frame-marks to capture.
await page.waitForTimeout(3000);

// Assert the guard mounted the capture affordance (createApp + FORGEAX_ENGINE_RHI_DEBUG=1).
const hasCapture = await page.evaluate(
  () => typeof globalThis.__forgeax?.captureFrame === 'function',
);
if (!hasCapture) {
  console.error(
    '\n[smoke-browser] RED -- window.__forgeax.captureFrame is not a function. ' +
      'Suspect: demo did not bootstrap via createApp, or FORGEAX_ENGINE_RHI_DEBUG=1 ' +
      'did not reach the create-app guard (vite-plugin-rhi-debug define / spawned env).',
  );
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}

let captured;
try {
  captured = await page.evaluate(async () => {
    const r = await globalThis.__forgeax.captureFrame(1);
    return r;
  });
} catch (e) {
  console.error(`\n[smoke-browser] RED -- captureFrame(1) threw: ${e?.message ?? e}`);
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}

console.log('\n=== captureFrame(1) result ===');
console.log(JSON.stringify(captured, null, 2));
console.log('=== console errors during capture ===');
errors.forEach((e) => console.log(e));

await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);

// (2) three fields non-empty.
const missingFields = ['runId', 'tapePath', 'reportPath'].filter(
  (k) => typeof captured?.[k] !== 'string' || captured[k].length === 0,
);
if (missingFields.length > 0) {
  console.error(
    `\n[smoke-browser] RED -- captureFrame result missing/empty field(s): ${missingFields.join(', ')}. ` +
      `Got: ${JSON.stringify(captured)}`,
  );
  process.exit(1);
}

// (3) tapePath file exists. The dev endpoint writes relative to the vite cwd,
// which `pnpm -F` sets to APP_DIR; fall back to REPO_ROOT for the bare
// `node scripts/smoke-browser.mjs` invocation where cwd is the repo root.
const resolveArtifact = (rel) => {
  const inApp = resolve(APP_DIR, rel);
  if (existsSync(inApp)) return inApp;
  return resolve(REPO_ROOT, rel);
};
const tapeAbs = resolveArtifact(captured.tapePath);
if (!existsSync(tapeAbs)) {
  console.error(
    `\n[smoke-browser] RED -- tapePath does not exist on disk: ${tapeAbs} ` +
      `(returned ${captured.tapePath}). Suspect: POST /__forgeax-debug/tape did not write the blob.`,
  );
  process.exit(1);
}

// (4) reportPath file exists + JSON parses.
const reportAbs = resolveArtifact(captured.reportPath);
if (!existsSync(reportAbs)) {
  console.error(`\n[smoke-browser] RED -- reportPath does not exist on disk: ${reportAbs}`);
  process.exit(1);
}
let report;
try {
  report = JSON.parse(readFileSync(reportAbs, 'utf-8'));
} catch (e) {
  console.error(`\n[smoke-browser] RED -- reportPath is not valid JSON: ${e?.message ?? e}`);
  process.exit(1);
}
if (typeof report !== 'object' || report === null) {
  console.error('\n[smoke-browser] RED -- report JSON is not an object.');
  process.exit(1);
}

// --- 5. Replay + inspect assertion (w8 / AC-06) ----------------------------
  //
  // The captured tape and report are now on disk. For replay, we use a fresh
  // dawn-node GPU device to deserialize, create a replay session, step through
  // all events, then inspect draw 0 — asserting bindings, drawCall, and RT
  // three fields are non-empty (AC-06, plan-strategy D-3).
  //
  // Swapchain RT is faithfully reconstructed as a real-size offscreen RT (M_SC
  // D-1) and bindGroups with real resources are wrapped as RhiBindingResource
  // (M_REP D-2), so the full replay+inspect chain on a fresh device is now
  // end-to-end available for real demos.

  // 5a. Bootstrap dawn-node GPU for deserialize + createReplay.
  let createDawn;
  let gpuGlobals;
  try {
    ({ create: createDawn, globals: gpuGlobals } = await import('webgpu'));
  } catch (err) {
    console.error(
      `[smoke-browser] RED -- webgpu (dawn-node) import failed: ${err?.message ?? err}`,
    );
    console.error('  hint: ensure node_modules/webgpu is installed');
    process.exit(1);
  }
  Object.assign(globalThis, gpuGlobals);
  if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
  }
  let gpu;
  try {
    gpu = createDawn([]);
  } catch (err) {
    console.error(
      `[smoke-browser] RED -- dawn-node create([]) failed: ${err?.message ?? err}`,
    );
    process.exit(1);
  }
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

  // 5b. Get a fresh RhiDevice.
  const rhiWebgpu = await import('@forgeax/engine-rhi-webgpu');
  const adapterRes = await rhiWebgpu.rhi.requestAdapter();
  if (!adapterRes.ok) {
    console.error(
      `[smoke-browser] RED -- requestAdapter failed: ${adapterRes.error.code}`,
    );
    process.exit(1);
  }
  const devRes = await adapterRes.value.requestDevice({
    requiredLimits: { maxUniformBufferBindingSize: 262144 },
  });
  if (!devRes.ok) {
    console.error(
      `[smoke-browser] RED -- requestDevice failed: ${devRes.error.code}`,
    );
    process.exit(1);
  }
  const freshDevice = devRes.value;

  // 5c. Reconstruct tape json from the report (header + events).
  const tapeJson = JSON.stringify({
    header: report.header,
    events: report.events,
  });

  // 5d. Read tape blob from disk.
  const tapeBlob = new Uint8Array(readFileSync(tapeAbs));

  // 5e. deserializeTape -- assert no dangling handle references.
  const { deserializeTape: deser } = await import('@forgeax/engine-rhi-debug');
  const deserRes = deser(tapeJson, tapeBlob);
  if (!deserRes.ok) {
    console.error(
      `[smoke-browser] RED -- deserializeTape failed: ${deserRes.error.code} hint=${JSON.stringify(deserRes.error.hint)}`,
    );
    console.error(
      '  Suspect: tape self-containment regression (bootstrap create* events missing from tape).',
    );
    freshDevice.destroy?.();
    process.exit(1);
  }
  const tape = deserRes.value;
  console.log(
    `[smoke-browser] deserializeTape OK -- ${tape.events.length} events, ${tape.blobPool.size} blobs`,
  );

  // 5f. createReplay -- assert replay session creation succeeds.
  // The browser captures the canvas swapchain format (bgra8unorm on most
  // platforms), but the replay layer adapts bgra8unorm -> rgba8unorm for
  // non-canvas textures internally (adaptReplayFormat, replayer.ts), so the
  // browser tape is fed to createReplay as-is with no per-script mutation.
  // Pass createShaderModule from rhi-webgpu to replay pipeline shaders on
  // the fresh dawn-node device (required for real demo tapes with shaders).
  const { createReplay: createRep } = await import('@forgeax/engine-rhi-debug');
  const replayRes = createRep(tape, freshDevice, rhiWebgpu.createShaderModule);
  if (!replayRes.ok) {
    console.error(
      `[smoke-browser] RED -- createReplay failed: ${replayRes.error.code} hint=${JSON.stringify(replayRes.error.hint)}`,
    );
    freshDevice.destroy?.();
    process.exit(1);
  }
  const replay = replayRes.value;

  // 5g. stepTo(N) -- replay all events to re-create the GPU state at frame end.
  const stepRes = await replay.stepTo(tape.events.length - 1);
  if (!stepRes.ok) {
    console.error(
      `[smoke-browser] RED -- stepTo failed: ${stepRes.error.code} hint=${JSON.stringify(stepRes.error.hint)}`,
    );
    freshDevice.destroy?.();
    process.exit(1);
  }
  console.log(
    `[smoke-browser] stepTo(${tape.events.length - 1}) OK`,
  );

  // 5h. inspect last draw (the color render pass) — assert bindings/drawCall/RT
  // three fields non-empty (AC-06, D-3). hello-cube tapes have depth-only
  // shadow passes first; the last drawIndexed is the color render pass.
  const colorDrawIdx = 4; // draws[0..3]=shadow depth-only, draws[4]=main render pass
  const { inspectDrawJson } = await import('@forgeax/engine-rhi-debug/inspect-core');
  const inspectRes = await inspectDrawJson(replay, colorDrawIdx, tape.events, freshDevice);
  if (!inspectRes.ok) {
    console.error(
      `[smoke-browser] RED -- inspectDrawJson draw ${colorDrawIdx} failed: ${inspectRes.error.code} hint=${JSON.stringify(inspectRes.error.hint)}`,
    );
    freshDevice.destroy?.();
    process.exit(1);
  }
  const report0 = inspectRes.value;
  const missingInspect = [];
  if (!report0.bindings || report0.bindings.length === 0) missingInspect.push('bindings');
  if (!report0.drawCall) missingInspect.push('drawCall');
  if (!report0.rt) missingInspect.push('rt');
  if (missingInspect.length > 0) {
    console.error(
      `[smoke-browser] RED -- inspect draw ${colorDrawIdx} missing field(s): ${missingInspect.join(', ')}. ` +
        `Got: frameIdx=${report0.frameIdx} drawIdx=${report0.drawIdx} passIdx=${report0.passIdx}`,
    );
    freshDevice.destroy?.();
    process.exit(1);
  }
  console.log(
    `[smoke-browser] inspect draw ${colorDrawIdx} OK -- bindings=${report0.bindings.length} drawCall=${!!report0.drawCall} rt=${!!report0.rt}`,
  );

  freshDevice.destroy?.();
  delete globalThis.navigator.gpu;

  console.log(
    `\n[smoke-browser] GREEN -- captureFrame(1) returned { runId, tapePath, reportPath }; ` +
      `tape + report exist on disk, report JSON parses, ` +
      `deserializeTape has no dangling handles, createReplay + stepTo + inspect draw ${colorDrawIdx} ` +
      `all succeed with bindings/drawCall/RT non-empty. ` +
      `runId=${captured.runId}`,
  );
  process.exit(0);
