import { World } from '@forgeax/engine-ecs';
import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { GpuResidencyCache } from '../device/gpu-residency';

describe('GpuResidencyCache mesh stride', () => {
  it('keeps the canonical 18F plus UV1 stride from the complete projection', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const store = new GpuResidencyCache();
    store.configureGpuDevice(
      device,
      undefined,
      () => {
        throw new Error('cubemap registration is not part of this test');
      },
      device.caps,
    );

    const mesh: MeshAsset = {
      kind: 'mesh',
      // The producer owns a canonical 20-float interleaved buffer:
      // 18F skinned data plus one additional UV set. Importers must publish
      // the complete map even when source accessors are sparse.
      vertices: new Float32Array(4 * 20),
      attributes: {
        position: new Float32Array(4 * 3),
        normal: new Float32Array(4 * 3),
        uv: new Float32Array(4 * 2),
        tangent: new Float32Array(4 * 4),
        skinIndex: new Uint16Array(4 * 4),
        skinWeight: new Float32Array(4 * 4),
        uv1: new Float32Array(4 * 2),
      },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 4,
          topology: 'triangle-list',
          materialSlot: 0,
        },
      ],
      materialSlots: [{ slotName: 'default' }],
    };
    const world = new World();
    const handle = world.allocSharedRef('MeshAsset', mesh);

    const resident = store.ensureResident(handle, mesh);

    expect(resident.ok).toBe(true);
    const entry = store.getMeshGpuHandles(handle);
    expect(entry?.layoutProjection).toEqual(deriveVertexLayoutProjection(mesh.attributes));
    expect(entry?.layoutProjection.arrayStride).toBe(80);
    expect(entry?.vertexCount).toBe(4);
  });
});
