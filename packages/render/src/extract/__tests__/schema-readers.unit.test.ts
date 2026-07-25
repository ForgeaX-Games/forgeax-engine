import { describe, expect, it } from 'vitest';
import { readRenderSchemas } from '../schema-readers';

describe('extract schema readers', () => {
  it('reads mesh, light, and camera semantics from canonical rows', () => {
    const handle = { id: 7 };
    const frame = readRenderSchemas(
      { assetHandle: handle },
      { direction: new Float32Array([0, -1, 0]), intensity: 3 },
      { projection: 1, near: 0.1, far: 50 },
    );
    expect(frame.mesh.assetHandle).toBe(handle);
    expect(frame.light.direction).toEqual(new Float32Array([0, -1, 0]));
    expect(frame.camera.projection).toBe(1);
  });
});
