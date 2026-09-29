import { Context } from '@forgeax/engine/plugin';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ui as uiPlugin } from '../ui.pack.ts';

const { dispose, mountUi, label, toggle } = vi.hoisted(() => {
  const dispose = vi.fn();
  const toggle = vi.fn();
  const label = { textContent: '' };
  return { dispose, toggle, label, mountUi: vi.fn(() => ({ ok: true, value: {
    dispose, host: { classList: { toggle }, shadowRoot: { querySelector: () => label } },
  } })) };
});
vi.mock('@forgeax/engine/ui', () => ({ mountUi, createUiLoader: () => ({ load: () => ({ ok: true, value: {} }) }) }));
vi.mock('../../shared/guid.ts', () => ({
  authoredGuid: () => ({ ok: true, value: new Uint8Array(16) }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function hostFixture() {
  const document = Object.assign(new EventTarget(), { querySelector: () => ({}), body: {}, pointerLockElement: null as unknown });
  vi.stubGlobal('document', document);
  const canvas = {};
  const ctx = new Context();
  ctx.provide('gameHost', {} as never);
  ctx.provide('assets', { installDecoder: () => ({ dispose() {} }), load: async () => ({ ok: true, value: {} }) } as never);
  return { ctx, document, canvas };
}

describe('game-3d Host UI lifecycle', () => {
  it('disposes the mounted UI when input listener installation fails', async () => {
    const { ctx, document } = hostFixture();
    try {
      vi.spyOn(document, 'addEventListener').mockImplementationOnce(() => {
        throw new Error('listener unavailable');
      });
      await expect(ctx.plugin(uiPlugin, { guide: '019fb7ce-3600-7000-8000-000000000001' })).rejects.toThrow('listener unavailable');
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('updates from Host pointer lock without a World and removes listeners on each disposal', async () => {
    const { ctx, document, canvas } = hostFixture();
    try {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        document.pointerLockElement = null;
        const fiber = await ctx.plugin(uiPlugin, { guide: '019fb7ce-3600-7000-8000-000000000001' });
        expect(label.textContent).toContain('Click to lock camera');
        document.pointerLockElement = canvas;
        document.dispatchEvent(new Event('pointerlockchange'));
        expect(label.textContent).toContain('Camera locked');
        expect(toggle).toHaveBeenLastCalledWith('locked', true);
        await fiber.dispose();
        expect(dispose).toHaveBeenCalledTimes(cycle + 1);
        document.pointerLockElement = null;
        document.dispatchEvent(new Event('pointerlockchange'));
        expect(label.textContent).toContain('Camera locked');
      }
    } finally {
      await ctx.fiber.dispose();
    }
  });
});
