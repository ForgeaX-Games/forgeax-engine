// feat-20260708-composited-multi-world-rendering M3 / m3-t3 — AC-03 frame-loop
// [world] wrapping.
//
// The app frame-loop is the single point that shields single-world AI users from
// the multi-world draw signature: internally it wraps the current World into
// `[world]` and passes `{ cameraOwner: 0, resourceOwner: 0 }` (plan-strategy §7 M3). Engine.create /
// createApp public API is unchanged — the user still hands over one World.
//
// This test drives createFrameLoop directly (injected now / raf / caf seams) with
// a spy renderer and asserts the exact call shape:
//   renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })
//
// Test-first (red before m3-i3): the frame-loop currently calls
// renderer.draw(world). After migration these assertions pass and the single
// world identity path (worldId 0) is preserved (AC-03 regression guarantee).

import { Update, World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
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
    attachWorld(): { ok: true; value: undefined } {
      return { ok: true, value: undefined };
    },
    detachWorld(): void {},
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
  it('attaches once before the first update without moving drawSource ahead of update', () => {
    const events: string[] = [];
    const world = new World();
    world
      .addSystem(Update, {
        name: 'observeUpdateOrder',
        queries: [],
        fn: () => events.push('update'),
      })
      .unwrap();
    const renderer = {
      backend: 'webgpu' as const,
      ready: Promise.resolve({ ok: true, value: undefined }),
      attachWorld(): { ok: true; value: undefined } {
        events.push('attach');
        return { ok: true, value: undefined };
      },
      detachWorld(): void {},
      draw(): { ok: true; value: undefined } {
        events.push('draw');
        return { ok: true, value: undefined };
      },
      onError: () => () => {},
      dispose: () => {},
    } as unknown as Renderer;
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      now,
      raf,
      caf,
      drawSource: () => {
        events.push('drawSource');
        return undefined;
      },
    });

    loop.start().unwrap();
    pump(2);
    loop.stop().unwrap();

    expect(events).toEqual([
      'attach',
      'update',
      'drawSource',
      'draw',
      'update',
      'drawSource',
      'draw',
    ]);
  });

  it('calls renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }) once per running frame', () => {
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
      expect(call.options).toEqual({ cameraOwner: 0, resourceOwner: 0 });
    }

    loop.stop();
  });

  it('does not draw a World whose update did not reach terminal publication', () => {
    const world = new World();
    world
      .addSystem(Update, {
        name: 'fail-update',
        queries: [],
        fn: () => {
          throw new Error('update failed');
        },
      })
      .unwrap();
    const { renderer, calls } = makeSpyRenderer();
    const onError = vi.fn();
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({ world, renderer, now, raf, caf, onError });

    loop.start().unwrap();
    pump(1);

    expect(calls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    loop.stop().unwrap();
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
      attachWorld: () => ({ ok: true, value: undefined }),
      detachWorld: () => {},
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
    expect(calls[0]?.options).toEqual({ cameraOwner: 0, resourceOwner: 0 });
    expect(onError).toHaveBeenCalledWith(rhiErr);

    loop.stop();
  });

  it('keeps the rAF heartbeat but freezes draw work during device loss', () => {
    const world = new World();
    let reason: 'alive' | 'device-lost' = 'alive';
    const calls: unknown[] = [];
    const renderer = {
      backend: 'webgpu' as const,
      ready: Promise.resolve({ ok: true, value: undefined }),
      attachWorld: () => ({ ok: true, value: undefined }),
      detachWorld: () => {},
      health: () => ({ reason, recoverable: reason === 'device-lost' }),
      draw(): { ok: true; value: undefined } {
        calls.push(undefined);
        return { ok: true, value: undefined };
      },
      onError(): () => void {
        return () => {};
      },
      dispose(): void {},
    } as unknown as Renderer;
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({ world, renderer, now, raf, caf });
    loop.start();
    pump(1);
    expect(calls).toHaveLength(1);

    reason = 'device-lost';
    pump(3);
    expect(calls).toHaveLength(1);

    reason = 'alive';
    pump(1);
    expect(calls).toHaveLength(2);
    loop.stop();
  });

  it('steps one deterministic frame through the same update and draw authority while paused', () => {
    const world = new World();
    const update = vi.spyOn(world, 'update');
    const { renderer, calls } = makeSpyRenderer();
    const { raf, caf, now } = makeSyncScheduler();
    const loop = createFrameLoop({ world, renderer, now, raf, caf });

    expect(loop.start().ok).toBe(true);
    expect(loop.pause().ok).toBe(true);
    const stepped = loop.stepFrame(1 / 60);

    expect(stepped.ok).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(1 / 60);
    expect(calls).toEqual([{ worlds: [world], options: { cameraOwner: 0, resourceOwner: 0 } }]);

    expect(loop.resume().ok).toBe(true);
    expect(loop.stop().ok).toBe(true);
  });

  it('rejects deterministic stepping outside paused state and with an invalid delta', () => {
    const world = new World();
    const { renderer } = makeSpyRenderer();
    const { raf, caf, now } = makeSyncScheduler();
    const loop = createFrameLoop({ world, renderer, now, raf, caf });

    const idle = loop.stepFrame(1 / 60);
    expect(idle.ok).toBe(false);
    if (!idle.ok) {
      expect(idle.error.code).toBe('app-frame-step-invalid');
      expect(idle.error.detail).toEqual({ state: 'idle', deltaSeconds: 1 / 60, reason: 'state' });
    }

    expect(loop.start().ok).toBe(true);
    expect(loop.pause().ok).toBe(true);
    const invalidDelta = loop.stepFrame(Number.NaN);
    expect(invalidDelta.ok).toBe(false);
    if (!invalidDelta.ok) {
      expect(invalidDelta.error).toMatchObject({
        code: 'app-frame-step-invalid',
        detail: { reason: 'delta' },
      });
    }
    expect(loop.resume().ok).toBe(true);
    expect(loop.stop().ok).toBe(true);
  });

  it('detaches draw-source Worlds as soon as routing stops referencing them', () => {
    const world = new World();
    const overlay = new World();
    const attached: World[] = [];
    const detached: World[] = [];
    const renderer = {
      backend: 'webgpu' as const,
      ready: Promise.resolve({ ok: true, value: undefined }),
      attachWorld(candidate: World) {
        attached.push(candidate);
        return { ok: true as const, value: undefined };
      },
      detachWorld(candidate: World): void {
        detached.push(candidate);
      },
      draw: () => ({ ok: true as const, value: undefined }),
      onError: () => () => {},
      dispose: () => {},
    } as unknown as Renderer;
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      now,
      raf,
      caf,
      drawSource: () => ({ worlds: [world, overlay], cameraOwner: 0, resourceOwner: 0 }),
    });

    loop.start().unwrap();
    pump(2);
    expect(attached).toEqual([world, overlay]);
    expect(detached).toEqual([]);

    loop.setDrawSource(undefined);
    expect(detached).toEqual([overlay]);
    loop.stop().unwrap();
    expect(detached).toEqual([overlay, world]);
  });

  it('detaches active draw-source Worlds when the loop stops', () => {
    const world = new World();
    const overlay = new World();
    const detached: World[] = [];
    const renderer = {
      backend: 'webgpu' as const,
      ready: Promise.resolve({ ok: true, value: undefined }),
      attachWorld: () => ({ ok: true as const, value: undefined }),
      detachWorld(candidate: World): void {
        detached.push(candidate);
      },
      draw: () => ({ ok: true as const, value: undefined }),
      onError: () => () => {},
      dispose: () => {},
    } as unknown as Renderer;
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({
      world,
      renderer,
      now,
      raf,
      caf,
      drawSource: () => ({ worlds: [world, overlay], cameraOwner: 0, resourceOwner: 0 }),
    });

    loop.start().unwrap();
    pump(1);
    loop.stop().unwrap();

    expect(detached).toEqual([overlay, world]);
  });

  it('terminates a paused loop and detaches its primary World exactly once', () => {
    const world = new World();
    const detached: World[] = [];
    const renderer = {
      backend: 'webgpu' as const,
      ready: Promise.resolve({ ok: true, value: undefined }),
      attachWorld: () => ({ ok: true as const, value: undefined }),
      detachWorld(candidate: World): void {
        detached.push(candidate);
      },
      draw: () => ({ ok: true as const, value: undefined }),
      onError: () => () => {},
      dispose: () => {},
    } as unknown as Renderer;
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({ world, renderer, now, raf, caf });

    loop.start().unwrap();
    pump(1);
    loop.pause().unwrap();
    loop.stop().unwrap();

    expect(loop.getState()).toBe('stopped');
    expect(detached).toEqual([world]);
  });

  it('terminal setStopped releases attachments once across repeated cleanup', () => {
    const world = new World();
    const detached: World[] = [];
    const renderer = {
      backend: 'webgpu' as const,
      ready: Promise.resolve({ ok: true, value: undefined }),
      attachWorld: () => ({ ok: true as const, value: undefined }),
      detachWorld(candidate: World): void {
        detached.push(candidate);
      },
      draw: () => ({ ok: true as const, value: undefined }),
      onError: () => () => {},
      dispose: () => {},
    } as unknown as Renderer;
    const { raf, caf, now, pump } = makeSyncScheduler();
    const loop = createFrameLoop({ world, renderer, now, raf, caf });

    loop.start().unwrap();
    pump(1);
    loop.setStopped();
    loop.setStopped();

    expect(loop.getState()).toBe('stopped');
    expect(detached).toEqual([world]);
  });
});
