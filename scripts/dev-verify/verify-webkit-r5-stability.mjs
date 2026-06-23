// scripts/dev-verify/verify-webkit-r5-stability.mjs
//
// bug-20260622 R5 WS1+WS2 shared WebKit e2e probe.
// Mirrors verify-webkit-hello-triangle.mjs structure:
//   webkit.launch -> scan wasm-trap signatures (panicked-at / Unreachable
//   code) -> screenshot non-black -> channel proof -> verdict.
//
// Architecture: reuses the hello-triangle dev server (DEV_SERVER_URL, default
// http://localhost:5181/) which serves the r5-probe.html page. The probe page
// lives at r5-probe.html under the hello-triangle workspace; its <script
// type="module" src="/src/r5-probe.ts"> is transformed by Vite dev server so
// bare imports (@forgeax/engine-*) and virtual:forgeax/bundler resolve
// correctly. No page.route — the dev server serves real pages.
//
// The probe page exposes window.__r5Probe = { mode, ready, errors, ... } and
// window.__r5Ready (Promise<void>) that resolves when main() finishes.
//
// Two workflows:
//   (a) over-capacity: spawns 15000 mesh entities -> screenshot must be
//       non-black (verifies WS1 truncation graceful degradation).
//   (b) bad-submit: destroys a buffer then submits a cmd buf referencing it
//       -> no panicked-at -> onError received RhiError -> next frame renders
//       (verifies WS2 on_uncaptured_error isolation).
//
// Usage:
//   node scripts/dev-verify/verify-webkit-r5-stability.mjs
// Env:
//   DEV_SERVER_URL=http://localhost:5181/  hello-triangle dev server (default)
//   TIMEOUT_MS=60000                        wall-clock budget per mode
//   SCREENSHOT_A=/tmp/r5-over-capacity.png  mode (a) screenshot
//   SCREENSHOT_B=/tmp/r5-bad-submit.png     mode (b) screenshot
//   REQUIRE_PIXEL=1                         disable pixel gate with 0
//   REQUIRE_NO_GPU=1                        disable channel proof gate with 0
//
// Exit codes:
//   0  both modes pass
//   1  any mode fails

import { webkit } from 'playwright';

const DEV_SERVER_URL = (process.env.DEV_SERVER_URL ?? 'http://localhost:5181/').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 60000);
const SCREENSHOT_A = process.env.SCREENSHOT_A ?? '/tmp/r5-over-capacity.png';
const SCREENSHOT_B = process.env.SCREENSHOT_B ?? '/tmp/r5-bad-submit.png';
const REQUIRE_PIXEL = (process.env.REQUIRE_PIXEL ?? '1') !== '0';
const REQUIRE_NO_GPU = (process.env.REQUIRE_NO_GPU ?? '1') !== '0';

// ── helpers ─────────────────────────────────────────────────────────────────

async function screenshotAndSample(page, path) {
  await page.screenshot({ path, fullPage: false });
  const fs = await import('node:fs/promises');
  const png = await fs.readFile(path);
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  return page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const off = document.createElement('canvas');
    off.width = img.width;
    off.height = img.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const sample = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
    // Non-black gate over the whole 512x512 canvas region, not just the
    // center: the over-capacity (mode a) frame renders a grid of tiny meshes
    // clustered in a band, so a single center sample is a false negative.
    // Scan a 16px grid and count any pixel whose RGB exceeds the black floor.
    let nonBlackCount = 0;
    const firstNonBlack = [];
    for (let y = 0; y < 512; y += 16) {
      for (let x = 0; x < 512; x += 16) {
        const c = sample(x, y);
        if (c.slice(0, 3).some((v) => v > 16)) {
          nonBlackCount += 1;
          if (firstNonBlack.length < 3) firstNonBlack.push({ x, y, c: c.slice(0, 3) });
        }
      }
    }
    return {
      center: sample(256, 256),
      nonBlackCount,
      firstNonBlack,
      allBlack: nonBlackCount === 0,
    };
  }, dataUrl);
}

async function runMode(label, hash, screenshotPath) {
  console.log(`--- ${label} ---`);
  const browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

  const logs = [];
  page.on('console', (msg) => logs.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (err) =>
    logs.push({ type: 'pageerror', text: `${err.message}\n${err.stack ?? ''}` }),
  );

  const url = `${DEV_SERVER_URL}/r5-probe.html${hash ? `#${hash}` : ''}`;
  let navOk = true;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 15000 });
  } catch (e) {
    navOk = false;
    logs.push({ type: 'navfail', text: String(e) });
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let panicSeen = false;
  let ready = false;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    for (const l of logs) {
      // Real wasm-trap signatures only. Do NOT grep bare 'Validation Error':
      // WS2's mode=b deliberately triggers a submit-period validation error
      // that the engine now HANDLES (fans out as queue-submit-failed without
      // a panic) — treating that string as a panic would false-positive the
      // very path this probe is asserting works.
      if (l.text.includes('panicked at') || l.text.includes('Unreachable code')) {
        panicSeen = true;
      }
      if (l.text.includes('READY_FOR_SCREENSHOT')) {
        ready = true;
      }
    }
    if (ready || panicSeen) break;
  }

  for (const { type, text } of logs) {
    const short = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    console.log(`  [${type}] ${short}`);
  }

  // Channel proof
  let channelProof = null;
  try {
    channelProof = await page.evaluate(() => ({
      hasGpu: typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu,
      gl2: !!document.createElement('canvas').getContext('webgl2'),
    }));
  } catch {
    /* ok */
  }

  let ss = null;
  try {
    ss = await screenshotAndSample(page, screenshotPath);
    console.log(`  SCREENSHOT: ${screenshotPath}`);
  } catch (e) {
    console.log(`  SCREENSHOT FAILED: ${e}`);
  }

  const probe = await page.evaluate(() => window.__r5Probe ?? null);
  await page.close();
  await browser.close();

  const pixNonBlack = ss && !ss.allBlack;
  return { navOk, panicSeen, ready, logs, channelProof, ss, probe, pixNonBlack };
}

// ── entry ───────────────────────────────────────────────────────────────────

async function run() {
  console.log('=== forgeax R5 WebKit stability probe ===');
  console.log(`dev server: ${DEV_SERVER_URL}`);
  console.log('');

  // Mode (a): over-capacity
  const a = await runMode('MODE (a): over-capacity non-black', 'mode=a', SCREENSHOT_A);
  const passA = a.navOk && !a.panicSeen && (a.pixNonBlack || !REQUIRE_PIXEL);
  console.log(
    '  nav:' +
      (a.navOk ? 'OK' : 'FAIL') +
      ' panic:' +
      a.panicSeen +
      ' pixel:' +
      (a.pixNonBlack === true ? 'NON-BLACK' : a.pixNonBlack === false ? 'BLACK' : 'SKIP'),
  );
  console.log(
    '  ready:' +
      (a.probe?.ready ?? '?') +
      ' spawned:' +
      (a.probe?.overCapacitySpawned ?? 0) +
      ' ceiling:' +
      (a.probe?.ceilingHitCount ?? 0) +
      ' exceeded:' +
      (a.probe?.exceededHitCount ?? 0),
  );
  console.log(`  RESULT: ${passA ? 'PASS' : 'FAIL'}`);

  // Mode (b): bad-submit
  console.log('');
  const b = await runMode('MODE (b): bad-submit survives', 'mode=b', SCREENSHOT_B);
  const bs = b.probe?.badSubmitResult;
  const badSubmitErr = bs && !bs.ok;
  const onErr = b.probe?.onErrorEvents?.some(
    (e) => e.code === 'queue-submit-failed' || e.code === 'webgpu-runtime-error',
  );
  const survived = b.probe?.nextFrameAfterBadSubmit === true;
  const passB =
    b.navOk &&
    !b.panicSeen &&
    (badSubmitErr || onErr) &&
    survived &&
    (b.pixNonBlack || !REQUIRE_PIXEL);

  console.log(
    '  nav:' +
      (b.navOk ? 'OK' : 'FAIL') +
      ' panic:' +
      b.panicSeen +
      ' badSubErr:' +
      badSubmitErr +
      ' onErr:' +
      onErr +
      ' survived:' +
      survived +
      ' pixel:' +
      (b.pixNonBlack === true ? 'NON-BLACK' : b.pixNonBlack === false ? 'BLACK' : 'SKIP'),
  );
  console.log(`  badSubmit: ${JSON.stringify(bs)}`);
  console.log(`  RESULT: ${passB ? 'PASS' : 'FAIL'}`);

  // Overall
  const overall = passA && passB;
  const channelGateFailed = REQUIRE_NO_GPU && a.channelProof?.hasGpu === true;

  console.log('\n=== OVERALL ===');
  console.log(`(a) over-capacity: ${passA ? 'PASS' : 'FAIL'}`);
  console.log(`(b) bad-submit:    ${passB ? 'PASS' : 'FAIL'}`);
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);

  console.log('\n=== CHANNEL PROOF ===');
  console.log(`navigator.gpu: ${a.channelProof?.hasGpu ?? 'unknown'}`);
  console.log(`webgl2: ${a.channelProof?.gl2 ?? 'unknown'}`);

  if (channelGateFailed) {
    console.log('CHANNEL GATE FAILED: navigator.gpu present, not exercising Channel 3');
  }

  const exitCode = overall && !channelGateFailed ? 0 : 1;
  process.exit(exitCode);
}

run().catch((e) => {
  console.error(`PROBE CRASHED: ${e.message || String(e)}`);
  console.error(e.stack);
  process.exit(1);
});
