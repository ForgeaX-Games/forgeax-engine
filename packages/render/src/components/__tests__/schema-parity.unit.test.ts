import { describe, expect, it } from 'vitest';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  orthographic,
  perspective,
  SkyboxBackground,
  Skylight,
} from '../index';

describe('render schema parity', () => {
  it('keeps branded mesh and merged light fields in the canonical schema', () => {
    expect(MeshFilter.fields.assetHandle.type).toBe('shared<MeshAsset>');
    expect(DirectionalLight.fields.direction.type).toBe('array<f32, 3>');
    expect(DirectionalLight.fields.castShadow.default).toBe(true);
    expect(MeshRenderer.fields.materials.type).toBe('array<shared<MaterialAsset>>');
    expect(Skylight.fields.equirect.simulationTransient).toBe(true);
    expect(SkyboxBackground.fields.equirect.simulationTransient).toBe(true);
  });

  it('exposes both camera projection variants and helpers', () => {
    expect(Camera.fields.projection.default).toBe(0);
    expect(Camera.fields.left.default).toBe(-1);
    expect(perspective({ fov: 1, aspect: 2 }).projection).toBe(0);
    expect(orthographic({ left: -2, right: 2, bottom: -1, top: 1 }).projection).toBe(1);
  });
});
