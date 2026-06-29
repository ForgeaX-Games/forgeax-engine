// scripts/dev-verify/verify-webkit-hello-triangle.mjs
//
// Drive WebKit (Safari engine) headless against a running hello-triangle
// dev server, capture every console message + stack trace, and exit non-zero
// when wgpu panics so we can iterate on the WebGL2 fallback gaps without
// bouncing every change through a human reload.
//
// Usage:
//   node scripts/dev-verify/verify-webkit-hello-triangle.mjs
// Env:
//   URL=http://localhost:5181/   target dev server (default)
//   TIMEOUT_MS=25000              wall-clock budget after navigation
//
// Exit codes:
//   0  no panic / validation error AND screenshot triangle pixel passed gate
//   1  panic / "Validation Error" string seen in any log line, OR
//      screenshot triangle pixel was empty (canvas all-black; engine path failed
//      silently). Disable the pixel gate with REQUIRE_PIXEL=0.
//
// bug-20260610-edge-webgpu-disabled-fallback verification harness, used both
// locally and in CI (.github/workflows/ci.yml § wgpu-wasm-webkit-verify) as the
// only gate that exercises the wgpu-wasm WebGL2 fallback channel end-to-end.
// dawn-node smoke walks real WebGPU; chromium playwright walks lavapipe WebGPU;
// neither hits Channel 3 so neither catches storage/uniform mismatch, missing
// VIEW_FORMATS downlevel flag, or the per-frame srgb-view rebuild gap.

import { webkit } from 'playwright';

const URL = process.env.URL ?? 'http://localhost:5181/';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 25000);
const SCREENSHOT = process.env.SCREENSHOT ?? '/tmp/hello-triangle.png';

const browser = await webkit.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
const page = await ctx.newPage();

const logs = [];
page.on('console', (msg) => logs.push({ type: msg.type(), text: msg.text() }));
page.on('pageerror', (err) =>
  logs.push({ type: 'pageerror', text: `${err.message}\n${err.stack ?? ''}` }),
);

let navOk = true;
try {
  await page.goto(URL, { waitUntil: 'load', timeout: 15000 });
} catch (e) {
  navOk = false;
  logs.push({ type: 'navfail', text: String(e) });
}

// Channel proof — confirm WebKit really lacks navigator.gpu so the engine
// must drop to Channel 3 (rhi-wgpu wasm GL backend). If navigator.gpu IS
// present here the harness is exercising Channel 2 (rhi-webgpu) instead and
// won't catch wgpu-wasm WebGL2 fallback regressions — fail loudly.
let channelProof = { hasGpu: null, gl2: null };
try {
  channelProof = await page.evaluate(() => ({
    hasGpu: typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu,
    // Probe webgl2 availability (Channel 3 needs a GL context to attach to;
    // Edge `enable-unsafe-webgpu=Disabled` returns null here too).
    gl2: !!document.createElement('canvas').getContext('webgl2'),
  }));
} catch (e) {
  console.log(`channel probe failed: ${e}`);
}

const deadline = Date.now() + TIMEOUT_MS;
let panicSeen = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(500);
  for (const l of logs) {
    if (l.text.includes('panicked at') || l.text.includes('Validation Error')) {
      panicSeen = true;
    }
  }
  if (panicSeen) break;
}

for (const { type, text } of logs) console.log(`[${type}] ${text}`);

// v19 diag: pull draw counters + canvas pixel sample so we can falsify the
// "draws happened" hypothesis without manual DevTools poking.
let diag = null;
let pixelSample = null;
try {
  diag = await page.evaluate(() => {
    const d = globalThis.__forgeax_draw_diag__;
    if (!d) return { present: false };
    return {
      present: true,
      setPipeline: d.setPipeline,
      setVertex: d.setVertex,
      setIndex: d.setIndex,
      setBindGroup: d.setBindGroup,
      draw: d.draw,
      drawIndexed: d.drawIndexed,
      lastPipelineLabels: d.lastPipelineLabels.slice(0, 16),
    };
  });
  pixelSample = await page.evaluate(() => {
    const all = [...document.querySelectorAll('canvas')];
    const inventory = all.map((c) => ({
      id: c.id,
      width: c.width,
      height: c.height,
      cssW: c.clientWidth,
      cssH: c.clientHeight,
    }));
    const c = document.querySelector('#app') ?? document.querySelector('canvas');
    if (!c) return { present: false, inventory };
    const w = c.width,
      h = c.height;
    // Try to read center pixel from a 2D copy (works whether GL or WebGPU).
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return { present: true, w, h, sampled: false };
    ctx.drawImage(c, 0, 0);
    const cx = (w / 2) | 0,
      cy = (h / 2) | 0;
    const px = ctx.getImageData(cx, cy, 1, 1).data;
    const tl = ctx.getImageData(2, 2, 1, 1).data;
    const tr = ctx.getImageData(w - 3, 2, 1, 1).data;
    // Triangle vertices in NDC: v0=(0, 0.7), v1=(-0.7, -0.6), v2=(0.7, -0.6).
    // After the (0,0,3) camera pulled back along -Z, the triangle's NDC
    // bounds shrink. Sample at NDC (0, -0.2) ≈ inside the triangle, expect
    // the mid-grey defaultMaterial baseColor.
    const cx2 = (w * 0.5) | 0;
    const cy2 = (h * 0.6) | 0;
    const inside = ctx.getImageData(cx2, cy2, 1, 1).data;
    return {
      present: true,
      w,
      h,
      inventory,
      sampled: true,
      center: [...px],
      topLeft: [...tl],
      topRight: [...tr],
      insideTri: [...inside],
    };
  });
} catch (e) {
  console.log(`DIAG QUERY FAILED: ${e}`);
}

let screenshotSample = null;
try {
  await page.screenshot({ path: SCREENSHOT, fullPage: false });
  console.log(`---\nSCREENSHOT: ${SCREENSHOT}`);
  // v19 falsify: read the screenshot bitmap and sample triangle-center
  // independently from the live canvas buffer (which loses content after
  // present() under GLES).
  const fs = await import('node:fs/promises');
  const png = await fs.readFile(SCREENSHOT);
  // Extremely tiny PNG IDAT decoder is overkill — instead use the page to
  // read the screenshot we just wrote, but route it through a fresh image:
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  screenshotSample = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const off = document.createElement('canvas');
    off.width = img.width;
    off.height = img.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(img, 0, 0);
    // Triangle in NDC: v0=(0,0.7) v1=(-0.7,-0.6) v2=(0.7,-0.6); CSS canvas
    // is 800×600. Center-x=400, sample y≈400 (lower half, inside triangle).
    const sampleAt = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
    return {
      w: img.width,
      h: img.height,
      // Demo canvas (#app) is 512×512 anchored top-left of the 800×600
      // playwright viewport, so the triangle lives roughly in (150-380,
      // 130-380). Sample at (256, 256) — solidly inside the triangle body
      // for both the unlit-flat (mid-grey ≈ 188) and the LearnOpenGL-orange
      // visual targets. The earlier (400, 380) probe landed in the empty
      // right half and false-failed even when render was correct.
      tri: sampleAt(256, 256),
      // Outside (right of canvas, definitely black):
      outsideL: sampleAt(600, 50),
      // Outside (right side, expected black):
      outsideR: sampleAt(750, 50),
    };
  }, dataUrl);
} catch (e) {
  console.log(`SCREENSHOT FAILED: ${e}`);
}

console.log(`\n=== DRAW DIAG ===`);
console.log(JSON.stringify(diag, null, 2));
console.log(`\n=== PIXEL SAMPLE ===`);
console.log(JSON.stringify(pixelSample, null, 2));
console.log(`\n=== SCREENSHOT SAMPLE ===`);
console.log(JSON.stringify(screenshotSample, null, 2));

await browser.close();

// Pixel gate: require the screenshot triangle sample to be non-black (any
// channel > 16 in tri[]). Disable with REQUIRE_PIXEL=0 for the case where
// only panic detection is wanted (e.g. iterating on shader compile fixes).
const requirePixel = (process.env.REQUIRE_PIXEL ?? '1') !== '0';
const triPixel = screenshotSample?.tri ?? [0, 0, 0, 0];
// Only inspect RGB — alpha is always 255 on a `2d` canvas screenshot, so
// triPixel.some(c => c > 16) would false-pass on an all-black [0,0,0,255]
// frame (the exact failure shape we are gating against).
const pixelDrawn = triPixel.slice(0, 3).some((c) => c > 16);
const pixelGateFailed = requirePixel && navOk && !panicSeen && !pixelDrawn;

// Channel-proof gate: if WebKit somehow exposed navigator.gpu, the engine
// would walk Channel 2 (rhi-webgpu) and the WebGL2 fallback we are gating
// against would be untested. Disable with REQUIRE_NO_GPU=0.
const requireNoGpu = (process.env.REQUIRE_NO_GPU ?? '1') !== '0';
const channelGateFailed = requireNoGpu && channelProof.hasGpu === true;

console.log(`\n=== CHANNEL PROOF ===`);
console.log(`navigator.gpu: ${channelProof.hasGpu}`);
console.log(`webgl2: ${channelProof.gl2}`);
console.log(`expected: navigator.gpu=false (Channel 3 rhi-wgpu) + webgl2=true`);

console.log(`\n=== VERDICT ===`);
console.log(`navigation: ${navOk ? 'OK' : 'FAIL'}`);
console.log(
  `channel: ${channelProof.hasGpu === false ? 'rhi-wgpu (Channel 3)' : channelProof.hasGpu === true ? 'rhi-webgpu (Channel 2 — UNEXPECTED)' : 'unknown'}`,
);
console.log(`panic seen: ${panicSeen}`);
console.log(`triangle drawn: ${pixelDrawn} (sample=${JSON.stringify(triPixel)})`);
console.log(`logs: ${logs.length}`);
const fail = !navOk || panicSeen || pixelGateFailed || channelGateFailed;
if (fail) {
  console.log(
    `RESULT: FAIL (${[!navOk ? 'navigation' : null, panicSeen ? 'panic' : null, pixelGateFailed ? 'all-black-canvas' : null, channelGateFailed ? 'channel-wrong-want-no-gpu' : null].filter(Boolean).join(' + ')})`,
  );
} else {
  console.log('RESULT: PASS (Channel 3 rhi-wgpu wasm GL — wgpu-wasm WebGL2 fallback verified)');
}
process.exit(fail ? 1 : 0);
