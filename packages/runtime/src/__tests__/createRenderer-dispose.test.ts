import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { constructRendererHost } from '../../../render/src/construct-renderer';
import { requireRenderer } from './renderer-test-utils';

function canvas(): HTMLCanvasElement {
  return { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement;
}

const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ schemaVersion: '1.0.0', entries: [] }))}`;

describe('createRenderer disposal contract', () => {
  it('keeps assets on the host and not on Renderer', async () => {
    const host = await constructRendererHost(canvas(), { rhi }, { shaderManifestUrl: manifest });
    expect(host.ok).toBe(true);
    if (!host.ok) return;
    expect(host.value.assets.inspect()).toBeDefined();
    expect(host.value.renderer).not.toHaveProperty('assets');
    expect(host.value.renderer).not.toHaveProperty('store');
    host.value.renderer.dispose();
  });

  it('disposes an attached lease path idempotently', async () => {
    const renderer = await requireRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    renderer.dispose();
    renderer.dispose();
    expect(renderer.inspect().state).toBe('disposed');
    expect(renderer.attach(world).ok).toBe(false);
  });

  it('returns a Result error instead of reopening a frame after disposal', async () => {
    const renderer = await requireRenderer(canvas(), { rhi }, { shaderManifestUrl: manifest });
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    renderer.dispose();
    const result = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(result.ok).toBe(false);
  });
});
