// smoke-browser.mjs -- feat-20260621-learn-render-5-5-parallax-mapping
//
// Playwright e2e pixel-readback smoke for the LO 5.5 parallax-mapping demo.
// Spawns a local vite dev server, drives headless Chrome with WebGPU, and
// asserts the FOUR things the dawn structural smoke cannot see:
//   (a) non-black     -- the textured wall actually rendered (not a black frame)
//   (b) displacement  -- the surface has texture detail (channel spread proves a
//                        real diffuse sample reached the shader, not flat white)
//   (c) algo-switch   -- pressing 1 (basic) vs 3 (POM) changes the pixels; this
//                        proves algoMode flows MaterialAsset.paramValues ->
//                        extract -> record -> UBO overlay -> shader dispatch
//                        end-to-end (the per-frame by-ref mutation path, D-7)
//   (d) pageerror     -- any uncaught page error / console error fails the gate
//
// Why a separate script (not the dawn smoke): smoke-dawn.mjs is structural-only
// (frames > 0, onError == 0). A frozen algoMode, a dropped height texture, or a
// black frame would all still pass it. Only a browser pixel readback that
// (i) confirms non-black detail and (ii) diffs two algorithms catches a demo
// that "runs" but does not actually do parallax.
//
// Invocation: `pnpm -F @forgeax/app-learn-render-5-advanced-lighting-5-parallax-mapping smoke:browser`
//
// Exit codes:
//   0 = green (non-black + textured detail + basic!=POM + no page errors)
//   1 = red   (black frame / flat fill / algo switch had no pixel effect / page error)
//   2 = harness error (vite did not boot / canvas pixels unreadable)

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts -> 5.parallax-mapping -> 5.advanced-lighting -> learn-render -> apps -> root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const PKG = '@forgeax/app-learn-render-5-advanced-lighting-5-parallax-mapping';

const viteProc = spawn('pnpm', ['-F', PKG, 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: '1' },
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

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
  ],
});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
// Chrome's console.error for a failed resource load is the generic string
// "Failed to load resource: ... 404" with NO url, so it cannot be classified
// from the console message alone. Track responses separately and only fail on
// a non-incidental 404 (favicon / sourcemap are expected in dev and ignored).
const non404Resources = [];
page.on('response', (resp) => {
  if (resp.status() < 400) return;
  const url = resp.url();
  if (/favicon|\.map(\?|$)/i.test(url)) return;
  non404Resources.push(`HTTP ${resp.status()} ${url}`);
});
page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const txt = msg.text();
  // Drop the urlless generic resource-load console error; the response tracker
  // above is the authoritative source for HTTP failures. Real app/engine
  // console.error lines (which carry a message) still fail the gate.
  if (/Failed to load resource:/i.test(txt)) return;
  errors.push(`CONSOLE-ERR: ${txt}`);
});

const fail = async (code, msg) => {
  console.error(msg);
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(code);
};

await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(5000);

// (d) createApp / page errors short-circuit before pixels.
const createAppFailed = errors.find((e) => /createApp failed|no usable backend|PAGEERROR/i.test(e));
if (createAppFailed) {
  await fail(1, `\n[smoke-browser] RED -- page error before pixels:\n  ${createAppFailed}`);
}

const canvasBox = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  if (canvas === null) return null;
  const r = canvas.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
if (canvasBox === null || canvasBox.width < 1 || canvasBox.height < 1) {
  await fail(2, '\n[smoke-browser] HARNESS ERROR -- canvas element not found / zero-size');
}

// pngjs lives only in pnpm's content-addressable store (transitive dep); glob it.
const { glob } = await import('node:fs/promises').then((m) => ({ glob: m.glob }));
let pngModPath = null;
for await (const p of glob(
  resolve(REPO_ROOT, 'node_modules/.pnpm/pngjs@*/node_modules/pngjs/lib/png.js'),
)) {
  pngModPath = p;
  break;
}
if (pngModPath === null) {
  await fail(2, '\n[smoke-browser] HARNESS ERROR -- pngjs not found under node_modules/.pnpm');
}
const { PNG } = await import(pathToFileURL(pngModPath).href);

const capture = async () => {
  const buf = await page.screenshot({ clip: canvasBox });
  return PNG.sync.read(buf);
};

// --- (a)+(b): non-black + textured detail on the default (POM at start? no,
// the demo starts on basic=0). Press '1' to pin basic explicitly first. ---
await page.keyboard.press('1');
await page.waitForTimeout(800);
let basic;
try {
  basic = await capture();
} catch (e) {
  await fail(2, `\n[smoke-browser] HARNESS ERROR -- PNG decode failed: ${String(e)}`);
}

const { width: w, height: h, data } = basic;
let nonBlack = 0;
let textured = 0;
let sampled = 0;
const y0 = Math.floor(h * 0.3);
const y1 = Math.floor(h * 0.7);
const x0 = Math.floor(w * 0.3);
const x1 = Math.floor(w * 0.7);
for (let y = y0; y < y1; y += 3) {
  for (let x = x0; x < x1; x += 3) {
    const i = (y * w + x) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 200) continue;
    sampled++;
    if (r > 24 || g > 24 || b > 24) nonBlack++;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    if (spread > 18) textured++;
  }
}
console.log(
  '=== probe basic ===',
  JSON.stringify({ w, h, sampled, nonBlack, textured }),
);
if (nonBlack < sampled * 0.2) {
  await fail(
    1,
    `\n[smoke-browser] RED -- frame is essentially black (nonBlack=${nonBlack}/${sampled}); the textured wall did not render.`,
  );
}
if (textured < 100) {
  await fail(
    1,
    `\n[smoke-browser] RED -- too little textured detail (textured=${textured}); the diffuse/height textures did not reach the shader (suspect dropped texture handle).`,
  );
}

// --- (c): switch basic -> POM and require the pixels to change. The parallax
// occlusion march shifts UVs much more aggressively than basic offset, so a
// correct end-to-end algoMode path produces a visible per-pixel delta. ---
await page.keyboard.press('3');
await page.waitForTimeout(800);
let pom;
try {
  pom = await capture();
} catch (e) {
  await fail(2, `\n[smoke-browser] HARNESS ERROR -- PNG decode (POM) failed: ${String(e)}`);
}

let diffPixels = 0;
let comparable = 0;
for (let y = y0; y < y1; y += 3) {
  for (let x = x0; x < x1; x += 3) {
    const i = (y * w + x) * 4;
    if (basic.data[i + 3] < 200 && pom.data[i + 3] < 200) continue;
    comparable++;
    const dr = Math.abs(basic.data[i] - pom.data[i]);
    const dg = Math.abs(basic.data[i + 1] - pom.data[i + 1]);
    const db = Math.abs(basic.data[i + 2] - pom.data[i + 2]);
    if (dr + dg + db > 24) diffPixels++;
  }
}
console.log('=== probe basic-vs-POM ===', JSON.stringify({ comparable, diffPixels }));
if (diffPixels < comparable * 0.02) {
  await fail(
    1,
    `\n[smoke-browser] RED -- switching basic->POM changed almost no pixels ` +
      `(diff=${diffPixels}/${comparable}); algoMode is not flowing paramValues -> ` +
      'extract -> record -> shader (the UBO overlay or by-ref mutation path is broken).',
  );
}

// (d) final error sweep: uncaught page errors, real console errors, and any
// non-incidental HTTP failure (a missing texture / shader / pack-index would
// 404 here).
const allErrors = [...errors, ...non404Resources];
if (allErrors.length > 0) {
  await fail(1, `\n[smoke-browser] RED -- page/console/resource errors:\n  ${allErrors.join('\n  ')}`);
}

console.log(
  `\n[smoke-browser] GREEN -- non-black + textured (textured=${textured}) + ` +
    `algo switch visible (diff=${diffPixels}/${comparable}), no page errors.`,
);
await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);
process.exit(0);
