import { toShared } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createParticleRenderBatch,
  type ParticleMeshBatch,
  validateParticleRenderBatch,
} from '../index.js';

const material = toShared<'MaterialAsset'>(21);
const mesh = toShared<'MeshAsset'>(22);

function meshBatch(count: number): ParticleMeshBatch {
  return {
    kind: 'mesh',
    material,
    mesh,
    count,
    attributes: {
      transform: new Float32Array(count * 16),
      color: new Float32Array(count * 4),
    },
  };
}

describe('ParticleRenderBatch mesh contract', () => {
  it('keeps mesh, material, count, and flat instance attributes together', () => {
    const source = meshBatch(3);
    const result = createParticleRenderBatch([source]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.value.batches[0];
    expect(output?.kind).toBe('mesh');
    if (output?.kind !== 'mesh') return;
    expect(output.mesh).toBe(mesh);
    expect(output.material).toBe(material);
    expect(output.count).toBe(3);
    expect(output.attributes.transform.length).toBe(48);
    expect(output.attributes.color.length).toBe(12);
    expectTypeOf(output.attributes.transform).toEqualTypeOf<Float32Array>();
  });

  it('rejects an attribute length that cannot represent the declared count', () => {
    const result = validateParticleRenderBatch({
      batches: [
        {
          ...meshBatch(2),
          attributes: {
            transform: new Float32Array(16),
            color: new Float32Array(8),
          },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    switch (result.error.code) {
      case 'vfx-batch-invalid':
        expect(result.error.detail.output).toBe('mesh');
        expect(result.error.detail.path).toBe('batches[0].attributes.transform');
        break;
      default:
        throw new Error(`unexpected error: ${result.error.code}`);
    }
  });

  it('rejects invalid count and unknown output variants without truncating data', () => {
    const negative = validateParticleRenderBatch({
      batches: [{ ...meshBatch(0), count: -1 }],
    });
    const unknown = validateParticleRenderBatch({
      batches: [{ kind: 'sprite', material, count: 1, attributes: {} }],
    });

    expect(negative.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (!negative.ok) {
      switch (negative.error.code) {
        case 'vfx-batch-invalid':
          expect(negative.error.detail.path).toBe('batches[0].count');
          break;
        default:
          throw new Error(`unexpected error: ${negative.error.code}`);
      }
    }
    if (!unknown.ok) {
      switch (unknown.error.code) {
        case 'vfx-batch-invalid':
          expect(unknown.error.detail.path).toBe('batches[0].kind');
          break;
        default:
          throw new Error(`unexpected error: ${unknown.error.code}`);
      }
    }
  });
});
