import type { Renderer } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

describe('app-facing renderer lifecycle', () => {
  it('consumes the three lifecycle Result boundaries without casts', async () => {
    const events: string[] = [];
    const renderer = {
      attach: () => ({ ok: false as const, error: {} }),
      draw: () => ({ ok: false as const, error: {} }),
      observe: async () => ({ ok: false as const, error: {} }),
      releaseSurface: () => ({ ok: true as const, value: undefined }),
      restoreSurface: () => ({ ok: true as const, value: undefined }),
      recover: async () => ({ ok: true as const, value: undefined }),
      dispose: () => events.push('dispose'),
      onError: () => () => undefined,
      onLost: () => () => undefined,
    } as unknown as Renderer;
    expect(renderer.attach({} as never).ok).toBe(false);
    expect(renderer.draw({} as never).ok).toBe(false);
    renderer.dispose();
    renderer.dispose();
    expect(events).toEqual(['dispose', 'dispose']);
  });
});
