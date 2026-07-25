import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { createRenderer } from '../createRenderer';
import { EngineEnvironmentError } from '../errors/environment';

function canvas(): HTMLCanvasElement {
  return {
    width: 64,
    height: 64,
    getContext: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
}

const manifest = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [
      { hash: 'pbr00000', wgsl: '/* pbr stub */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      { hash: 'tonemap0', wgsl: '/* tonemap stub */', glsl: '', bindings: '' },
    ],
  }),
)}`;

describe('runtime assembly contract', () => {
  it('resolves a renderer and exposes Result lifecycle methods', async () => {
    const renderer = await createRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    const ready = await renderer.ready;
    expect(ready.ok).toBe(true);
    expect(renderer.draw([], { owner: 0 }).ok).toBe(true);
    renderer.dispose();
    expect(renderer.draw([], { owner: 0 }).ok).toBe(false);
  });

  it('preserves structured environment rejection when no backend is available', async () => {
    await expect(createRenderer(canvas(), { rhi: undefined })).rejects.toBeInstanceOf(
      EngineEnvironmentError,
    );
  });
});
