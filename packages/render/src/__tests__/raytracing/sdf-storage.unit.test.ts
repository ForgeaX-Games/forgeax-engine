import { buildMeshDistanceField, buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import { assert, expect, it } from 'vitest';
import { packSdfScene } from '../../raytracing/sdf-query';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

it('packs sampled visibility into SNORM16 distances with a half-step scalar error bound', async () => {
  const field = (
    await buildVisibilityDistanceField([-1, -1, 0, 1, -1, 0, 0, 1, 0], [0, 1, 2], {
      voxelSize: 0.25,
      triangleSidedness: [0],
    })
  ).unwrap();
  assert(field.policy.kind === 'sampled-visibility');
  field.values[0] = 0;
  const source = { instanceId: 1, geometryId: 2, mask: 255, transform, field };
  const packed = packSdfScene([source, { ...source, instanceId: 3 }]).unwrap();
  expect(packed.fields.byteLength).toBe(Math.ceil(field.values.length / 2) * 4);
  const instances = new DataView(packed.instances.buffer);
  expect(instances.getUint32(80, true)).toBe(0);
  expect(instances.getUint32(144 + 80, true)).toBe(0);
  expect(instances.getFloat32(124, true)).toBe(field.policy.distanceBand);
  const band = field.policy.distanceBand;
  const encoded = new DataView(packed.fields.buffer);
  let negative = 0,
    positive = 0,
    zero = 0;
  for (const [i, value] of field.values.entries()) {
    const code = encoded.getInt16(i * 2, true);
    const restored = (code / 32767) * band;
    expect(Math.abs(restored - value)).toBeLessThanOrEqual(band / (2 * 32767) + 1e-12);
    if (value < 0) negative++;
    if (value > 0) positive++;
    if (value === 0) {
      zero++;
      expect(code).toBe(0);
    }
  }
  expect(negative).toBeGreaterThan(0);
  expect(positive).toBeGreaterThan(0);
  expect(zero).toBeGreaterThan(0);
});

it('keeps geometric fields bit-exact after a partial SNORM16 word and shares immutable inputs', async () => {
  const sampled = (
    await buildVisibilityDistanceField([-1, -1, 0, 1, -1, 0, 0, 1, 0.4], [0, 1, 2], {
      voxelSize: 0.35,
      triangleSidedness: [1],
    })
  ).unwrap();
  const original = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 8 })
  ).unwrap();
  const storage = new Float32Array(original.values.length + 3);
  const values = storage.subarray(1, original.values.length + 1);
  values.set(original.values);
  const geometric = { ...original, values };
  const source = { instanceId: 1, geometryId: 2, mask: 255, transform, field: sampled };
  const packed = packSdfScene([
    source,
    { ...source, instanceId: 3, geometryId: 4, field: geometric },
    { ...source, instanceId: 5 },
  ]).unwrap();
  const offset = Math.ceil(sampled.values.length / 2) * 4;
  expect(sampled.values.length % 2).not.toBe(0);
  const instances = new DataView(packed.instances.buffer);
  expect(instances.getUint32(144 + 80, true)).toBe(offset / 4);
  expect(instances.getUint32(288 + 80, true)).toBe(0);
  expect(packed.fields.byteLength).toBe(offset + geometric.values.byteLength);
  expect(packed.fields.subarray(offset)).toEqual(
    new Uint8Array(
      geometric.values.buffer,
      geometric.values.byteOffset,
      geometric.values.byteLength,
    ),
  );
  const frozen = packed.fields.slice();
  sampled.values.fill(0);
  geometric.values.fill(0);
  expect(packed.fields).toEqual(frozen);
});
