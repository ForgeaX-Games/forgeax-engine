#!/usr/bin/env node
// apps/collectathon -- Playwright dev-server boot e2e (D-10 zero-tolerance).
//
// Why a SECOND smoke beyond smoke-dawn.mjs (P-13 dawn necessary-but-insufficient):
// the dawn-node smoke replicates the spawn shape against built engine packages
// and skips BOTH the dev-server pack pipeline (JSON.stringify -> fetch ->
// JSON.parse for humanoid.fbx / sky.hdr / audio) AND real WebGPU validation.
// Browser-path-only failures -- typed-array survival across the pack round-trip,
// BGL shape mismatch, vertex-attribute presence, IBL cubemap upload -- surface
// only here. This smoke boots the actual Vite app in headed Chrome+WebGPU and
// asserts the full level boots cleanly.
//
// D-10 zero-tolerance (this rewrite, feat-20260626 M6 / m6-5): the PRIOR version
// of this file WIPED the boot-window console + device errors after the HUD
// appeared (it cleared consoleErrors + __collectathonDeviceErrors, calling
// `render-system-no-camera` a "pre-Play artifact"). That structurally let the
// exact startup crash a human hit on `pnpm dev` pass green. The judgment human
// reject + spike m6-1 proved the boot window IS the system-under-test, not noise.
// The semantics here are INVERTED: the whole boot-to-steady window is asserted
// to be clean. Specifically:
//   (a) ZERO of the three startup crash signatures anywhere in the boot window:
//       render-system-no-camera (R-12), channel-leaf-mismatch (symptom2),
//       MAX_VERTEX_CAPACITY (R-13)
//   (b) ZERO uncaught pageerror in the boot window (page.on('pageerror'))
//   (c) ZERO SUT device/console errors (filtered to this game's surface)
//   (d) Play entered (DOM HUD visible) + cameraCount >= 1
//   (e) entityCount in the locked baseline band (full level instantiated)
//   (f) drawCalls > 0 (the renderer issued geometry -- P-10 guard)
// Nothing is ever wiped.
//
// Structural-only (OOS-7, no pixel readback): visual correctness (bloom glow /
// CSM shadows / IBL skybox) is the browser-PNG SSOT arbitrated by the verify
// sandbox + main session, not this gate. D-10's text channel (boot zero-error)
// is the PRE-CONDITION for the visual gate (a single sandbox PNG does not
// represent the real dev-server path -- the lesson of the judgment reject).
//
// P-11 cold-start: physics (rapier) + audio (Web Audio) + the IBL cubemap
// upload are WASM-heavy and the first dev run also pays Vite dep pre-optimize.
// A fixed wait flakes red; this polls the HUD-visible signal up to 20s.
//
// CI posture (AC-02 / R-14): runs in the self-hosted Linux Chrome-WebGPU job;
// FBX is parsed by the ufbx WASM path and no native SDK is required. Local:
// `pnpm --filter @forgeax/collectathon smoke:browser`.
//
// Output literals (grep-friendly): `[collectathon browser] PASS` / `FAIL`.
// Exit codes: 0 = green, 1 = red (regression), 2 = harness error (vite/browser).

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');

// M5 baseline LOCKED (this is the real-app SSOT for the instantiated count).
// The Play scene spawns: DirectionalLight + Skylight + Camera + ground + 4 walls
// + 12 Cores + Portal + player parent + the instantiated humanoid skeleton
// hierarchy (the bulk of the count) + 3 Guardian bodies + 3 attack sensors +
// SkyboxBackground + 4 audio emitters. Measured live count = 112 on Chromium.
// Locked to a [100, 130] band: below means the level/skeleton failed to
// instantiate (fallback / asset load failure); above means a leak.
const ENTITY_FLOOR = 100;
const ENTITY_CEIL = 130;
const POLL_BUDGET_MS = 20000;

// The three startup crash signatures (D-10). Any occurrence ANYWHERE in the boot
// window is a hard FAIL -- these are exactly the symptoms the judgment human hit
// and the spike m6-1 reproduced. Matched against the full console stream (they
// surface as console error/warning), never wiped.
const CRASH_SIGNATURES = ['render-system-no-camera', 'channel-leaf-mismatch', 'MAX_VERTEX_CAPACITY'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. spawn the Vite dev server ---------------------------------------------

const viteProc = spawn('npx', ['vite', '--host', '127.0.0.1', '--clearScreen', 'false'], {
  cwd: appDir,
  env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
});

// Strip ANSI escape sequences before matching: Vite colorizes its banner even
// under FORCE_COLOR=0 in some terminals, and the codes would otherwise pollute
// the captured URL.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s) => s.replace(ANSI_RE, '');
let portUrl = null;
viteProc.stdout.on('data', (chunk) => {
  const s = stripAnsi(chunk.toString());
  process.stdout.write(`[vite] ${s}`);
  const m = s.match(/Local:\s+(http:\/\/\S+)/);
  if (m) portUrl = m[1].replace(/\/?$/, '/');
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

const viteDeadline = Date.now() + 30000;
while (!portUrl && Date.now() < viteDeadline) await sleep(200);
if (!portUrl) {
  console.error('[collectathon browser] FAIL - vite did not become ready in 30s');
  viteProc.kill();
  process.exit(2);
}
console.log(`[collectathon browser] using ${portUrl}`);

// --- 2. launch headed Chrome with WebGPU --------------------------------------

let browser;
try {
  const chromeChannel = process.env.FORGEAX_CHROME_CHANNEL || 'chrome';
  const chromeArgs = [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
    '--disable-dawn-features=disallow_unsafe_apis',
  ];
  // The self-hosted Linux path uses the same lavapipe/SwiftShader combination
  // as the Vitest browser gate. Without these flags Chrome Beta destroys the
  // WebGPU device during the first collectathon frame.
  if (chromeChannel === 'chrome-beta') {
    chromeArgs.push(
      '--use-vulkan=swiftshader',
      '--disable-vulkan-surface',
      '--disable-gpu-driver-bug-workarounds',
      '--autoplay-policy=no-user-gesture-required',
    );
  }
  browser = await chromium.launch({
    headless: true,
    channel: chromeChannel,
    args: chromeArgs,
  });
} catch (err) {
  console.error(
    `[collectathon browser] FAIL - chromium.launch failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  viteProc.kill();
  process.exit(2);
}

const ctx = await browser.newContext();
const page = await ctx.newPage();

// Collect the FULL boot-window signal (never wiped). pageErrors are uncaught
// exceptions; consoleMessages is every console line (the crash signatures
// surface as error/warning, so we scan the whole stream, not only error-level).
const pageErrors = [];
const consoleMessages = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${e.message}`));
page.on('console', (msg) => {
  const txt = msg.text();
  process.stdout.write(`[page:${msg.type()}] ${txt}\n`);
  consoleMessages.push(txt);
  if (msg.type() === 'error') consoleErrors.push(`CONSOLE-ERR: ${txt}`);
});

// The self-hosted Linux image currently crashes Chromium's WebGPU
// WebGPUSwapBufferProvider when a headless canvas swapchain texture is submitted
// (the same app is stable when the render target is an ordinary GPUTexture).
// Keep this browser gate focused on the dev-server/resource/render-recording
// contract and use a real offscreen GPUTexture only on that runner. The dawn
// smoke remains the swapchain-independent GPU execution gate.
if (process.env.FORGEAX_COLLECTATHON_OFFSCREEN === '1') {
  await page.addInitScript(() => {
    const canvasProto = HTMLCanvasElement.prototype;
    const originalGetContext = canvasProto.getContext;
    canvasProto.getContext = function getContext(kind, ...args) {
      if (kind !== 'webgpu') return originalGetContext.call(this, kind, ...args);
      const canvas = this;
      let device;
      let format = 'bgra8unorm';
      let texture;
      let textureWidth = 0;
      let textureHeight = 0;
      return {
        configure(desc) {
          device = desc.device;
          format = desc.format ?? format;
        },
        unconfigure() {
          texture?.destroy();
          texture = undefined;
          device = undefined;
        },
        getCurrentTexture() {
          if (!device) throw new DOMException('GPUCanvasContext is not configured', 'InvalidStateError');
          const width = Math.max(1, canvas.width);
          const height = Math.max(1, canvas.height);
          if (!texture || width !== textureWidth || height !== textureHeight) {
            texture?.destroy();
            texture = device.createTexture({
              size: { width, height },
              format,
              usage: 0x10 | 0x01,
              viewFormats: format.endsWith('-srgb') ? [] : [`${format}-srgb`],
            });
            textureWidth = width;
            textureHeight = height;
          }
          return texture;
        },
      };
    };
  });
}

// Capture GPU device errors + count draw calls (draw / drawIndexed on every
// render pass encoder). Installed before navigation so the very first frame is
// observed. drawCalls > 0 proves the renderer issued geometry (P-10).
await page.addInitScript(() => {
  globalThis.__collectathonDeviceErrors = [];
  globalThis.__collectathonDrawCalls = 0;
  if (navigator.gpu == null) return;
  const origReqAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  navigator.gpu.requestAdapter = async (...a) => {
    const adapter = await origReqAdapter(...a);
    if (adapter == null) return adapter;
    const origReqDev = adapter.requestDevice.bind(adapter);
    adapter.requestDevice = async (...da) => {
      const dev = await origReqDev(...da);
      if (dev == null) return dev;
      dev.addEventListener('uncapturederror', (ev) => {
        globalThis.__collectathonDeviceErrors.push(String(ev.error?.message ?? ev));
      });
      const origCCE = dev.createCommandEncoder.bind(dev);
      dev.createCommandEncoder = (...ce) => {
        const enc = origCCE(...ce);
        const origBRP = enc.beginRenderPass.bind(enc);
        enc.beginRenderPass = (...rp) => {
          const pass = origBRP(...rp);
          const origDraw = pass.draw.bind(pass);
          pass.draw = (...d) => {
            globalThis.__collectathonDrawCalls += 1;
            return origDraw(...d);
          };
          const origDrawIndexed = pass.drawIndexed.bind(pass);
          pass.drawIndexed = (...d) => {
            globalThis.__collectathonDrawCalls += 1;
            return origDrawIndexed(...d);
          };
          return pass;
        };
        return enc;
      };
      return dev;
    };
    return adapter;
  };
});

// Navigate with retry: Vite prints its banner a moment before the HTTP server
// actually accepts connections, and a back-to-back run (e.g. right after the
// dawn smoke) can momentarily ERR_CONNECTION_REFUSED on the same port. Retry the
// goto for up to 15s rather than failing the whole smoke on a transient refusal.
let navigated = false;
const navDeadline = Date.now() + 15000;
while (!navigated && Date.now() < navDeadline) {
  try {
    await page.goto(portUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    navigated = true;
  } catch (err) {
    process.stdout.write(
      `[collectathon browser] goto retry: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}\n`,
    );
    await sleep(500);
  }
}
if (!navigated) {
  console.error('[collectathon browser] FAIL - could not navigate to the dev server in 15s');
  await finish(2);
}

// --- 3. poll up to 20s for the HUD to become visible (Play entered) -----------

let hudVisible = false;
const pollDeadline = Date.now() + POLL_BUDGET_MS;
while (Date.now() < pollDeadline) {
  hudVisible = await page
    .evaluate(() => {
      const hud = document.getElementById('hud');
      if (hud === null) return false;
      return getComputedStyle(hud).display !== 'none';
    })
    .catch(() => false);
  if (hudVisible) break;
  await sleep(400);
}

if (!hudVisible) {
  console.error('[collectathon browser] FAIL - smoke-browser timeout after 20s: HUD not detected');
  await finish(1);
}

// Give a few extra frames for the Play scene + IBL cubemap to settle (P-12).
// IMPORTANT (D-10): boot-window errors are NOT discarded here -- this rewrite
// removed the prior wipe block. Any crash signature / pageerror that fired from
// the first frame onward is still in pageErrors / consoleMessages and is
// asserted below.
await sleep(1500);

// --- 4. read capture data -----------------------------------------------------

const captured = await page.evaluate(() => {
  const hook = globalThis.__collectathon;
  return {
    entityCount: hook ? hook.entityCount() : -1,
    cameraCount: hook ? hook.cameraCount() : -1,
    deviceErrors: globalThis.__collectathonDeviceErrors ?? [],
    drawCalls: globalThis.__collectathonDrawCalls ?? 0,
  };
});

console.log('[collectathon browser] captured:', JSON.stringify(captured));
console.log(
  `[collectathon browser] pageErrors=${pageErrors.length} consoleErrors=${consoleErrors.length} consoleLines=${consoleMessages.length}`,
);

// --- 5. assertions (D-10 zero-tolerance) --------------------------------------

const failures = [];

// (a) Three startup crash signatures: scan the FULL console stream. Any hit is a
// hard FAIL -- these are the exact symptoms of the judgment-reject crash.
const signatureHits = [];
for (const sig of CRASH_SIGNATURES) {
  const n = consoleMessages.filter((m) => m.includes(sig)).length;
  if (n > 0) signatureHits.push(`${sig} x${n}`);
}
if (signatureHits.length > 0) {
  failures.push(`(a) boot-window crash signature(s): ${signatureHits.join(' | ')}`);
}

// (b) Uncaught exceptions in the boot window.
if (pageErrors.length > 0) {
  failures.push(
    `(b) ${pageErrors.length} uncaught pageerror(s): ${pageErrors.slice(0, 3).join(' | ')}`,
  );
}

// (c) SUT error filter: keep only this game's surface. Excluded as
// environmental, not SUT failures:
//   - AudioContext autoplay (headless has no user gesture)
//   - inspector/console JSON-RPC WS race ('send was called before connect') --
//     the dev inspector socket emits this until it finishes connecting; it is a
//     dev-tooling artifact unrelated to the game's render/logic surface
//   - favicon / dev-asset 404s
const sutErrors = [...captured.deviceErrors, ...consoleErrors].filter((e) => {
  const s = String(e).toLowerCase();
  if (s.includes('audiocontext') || s.includes('was not allowed to start')) return false;
  if (s.includes('send was called before connect')) return false;
  if (s.includes('404') && s.includes('not found')) return false;
  return true;
});
if (sutErrors.length > 0) {
  failures.push(`(c) ${sutErrors.length} SUT error(s): ${sutErrors.slice(0, 5).join(' | ')}`);
}

// (d) Camera present (Play entered + camera ready -- the R-12 surface).
if (captured.cameraCount < 1) {
  failures.push(`(d) cameraCount=${captured.cameraCount} (expected >= 1)`);
}

// (e) Full level instantiated (not a fallback / partial scene).
if (captured.entityCount < ENTITY_FLOOR || captured.entityCount > ENTITY_CEIL) {
  failures.push(`(e) entityCount=${captured.entityCount} outside [${ENTITY_FLOOR}, ${ENTITY_CEIL}]`);
}

// (f) Renderer issued geometry (P-10 guard).
if (captured.drawCalls <= 0) {
  failures.push(`(f) drawCalls=${captured.drawCalls} (expected > 0)`);
}

if (failures.length > 0) {
  console.error(`[collectathon browser] FAIL - ${failures.length} criteria failed:`);
  for (const f of failures) console.error(`  ${f}`);
  await finish(1);
}

console.log(
  `[collectathon browser] PASS - hudVisible=true, entityCount=${captured.entityCount}, cameraCount=${captured.cameraCount}, drawCalls=${captured.drawCalls}, crash signatures=0, pageErrors=0, SUT errors=0`,
);
await finish(0);

// --- helpers ------------------------------------------------------------------

async function finish(code) {
  await browser.close().catch(() => {});
  viteProc.kill();
  process.exit(code);
}
