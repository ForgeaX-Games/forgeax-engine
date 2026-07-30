import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import { createPreparedGraphicsStore } from '../features/prepared-graphics-store';
import type { RenderFeature } from '../features/types';

function feature(): RenderFeature<{ readonly ready: true }> {
  let pipeline: { readonly kind: 'pipeline'; readonly generation: number } | undefined;
  return {
    identity: 'synthetic.generation',
    extract: () => ok({ ready: true }),
    prepare: (_data, context) => {
      const result = context.graphics.preparePipeline('pipeline', {
        shader: 'synthetic.shader',
        vertexLayout: 'position',
        colorFormats: ['rgba8unorm'],
      });
      if (!result.ok) return result;
      pipeline = result.value;
      return ok(undefined);
    },
    contribute: () => {
      expect(pipeline?.kind).toBe('pipeline');
      return ok(undefined);
    },
  };
}

describe('prepared graphics generation ownership', () => {
  it('rejects stale generation and foreign owner or kind references', () => {
    const store = createPreparedGraphicsStore();
    const owner = store.beginFrame('synthetic.owner', 4);
    const foreign = store.beginFrame('synthetic.foreign', 4);
    const old = owner.prepare('pipeline', 'pipeline', { signature: 'pipeline:v1' });
    const foreignRef = foreign.prepare('pipeline', 'pipeline', { signature: 'pipeline:v1' });
    expect(old.ok).toBe(true);
    expect(foreignRef.ok).toBe(true);
    owner.commit();
    foreign.commit();

    const next = store.beginFrame('synthetic.owner', 5);
    const nextRef = next.prepare('pipeline', 'pipeline', { signature: 'pipeline:v2' });
    expect(nextRef.ok).toBe(true);
    if (old.ok && foreignRef.ok && nextRef.ok) {
      expect(next.owns(old.value)).toBe(false);
      expect(next.owns(foreignRef.value)).toBe(false);
      expect(nextRef.value).not.toBe(old.value);
      expect(nextRef.value.generation).toBe(5);
    }
    expect(next.graphicsState(true, []).generation).toBe(5);
  });

  it('keeps registration while replacing prepared state after a pipeline generation switch', () => {
    const host = createRenderFeatureHost([feature()]).unwrap();
    const before = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      generation: 1,
      caps: { backendKind: 'null' } as never,
    });
    const after = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 2,
      generation: 2,
      caps: { backendKind: 'null' } as never,
    });

    expect(before.errors).toEqual([]);
    expect(after.errors).toEqual([]);
    expect(before.contributions).toEqual([]);
    expect(after.contributions).toEqual([]);
    expect(host.features).toHaveLength(1);
    expect(host.features[0]?.identity).toBe('synthetic.generation');
    expect(host.diagnostics()[0]?.status).toBe('active');
  });
});
