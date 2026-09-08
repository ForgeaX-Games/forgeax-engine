import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { requireRenderer } from './renderer-test-utils';

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
  it('keeps dispose idempotent after attach and draw', async () => {
    const renderer = await requireRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    const attached = renderer.attach(new World());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    renderer.dispose();
    renderer.dispose();
    expect(
      renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      }).ok,
    ).toBe(false);
  });
});
