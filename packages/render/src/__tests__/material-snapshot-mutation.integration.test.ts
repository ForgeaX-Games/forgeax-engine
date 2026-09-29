import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { deriveStandardLayerPlan } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { projectStandardSurfacePasses } from '../assembly/material/surface-projection';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import {
  type MaterialSnapshotCachesByWorld,
  resolveMaterialSnapshot,
} from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';

describe('material snapshot mutation', () => {
  it('retains color mask and bias through primary/submesh extraction and state edits', () => {
    const world = new World();
    const assets = new AssetRegistry({
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const renderState = {
      tags: { LightMode: 'Forward' },
      colorWriteMask: 0,
      depthBias: -1,
      depthBiasSlopeScale: -2,
      depthBiasClamp: -0.01,
    };
    const material: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax::default-unlit' }, renderState }],
      values: {},
    };
    const handle = world.allocSharedRef('MaterialAsset', material);
    world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [handle] } },
    );
    const cache: MaterialSnapshotCachesByWorld = new WeakMap();
    const first = extractFrames([world], 0, assets, undefined, cache).renderables[0];
    expect(first?.material.renderState).toMatchObject({
      colorWriteMask: 0,
      depthBias: -1,
      depthBiasSlopeScale: -2,
      depthBiasClamp: -0.01,
    });
    expect(resolveMaterialSnapshot(handle, world, assets).renderState).toEqual(
      first?.material.renderState,
    );
    renderState.colorWriteMask = 5;
    renderState.depthBias = 2;
    const second = extractFrames([world], 0, assets, undefined, cache).renderables[0];
    expect(second?.material.renderState).toMatchObject({ colorWriteMask: 5, depthBias: 2 });
    expect(first?.material.renderState).toMatchObject({ colorWriteMask: 0, depthBias: -1 });
    expect(second?.gpuDrivenDraws?.[0]?.pipelineClass).not.toBe(
      first?.gpuDrivenDraws?.[0]?.pipelineClass,
    );
  });

  it('projects the same Surface model for primary and reusable submesh snapshots', () => {
    const world = new World();
    const assets = new AssetRegistry({
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const material: MaterialAsset = {
      kind: 'material',
      surface: {
        model: 'single-layer-medium',
        module: 'game::water-surface',
      },
      passes: [
        {
          name: 'color',
          program: { module: 'forgeax::single-layer-medium' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 3000 },
        },
      ],
      values: {},
    };
    const materialHandle = world.allocSharedRef('MaterialAsset', material);
    world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    );

    const primary = extractFrames([world], 0, assets).renderables[0]?.material;
    const reusable = resolveMaterialSnapshot(materialHandle, world, assets);

    expect(primary?.surfaceModel).toBe('single-layer-medium');
    expect(reusable.surfaceModel).toBe('single-layer-medium');
  });

  it('projects in-place material value updates into the next extracted frame', () => {
    const world = new World();
    const assets = new AssetRegistry({
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const values: Record<string, unknown> = {
      baseColor: [1, 0, 0, 1],
      metallic: 0,
      roughness: 0.5,
    };
    const material: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-standard-pbr' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: values as NonNullable<MaterialAsset['values']>,
    };
    const materialHandle = world.allocSharedRef('MaterialAsset', material);

    world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    );
    const materialCaches: MaterialSnapshotCachesByWorld = new WeakMap();

    const first = extractFrames([world], 0, assets, undefined, materialCaches).renderables[0]
      ?.material;
    expect(first?.baseColor).toEqual(new Float32Array([1, 0, 0]));

    values.baseColor = [0, 1, 0, 1];

    const second = extractFrames([world], 0, assets, undefined, materialCaches).renderables[0]
      ?.material;
    expect(second?.baseColor).toEqual(new Float32Array([0, 1, 0]));
    expect(second).not.toBe(first);
  });

  it('keeps the pipeline identity stable for a value-only child update', () => {
    const world = new World();
    const assets = new AssetRegistry({
      findMaterialArtifact: () => ({ ok: false, error: new Error('not registered') }),
    } as unknown as ShaderRegistry);
    const values: Record<string, unknown> = { baseColor: [1, 0, 0, 1] };
    const material: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax_material::standard' },
          renderState: { tags: { LightMode: 'Forward' }, queue: 2000 },
        },
      ],
      values: values as NonNullable<MaterialAsset['values']>,
    };
    const materialHandle = world.allocSharedRef('MaterialAsset', material);
    world.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
    );
    const materialCaches: MaterialSnapshotCachesByWorld = new WeakMap();
    const first = extractFrames([world], 0, assets, undefined, materialCaches).renderables[0];
    values.baseColor = [0, 1, 0, 1];
    const second = extractFrames([world], 0, assets, undefined, materialCaches).renderables[0];

    expect(first?.gpuDrivenDraws?.[0]?.pipelineClass).toBe(
      second?.gpuDrivenDraws?.[0]?.pipelineClass,
    );
    expect(first?.material?.materialShaderId).toBe(second?.material?.materialShaderId);
  });

  it('falsifies legacy surface, physical deferred, and forward fallback projections', () => {
    const basePlan = deriveStandardLayerPlan([]);
    const physicalPlan = deriveStandardLayerPlan([
      { name: 'clearcoat', type: 'f32' },
      { name: 'clearcoatRoughness', type: 'f32' },
    ]);

    const base = projectStandardSurfacePasses({
      surfaceModule: 'game_3d::rusted_iron_surface',
      values: {},
      layerPlan: basePlan,
      geometryVariant: 'rigid',
      lightingLane: 'direct',
    });
    const physical = projectStandardSurfacePasses({
      surfaceModule: 'game_3d::rusted_iron_surface',
      values: {},
      layerPlan: physicalPlan,
      geometryVariant: 'rigid',
      lightingLane: 'direct',
    });
    const legacy = base.map((entry) => ({
      ...entry,
      program: { ...entry.program, moduleSlots: { surface: 'legacy::surface_data' } },
    }));
    const physicalDeferred = physical.some((entry) => entry.name === 'deferred');
    const forwardFallback = base.some((entry) => entry.name === 'forward');

    expect(legacy[0]?.program.moduleSlots?.surface).not.toBe('game_3d::rusted_iron_surface');
    expect(physicalDeferred).toBe(false);
    expect(forwardFallback).toBe(true);
  });
});
