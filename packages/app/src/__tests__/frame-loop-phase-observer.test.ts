import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

import { createFrameLoop } from '../internal/frame-loop';
import type { FramePhaseEvent } from '../types';

function makeRenderer(draw: Renderer['draw'] = () => ({ ok: true, value: undefined })): Renderer {
  return {
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw,
    onError: () => () => {},
    onLost: () => () => {},
    dispose: () => {},
  } as unknown as Renderer;
}

function makeScheduler() {
  let callback: ((timestamp: number) => void) | undefined;
  return {
    raf: (next: (timestamp: number) => void): number => {
      callback = next;
      return 1;
    },
    caf: (): void => {
      callback = undefined;
    },
    tick(timestamp: number): void {
      const next = callback;
      callback = undefined;
      next?.(timestamp);
    },
  };
}

describe('frame-loop phase observer', () => {
  it('emits a complete, ordered phase span for the single-world path', () => {
    const events: FramePhaseEvent[] = [];
    const world = new World();
    const scheduler = makeScheduler();
    const loop = createFrameLoop({
      world,
      renderer: makeRenderer(),
      now: (() => {
        const values = [1000, 1016];
        return () => values.shift() ?? 1016;
      })(),
      raf: scheduler.raf,
      caf: scheduler.caf,
      framePhaseObserver: { onEvent: (event) => events.push(event) },
    });

    loop.start().unwrap();
    scheduler.tick(1016);

    expect(events.map((event) => `${event.phase}:${event.boundary}`)).toEqual([
      'frame-total:begin',
      'world-update-primary:begin',
      'world-update-primary:end',
      'draw-source:begin',
      'draw-source:end',
      'world-update-injected:begin',
      'world-update-injected:end',
      'renderer-draw:begin',
      'renderer-draw:end',
      'frame-total:end',
    ]);
    expect(new Set(events.map((event) => event.frameSeq))).toEqual(new Set([1]));
    expect(
      events
        .filter((event) => event.phase === 'world-update-primary')
        .every((event) => event.worldCount === 1),
    ).toBe(true);
    expect(
      events
        .filter((event) => event.phase === 'world-update-injected')
        .every((event) => event.worldCount === 0),
    ).toBe(true);
  });

  it('counts only non-primary injected worlds and closes spans when draw throws', () => {
    const events: FramePhaseEvent[] = [];
    const own = new World();
    const injected = new World();
    const scheduler = makeScheduler();
    const onError: unknown[] = [];
    const loop = createFrameLoop({
      world: own,
      renderer: makeRenderer(() => {
        throw new Error('draw failure');
      }),
      now: () => 1016,
      raf: scheduler.raf,
      caf: scheduler.caf,
      onError: (error) => onError.push(error),
      drawSource: () => ({ worlds: [own, injected], cameraOwner: 0, resourceOwner: 0 }),
      framePhaseObserver: { onEvent: (event) => events.push(event) },
    });

    loop.start().unwrap();
    scheduler.tick(1016);

    const injectedEvents = events.filter((event) => event.phase === 'world-update-injected');
    expect(injectedEvents).toHaveLength(2);
    expect(injectedEvents.every((event) => event.worldCount === 1)).toBe(true);
    expect(events.at(-2)).toMatchObject({ phase: 'renderer-draw', boundary: 'end' });
    expect(events.at(-1)).toMatchObject({ phase: 'frame-total', boundary: 'end' });
    expect(onError).toHaveLength(1);
  });

  it('contains observer failures and preserves normal frame work', () => {
    const scheduler = makeScheduler();
    let draws = 0;
    const loop = createFrameLoop({
      world: new World(),
      renderer: makeRenderer(() => {
        draws += 1;
        return { ok: true, value: undefined };
      }),
      now: () => 1016,
      raf: scheduler.raf,
      caf: scheduler.caf,
      framePhaseObserver: {
        onEvent: () => {
          throw new Error('observer failure');
        },
      },
    });

    loop.start().unwrap();
    scheduler.tick(1016);

    expect(draws).toBe(1);
  });
});
