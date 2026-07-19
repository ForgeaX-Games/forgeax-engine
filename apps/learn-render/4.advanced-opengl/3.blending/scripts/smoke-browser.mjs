// smoke-browser.mjs -- bug-20260619-material-shader-paramschema-texture-under-declaration
//
// Playwright e2e smoke for apps/learn-render/4.advanced-opengl/3.blending.
// Spawns a local vite dev server, drives headed Chrome with WebGPU enabled,
// and asserts the transparent grass + window quads render with their texture
// (NOT the opaque neutral-white regression).
//
// Why a separate script (not the dawn smoke):
// `smoke-dawn.mjs` asserts "pixels differ from clear color", which `[0,0,0]`
// and even an opaque-white quad both satisfy. The regression this gate guards
// (a custom material shader whose paramSchema omits a sampled baseColorTexture,
// so extract's `validateTextureHandle` silently drops the handle and binds the
// default WHITE texture) is invisible to the dawn smoke -- it renders white
// quads that "differ from clear color" and passes. Only a browser pixel
// readback that checks the pane is NOT neutral-white catches it. See
// docs/handover/2026-06-19-blending-transparency-regression-bisect.md.
//
// Invocation: `pnpm -F @forgeax/app-learn-render-4-advanced-opengl-3-blending smoke:browser`
//
// Exit codes:
//   0 = green (a transparent window pane sampled the window texture: pane is
//       reddish, NOT opaque neutral-white, AND no createApp/backend error)
//   1 = red (regression: opaque-white panes, or createApp failed)
//   2 = harness error (vite did not boot / canvas pixels unreadable)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/learn-render/4.advanced-opengl/3.blending/scripts -> repo root (5 up):
// scripts -> 3.blending -> 4.advanced-opengl -> learn-render -> apps -> root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');
const PKG = '@forgeax/app-learn-render-4-advanced-opengl-3-blending';

const viteProc = spawn('pnpm', ['-F', PKG, 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
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
page.on('console', (msg) => {
  const txt = msg.text();
  if (msg.type() === 'error') errors.push(`CONSOLE-ERR: ${txt}`);
});

await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(6000);

// createApp failure short-circuits the whole demo -- catch it before pixels.
const createAppFailed = errors.find((e) => /createApp failed|no usable backend/i.test(e));
if (createAppFailed) {
  console.error(`\n[smoke-browser] RED -- engine init failed:\n  ${createAppFailed}`);
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}

// Read back the canvas pixels across the horizontal mid-band where the 5 grass
// + window quads sit. A headless WebGPU canvas cannot be read via
// `drawImage()` into a 2D canvas (the compositor surface is opaque to
// getImageData), so we capture through Playwright's `page.screenshot` (the real
// compositor path) and decode the PNG with pngjs. Each opaque sampled pixel is
// classified:
//   - "neutral-white": r,g,b all high AND near-equal (the regression signature
//     -- the default white texture with no tint) -> BAD
//   - "textured": any pixel where the channels diverge enough to prove a real
//     texture sample reached the shader (green grass blades, red glass) -> GOOD
const canvasBox = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  if (canvas === null) return null;
  const r = canvas.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
if (canvasBox === null || canvasBox.width < 1 || canvasBox.height < 1) {
  console.error('\n[smoke-browser] HARNESS ERROR -- canvas element not found / zero-size');
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(2);
}
const pngBuffer = await page.screenshot({ clip: canvasBox });

await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);

// pngjs ships only inside pnpm's content-addressable store (a transitive dep of
// the toolchain, not declared by this app), so a bare `import('pngjs')` does not
// resolve. Glob the hoisted copy under node_modules/.pnpm and import it by URL.
const { glob } = await import('node:fs/promises').then((m) => ({ glob: m.glob }));
let pngModPath = null;
for await (const p of glob(resolve(REPO_ROOT, 'node_modules/.pnpm/pngjs@*/node_modules/pngjs/lib/png.js'))) {
  pngModPath = p;
  break;
}
if (pngModPath === null) {
  console.error('\n[smoke-browser] HARNESS ERROR -- pngjs not found under node_modules/.pnpm');
  process.exit(2);
}
const { PNG } = await import(pathToFileURL(pngModPath).href);
let png;
try {
  png = PNG.sync.read(pngBuffer);
} catch (e) {
  console.error(`\n[smoke-browser] HARNESS ERROR -- PNG decode failed: ${String(e)}`);
  process.exit(2);
}
const { width: w, height: h, data } = png;
let neutralWhite = 0;
let textured = 0;
let opaqueSampled = 0;
const y0 = Math.floor(h * 0.35);
const y1 = Math.floor(h * 0.75);
for (let y = y0; y < y1; y += 4) {
  for (let x = 0; x < w; x += 4) {
    const i = (y * w + x) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 200) continue;
    // Skip the near-black background + dark floor + dark window frame.
    if (r < 60 && g < 60 && b < 60) continue;
    opaqueSampled++;
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    const spread = maxc - minc;
    if (maxc > 180 && spread < 24) neutralWhite++;
    else if (spread > 30) textured++;
  }
}
const probe = { ok: true, w, h, neutralWhite, textured, opaqueSampled };
console.log('=== pixel probe ===', JSON.stringify(probe));

// The regression renders the panes opaque neutral-white with effectively zero
// textured pixels. The fixed demo shows green grass blades + red glass, i.e.
// many textured pixels and the textured count dominating neutral-white.
if (probe.textured < 200) {
  console.error(
    '\n[smoke-browser] RED -- too few textured pixels ' +
      `(textured=${probe.textured}, neutralWhite=${probe.neutralWhite}, ` +
      `opaqueSampled=${probe.opaqueSampled}). The grass / window textures did not ` +
      'reach the shader. Suspect: a custom material shader paramSchema that omits a ' +
      'sampled baseColorTexture (extract validateTextureHandle drops the handle -> ' +
      'default white). See docs/handover/2026-06-19-blending-transparency-regression-bisect.md.',
  );
  process.exit(1);
}
if (probe.neutralWhite > probe.textured) {
  console.error(
    '\n[smoke-browser] RED -- neutral-white pixels dominate ' +
      `(neutralWhite=${probe.neutralWhite} > textured=${probe.textured}); ` +
      'panes rendered opaque white (the texture-drop regression).',
  );
  process.exit(1);
}

console.log(
  `\n[smoke-browser] GREEN -- transparent quads sampled their textures ` +
    `(textured=${probe.textured}, neutralWhite=${probe.neutralWhite}).`,
);
process.exit(0);
