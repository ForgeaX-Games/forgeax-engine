import { vec3 } from '@forgeax/engine-math';
import type { MaterialShaderManifestEntry } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';
import {
  inspectPointShadow,
  materialShadersSamplePointShadows,
  projectPointShadowInspection,
} from '../point-shadow-inspection';
import type { PointShadowSnapshot } from '../render-system-extract';
import { SHADOW_ATLAS_DEFAULT_LAYERS } from '../shadow-atlas';

function snapshots(...layers: number[]): PointShadowSnapshot[] {
  return layers.map((shadowAtlasLayer, entity) => ({
    entity,
    position: vec3.create(0, 0, 0),
    mapSize: 512,
    nearPlane: 0.1,
    farPlane: 25,
    depthBias: 0.005,
    normalBias: 0.05,
    shadowAtlasLayer,
    shadowMatrices: new Float32Array(96),
  }));
}

describe('point-shadow inspection', () => {
  it('derives requested, admitted, shadowed, and occupancy from one layer projection', () => {
    expect(inspectPointShadow(snapshots(0, 1, 2, 3, -1), SHADOW_ATLAS_DEFAULT_LAYERS)).toEqual({
      status: 'over-budget',
      requested: SHADOW_ATLAS_DEFAULT_LAYERS + 1,
      admitted: SHADOW_ATLAS_DEFAULT_LAYERS,
      shadowed: SHADOW_ATLAS_DEFAULT_LAYERS,
      shadowAtlasOccupancy: SHADOW_ATLAS_DEFAULT_LAYERS,
      shadowAtlasCapacity: SHADOW_ATLAS_DEFAULT_LAYERS,
    });
  });

  it('reports disabled shadow production without inventing a fallback admission', () => {
    expect(inspectPointShadow([], SHADOW_ATLAS_DEFAULT_LAYERS)).toEqual({
      status: 'inactive',
      requested: 0,
      admitted: 0,
      shadowed: 0,
      shadowAtlasOccupancy: 0,
      shadowAtlasCapacity: SHADOW_ATLAS_DEFAULT_LAYERS,
    });
  });

  it('treats an invalid layer as non-admitted and keeps the request visible', () => {
    expect(inspectPointShadow(snapshots(-1, 7), SHADOW_ATLAS_DEFAULT_LAYERS)).toMatchObject({
      status: 'over-budget',
      requested: 2,
      admitted: 0,
      shadowed: 0,
      shadowAtlasOccupancy: 0,
    });
  });

  it('does not call a partially admitted request ready', () => {
    expect(inspectPointShadow(snapshots(0, -1), SHADOW_ATLAS_DEFAULT_LAYERS)).toMatchObject({
      status: 'over-budget',
      requested: 2,
      admitted: 1,
      shadowed: 1,
    });
  });
});

// Declaration shape copied from a `pointShadows: true` naga_oil build.
const LANE_WGSL =
  '@group(0) @binding(5) \nvar shadowAtlasX_naga_oil_mod_XMZXXEZ3FMF4F65TJMV3TUOTDN5WW233OX: texture_depth_cube_array;\n';

function entry(variantWgsl: readonly string[]): MaterialShaderManifestEntry {
  return {
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'standard.wgsl',
    composedWgsl: '@group(0) @binding(8) var spotShadowMap: texture_depth_2d_array;',
    paramSchema: '[]',
    variants: variantWgsl.map((composedWgsl, index) => ({
      definesKey: `CLUSTER_FORWARD_AVAILABLE=${index === 0}`,
      defines: { CLUSTER_FORWARD_AVAILABLE: index === 0 },
      composedWgsl,
    })),
  };
}

describe('point-shadow shader lane', () => {
  it('derives the lane only from a compiled cube-array atlas declaration', () => {
    expect(materialShadersSamplePointShadows([entry([LANE_WGSL, 'fn main() {}'])])).toBe(true);
    expect(materialShadersSamplePointShadows([entry(['fn main() {}', 'fn main() {}'])])).toBe(
      false,
    );
    expect(materialShadersSamplePointShadows([])).toBe(false);
  });

  it('never reports ready when no loaded shader samples point shadows', () => {
    const recorded = inspectPointShadow(snapshots(0), SHADOW_ATLAS_DEFAULT_LAYERS);
    expect(recorded.status).toBe('ready');
    expect(projectPointShadowInspection(recorded, false)).toEqual({
      status: 'unavailable',
      requested: 1,
      admitted: 0,
      shadowed: 0,
      shadowAtlasOccupancy: 0,
      shadowAtlasCapacity: SHADOW_ATLAS_DEFAULT_LAYERS,
    });
    expect(projectPointShadowInspection(undefined, false)?.status).toBe('unavailable');
    expect(projectPointShadowInspection(recorded, true)).toBe(recorded);
  });
});
