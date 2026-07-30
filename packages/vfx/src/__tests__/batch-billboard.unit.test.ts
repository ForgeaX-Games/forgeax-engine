import { toShared } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createParticleRenderBatch,
  type ParticleBillboardBatch,
  type ParticleRenderBatch,
  validateParticleRenderBatch,
} from '../index.js';

const material = toShared<'MaterialAsset'>(11);

function billboard(count: number): ParticleBillboardBatch {
  return {
    kind: 'billboard',
    material,
    count,
    attributes: {
      position: new Float32Array(count * 3),
      size: new Float32Array(count * 2),
      color: new Float32Array(count * 4),
    },
  };
}

describe('ParticleRenderBatch billboard contract', () => {
  it('accepts an empty producer snapshot without doing work', () => {
    const result = createParticleRenderBatch([]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual<ParticleRenderBatch>({ batches: [] });
  });

  it('keeps billboard material, count, and flat attributes together', () => {
    const source = billboard(2);
    const result = createParticleRenderBatch([source]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.value.batches[0];
    expect(output).toBeDefined();
    if (output?.kind !== 'billboard') return;
    expect(output.material).toBe(material);
    expect(output.count).toBe(2);
    expect(output.attributes.position).toBeInstanceOf(Float32Array);
    expect(output.attributes.position.length).toBe(6);
    expect(output.attributes.size.length).toBe(4);
    expect(output.attributes.color.length).toBe(8);
    expectTypeOf(output.attributes.position).toEqualTypeOf<Float32Array>();
  });

  it('rejects an unknown output variant with a structured batch error', () => {
    const result = validateParticleRenderBatch({
      batches: [{ kind: 'ribbon', material, count: 1, attributes: {} }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    switch (result.error.code) {
      case 'vfx-batch-invalid':
        expect(result.error.detail.output).toBe('ribbon');
        expect(result.error.detail.path).toBe('batches[0].kind');
        break;
      default:
        throw new Error(`unexpected error: ${result.error.code}`);
    }
  });
});
