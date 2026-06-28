// @forgeax/apps-shared/scripts/rhi-debug-verify -- reusable RHI-debug capture
// verification harness for learn-render / hello-* demos.
//
// Why this exists: feat-20260625 (initial-state capture) and PR #525 (the
// all-black replay bug) exposed that the "real demo capture -> offline replay"
// path had no test comparing the replayed frame against the demo's actual
// rendered image. Synthetic-tape tests stayed green while the real path rendered
// black. This harness closes that gap with two modes:
//
//   mode='pixel'      (static demos): capture a frame, replay it on a fresh
//                     dawn-node device, read back BOTH the live canvas pixels and
//                     the replayed RT pixels, and assert pixelDeltaAbsMean <= eps.
//                     This is the only check that proves "replay == demo effect".
//
//   mode='structural' (animated demos): capture -> replay -> stepTo -> inspect,
//                     asserting bindings/drawCall/rt are non-empty. No live-pixel
//                     comparison (an animated demo's live frame and tape frame
//                     can diverge by a frame, which would masquerade as a tool
//                     bug). Same coverage as apps/hello/cube/scripts/smoke-browser.
//
// The pixel comparison auto-detects the correct pixel-buffer alignment between
// the two readback paths (identity / Y-flip / BGRA<->RGBA channel swap / both)
// by measuring the delta under each and choosing the minimum. Both paths SHOULD
// already agree (renderer.readPixels returns top-left RGBA via getImageData;
// replay.readbackRt returns top-left RGBA from an rgba8unorm RT), but measuring
// rather than assuming turns "is it flipped/swapped?" from a guess into reported
// data -- so a genuine fidelity bug is never misread as a normalization mistake.
//
// Exit codes (mirrors cube smoke): 0 green, 1 red (regression), 2 harness error.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { writeReferencePng } from '../png-codec.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/**
 * @typedef {Object} VerifyOptions
 * @property {string} pkg           pnpm package name, e.g. '@forgeax/learn-render-2-1-colors'
 * @property {string} label         human label for log lines
 * @property {'pixel'|'structural'} mode
 * @property {string} [liveHook]    window fn name returning live RGBA Uint8Array
 *                                  (pixel mode only). e.g. '__captureColors'.
 * @property {number} [drawIdx]     draw to inspect in structural mode (default last color pass)
 * @property {number} [rtIdx]       RT index for readbackRt (pixel mode, default 0)
 * @property {number} [epsilon]     max whole-frame pixelDeltaAbsMean (default 0.02)
 * @property {number} [maxChannelEpsilon] max single-channel abs delta over any pixel (default 0.10)
 * @property {number} [coveredEpsilon]    max mean delta over non-background pixels (default 0.03)
 * @property {string} [appDir]      the demo's own dir (dirname of its smoke script's parent);
 *                                  the dev endpoint writes .forgeax-debug relative to vite cwd
 *                                  (= the package dir), so artifacts are resolved against this.
 * @property {number} [warmupMs]    rAF warmup before capture (default 3000)
 */

/** @param {VerifyOptions} opts */
export async function verifyDemoCapture(opts) {
  const {
    pkg,
    label,
    mode,
    liveHook,
    drawIdx,
    rtIdx = 0,
    epsilon = 0.02,
    maxChannelEpsilon = 0.1,
    coveredEpsilon = 0.03,
    appDir = REPO_ROOT,
    warmupMs = 3000,
  } = opts;

  if (mode === 'pixel' && !liveHook) {
    fail(2, `[${label}] pixel mode requires a liveHook (window fn returning live RGBA)`);
  }

  // --- 1. spawn vite dev with the capture flag --------------------------------
  const viteProc = spawn('pnpm', ['-F', pkg, 'dev'], {
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

  const killVite = () => {
    try {
      viteProc.kill('SIGTERM');
    } catch {
      // already gone
    }
  };

  const deadline = Date.now() + 30000;
  while (!portUrl && Date.now() < deadline) await sleep(200);
  if (!portUrl) {
    killVite();
    fail(2, `[${label}] vite did not become ready in 30s`);
  }
  console.log(`[${label}] dev server: ${portUrl}`);

  // --- 2. launch headless Chrome with WebGPU ----------------------------------
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
    killVite();
    fail(2, `[${label}] could not launch Chrome with WebGPU: ${e?.message ?? e}`);
  }

  const page = await (await browser.newContext()).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`CONSOLE-ERR: ${msg.text()}`);
  });

  await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(warmupMs);

  const hasCapture = await page.evaluate(
    () => typeof globalThis.__forgeax?.captureFrame === 'function',
  );
  if (!hasCapture) {
    await browser.close();
    killVite();
    fail(
      1,
      `[${label}] RED -- window.__forgeax.captureFrame missing. Suspect: demo did not ` +
        `bootstrap via createApp, or FORGEAX_ENGINE_RHI_DEBUG=1 did not reach the create-app guard.`,
    );
  }

  // --- 3. capture the frame (and, in pixel mode, the live pixels) -------------
  // Critical for pixel mode: take the live readback in the SAME page.evaluate
  // microtask right after captureFrame resolves, before any further rAF tick, so
  // the live image and the captured tape describe the same GPU state.
  let captured;
  let livePixelsB64 = null;
  let liveDims = null;
  try {
    const result = await page.evaluate(
      async ({ mode, liveHook }) => {
        const cap = await globalThis.__forgeax.captureFrame(1);
        let live = null;
        let dims = null;
        if (mode === 'pixel') {
          const fn = globalThis[liveHook];
          if (typeof fn !== 'function') {
            throw new Error(`live hook window.${liveHook} is not a function`);
          }
          const bytes = await fn();
          const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          const canvas = document.querySelector('#app');
          dims = { width: canvas?.width ?? 0, height: canvas?.height ?? 0 };
          // base64 the pixels for transport across the CDP boundary.
          let binary = '';
          const CHUNK = 0x2000;
          for (let i = 0; i < u8.length; i += CHUNK) {
            binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
          }
          live = btoa(binary);
        }
        return { cap, live, dims };
      },
      { mode, liveHook },
    );
    captured = result.cap;
    livePixelsB64 = result.live;
    liveDims = result.dims;
  } catch (e) {
    await browser.close();
    killVite();
    fail(1, `[${label}] RED -- capture/live-readback threw: ${e?.message ?? e}`);
  }

  console.log(`[${label}] captureFrame result: ${JSON.stringify(captured)}`);
  if (errors.length) {
    console.log(`[${label}] console errors during capture:`);
    errors.forEach((e) => console.log(`  ${e}`));
  }

  await browser.close();
  killVite();
  await sleep(500);

  // --- 4. validate returned artifact paths ------------------------------------
  const missing = ['runId', 'tapePath', 'reportPath'].filter(
    (k) => typeof captured?.[k] !== 'string' || captured[k].length === 0,
  );
  if (missing.length) {
    fail(1, `[${label}] RED -- captureFrame missing field(s): ${missing.join(', ')}`);
  }

  const resolveArtifact = (rel) => {
    const inApp = resolve(appDir, rel);
    if (existsSync(inApp)) return inApp;
    return resolve(REPO_ROOT, rel);
  };
  const tapeAbs = resolveArtifact(captured.tapePath);
  const reportAbs = resolveArtifact(captured.reportPath);
  if (!existsSync(tapeAbs)) {
    fail(1, `[${label}] RED -- tapePath missing on disk: ${tapeAbs}`);
  }
  if (!existsSync(reportAbs)) {
    fail(1, `[${label}] RED -- reportPath missing on disk: ${reportAbs}`);
  }
  let report;
  try {
    report = JSON.parse(readFileSync(reportAbs, 'utf-8'));
  } catch (e) {
    fail(1, `[${label}] RED -- report not valid JSON: ${e?.message ?? e}`);
  }

  // --- 5. bootstrap dawn-node + replay ----------------------------------------
  const { freshDevice, rhiWebgpu } = await bootstrapDawn(label);

  const tapeJson = JSON.stringify({ header: report.header, events: report.events });
  const tapeBlob = new Uint8Array(readFileSync(tapeAbs));

  const { deserializeTape, createReplay } = await import('@forgeax/engine-rhi-debug');
  const deserRes = deserializeTape(tapeJson, tapeBlob);
  if (!deserRes.ok) {
    freshDevice.destroy?.();
    fail(
      1,
      `[${label}] RED -- deserializeTape failed: ${deserRes.error.code} ` +
        `hint=${JSON.stringify(deserRes.error.hint)}. Suspect: tape self-containment regression.`,
    );
  }
  const tape = deserRes.value;
  console.log(`[${label}] tape: ${tape.events.length} events, ${tape.blobPool.size} blobs`);

  const replayRes = createReplay(tape, freshDevice, rhiWebgpu.createShaderModule);
  if (!replayRes.ok) {
    freshDevice.destroy?.();
    fail(1, `[${label}] RED -- createReplay failed: ${replayRes.error.code} hint=${JSON.stringify(replayRes.error.hint)}`);
  }
  const replay = replayRes.value;

  const stepRes = await replay.stepTo(tape.events.length - 1);
  if (!stepRes.ok) {
    freshDevice.destroy?.();
    fail(1, `[${label}] RED -- stepTo failed: ${stepRes.error.code} hint=${JSON.stringify(stepRes.error.hint)}`);
  }

  if (mode === 'structural') {
    await assertStructural({ label, replay, tape, freshDevice, drawIdx });
    freshDevice.destroy?.();
    green(label, `structural -- capture+replay+inspect all succeed (runId=${captured.runId})`);
  }

  // --- 6. pixel comparison (static demos) -------------------------------------
  const rtRes = await replay.readbackRt(rtIdx);
  if (!rtRes.ok) {
    freshDevice.destroy?.();
    fail(1, `[${label}] RED -- readbackRt(${rtIdx}) failed: ${rtRes.error.code} hint=${JSON.stringify(rtRes.error.hint)}`);
  }
  const replayPixels = rtRes.value.pixels;
  const rw = rtRes.value.width;
  const rh = rtRes.value.height;

  const livePixels = Uint8Array.from(Buffer.from(livePixelsB64, 'base64'));
  freshDevice.destroy?.();

  if (livePixels.length !== replayPixels.length) {
    fail(
      1,
      `[${label}] RED -- pixel buffer size mismatch: live=${livePixels.length} ` +
        `(${liveDims?.width}x${liveDims?.height}) replay=${replayPixels.length} (${rw}x${rh}). ` +
        `Suspect: RT size disagreement between live canvas and replayed attachment.`,
    );
  }

  // Empty-frame guard (empty-vs-empty trap): if the LIVE frame is essentially
  // all-black the demo did not actually render before capture -- IBL/HDR prewarm
  // still running, an async asset not yet loaded, or capture racing ahead of the
  // first real draw. Comparing two black frames yields delta 0 and a false GREEN.
  // A pixel-mode demo must produce visible output; require a minimum lit
  // coverage. (Demos that legitimately render near-black are not pixel-mode
  // candidates.) Reuse localMetrics' background test via a quick coverage scan.
  const liveCoverage = litCoverage(livePixels);
  if (liveCoverage < 0.001) {
    fail(
      1,
      `[${label}] RED -- live frame is ~all-black (lit coverage ${liveCoverage.toFixed(4)}). ` +
        `The demo did not render before capture (IBL/HDR prewarm or async asset not ready, ` +
        `or capture raced the first draw). Increase warmupMs, or if the demo is genuinely ` +
        `slow to first-paint, gate it structurally instead of pixel.`,
    );
  }

  const { pixelDeltaAbsMean } = await import('@forgeax/engine-rhi-debug');
  const best = bestAlignmentDelta(livePixels, replayPixels, rw, rh, pixelDeltaAbsMean);

  // Whole-frame mean alone is too lenient: a demo whose subject covers a small
  // fraction of a mostly-black frame can hide a large per-pixel error in the
  // subject under a tiny mean (the sRGB gap read 0.046 mean while the cube was
  // visibly ~2.7x too dark). Also compute the worst single-channel delta and the
  // mean restricted to non-background pixels, on the best-aligned buffer, and
  // gate on all three so a localized fidelity break cannot pass.
  const local = localMetrics(livePixels, best.applied);

  console.log(
    `[${label}] pixel delta: mean=${best.delta.toFixed(5)} via '${best.name}' ` +
      `(identity=${best.all.identity.toFixed(5)} yflip=${best.all.yflip.toFixed(5)} ` +
      `bgra=${best.all.bgra.toFixed(5)} both=${best.all.both.toFixed(5)})`,
  );
  console.log(
    `[${label}] localized: maxChannelDelta=${local.maxDelta.toFixed(5)} ` +
      `coveredMean=${local.coveredMean.toFixed(5)} (over ${local.coveredFrac.toFixed(3)} non-bg coverage)`,
  );

  // Dump live / replay / side-by-side PNGs so a human can eyeball "replay ==
  // demo". The replay buffer is written under its best-fit alignment so the two
  // panes are directly comparable (any residual gap is real fidelity, not a flip
  // or channel-order artefact). Written next to the tape under .forgeax-debug.
  const pngDir = dirname(tapeAbs);
  const replayAligned = best.applied;
  try {
    writeFileSync(resolve(pngDir, 'live.png'), writeReferencePng(livePixels, rw, rh));
    writeFileSync(resolve(pngDir, 'replay.png'), writeReferencePng(replayAligned, rw, rh));
    const sbs = sideBySide(livePixels, replayAligned, rw, rh);
    writeFileSync(resolve(pngDir, 'compare.png'), writeReferencePng(sbs.pixels, sbs.width, sbs.height));
    console.log(
      `[${label}] wrote PNGs: ${resolve(pngDir, 'compare.png')} (left=live demo, right=replay)`,
    );
  } catch (e) {
    console.log(`[${label}] (non-fatal) PNG dump skipped: ${e?.message ?? e}`);
  }

  const failures = [];
  if (best.delta > epsilon) {
    failures.push(`mean ${best.delta.toFixed(5)} > eps ${epsilon}`);
  }
  if (local.maxDelta > maxChannelEpsilon) {
    failures.push(`maxChannelDelta ${local.maxDelta.toFixed(5)} > ${maxChannelEpsilon}`);
  }
  if (local.coveredMean > coveredEpsilon) {
    failures.push(`coveredMean ${local.coveredMean.toFixed(5)} > ${coveredEpsilon}`);
  }
  if (failures.length) {
    fail(
      1,
      `[${label}] RED -- replay does NOT match the live demo render: ${failures.join('; ')} ` +
        `(best alignment '${best.name}'). This is a tool fidelity bug -- ` +
        `inspect .forgeax-debug/${captured.runId}/compare.png.`,
    );
  }
  green(
    label,
    `pixel -- mean ${best.delta.toFixed(5)}<=${epsilon}, maxChannel ${local.maxDelta.toFixed(5)}<=${maxChannelEpsilon}, ` +
      `coveredMean ${local.coveredMean.toFixed(5)}<=${coveredEpsilon} via '${best.name}' ` +
      `(${rw}x${rh}, runId=${captured.runId})`,
  );
}

// ============================================================================
// helpers
// ============================================================================

async function bootstrapDawn(label) {
  let createDawn;
  let gpuGlobals;
  try {
    ({ create: createDawn, globals: gpuGlobals } = await import('webgpu'));
  } catch (err) {
    fail(2, `[${label}] webgpu (dawn-node) import failed: ${err?.message ?? err}`);
  }
  Object.assign(globalThis, gpuGlobals);
  if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  }
  let gpu;
  try {
    gpu = createDawn([]);
  } catch (err) {
    fail(2, `[${label}] dawn-node create([]) failed: ${err?.message ?? err}`);
  }
  Object.defineProperty(globalThis.navigator, 'gpu', { value: gpu, configurable: true, writable: true });
  gpu.getPreferredCanvasFormat = () => 'rgba8unorm';

  const rhiWebgpu = await import('@forgeax/engine-rhi-webgpu');
  const adapterRes = await rhiWebgpu.rhi.requestAdapter();
  if (!adapterRes.ok) fail(2, `[${label}] requestAdapter failed: ${adapterRes.error.code}`);
  const devRes = await adapterRes.value.requestDevice({
    requiredLimits: { maxUniformBufferBindingSize: 262144 },
  });
  if (!devRes.ok) fail(2, `[${label}] requestDevice failed: ${devRes.error.code}`);
  return { freshDevice: devRes.value, rhiWebgpu };
}

async function assertStructural({ label, replay, tape, freshDevice, drawIdx }) {
  // Default to the last draw (the main color pass) when no drawIdx is given.
  const idx = typeof drawIdx === 'number' ? drawIdx : lastDrawIdx(tape.events);
  if (idx < 0) {
    freshDevice.destroy?.();
    fail(1, `[${label}] RED -- no draw/drawIndexed event found in tape`);
  }
  const { inspectDrawJson } = await import('@forgeax/engine-rhi-debug/inspect-core');
  const inspectRes = await inspectDrawJson(replay, idx, tape.events, freshDevice);
  if (!inspectRes.ok) {
    freshDevice.destroy?.();
    fail(1, `[${label}] RED -- inspectDrawJson draw ${idx} failed: ${inspectRes.error.code} hint=${JSON.stringify(inspectRes.error.hint)}`);
  }
  const r = inspectRes.value;
  const missing = [];
  if (!r.bindings || r.bindings.length === 0) missing.push('bindings');
  if (!r.drawCall) missing.push('drawCall');
  if (!r.rt) missing.push('rt');
  if (missing.length) {
    freshDevice.destroy?.();
    fail(1, `[${label}] RED -- inspect draw ${idx} missing: ${missing.join(', ')}`);
  }
  console.log(`[${label}] inspect draw ${idx} OK -- bindings=${r.bindings.length} drawCall=true rt=true`);
}

/** Count draw/drawIndexed events and return the event-draw index of the last. */
function lastDrawIdx(events) {
  let count = -1;
  for (const ev of events) {
    if (ev && (ev.kind === 'draw' || ev.kind === 'drawIndexed')) count++;
  }
  return count;
}

/** Y-flip an RGBA tight buffer in place into a new buffer. */
function yflip(px, w, h) {
  const out = new Uint8Array(px.length);
  const rowBytes = w * 4;
  for (let y = 0; y < h; y++) {
    const src = y * rowBytes;
    const dst = (h - 1 - y) * rowBytes;
    out.set(px.subarray(src, src + rowBytes), dst);
  }
  return out;
}

/** Swap R and B channels of an RGBA tight buffer into a new buffer. */
function bgraSwap(px) {
  const out = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i += 4) {
    out[i] = px[i + 2];
    out[i + 1] = px[i + 1];
    out[i + 2] = px[i];
    out[i + 3] = px[i + 3];
  }
  return out;
}

/**
 * Measure pixelDeltaAbsMean(live, replay) under 4 candidate alignments of the
 * replay buffer and return the minimum. Reports all four so a non-identity
 * winner is visible (= a normalization quirk, not a fidelity failure).
 */
function bestAlignmentDelta(live, replay, w, h, delta) {
  const flipped = yflip(replay, w, h);
  const buffers = {
    identity: replay,
    yflip: flipped,
    bgra: bgraSwap(replay),
    both: bgraSwap(flipped),
  };
  const all = {
    identity: delta(live, buffers.identity),
    yflip: delta(live, buffers.yflip),
    bgra: delta(live, buffers.bgra),
    both: delta(live, buffers.both),
  };
  let name = 'identity';
  let min = all.identity;
  for (const k of ['yflip', 'bgra', 'both']) {
    if (all[k] < min) {
      min = all[k];
      name = k;
    }
  }
  return { delta: min, name, all, applied: buffers[name] };
}

/**
 * Localized fidelity metrics on two aligned RGBA buffers:
 * - maxDelta: worst single-channel |a-b|/255 over every channel of every pixel.
 *   Catches a large error confined to a small region (which a whole-frame mean
 *   would average away).
 * - coveredMean: mean delta restricted to "non-background" pixels (any pixel
 *   non-black in either buffer). For a small subject on a black frame this is
 *   the delta that actually matters; the whole-frame mean dilutes it by the
 *   black area's coverage.
 * - coveredFrac: fraction of pixels counted as non-background.
 */
function localMetrics(a, b) {
  let maxAbs = 0;
  let coveredSum = 0;
  let coveredCount = 0;
  const pixels = a.length / 4;
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    let pixelDeltaSum = 0;
    let nonBg = false;
    for (let c = 0; c < 4; c++) {
      const av = a[i + c] ?? 0;
      const bv = b[i + c] ?? 0;
      const d = Math.abs(av - bv);
      if (d > maxAbs) maxAbs = d;
      pixelDeltaSum += d;
      // Ignore alpha for background detection; a pixel is "covered" if any RGB
      // channel is lit in either buffer.
      if (c < 3 && (av > 8 || bv > 8)) nonBg = true;
    }
    if (nonBg) {
      coveredSum += pixelDeltaSum;
      coveredCount++;
    }
  }
  return {
    maxDelta: maxAbs / 255,
    coveredMean: coveredCount > 0 ? coveredSum / (coveredCount * 4) / 255 : 0,
    coveredFrac: pixels > 0 ? coveredCount / pixels : 0,
  };
}

/** Fraction of pixels with any RGB channel lit (> 8). Used by the empty-frame guard. */
function litCoverage(px) {
  let lit = 0;
  const pixels = px.length / 4;
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    if ((px[i] ?? 0) > 8 || (px[i + 1] ?? 0) > 8 || (px[i + 2] ?? 0) > 8) lit++;
  }
  return pixels > 0 ? lit / pixels : 0;
}

/**
 * Build a side-by-side RGBA image: live on the left, replay on the right, with a
 * 4px black gutter between them. Both panes are w x h, so the result is
 * (2w + gutter) x h.
 */
function sideBySide(live, replay, w, h) {
  const gutter = 4;
  const outW = w * 2 + gutter;
  const out = new Uint8Array(outW * h * 4);
  // gutter column stays black (alpha 255 so it renders solid).
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  const rowBytes = w * 4;
  const outRowBytes = outW * 4;
  for (let y = 0; y < h; y++) {
    out.set(live.subarray(y * rowBytes, y * rowBytes + rowBytes), y * outRowBytes);
    out.set(
      replay.subarray(y * rowBytes, y * rowBytes + rowBytes),
      y * outRowBytes + (w + gutter) * 4,
    );
  }
  return { pixels: out, width: outW, height: h };
}

function fail(code, msg) {
  console.error(`\n${msg}`);
  process.exit(code);
}

function green(label, detail) {
  console.log(`\n[${label}] GREEN -- ${detail}`);
  process.exit(0);
}
