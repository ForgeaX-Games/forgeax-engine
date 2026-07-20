// feat-20260708-composited-multi-world-rendering M3 / m3-t3 — AC-03 frame-loop
// [world] wrapping.
//
// The app frame-loop is the single point that shields single-world AI users from
// the multi-world draw signature: internally it wraps the current World into
// `[world]` and passes `{ owner: 0 }` (plan-strategy §7 M3). Engine.create /
// createApp public API is unchanged — the user still hands over one World.
//
// This test drives createFrameLoop directly (injected now / raf / caf seams) with
// a spy renderer and asserts the exact call shape:
//   renderer.draw([world], { owner: 0 })
//
// Test-first (red before m3-i3): the frame-loop currently calls
// renderer.draw(world). After migration these assertions pass and the single
// world identity path (worldId 0) is preserved (AC-03 regression guarantee).

import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-runtime';
import { describe, expect, it, vi } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';

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
 * The injected `raf` stores the next callback; `pump` invokes it, which in
 * turn schedules the following one, so we can step the loop deterministically.
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

describe('M3 / m3-t3 — frame-loop wraps the single World into [world] with owner 0', () => {
  it('calls renderer.draw([world], { owner: 0 }) once per running frame', () => {
    const world = new World();
    const { renderer, calls } = makeSpyRenderer();
    const { raf, caf, now, pump } = makeSyncScheduler();

    const loop = createFrameLoop({ world, renderer, now, raf, caf });
    const started = loop.start();
    expect(started.ok).toBe(true);

    // start() schedules the first tick via raf (it does not run synchronously);
    // pump three ticks so we observe 3 frames total.
    pump(3);

    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      // The worlds argument is an array carrying exactly the single world.
      expect(Array.isArray(call.worlds)).toBe(true);
      const arr = call.worlds as unknown[];
      expect(arr.length).toBe(1);
      expect(arr[0]).toBe(world);
      // owner is the required, defaulted-to-0 index (single-world identity).
      expect(call.options).toEqual({ owner: 0 });
    }

    loop.stop();
  });

  it('does not mutate the public frame-loop contract: start/stop return Result.ok', () => {
    const world = new World();
    const { renderer } = makeSpyRenderer();
    const { raf, caf, now } = makeSyncScheduler();
    const loop = createFrameLoop({ world, renderer, now, raf, caf });

    const started = loop.start();
    expect(started.ok).toBe(true);
    const stopped = loop.stop();
    expect(stopped.ok).toBe(true);
  });

  it('forwards a draw Result.err through onError (single world path unchanged)', () => {
    const world = new World();
    const calls: DrawCall[] = [];
    const rhiErr = { code: 'rhi-not-available' } as const;
    const renderer = {
      backend: 'webgpu' as const,
      ready: Promise.resolve({ ok: true, value: undefined }),
      draw(worlds: unknown, options: unknown): { ok: false; error: typeof rhiErr } {
        calls.push({ worlds, options });
        return { ok: false, error: rhiErr };
      },
      onError(): () => void {
        return () => {
          // no-op
        };
      },
      dispose(): void {
        // no-op
      },
    } as unknown as Renderer;
    const onError = vi.fn();
    const { raf, caf, now, pump } = makeSyncScheduler();

    const loop = createFrameLoop({ world, renderer, now, raf, caf, onError });
    loop.start();
    // start() schedules the first tick via raf; pump once to run it.
    pump(1);

    expect(calls[0]?.worlds).toEqual([world]);
    expect(calls[0]?.options).toEqual({ owner: 0 });
    expect(onError).toHaveBeenCalledWith(rhiErr);

    loop.stop();
  });
});
