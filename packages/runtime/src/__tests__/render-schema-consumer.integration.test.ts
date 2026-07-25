import {
  Camera,
  DirectionalLight,
  MeshFilter,
  orthographic,
  prepareRenderSchemas,
  readRenderSchemas,
} from '@forgeax/engine-render/internal';
import { describe, expect, it } from 'vitest';

describe('runtime render schema consumer', () => {
  it('reads canonical render fields without adapters or casts', () => {
    const row = readRenderSchemas(
      { assetHandle: 3 },
      { direction: new Float32Array([0, -1, 0]), intensity: 2 },
      orthographic({ left: -1, right: 1, bottom: -1, top: 1, near: 0.1, far: 10 }),
    );
    const prepared = prepareRenderSchemas(row);
    expect(prepared.meshAssetHandle).toBe(3);
    expect(prepared.cameraProjection).toBe(1);
    expect(Camera.fields.projection.default).toBe(0);
    expect(DirectionalLight.fields.direction.type).toBe('array<f32, 3>');
    expect(MeshFilter.fields.assetHandle.type).toBe('shared<MeshAsset>');
  });
});
