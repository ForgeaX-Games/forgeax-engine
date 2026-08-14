import { World } from '@forgeax/engine-ecs';
import { createProfiler } from '@forgeax/engine-profiler';
import type { DrawOwnerOptions, Renderer } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

import { createFrameLoop } from '../internal/frame-loop';
import { APP_PHASE_CATALOG } from '../types';

function makeScheduler() {
  let callback: ((timestamp: number) => void) | undefined;
  return {
    raf(next: (timestamp: number) => void): number {
      callback = next;
      return 1;
    },
    caf(): void {
      callback = undefined;
    },
    tick(timestamp: number): void {
      const next = callback;
      callback = undefined;
      next?.(timestamp);
    },
  };
}

function makeRenderer(draw: (options: DrawOwnerOptions) => void): Renderer {
  return {
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    attachWorld: () => ({ ok: true, value: undefined }),
    detachWorld: () => {},
    draw: (_worlds: World[], options: DrawOwnerOptions) => {
      draw(options);
      return { ok: true, value: undefined };
    },
    onError: () => () => {},
    onLost: () => () => {},
    dispose: () => {},
  } as unknown as Renderer;
}

function start(profiler: ReturnType<typeof createProfiler>) {
  const result = profiler.startCapture({ frameLimit: 2, eventLimit: 64 });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function finish(profiler: ReturnType<typeof createProfiler>) {
  const session = profiler.activeSession();
  if (session === undefined) {
    const latest = profiler.latestCapture();
    if (latest === undefined) throw new Error('capture did not publish');
    return latest;
  }
  const result = session.finish();
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe('App and Render profiler integration', () => {
  it('keeps normal and App-only frames on one capture identity', () => {
    const profiler = createProfiler();
    start(profiler);
    const scheduler = makeScheduler();
    const drawOptions: DrawOwnerOptions[] = [];
    const loop = createFrameLoop({
      world: new World(),
      renderer: makeRenderer((options) => drawOptions.push(options)),
      now: () => 1000,
      raf: scheduler.raf,
      caf: scheduler.caf,
      profiler,
    });

    loop.start().unwrap();
    scheduler.tick(1000);
    loop.stop().unwrap();

    const capture = finish(profiler);
    expect(capture.records.filter((record) => record.source === 'app')).toHaveLength(5);
    expect(capture.records.every((record) => record.frameId === 1)).toBe(true);
    expect(drawOptions[0]).toMatchObject({
      profileFrame: { captureId: capture.captureId, frameId: 1 },
    });
    expect(capture.phaseCatalog.app).toEqual(APP_PHASE_CATALOG);
  });

  it('isolates a renderer failure while the host frame loop continues', () => {
    const profiler = createProfiler();
    start(profiler);
    const scheduler = makeScheduler();
    let draws = 0;
    const errors: unknown[] = [];
    const loop = createFrameLoop({
      world: new World(),
      renderer: makeRenderer(() => {
        draws += 1;
        throw new Error('render failure');
      }),
      now: () => 1000,
      raf: scheduler.raf,
      caf: scheduler.caf,
      onError: (error) => errors.push(error),
      profiler,
    });

    loop.start().unwrap();
    scheduler.tick(1000);
    scheduler.tick(1000);
    loop.stop().unwrap();

    const capture = finish(profiler);
    expect(draws).toBe(2);
    expect(errors).toHaveLength(2);
    expect(capture.records.filter((record) => record.source === 'app')).toHaveLength(10);
  });
});
