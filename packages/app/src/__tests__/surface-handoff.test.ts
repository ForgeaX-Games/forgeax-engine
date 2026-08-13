import { Update, World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { createApp } from '../create-app';
import type { App } from '../types';

describe('createApp presentation surface handoff', () => {
  it('keeps the current frame drawable when release starts during Update', async () => {
    const previousRaf = globalThis.requestAnimationFrame;
    const previousCaf = globalThis.cancelAnimationFrame;
    let pendingFrame: ((timestamp: number) => void) | undefined;
    let surfaceReleased = false;
    let drawSawReleasedSurface = false;
    let releaseCount = 0;

    globalThis.requestAnimationFrame = (callback) => {
      pendingFrame = callback;
      return 1;
    };
    globalThis.cancelAnimationFrame = () => {
      pendingFrame = undefined;
    };

    const renderer = {
      backend: 'webgpu' as const,
      ready: Promise.resolve({ ok: true, value: undefined }),
      draw(): { ok: true; value: undefined } {
        drawSawReleasedSurface = surfaceReleased;
        return ok(undefined);
      },
      onError(): () => void {
        return () => {};
      },
      onLost(): () => void {
        return () => {};
      },
      releaseSurface(): { ok: true; value: undefined } {
        releaseCount += 1;
        surfaceReleased = true;
        return ok(undefined);
      },
      restoreSurface(): { ok: true; value: undefined } {
        surfaceReleased = false;
        return ok(undefined);
      },
      dispose(): void {},
    } as unknown as Renderer;

    try {
      const world = new World();
      let app: App | undefined;
      world
        .addSystem(Update, {
          name: 'request-surface-handoff',
          queries: [],
          fn: () => {
            if (app !== undefined) void app.releaseSurfacePreserveWorld();
          },
        })
        .unwrap();

      const result = await createApp({ renderer, world, silenceUnhandledErrors: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      app = result.value;

      expect(app.start().ok).toBe(true);
      const frame = pendingFrame;
      expect(frame).toBeDefined();
      frame?.(16);
      await Promise.resolve();

      expect(drawSawReleasedSurface).toBe(false);
      expect(releaseCount).toBe(1);
      expect((await app.restoreSurface()).ok).toBe(true);
      expect(app.stop().ok).toBe(true);
    } finally {
      if (previousRaf === undefined) {
        Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
      } else {
        globalThis.requestAnimationFrame = previousRaf;
      }
      if (previousCaf === undefined) {
        Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
      } else {
        globalThis.cancelAnimationFrame = previousCaf;
      }
    }
  });
});
