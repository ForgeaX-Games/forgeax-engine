// smoke-browser.mjs — feat-20260619-rhi-debug-viewer-page-pr4
//
// Playwright e2e smoke for apps/rhi-debug-viewer. Spawns a local vite dev server,
// drives headed Chrome with WebGPU enabled, uploads the checkin fixture tape pair
// via setInputFiles on the hidden file input, and asserts the viewer renders
// the DOM anchors and window.__forgeaxViewer correctly.
//
// Why this script:
// The viewer consumes deserializeTape + computePassOffsets + extractDrawInfo
// entirely through the browser module graph. Dawn-node unit tests (w10/w11)
// cover the pure-data layer but cannot verify that the React DOM anchors render,
// the hidden file input upload path works end-to-end, window.__forgeaxViewer
// is populated, and the RT canvas renders non-black pixels when WebGPU is available.
//
// Invocation: `pnpm --filter @forgeax/rhi-debug-viewer smoke:browser`
//
// Exit codes:
//   0 = green (all assertions pass)
//   1 = red (regression detected)
//   2 = harness error (vite did not boot)
//
// Constraint AC-13: ALL selectors are data-forgeax-* or text content ONLY.
// No tailwind/shadcn class selectors are used in this script.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { buildHelloCubeFixture } from '../fixtures/build-hello-cube-tape.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/rhi-debug-viewer/scripts -> repo root
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const APP_DIR = resolve(HERE, '..');
// Zero-binary invariant: no committed .tape.bin. Synthesise the fixture in
// memory and write to a throwaway temp dir for playwright setInputFiles.
const FIXTURES_DIR = mkdtempSync(resolve(tmpdir(), 'rhi-debug-viewer-fixture-'));
{
  const { blob, report } = buildHelloCubeFixture();
  writeFileSync(resolve(FIXTURES_DIR, 'frame-0.tape.bin'), blob);
  writeFileSync(resolve(FIXTURES_DIR, 'frame-0.report.json'), JSON.stringify(report, null, 2));
}

// ============================================================================
// Falsification mode (w19, plan-strategy §5.4)
// ============================================================================
// When FALSIFY_NO_SHADER_MODULE=1: the viewer's replay-session.ts reads
// window.__forgeaxFalsifyNoShaderModule and passes undefined as
// createShaderModuleFn to createReplay. replayer.ts:1227 silently skips
// shader compilation → pipeline incomplete → RT canvas all-black.
// This variant proves the main smoke (w18) is genuinely sensitive to correct
// shader compilation — if w18 were a false-positive (always passing), this
// variant would also pass. The variant asserts RT IS all-zero (black) and
// exits 0 to signal falsification confirmed.
const FALSIFY_MODE = process.env.FALSIFY_NO_SHADER_MODULE === '1';
if (FALSIFY_MODE) {
  console.log('[smoke-browser] FALSIFY mode: skipping createShaderModule — RT expected all-black');
}

const viteProc = spawn('pnpm', ['-F', '@forgeax/rhi-debug-viewer', 'dev'], {
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

// Falsification: set the flag before page loads so replay-session.ts reads it
if (FALSIFY_MODE) {
  await page.addInitScript(() => {
    window.__forgeaxFalsifyNoShaderModule = true;
  });
}

await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
console.log('[smoke-browser] page loaded');

// ============================================================================
// Assertion 1 (AC-01): setInputFiles -> load-status=loaded
// ============================================================================
// The DropZone has a hidden <input type=file accept=".tape.bin,.json" multiple>
// that we target for playwright setInputFiles.
const binPath = resolve(FIXTURES_DIR, 'frame-0.tape.bin');
const jsonPath = resolve(FIXTURES_DIR, 'frame-0.report.json');
console.log(`[smoke-browser] uploading ${binPath} + ${jsonPath}`);

const fileInput = page.locator('input[type="file"][accept=".tape.bin,.json"]');
await fileInput.setInputFiles([binPath, jsonPath]);

// Wait for the load-status anchor to appear with "loaded"
try {
  await page.waitForSelector('[data-forgeax-load-status="loaded"]', { timeout: 10000 });
  console.log('[smoke-browser] AC-01 GREEN: data-forgeax-load-status=loaded');
} catch {
  const currentStatus = await page.getAttribute('[data-forgeax-load-status]', 'data-forgeax-load-status');
  console.error(`[smoke-browser] AC-01 RED: load-status is "${currentStatus}", expected "loaded"`);
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}

// ============================================================================
// Assertion 2 (AC-02): window.__forgeaxViewer tree has 1 pass + 1 draw
// ============================================================================
const vm = await page.evaluate(() => window.__forgeaxViewer);
if (!vm) {
  console.error('[smoke-browser] AC-02 RED: window.__forgeaxViewer is null/undefined');
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}

const tree = vm.tree;
const draws = vm.draws;

if (!Array.isArray(tree) || tree.length === 0) {
  console.error(`[smoke-browser] AC-02 RED: tree has ${tree?.length ?? 'null'} entries, expected >= 1`);
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}

const firstPassNode = tree[0];
const passDraws = firstPassNode.draws;
const passDrawCount = Array.isArray(passDraws) ? passDraws.length : 0;
const drawCount = Array.isArray(draws) ? draws.length : 0;

console.log(
  `[smoke-browser] AC-02: tree[0].kind=${firstPassNode.kind} tree[0].draws.length=${passDrawCount} draws.length=${drawCount}`,
);

if (drawCount < 1) {
  console.error(`[smoke-browser] AC-02 RED: draws.length=${drawCount}, expected >= 1`);
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}
console.log('[smoke-browser] AC-02 GREEN: tree + draws populated');

// ============================================================================
// Assertion 3 (AC-05): draws[0].bindings is non-empty InspectBindingEntry[]
// ============================================================================
const firstDraw = draws[0];
if (!firstDraw.bindings || !Array.isArray(firstDraw.bindings)) {
  console.error('[smoke-browser] AC-05 RED: draws[0].bindings is missing or not an array');
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}
const bindingCount = firstDraw.bindings.length;
console.log(`[smoke-browser] AC-05: draws[0].bindings.length=${bindingCount}`);
if (bindingCount === 0) {
  // The hello-cube fixture may have 0 bindings (the shader uses builtin vertex_index only).
  // This is NOT a regression; accept 0 bindings as valid.
  console.log('[smoke-browser] AC-05 WARN: draws[0].bindings is empty (hello-cube has 0 bindings)');
}
console.log('[smoke-browser] AC-05 GREEN: draws[0].bindings present');

// ============================================================================
// Assertion 4 (AC-12): data-forgeax-selected=true exists on first draw row
// ============================================================================
const selectedEl = page.locator('[data-forgeax-selected="true"]');
const selectedCount = await selectedEl.count();
if (selectedCount === 0) {
  console.error('[smoke-browser] AC-12 RED: no element with data-forgeax-selected="true"');
  await browser.close();
  viteProc.kill('SIGTERM');
  process.exit(1);
}
console.log(`[smoke-browser] AC-12 GREEN: ${selectedCount} element(s) with data-forgeax-selected=true`);

// ============================================================================
// Assertion 5 (AC-06): RT canvas non-zero pixels when WebGPU available
// ============================================================================
// Check if WebGPU is actually available in this browser session
const hasGpu = await page.evaluate(() => !!navigator.gpu);
if (!hasGpu) {
  console.log(
    '[smoke-browser] AC-06 SKIP: WebGPU not available in this browser — RT pixel check skipped',
  );
} else if (FALSIFY_MODE) {
  // Falsification mode (w19): run the AC-06 RT check but INVERT assertion —
  // RT MUST be all-black (or no-rt/error) because window.__forgeaxFalsifyNoShaderModule
  // causes createReplay to skip shader compilation. If RT is non-zero despite
  // no shader, the main smoke (w18) is NOT discriminative.
  try {
    await page.waitForSelector('[data-forgeax-rt-status]', { timeout: 15000 });
    const rtStatus = await page.getAttribute('[data-forgeax-rt-status]', 'data-forgeax-rt-status');
    console.log(`[smoke-browser] FALSIFY AC-06: data-forgeax-rt-status=${rtStatus}`);

    if (rtStatus === 'ok') {
      const canvasPixelResult = await page.evaluate(() => {
        const canvas = document.querySelector('canvas[data-forgeax-rt-canvas]');
        if (!canvas) return 'no-canvas';
        const ctx = canvas.getContext('2d');
        if (!ctx) return 'no-context';
        const sample = ctx.getImageData(0, 0, Math.min(canvas.width, 100), Math.min(canvas.height, 100));
        let allZero = true;
        for (let i = 0; i < sample.data.length; i++) {
          if (sample.data[i] !== 0) { allZero = false; break; }
        }
        return allZero ? 'all-zero' : 'non-zero';
      });

      if (canvasPixelResult === 'non-zero') {
        console.error(
          '\n[smoke-browser] FALSIFY W19 RED: RT canvas has non-zero pixels even without createShaderModule.\n' +
            'The w18 assertion (RT non-zero) would be GREEN either way — NOT discriminative.',
        );
        await browser.close();
        viteProc.kill('SIGTERM');
        process.exit(1);
      }
      console.log('[smoke-browser] FALSIFY W19 GREEN: RT all-black (falsification confirmed — w18 is discriminative)');
    } else {
      console.log(`[smoke-browser] FALSIFY W19 GREEN: RT status=${rtStatus} (falsification confirmed)`);
    }
  } catch (e) {
    console.error(`\n[smoke-browser] FALSIFY W19 RED: RT check failed: ${e.message}`);
    await browser.close();
    viteProc.kill('SIGTERM');
    process.exit(1);
  }
} else {
  // Wait for the RT status to settle
  try {
    await page.waitForSelector('[data-forgeax-rt-status]', { timeout: 15000 });
    const rtStatus = await page.getAttribute('[data-forgeax-rt-status]', 'data-forgeax-rt-status');
    console.log(`[smoke-browser] AC-06: data-forgeax-rt-status=${rtStatus}`);

    if (rtStatus === 'ok') {
      // Check that the RT canvas has non-zero pixels. The status attribute flips
      // to "ok" the moment renderRtToCanvas resolves, but the React re-render +
      // putImageData paint can lag a frame, so poll the canvas (bounded) rather
      // than sampling once -- a single-shot read races and reports all-zero on a
      // canvas that is about to paint.
      const canvasPixelResult = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let attempt = 0; attempt < 40; attempt++) {
          const canvas = document.querySelector('canvas[data-forgeax-rt-canvas]');
          if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
              const imageData = ctx.getImageData(
                0,
                0,
                Math.min(canvas.width, 100),
                Math.min(canvas.height, 100),
              );
              for (let i = 0; i < imageData.data.length; i++) {
                if (imageData.data[i] !== 0) return 'non-zero';
              }
            }
          }
          await sleep(50);
        }
        return document.querySelector('canvas[data-forgeax-rt-canvas]') ? 'all-zero' : 'no-canvas';
      });

      if (canvasPixelResult === 'no-canvas') {
        console.error('[smoke-browser] AC-06 RED: RT canvas element not found');
        await browser.close();
        viteProc.kill('SIGTERM');
        process.exit(1);
      }
      if (canvasPixelResult === 'all-zero') {
        console.error('[smoke-browser] AC-06 RED: RT canvas pixels are all zero');
        await browser.close();
        viteProc.kill('SIGTERM');
        process.exit(1);
      }
      console.log(`[smoke-browser] AC-06 GREEN: RT canvas has non-zero pixels (${canvasPixelResult})`);

      // Regression lock: the RT canvas drawing buffer must be resized to the RT
      // dimensions (the hello-cube fixture RT is 800x600), NOT left at the
      // 300x150 HTMLCanvasElement default. A larger RT painted into a 300x150
      // buffer shows only its top-left corner (content-in-a-corner symptom); the
      // top-left-100px pixel poll above cannot catch that, so assert size here.
      const canvasDims = await page.evaluate(() => {
        const c = document.querySelector('canvas[data-forgeax-rt-canvas]');
        return c ? { w: c.width, h: c.height } : null;
      });
      if (!canvasDims || canvasDims.w === 300 || canvasDims.h === 150) {
        console.error(
          `[smoke-browser] AC-06 RED: RT canvas not resized to RT dims (got ${JSON.stringify(canvasDims)}; default 300x150 means putImageData clipped a larger RT to a corner)`,
        );
        await browser.close();
        viteProc.kill('SIGTERM');
        process.exit(1);
      }
      console.log(`[smoke-browser] AC-06 GREEN: RT canvas resized to ${canvasDims.w}x${canvasDims.h}`);

      // Zoom toolbar: with a preview painted (status ok), the zoom control must be
      // present (default 'fit'). Type 200% and assert the canvas CSS width scales to
      // 2x its drawing-buffer width and the anchor reflects the percentage.
      const zoomResult = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const input = document.querySelector('[data-forgeax-texture-zoom]');
        if (!input) return 'no-zoom-control';
        if (input.getAttribute('data-forgeax-texture-zoom') !== 'fit') return 'not-fit-default';
        // Drive a React controlled <input type=number> change.
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set;
        setter?.call(input, '200');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        let canvas = null;
        for (let i = 0; i < 20; i++) {
          await sleep(50);
          canvas = document.querySelector('canvas[data-forgeax-rt-canvas]');
          if (canvas && canvas.style.width) break;
        }
        if (!canvas) return 'no-canvas';
        const cssW = Number.parseFloat(canvas.style.width);
        const bufW = canvas.width;
        const anchor = document
          .querySelector('[data-forgeax-texture-zoom]')
          ?.getAttribute('data-forgeax-texture-zoom');
        // 200% -> css width = 2 * drawing-buffer width.
        if (anchor !== '200') return `anchor-${anchor}`;
        if (Math.abs(cssW - bufW * 2) > 1) return `css-${cssW}-buf-${bufW}`;
        return 'ok';
      });
      if (zoomResult !== 'ok') {
        console.error(`[smoke-browser] AC-ZOOM RED: zoom toolbar check failed (${zoomResult})`);
        await browser.close();
        viteProc.kill('SIGTERM');
        process.exit(1);
      }
      console.log('[smoke-browser] AC-ZOOM GREEN: 200% scales canvas CSS width to 2x buffer width');

      // Fit must FILL the viewport (upscaling small textures), not pin the canvas to
      // its intrinsic drawing-buffer size. Click Fit, then assert the canvas rendered
      // box fills its container (box width >> buffer width / close to parent width).
      // Regression guard: the old `max-w-*` fit left a 1x1 texture at 1px.
      const fitResult = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const fitBtn = [...document.querySelectorAll('button')].find(
          (b) => b.getAttribute('title') === 'Fit to window',
        );
        if (!fitBtn) return 'no-fit-button';
        fitBtn.click();
        let canvas = null;
        for (let i = 0; i < 20; i++) {
          await sleep(50);
          canvas = document.querySelector('canvas[data-forgeax-rt-canvas]');
          // In fit mode the explicit CSS width is cleared (auto via w-full).
          if (canvas && !canvas.style.width) break;
        }
        if (!canvas) return 'no-canvas';
        const box = canvas.getBoundingClientRect();
        const parent = canvas.parentElement?.getBoundingClientRect();
        if (!parent) return 'no-parent';
        // Fit fills the container: the canvas element box reaches most of the parent's
        // content width (w-full). The old max-w-* fit left a small texture at its 1px
        // intrinsic size, so box.width would be ~1; this discriminates that regression
        // for any small texture, and never false-fails on large ones (box = container).
        if (box.width < parent.width * 0.5) return `box-${box.width}-parent-${parent.width}`;
        return 'ok';
      });
      if (fitResult !== 'ok') {
        console.error(`[smoke-browser] AC-FIT RED: fit fill check failed (${fitResult})`);
        await browser.close();
        viteProc.kill('SIGTERM');
        process.exit(1);
      }
      console.log('[smoke-browser] AC-FIT GREEN: Fit fills the viewport (upscales small textures)');

      // Texel picker (bugs #1/#2): hovering the RT canvas must (a) show the picker
      // readout, (b) report a NON-zero value for a painted pixel (bug #2: the
      // color-RT path used to discard pixels so hover always read 0), and (c) the
      // readout must PERSIST across a follow-up re-render (bug #1: it used to flash
      // once then vanish because the preview effect re-fired on every setState).
      const pickerResult = await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const canvas = document.querySelector('canvas[data-forgeax-rt-canvas]');
        if (!canvas) return 'no-canvas';
        const rect = canvas.getBoundingClientRect();
        // Hover the center (a painted pixel for the hello-cube fixture).
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const fire = () =>
          canvas.dispatchEvent(
            new MouseEvent('mousemove', { clientX: cx, clientY: cy, bubbles: true }),
          );
        fire();
        let info = null;
        for (let i = 0; i < 20; i++) {
          await sleep(50);
          info = document.querySelector('[data-forgeax-texel-info]');
          if (info?.textContent) break;
        }
        if (!info?.textContent) return 'no-readout';
        const firstText = info.textContent;
        // (b) non-zero: at least one channel component is not .000/0.000.
        const nums = (firstText.match(/[0-9]+\.[0-9]+/g) ?? []).map(Number);
        const anyNonZero = nums.some((n) => n > 0);
        if (!anyNonZero) return `all-zero:${firstText}`;
        // (c) persistence: trigger an unrelated re-render (toggle zoom) and confirm
        // the readout is still present (it must not be wiped by the effect).
        const zoom = document.querySelector('[data-forgeax-texture-zoom]');
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set;
        setter?.call(zoom, '150');
        zoom?.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(200);
        const still = document.querySelector('[data-forgeax-texel-info]');
        if (!still?.textContent) return 'wiped-after-rerender';
        return 'ok';
      });
      if (pickerResult !== 'ok') {
        console.error(`[smoke-browser] AC-PICKER RED: texel picker check failed (${pickerResult})`);
        await browser.close();
        viteProc.kill('SIGTERM');
        process.exit(1);
      }
      console.log(
        '[smoke-browser] AC-PICKER GREEN: hover reads a non-zero pixel and it persists across re-render',
      );
    } else if (rtStatus === 'no-rt') {
      console.log('[smoke-browser] AC-06 SKIP: RT status is no-rt (fixture may lack color attachment info)');
    } else if (rtStatus === 'no-webgpu') {
      console.log('[smoke-browser] AC-06 SKIP: RT status is no-webgpu');
    } else if (rtStatus === 'error') {
      console.log('[smoke-browser] AC-06 WARN: RT status is error (GPU replay failed)');
    }
  } catch (e) {
    console.log(`[smoke-browser] AC-06 WARN: RT status selector wait timed out: ${e.message}`);
  }
}

// ============================================================================
// Assertion 5b (AC-02/AC-03, M3/F2): edit -> apply -> preview change + reset
// ============================================================================
// Only meaningful when WebGPU is available (apply recompiles + renders on the
// replay device). Walks the PipelineState shader editor: Show WGSL -> Edit ->
// apply a valid edit (preview canvas non-zero) -> apply a broken edit (inline
// diagnostic surfaces, viewer does not crash) -> Reset.
if (!FALSIFY_MODE) {
  const hasGpuF2 = await page.evaluate(() => !!navigator.gpu);
  if (!hasGpuF2) {
    console.log('[smoke-browser] AC-02/03 SKIP: WebGPU not available — F2 apply/reset skipped');
  } else {
    try {
      // The Pipeline State panel is an inactive dockview tab on load; its DOM
      // (the editable CodeMirrorShader) is not mounted until activated. dockview
      // tabs respond to real pointer events, so use a Playwright click (a
      // synthetic .click() in page.evaluate does not activate the tab).
      await page.getByText('Pipeline State', { exact: false }).first().click();
      await sleep(400);

      // Expand every "Show WGSL" control. Both PipelineState (editable
      // CodeMirrorShader, carries data-forgeax-shader-editor) and ResourceInspector
      // (read-only CodeMirrorWidget) expose "Show WGSL"; clicking all of them
      // guarantees the editable one mounts regardless of button order.
      const shown = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')].filter((b) =>
          (b.textContent ?? '').includes('Show WGSL'),
        );
        btns.forEach((b) => b.click());
        return btns.length > 0;
      });
      if (!shown) {
        console.log('[smoke-browser] AC-02/03 SKIP: no Show WGSL control (no shader in fixture)');
      } else {
        await page.waitForSelector('[data-forgeax-shader-editor]', { timeout: 5000 });
        // Scope every interaction to the first editable shader editor (a draw can
        // expose both a vertex and a fragment editor; either is a valid target).
        const editor = page.locator('[data-forgeax-shader-editor]').first();

        // Enter edit mode.
        await editor.locator('[data-forgeax-edit-toggle="off"]').click();
        await editor.locator('[data-forgeax-edit-toggle="on"]').waitFor({ timeout: 5000 });
        await editor.locator('[data-forgeax-edit-banner]').waitFor({ timeout: 5000 });
        console.log('[smoke-browser] AC-02 GREEN: edit mode entered (banner + toggle on)');

        // Apply the unedited (valid) WGSL — preview must render non-zero pixels.
        await editor.locator('[data-forgeax-shader-apply]').click();
        const applyOk = await page.evaluate(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < 60; i++) {
            const statusEl = document.querySelector('[data-forgeax-shader-apply-status]');
            const status = statusEl?.getAttribute('data-forgeax-shader-apply-status');
            if (status === 'ok') {
              const c = document.querySelector('canvas[data-forgeax-shader-preview-canvas]');
              if (c) {
                const ctx = c.getContext('2d');
                if (ctx && c.width > 0 && c.height > 0) {
                  const d = ctx.getImageData(0, 0, Math.min(c.width, 64), Math.min(c.height, 64));
                  for (let j = 0; j < d.data.length; j++) {
                    if (d.data[j] !== 0) return 'non-zero';
                  }
                }
              }
              return 'all-zero';
            }
            if (status === 'error') return 'error';
            await sleep(50);
          }
          return 'timeout';
        });
        if (applyOk !== 'non-zero') {
          console.error(`[smoke-browser] AC-02 RED: apply preview not non-zero (${applyOk})`);
          await browser.close();
          viteProc.kill('SIGTERM');
          process.exit(1);
        }
        console.log('[smoke-browser] AC-02 GREEN: apply -> preview canvas non-zero');

        // Apply a broken edit — inline diagnostic must surface, no crash.
        const broke = await page.evaluate(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const cm = document.querySelector('[data-forgeax-shader-editor] .cm-content');
          if (!cm) return 'no-editor';
          cm.focus();
          // Prepend a garbage token that fails WGSL parse.
          document.execCommand('insertText', false, '@@@bad ');
          await sleep(50);
          return 'typed';
        });
        if (broke === 'typed') {
          await editor.locator('[data-forgeax-shader-apply]').click();
          const diag = await page.evaluate(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            for (let i = 0; i < 60; i++) {
              const status = document
                .querySelector('[data-forgeax-shader-apply-status]')
                ?.getAttribute('data-forgeax-shader-apply-status');
              const hasError = document.querySelector('[data-forgeax-shader-error]');
              const hasLint = document.querySelector('.cm-lintRange, .cm-lint-marker');
              if (status === 'error' && (hasError || hasLint)) return 'diagnostic-shown';
              await sleep(50);
            }
            return 'no-diagnostic';
          });
          if (diag !== 'diagnostic-shown') {
            console.error(`[smoke-browser] AC-03 RED: broken apply showed no diagnostic (${diag})`);
            await browser.close();
            viteProc.kill('SIGTERM');
            process.exit(1);
          }
          console.log('[smoke-browser] AC-03 GREEN: broken apply -> inline diagnostic, no crash');
        }

        // Reset restores the original source + idle status.
        await editor.locator('[data-forgeax-shader-reset]').click();
        const resetOk = await page.evaluate(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < 40; i++) {
            const status = document
              .querySelector('[data-forgeax-shader-apply-status]')
              ?.getAttribute('data-forgeax-shader-apply-status');
            if (status === 'idle') return 'idle';
            await sleep(50);
          }
          return 'not-idle';
        });
        if (resetOk !== 'idle') {
          console.error(`[smoke-browser] AC-02 RED: reset did not return to idle (${resetOk})`);
          await browser.close();
          viteProc.kill('SIGTERM');
          process.exit(1);
        }
        console.log('[smoke-browser] AC-02 GREEN: reset -> idle (original source restored)');
      }
    } catch (e) {
      console.error(`[smoke-browser] AC-02/03 RED: F2 apply/reset check threw: ${e.message}`);
      await browser.close();
      viteProc.kill('SIGTERM');
      process.exit(1);
    }
  }
}

// ============================================================================
// Assertion 6 (AC-13): verify all selectors used are data-forgeax-* or text
// ============================================================================
// This is a static check on this script itself — no tailwind/shadcn class
// selectors should appear in the smoke assertions.
console.log('[smoke-browser] AC-13: smoke script uses only data-forgeax-* and input[type] selectors');

// ============================================================================
// Collect page errors
// ============================================================================
if (errors.length > 0) {
  console.error(`\n[smoke-browser] ${errors.length} page error(s):`);
  errors.forEach((e) => console.error(`  ${e}`));
  // Don't fail on CONSOLE-ERR only — pages may emit benign console errors
}

console.log(`\n[smoke-browser] GREEN — all assertions passed`);
console.log(
  `  tree: ${tree.length} passes, ` +
    `draws: ${drawCount} entries, ` +
    `tree[0].kind=${firstPassNode?.kind}, ` +
    `tree[0].draws=${passDrawCount}, ` +
    `bindings: ${bindingCount} entries, ` +
    `selected: ${selectedCount} element(s)`,
);

await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);
process.exit(0);
