import { Time, World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';

import { createFrameLoop } from '../internal/frame-loop';

function renderer(): Renderer {
  return {
    backend: 'webgpu',
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw: () => ({ ok: true, value: undefined }),
    onError: () => () => {},
    onLost: () => () => {},
    dispose: () => {},
  } as unknown as Renderer;
}

function scheduler() {
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

describe('frame-loop Time forwarding', () => {
  it('forwards one measured delta to own and injected Worlds', () => {
    const own = new World();
    const injected = new World();
    const clock = scheduler();
    const loop = createFrameLoop({
      world: own,
      renderer: renderer(),
      now: (() => {
        const values = [1000, 1016];
        return () => values.shift() ?? 1016;
      })(),
      raf: clock.raf,
      caf: clock.caf,
      drawSource: () => ({ worlds: [own, injected], cameraOwner: 0, resourceOwner: 0 }),
    });

    loop.start().unwrap();
    clock.tick(1016);

    expect(own.getResource(Time).delta).toBeCloseTo(0.016);
    expect(injected.getResource(Time).delta).toBeCloseTo(0.016);
  });
});
