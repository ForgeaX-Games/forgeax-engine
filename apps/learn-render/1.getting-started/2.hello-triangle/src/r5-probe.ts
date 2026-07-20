// apps/learn-render/1.getting-started/2.hello-triangle/src/r5-probe.ts
// R5 WebKit stability probe page (dev-only, not in dawn smoke roster).
//
// Two modes via URL hash:
//   #mode=a  over-capacity: spawn 15000 mesh entities, verify non-black frame
//                           after SSBO ceiling truncation (WS1 graceful degrade).
//   #mode=b  bad-submit:    submit a command buffer referencing a destroyed buffer,
//                           verify onError receives queue-submit-failed + no panic +
//                           next frame still renders (WS2 on_uncaptured_error isolation).
//
// Exposes window.__r5Probe for the e2e script to read results.

import { World } from '@forgeax/engine-ecs';
import { HANDLE_TRIANGLE } from '@forgeax/engine-assets-runtime';
import { Camera, Engine, EngineEnvironmentError, MeshFilter, MeshRenderer, Transform } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const statusEl = document.getElementById('status')!;

function log(msg: string): void {
  statusEl.textContent += msg + '\n';
}

function win(): Record<string, unknown> {
  return window as unknown as Record<string, unknown>;
}

const MODE = location.hash.slice(1) || 'default';
const errors: Array<{ code: string; hint: string; detail?: unknown }> = [];

interface R5ProbeResult {
  mode: string;
  ready: boolean;
  readyError: { code: string; hint?: string } | null;
  errors: typeof errors;
  overCapacitySpawned: number;
  ceilingHitCount: number;
  exceededHitCount: number;
  badSubmitDone: boolean;
  badSubmitResult: { ok: boolean; code?: string; hint?: string; reason?: string; message?: string } | null;
  nextFrameAfterBadSubmit: boolean;
  onErrorEvents: Array<{ code: string; hint: string; timestamp: number }>;
}

const P: R5ProbeResult = {
  mode: MODE,
  ready: false,
  readyError: null,
  errors,
  overCapacitySpawned: 0,
  ceilingHitCount: 0,
  exceededHitCount: 0,
  badSubmitDone: false,
  badSubmitResult: null,
  nextFrameAfterBadSubmit: false,
  onErrorEvents: [],
};
win().__r5Probe = P;

let _resolveReady: () => void;
const readyPromise = new Promise<void>((resolve) => {
  _resolveReady = resolve;
});
win().__r5Ready = readyPromise;

async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#app');
  if (!canvas) {
    log('missing canvas#app');
    _resolveReady();
    return;
  }

  try {
    const renderer = await Engine.create(canvas, {}, forgeaxBundlerAdapter());
    // Module-lifetime keepalive for the renderer. hello-triangle's index.ts
    // holds its renderer reachable via an infinite recursive rAF closure;
    // this probe runs finite loops and lets main() return, so without a
    // persistent reference the renderer wrapper becomes GC-eligible. On the
    // Channel-3 (wgpu-wasm WebGL2) WebKit path, wasm-bindgen finalization
    // then drops the Rust-side Surface and the next present/lookup panics
    // with `Surface[Id(0,2)] does not exist`. Pinning to window keeps the
    // Surface alive for the page lifetime (the lifetime contract index.ts
    // gets for free from its perpetual rAF) and doubles as the e2e read hook.
    win().__r5Renderer = renderer;
    renderer.onError((e) => {
      const detail = (e as { detail?: unknown }).detail ?? null;
      errors.push({ code: e.code, hint: e.hint || '', detail });
      P.onErrorEvents.push({
        code: e.code,
        hint: e.hint || '',
        timestamp: Date.now(),
      });
      log('onError: ' + e.code + ' ' + (e.hint || ''));
    });

    const ready = await renderer.ready;
    if (!ready.ok) {
      log('ready failed: ' + ready.error.code + ' ' + (ready.error.hint || ''));
      P.readyError = { code: ready.error.code, hint: ready.error.hint };
      _resolveReady();
      return;
    }
    P.ready = true;
    log('renderer ready, backend=' + renderer.backend);

    const world = new World();

    // Camera at z=3, same as hello-triangle defaults.
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
      },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 1000000 } },
    );

    if (MODE === 'mode=a') {
      const N = 15000;
      log('mode a: spawning ' + N + ' entities...');
      for (let i = 0; i < N; i++) {
        world.spawn(
          {
            component: Transform,
            data: {
              pos: [(i % 200) * 0.02 - 2, Math.floor(i / 200) * 0.02 - 2, -1], quat: [0, 0, 0, 1], scale: [0.01, 0.01, 0.01],},
          },
          { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
          { component: MeshRenderer, data: {} },
        );
      }
      P.overCapacitySpawned = N;

      for (let f = 0; f < 10; f++) {
        renderer.draw([world], { owner: 0 });
        await new Promise((r) => requestAnimationFrame(r));
      }

      P.ceilingHitCount = errors.filter((e) => e.code === 'mesh-ssbo-ceiling-reached').length;
      P.exceededHitCount = errors.filter((e) => e.code === 'mesh-ssbo-capacity-exceeded').length;
      log('done. errors=' + errors.length + ' ceiling=' + P.ceilingHitCount + ' exceeded=' + P.exceededHitCount);

      // One more draw + rAF to flush a frame for screenshot.
      renderer.draw([world], { owner: 0 });
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      log('READY_FOR_SCREENSHOT');
    } else if (MODE === 'mode=b') {
      // Spawn visible triangle first frame.
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
        { component: MeshRenderer, data: {} },
      );

      renderer.draw([world], { owner: 0 });
      await new Promise((r) => requestAnimationFrame(r));

      // Trigger a submit-period validation error on the engine's OWN live
      // device (renderer.device), not a freshly-spun second device. On the
      // Channel-3 (wgpu-wasm WebGL2) path a second adapter request without a
      // compatibleSurface fails `adapter-unavailable` (rhi-wgpu requestAdapter
      // requires a compatible surface for GL adapter enumeration), so a
      // second-device approach can never reach the bad submit on WebKit.
      // Reusing renderer.device is also exactly what AC-06 asks: the SAME
      // renderer instance must survive the bad submit and render the next frame.
      try {
        const dev = renderer.device;

        // Buffer with COPY_SRC | COPY_DST so copyBufferToBuffer is structurally
        // valid; destroying it before submit makes the submitted command buffer
        // reference a destroyed resource -> submit-period validation error.
        const bRes = dev.createBuffer({
          label: 'r5p',
          size: 64,
          usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        if (!bRes.ok) {
          P.badSubmitResult = { ok: false, reason: 'buffer-create-failed', code: bRes.error.code };
          log('badSubmit: buffer failed ' + bRes.error.code);
          log('READY_FOR_SCREENSHOT');
          _resolveReady();
          return;
        }
        const buf = bRes.value;

        const eRes = dev.createCommandEncoder({ label: 'r5p-enc' });
        if (!eRes.ok) {
          P.badSubmitResult = { ok: false, reason: 'encoder-create-failed', code: eRes.error.code };
          log('badSubmit: encoder failed ' + eRes.error.code);
          log('READY_FOR_SCREENSHOT');
          _resolveReady();
          return;
        }
        const enc = eRes.value;
        enc.copyBufferToBuffer(buf, 0, buf, 0, 64);
        const cbRes = enc.finish();
        if (!cbRes.ok) {
          P.badSubmitResult = { ok: false, reason: 'finish-failed', code: cbRes.error.code };
          log('badSubmit: finish failed ' + cbRes.error.code);
          log('READY_FOR_SCREENSHOT');
          _resolveReady();
          return;
        }
        const cb = cbRes.value;

        // Destroy the buffer AFTER recording / finishing but BEFORE submit so
        // the in-flight command buffer references a destroyed resource.
        dev.destroyBuffer(buf);

        const sRes = dev.queue.submit([cb]);
        P.badSubmitDone = true;
        P.badSubmitResult = sRes.ok
          ? { ok: true }
          : { ok: false, code: sRes.error.code, hint: sRes.error.hint || '' };
        log('badSubmit: ok=' + sRes.ok + ' code=' + (sRes.ok ? 'none' : sRes.error.code));

        // Next frame with the same renderer must still render (AC-06).
        await new Promise((r) => requestAnimationFrame(r));
        renderer.draw([world], { owner: 0 });
        await new Promise((r) => requestAnimationFrame(r));
        await new Promise((r) => requestAnimationFrame(r));
        P.nextFrameAfterBadSubmit = true;
        log('next frame rendered, instance survived');
        log('READY_FOR_SCREENSHOT');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        log('badSubmit exception: ' + msg);
        P.badSubmitResult = { ok: false, reason: 'exception', message: msg };
        log('READY_FOR_SCREENSHOT');
      }
    } else {
      // Default baseline: render one triangle frame.
      world.spawn(
        {
          component: Transform,
          data: {
            pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_TRIANGLE } },
        { component: MeshRenderer, data: {} },
      );
      renderer.draw([world], { owner: 0 });
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      log('READY_FOR_SCREENSHOT');
    }
  } catch (err: unknown) {
    if (err instanceof EngineEnvironmentError) {
      log('EngineEnvironmentError: ' + err.message);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      log('crash: ' + msg);
    }
  }
  _resolveReady();
}

main();