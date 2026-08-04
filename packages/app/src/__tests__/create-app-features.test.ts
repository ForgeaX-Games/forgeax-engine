import type { RenderFeature } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';

const createRenderer = vi.hoisted(() => vi.fn());

vi.mock('@forgeax/engine-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgeax/engine-runtime')>();
  return { ...actual, createRenderer };
});

import { createApp } from '../create-app';

function rendererStub() {
  return {
    backend: 'webgpu' as const,
    ready: Promise.resolve({ ok: true as const, value: undefined }),
    draw: () => ({ ok: true as const, value: undefined }),
    onError: () => () => undefined,
    onLost: () => () => undefined,
    onHealthChange: () => () => undefined,
    dispose: () => undefined,
  };
}

describe('createApp features passthrough', () => {
  it('forwards the same ordered feature array to createRenderer', async () => {
    const first = { identity: 'test.first' } as unknown as RenderFeature<unknown>;
    const second = { identity: 'test.second' } as unknown as RenderFeature<unknown>;
    const features = [first, second] as const;
    createRenderer.mockResolvedValue(rendererStub());

    const canvas = { tagName: 'canvas', isConnected: true } as HTMLCanvasElement;
    const result = await createApp(canvas, { features });

    expect(result.ok).toBe(true);
    expect(createRenderer).toHaveBeenCalledTimes(1);
    expect(createRenderer.mock.calls[0]?.[1]).toMatchObject({ features });
    expect(createRenderer.mock.calls[0]?.[1].features).toBe(features);
  });
});
