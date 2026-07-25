import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { createRenderer } from '../createRenderer';

function canvas(): HTMLCanvasElement {
  return { width: 32, height: 32, getContext: () => null } as unknown as HTMLCanvasElement;
}

const manifest = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [
      { hash: 'pbr00000', wgsl: '/* pbr */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit */', glsl: '', bindings: '' },
      { hash: 'tonemap0', wgsl: '/* tonemap */', glsl: '', bindings: '' },
    ],
  }),
)}`;

describe('renderer lifecycle assembly', () => {
  it('keeps dispose idempotent after ready and draw', async () => {
    const renderer = await createRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    await renderer.ready;
    renderer.draw([], { owner: 0 });
    renderer.dispose();
    renderer.dispose();
    expect(renderer.draw([], { owner: 0 }).ok).toBe(false);
  });
});
