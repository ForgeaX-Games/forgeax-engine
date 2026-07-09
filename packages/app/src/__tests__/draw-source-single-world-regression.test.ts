// feat-20260709-editor-world-partition-editorworld-super-composite / M2 / w8
// (RED — impl lands in w12). Contract test: the drawSource injection seam MUST
// degrade to the existing single-world path byte-identically when the host does
// not opt in.
//
// Two non-opt-in shapes must both reproduce the legacy call
// `renderer.draw([world], { owner: 0 })` (feat-20260708 M3 / AC-03 wrapping):
//
//   1. `drawSource` absent entirely — the createApp/frame-loop caller passes no
//      drawSource (the single-world AI-user default).
//   2. `drawSource` present but returning `undefined` on the frame — a host
//      that wired the seam but, this frame, has nothing multi-world to inject
//      (e.g. editor with no partitioned viewport active).
//
// Both cases MUST call `renderer.draw([world], { owner: 0 })` with the loop's
// own single world and owner 0. This pins the AC-03 regression guarantee across
// the new seam: adding drawSource never perturbs the single-world path.
//
// This test drives createFrameLoop directly (injected now / raf / caf seams)
// with a spy renderer, mirroring frame-loop-world-array.test.ts. The drawSource
// option is reached through a typed alias so the intent reads clearly before w12
// widens the real FrameLoopOptions type (test-first RED window).
//
// Anchors:
//   plan-strategy §2 D-3 (drawSource pull callback; absent / undefined -> single
//     world path byte-identical to draw([world], { owner: 0 }))
//   research F1 (frame-loop hardcodes renderer.draw([world], { owner: 0 }) — the
//     seam insertion point)

import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';
import { createFrameLoop, type FrameLoopOptions } from '../internal/frame-loop';

interface DrawCall {
  readonly worlds: unknown;
  readonly options: unknown;
}

function makeSpyRenderer(): { renderer: Renderer; calls: DrawCall[] } {
  const calls: DrawCall[] = [];
  const renderer = {
    backend: 'webgpu' as const,
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw(worlds: unknown, options: unknown): { ok: true; value: undefined } {
      calls.push({ worlds, options });
      return { ok: true, value: undefined };
    },
    onError(): () => void {
      return () => {
        // no-op unsubscribe
      };
    },
    dispose(): void {
      // no-op
    },
  } as unknown as Renderer;
  return { renderer, calls };
}

/**
 * Synchronous rAF driver: fire the scheduled tick exactly `frames` times.
 * Mirrors frame-loop-world-array.test.ts so both single-world contract tests
 * step the loop identically.
 */
function makeSyncScheduler() {
  let pending: ((t: number) => void) | null = null;
  let clock = 0;
  const raf = (cb: (t: number) => void): number => {
    pending = cb;
    return 1;
  };
  const caf = (): void => {
    pending = null;
  };
  const now = (): number => {
    clock += 16;
    return clock;
  };
  const pump = (frames: number): void => {
    for (let i = 0; i < frames; i++) {
      const cb = pending;
      pending = null;
      if (cb === null) break;
      cb(clock);
    }
  };
  return { raf, caf, now, pump };
}

// The drawSource pull callback shape w11/w12 will introduce on FrameLoopOptions.
// Declared locally so this test states the contract independent of the (not-yet
// widened) source type. `undefined` return = "no multi-world injection this
// frame" (degrade to single world).
type DrawSourceCallback = () =>
  | { worlds: readonly World[]; cameraOwner: number; resourceOwner: number }
  | undefined;

type FrameLoopOptionsWithDrawSource = FrameLoopOptions & {
  drawSource?: DrawSourceCallback;
};

const createFrameLoopWithDrawSource = createFrameLoop as unknown as (
  opts: FrameLoopOptionsWithDrawSource,
) => ReturnType<typeof createFrameLoop>;

describe('drawSource seam degrades to single-world path (w8, AC-03 regression)', () => {
  it('no drawSource: draws [world] with { owner: 0 } every frame (legacy path)', () => {
    const world = new World();
    const { renderer, calls } = makeSpyRenderer();
    const { raf, caf, now, pump } = makeSyncScheduler();

    // No drawSource field at all — the single-world AI-user default.
    const loop = createFrameLoop({ world, renderer, now, raf, caf });
    expect(loop.start().ok).toBe(true);
    pump(3);

    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(Array.isArray(call.worlds)).toBe(true);
      const arr = call.worlds as unknown[];
      expect(arr.length).toBe(1);
      expect(arr[0]).toBe(world);
      expect(call.options).toEqual({ owner: 0 });
    }

    loop.stop();
  });

  it('drawSource returns undefined: still draws [world] with { owner: 0 } (no-inject frame)', () => {
    const world = new World();
    const { renderer, calls } = makeSpyRenderer();
    const { raf, caf, now, pump } = makeSyncScheduler();

    let pulls = 0;
    const drawSource: DrawSourceCallback = () => {
      pulls++;
      // Host wired the seam but has nothing multi-world to inject this frame.
      return undefined;
    };

    const loop = createFrameLoopWithDrawSource({ world, renderer, now, raf, caf, drawSource });
    expect(loop.start().ok).toBe(true);
    pump(3);

    // The seam was consulted (pull callback fired) but the resulting draw is
    // byte-identical to the legacy single-world call.
    expect(pulls).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(Array.isArray(call.worlds)).toBe(true);
      const arr = call.worlds as unknown[];
      expect(arr.length).toBe(1);
      expect(arr[0]).toBe(world);
      expect(call.options).toEqual({ owner: 0 });
    }

    loop.stop();
  });
});
