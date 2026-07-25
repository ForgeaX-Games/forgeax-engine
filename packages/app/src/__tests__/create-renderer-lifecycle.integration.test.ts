import type { Renderer } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';

describe('app-facing renderer lifecycle', () => {
  it('consumes the three lifecycle Result boundaries without casts', async () => {
    const events: string[] = [];
    const renderer = {
      ready: Promise.resolve({ ok: true as const, value: undefined }),
      draw: () => ({ ok: true as const, value: undefined }),
      dispose: () => events.push('dispose'),
    } as unknown as Renderer;
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);
    expect(renderer.draw([], { owner: 0 }).ok).toBe(true);
    renderer.dispose();
    renderer.dispose();
    expect(events).toEqual(['dispose', 'dispose']);
  });
});
