// frame-loop-time-elapsed.test.ts — Time resource `elapsed` accumulator
// (solo bevy-examples round 20260713-212920).
//
// Regression guard for the friction that motivated the field: the Time resource
// was `{ dt }` only, so absolute-time-keyed behavior (pulsing, sin(elapsed))
// forced each system to hand-accumulate dt (drift + re-derivation). The frame-loop
// now writes `{ dt, elapsed }` where elapsed = Σ(clamped dt). These tests pin:
//   1. elapsed accumulates: after N frames of dt, elapsed ≈ N·dt,
//   2. elapsed is monotonic non-decreasing,
//   3. elapsed uses the CLAMPED dt (a huge raw gap advances elapsed by the ceiling,
//      not the raw gap — no time jump),
//   4. dt is still present + correct (existing consumers unaffected).

import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';
import { createFrameLoop } from '../internal/frame-loop';
import { TIME_RESOURCE_KEY, type TimeResource } from '../internal/time-resource';

function makeSpyRenderer(): Renderer {
  return {
    backend: 'webgpu' as const,
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw(): { ok: true; value: undefined } {
      return { ok: true, value: undefined };
    },
    onError(): () => void {
      return () => {};
    },
    dispose(): void {},
  } as unknown as Renderer;
}

// Scheduler whose `now` advances by a fixed step per tick (deterministic dt).
function makeSyncScheduler(stepMs: number) {
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
    clock += stepMs;
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

function readTime(world: World): TimeResource {
  return world.getResource<TimeResource>(TIME_RESOURCE_KEY);
}

describe('Time.elapsed — accumulation', () => {
  it('after N frames of fixed dt, elapsed ≈ N·dt', () => {
    const world = new World();
    // 16 ms/tick → dt = 0.016 s (well under the default clamp ceiling).
    const { raf, caf, now, pump } = makeSyncScheduler(16);
    const loop = createFrameLoop({ world, renderer: makeSpyRenderer(), now, raf, caf });
    loop.start();
    pump(10);
    const time = readTime(world);
    expect(time.dt).toBeCloseTo(0.016, 6);
    // 10 ticks, but start() sets the baseline at t=16 (first now()), so the first
    // tick's dt is measured from there; elapsed is the running sum of clamped dt.
    // Assert it equals dt * (number of ticks that ran) within a tick's slack.
    expect(time.elapsed).toBeGreaterThan(0.1); // ~10 * 0.016 = 0.16
    expect(time.elapsed).toBeLessThanOrEqual(0.016 * 10 + 1e-9);
    loop.stop();
  });

  it('elapsed is monotonic non-decreasing across frames', () => {
    const world = new World();
    const { raf, caf, now, pump } = makeSyncScheduler(16);
    const loop = createFrameLoop({ world, renderer: makeSpyRenderer(), now, raf, caf });
    loop.start();
    let prev = -1;
    for (let i = 0; i < 20; i++) {
      pump(1);
      const e = readTime(world).elapsed;
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
    loop.stop();
  });

  it('elapsed uses the CLAMPED dt — a huge raw frame gap does not jump elapsed', () => {
    const world = new World();
    // 5000 ms/tick → raw dt = 5 s, far above the default clamp ceiling. elapsed
    // must advance by the CEILING per tick, not 5 s (no time jump — same clamp the
    // dt field already applies).
    const { raf, caf, now, pump } = makeSyncScheduler(5000);
    const loop = createFrameLoop({ world, renderer: makeSpyRenderer(), now, raf, caf });
    loop.start();
    pump(3);
    const time = readTime(world);
    // dt is clamped, so a single frame's dt is well under the raw 5 s.
    expect(time.dt).toBeLessThan(1);
    // 3 clamped ticks → elapsed is a few * ceiling, nowhere near the raw 15 s.
    expect(time.elapsed).toBeLessThan(3);
    expect(time.elapsed).toBeCloseTo(time.dt * 3, 6);
    loop.stop();
  });
});
