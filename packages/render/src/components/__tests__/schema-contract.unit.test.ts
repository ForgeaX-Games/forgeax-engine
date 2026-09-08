import { describe, expect, it } from 'vitest';
import { Camera, DirectionalLight, MeshFilter } from '../index';

describe('canonical render schema owners', () => {
  it('keeps mesh, light, and camera facts on their component owners', () => {
    expect(MeshFilter.fields.assetHandle.type).toBe('shared<MeshAsset>');
    expect(DirectionalLight.fields.direction.type).toBe('array<f32, 3>');
    expect(Camera.fields.projection.default).toBe(0);
  });
});
