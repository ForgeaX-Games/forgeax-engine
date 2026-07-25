import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';
import { createApp } from '../create-app';

describe('app renderer construction boundary', () => {
  it('keeps construction failures catchable', async () => {
    await expect(createRenderer(null as never)).rejects.toBeDefined();
  });

  it('returns EngineEnvironmentError through the canvas Result path', async () => {
    const canvas = {
      tagName: 'CANVAS',
      isConnected: true,
      width: 16,
      height: 16,
      getContext: () => null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
    const result = await createApp(canvas, { rhi: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(EngineEnvironmentError);
  });
});
