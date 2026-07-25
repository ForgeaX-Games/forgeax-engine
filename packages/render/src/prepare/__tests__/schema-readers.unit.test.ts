import { describe, expect, it } from 'vitest';
import { prepareRenderSchemas } from '../schema-readers';

describe('prepare schema readers', () => {
  it('retains branded handles and projection bounds', () => {
    const direction = new Float32Array([1, 0, 0]);
    const prepared = prepareRenderSchemas({
      mesh: { assetHandle: 11 },
      light: { direction, intensity: 1 },
      camera: { projection: 1, near: 0.1, far: 100 },
    });
    expect(prepared.meshAssetHandle).toBe(11);
    expect(prepared.lightDirection).toBe(direction);
    expect(prepared.cameraProjection).toBe(1);
  });
});
