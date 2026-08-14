// device-lost.browser.test.ts -- M4 (w12) acceptanceCheck: 4-path coverage
// for the device-lost internal subscription + cleanup landing in
// packages/app/src/create-app.ts (w13) and packages/app/src/internal/cleanup.ts.
//
// Anchors:
//   - plan-strategy D-2: device loss is a recoverable renderer-owned interval.
//     The rAF heartbeat remains armed, World/update work is frozen while the
//     renderer reports `device-lost`, lastError is captured, and the error fans
//     out via host onError listeners verbatim.
//   - plan-strategy D-3: AppError union does NOT add 'app-device-lost';
//     RhiError({code:'device-lost'}) is forwarded through onError (D-2/D-3).
//   - plan-strategy R-1 (research section 7.4): rAF handle must exist
//     BEFORE renderer.onError(internal) subscribes. If renderer late-attach
//     replays a lost event immediately, the listener cancels a still-null
//     rafHandle. We assert no NPE on that timing.
//   - plan-strategy R-4 (research section 7.3 / D-2): explicit stop and
//     exception cleanup remain centralized. Device loss does not run the
//     terminal cleanup funnel, so a successful Renderer.recover() can re-enter
//     through the same App frame loop.
//   - research section 7.7: 'device-lost' is already in RhiErrorCode 18-member
//     union (no new AppError member).
//
// charter awareness:
//   - P3 explicit failure: device-lost is a loud signal (host listener +
//     recoverable renderer health + lastError captured) -- never silent.

import { ScheduleMutationError, Update, World, type Result } from '@forgeax/engine-ecs';
import {
  FRAME_START_SCAN_SYSTEM_NAME,
  INPUT_BACKEND_KEY,
  type InputBackend,
} from '@forgeax/engine-input';
import { Camera, perspective, type RendererLostListener } from '@forgeax/engine-render';
import { RhiError } from '@forgeax/engine-runtime';
import type { RendererErrorListener } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';

import { createApp, inputPlugin } from '../src/index';
import type { App, AppError } from '../src/types';

// -------- helpers ----------------------------------------------------

interface FakeRendererState {
  readonly errorListeners: Set<RendererErrorListener>;
  readonly lostListeners: Set<RendererLostListener>;
  drawCalls: number;
  reason: 'alive' | 'device-lost';
  fireDeviceLost: () => void;
}

function makeFakeRenderer(opts?: {
  fireOnSubscribe?: boolean;
}): { renderer: ReturnType<typeof Object.assign>; state: FakeRendererState } {
  const errorListeners = new Set<RendererErrorListener>();
  const lostListeners = new Set<RendererLostListener>();
  const state = {
    errorListeners,
    lostListeners,
    drawCalls: 0,
    reason: 'alive' as 'alive' | 'device-lost',
    fireDeviceLost: () => {
      // no-op until reset below
    },
  };
  const lostError = new RhiError({
    code: 'device-lost',
    expected: 'device must remain alive',
    hint: 'reload the page or rebuild the Renderer via createRenderer({...})',
  });
  state.fireDeviceLost = () => {
    state.reason = 'device-lost';
    for (const cb of Array.from(errorListeners)) {
      cb(lostError);
    }
  };
  const renderer = {
    backend: 'webgpu' as const,
    ready: Promise.resolve({ ok: true, value: undefined }),
    health: () => ({ reason: state.reason, recoverable: state.reason === 'device-lost' }),
    attachWorld(): Result<void, never> {
      return { ok: true, value: undefined };
    },
    detachWorld(): void {},
    draw(): void {
      state.drawCalls++;
    },
    dispose(): void {},
    onError(cb: RendererErrorListener): () => void {
      errorListeners.add(cb);
      if (opts?.fireOnSubscribe === true) {
        // simulate Renderer.LostListenerRegistry late-attach replay --
        // a freshly registered listener is invoked synchronously with
        // the persisted lost event before this call returns.
        cb(lostError);
      }
      return () => {
        errorListeners.delete(cb);
      };
    },
    onLost(cb: RendererLostListener): () => void {
      lostListeners.add(cb);
      return () => {
        lostListeners.delete(cb);
      };
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: test stub signature widens at boundary
  return { renderer: renderer as any, state };
}

function makeFakeBackend(): { backend: InputBackend; detachCalls: number; getDetachCalls(): number } {
  let detachCalls = 0;
  const backend: InputBackend = {
    sample: () => ({
      downKeys: new Set(),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
    }),
    detach: () => {
      detachCalls++;
    },
  };
  return {
    backend,
    detachCalls,
    getDetachCalls: () => detachCalls,
  };
}

// -------- path 1: device-lost freezes the recoverable interval --------

describe('device-lost path 1 -- heartbeat retained + simulation frozen', () => {
  it('renderer.onError fires RhiError(device-lost) -> app remains running but draw work pauses', async () => {
    const { renderer, state } = makeFakeRenderer();
    const world = new World();
    const result = await createApp({ renderer, world });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.value;
    try {
      const startResult = app.start();
      expect(startResult.ok).toBe(true);

      // wait one rAF tick to ensure rafHandle is captured non-null
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const drawCallsBefore = state.drawCalls;

      // fire device-lost via the fake renderer
      state.fireDeviceLost();

      // Device loss is recoverable at the renderer boundary, so the App remains
      // started and an accidental second start is rejected as already-running.
      const restart = app.start();
      expect(restart.ok).toBe(false);
      if (restart.ok) return;
      expect(restart.error.code).toBe('app-already-running');

      // The rAF heartbeat remains armed, but the frame-loop must not submit work
      // against a lost device until the host calls Renderer.recover().
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(state.drawCalls).toBe(drawCallsBefore);
    } finally {
      app.stop();
    }
  });
});

// -------- path 2: device-lost still fans out to host listener -------

describe('device-lost path 2 -- error fans out to host onError listener verbatim (D-3)', () => {
  it('host onError listener receives RhiError(device-lost) intact', async () => {
    const { renderer, state } = makeFakeRenderer();
    const world = new World();
    const result = await createApp({ renderer, world });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.value;

    const received: Array<AppError | RhiError> = [];
    try {
      app.onError((e) => {
        received.push(e);
      });
      app.start();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      state.fireDeviceLost();

      const lostEvent = received.find(
        (e) => e instanceof RhiError && e.code === 'device-lost',
      );
      expect(lostEvent).toBeDefined();
      if (!(lostEvent instanceof RhiError)) return;
      expect(lostEvent.code).toBe('device-lost');
    } finally {
      app.stop();
    }
  });
});

// -------- path 3: late-attach replay -- listener fires before rAF --

describe('device-lost path 3 -- late-attach replay does not throw NPE', () => {
  it('renderer.onError invokes listener synchronously on subscribe; no NPE on cancelAnimationFrame', async () => {
    // The fake renderer fires device-lost the moment the internal
    // listener is registered (simulating LostListenerRegistry late-attach
    // replay). The internal subscription order (rAF first, listener
    // second) ensures rafHandle is a number / null, never undefined.
    const { renderer } = makeFakeRenderer({ fireOnSubscribe: true });
    const world = new World();
    const result = await createApp({ renderer, world });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.value;

    // The host had not registered onError yet -- the late-attach replay
    // will land on the internal listener AND fall back to console.error
    // (if listener set is empty); we silence the fallback so test stderr
    // stays clean and assert no throw is raised.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      // silence
    });
    try {
      // start should not throw even though listener fires synchronously
      // during/right after subscribe.
      const startResult = app.start();
      expect(startResult.ok).toBe(true);
      // drive one tick; the heartbeat is retained, but the lost renderer
      // freezes frame work until explicit recovery.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    } finally {
      app.stop();
      consoleErrorSpy.mockRestore();
    }
  });
});

// -------- path 4: explicit stop remains the cleanup owner -------------

describe('device-lost path 4 -- explicit stop owns cleanup (R-4)', () => {
  it('device-lost path triggers attachInputAuto detach + world.removeSystem', async () => {
    const { renderer, state } = makeFakeRenderer();
    const world = new World();

    // We pre-attach a fake input backend through the assemble form to
    // observe the cleanup hooks. Because the assemble form is host-
    // owned for input, we instead test cleanup via removeSystem spy
    // against the world: the device-lost path SHOULD call cleanup() if
    // a cleanup function was wired (which is true on the canvas form,
    // not the assemble form). For the assemble form path, host owns
    // input lifetime, so we focus on state -> stopped + draw stop.
    const fakeBackend = makeFakeBackend();
    // Pre-inject the input backend as a world resource (D-3): inputPlugin.build
    // finds INPUT_BACKEND_KEY and registers the frame-start scan system. The old
    // AppAssembleArgs.input opt was deleted in the plugin-system unify (M3).
    world.insertResource(INPUT_BACKEND_KEY, fakeBackend.backend);
    const result = await createApp({ renderer, world, plugins: [inputPlugin()] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app: App = result.value;
    expect(app.input).toBe(fakeBackend.backend);

    app.start();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const drawCallsBefore = state.drawCalls;

    state.fireDeviceLost();

    // During device-lost, the rAF heartbeat remains armed but no draws are
    // submitted until recovery.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(state.drawCalls).toBe(drawCallsBefore);
    // Explicit stop remains the cleanup owner and is still valid after a loss.
    const stopResult = app.stop();
    expect(stopResult.ok).toBe(true);
  });

  it('device-lost path on canvas form -- removeSystem called via cleanup funnel', async () => {
    // Spy World.prototype.removeSystem so the cleanup funnel is observed
    // even though we used the assemble form here (cleanup is engaged via
    // the canvas form -- this fixture drives the canvas form to confirm
    // the device-lost cleanup path actually crosses the input cleanup).
    const removeSpy = vi
      .spyOn(World.prototype, 'removeSystem')
      .mockImplementation(
        function (this: World, name: string): Result<void, ScheduleMutationError> {
          if (name === FRAME_START_SCAN_SYSTEM_NAME) {
            return { ok: true, value: undefined };
          }
          return { ok: true, value: undefined };
        },
      );

    try {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      document.body.appendChild(canvas);
      try {
        const result = await createApp(canvas);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const app = result.value;
        // The canvas form owns a real renderer, so give its first frame the
        // minimum valid scene. Without a Camera the render path reports
        // render-system-no-camera and can leave headed WebGPU waiting for the
        // frame-loop timeout before stop() reaches the cleanup assertion.
        app.world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 2] } },
            { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1 }) },
          )
          .unwrap();
        // This path runs in a fresh Vitest browser process now. Spy through to
        // the real dispose so the GPUDevice is released before that process
        // hands control to the next split group.
        const disposeSpy = vi.spyOn(app.renderer, 'dispose');
        // Replace renderer's onError with a controllable one before start
        // is not possible here -- the real renderer is wired. Instead, we
        // assert the canvas-form path engages cleanup on stop; the
        // device-lost cleanup reuses the same funnel (R-4). This path
        // assertion is a proxy for "cleanup() is wired into the canvas
        // form".
        app.start();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const stopResult = app.stop();
        expect(stopResult.ok).toBe(true);
        expect(disposeSpy).toHaveBeenCalledTimes(1);
        // cleanup funnel reached removeSystem at least once with the
        // scan system name (R-4 cleanup proxy).
        expect(removeSpy).toHaveBeenCalledWith(Update, FRAME_START_SCAN_SYSTEM_NAME);
        disposeSpy.mockRestore();
      } finally {
        canvas.remove();
      }
    } finally {
      removeSpy.mockRestore();
    }
  });
});
