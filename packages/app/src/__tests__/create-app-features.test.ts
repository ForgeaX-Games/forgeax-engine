import type { RenderFeature } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';

const constructRuntimeRendererHost = vi.hoisted(() => vi.fn());

vi.mock('@forgeax/engine-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgeax/engine-runtime')>();
  return actual;
});

vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost,
  loadRhiPack: vi.fn(),
}));

import { createApp } from '../create-app';

function rendererStub() {
  const lease = {};
  return {
    attach: () => ({ ok: true as const, value: lease }),
    draw: () => ({ ok: true as const, value: {} }),
    observe: async () => ({ ok: true as const, value: {} }),
    releaseSurface: () => ({ ok: true as const, value: undefined }),
    restoreSurface: () => ({ ok: true as const, value: undefined }),
    recover: async () => ({ ok: true as const, value: undefined }),
    onError: () => () => undefined,
    onLost: () => () => undefined,
    dispose: () => undefined,
  };
}

describe('createApp features passthrough', () => {
  it('forwards the same ordered feature array to createRenderer', async () => {
    const first = { identity: 'test.first' } as unknown as RenderFeature<unknown>;
    const second = { identity: 'test.second' } as unknown as RenderFeature<unknown>;
    const features = [first, second] as const;
    constructRuntimeRendererHost.mockResolvedValue({
      ok: true,
      value: { renderer: rendererStub(), assets: undefined },
    });

    const canvas = { tagName: 'canvas', isConnected: true } as HTMLCanvasElement;
    const result = await createApp(canvas, { features });

    expect(result.ok).toBe(true);
    expect(constructRuntimeRendererHost).toHaveBeenCalledTimes(1);
    expect(constructRuntimeRendererHost.mock.calls[0]?.[1]).toMatchObject({ features });
    expect(constructRuntimeRendererHost.mock.calls[0]?.[1].features).toBe(features);
  });
});
