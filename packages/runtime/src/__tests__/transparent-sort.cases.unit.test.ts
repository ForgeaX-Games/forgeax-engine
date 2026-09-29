// @ts-nocheck — merged file: indexed-access checks cascade across noUncheckedIndexedAccess for blocks originally outside src/ rootDir
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
//
// Source files (N=44):
//   - packages/runtime/__tests__/antialias-from-f32.test.ts
//   - packages/runtime/src/__tests__/bloom-gating.test.ts
//   - packages/runtime/src/__tests__/camera-antialias.test.ts
//   - packages/runtime/src/__tests__/camera-bloom.test.ts
//   - packages/runtime/src/__tests__/camera-clear-schema.test.ts
//   - packages/runtime/src/__tests__/camera-ortho.test.ts
//   - packages/runtime/src/__tests__/fxaa-intermediate-texture.test.ts
//   - packages/runtime/src/__tests__/fxaa-pipeline.test.ts
//   - packages/runtime/src/__tests__/ibl-pipeline-cache.test.ts
//   - packages/runtime/src/__tests__/ibl-runtime-probe.test.ts
//   - packages/runtime/src/__tests__/render-system-record-warn-once.test.ts
//   - packages/runtime/src/__tests__/shadow-skip-non-triangle.test.ts
//   - packages/runtime/src/__tests__/skin-errors-kebab-case.test.ts
//   - packages/runtime/src/__tests__/skybox-error.test.ts
//   - packages/runtime/src/__tests__/skybox-shader-compile.test.ts
//   - packages/runtime/src/__tests__/skylight-bind-group.test.ts
//   - packages/runtime/src/__tests__/skylight-component.test.ts
//   - packages/runtime/src/__tests__/skylight-fallback-path.test.ts
//   - packages/runtime/src/__tests__/skylight-pipeline-layout.test.ts
//   - packages/runtime/src/__tests__/tonemap-hdr-target.test.ts
//   - packages/runtime/src/__tests__/tonemap-pipeline-split.test.ts
//   - packages/runtime/src/__tests__/zero-camera-clear-fallback.test.ts
//   - packages/runtime/src/components/__tests__/skin.test.ts
//   - packages/runtime/src/systems/__tests__/advance-animation-player.test.ts
//   - packages/runtime/src/systems/__tests__/graph-skybox.test.ts
//   - packages/runtime/src/systems/__tests__/propagate-transforms.test.ts
//   - packages/runtime/src/systems/__tests__/skin-cap-gate.test.ts
//   - packages/runtime/src/systems/__tests__/skin-instances-coexist.test.ts
//   - packages/runtime/src/systems/__tests__/skin-palette-extract.test.ts
//   - packages/runtime/src/systems/__tests__/skin-pipeline-routing.test.ts
//   - packages/runtime/src/systems/__tests__/skybox-extract.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-boundary.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-clamp.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-frame-duration-negative.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-frame-duration-zero.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-loop.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-override-probe.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-regions-mismatch.test.ts
//   - packages/runtime/src/systems/__tests__/tonemap.test.ts
//   - packages/runtime/src/systems/__tests__/transparent-sort-config-get.test.ts
//   - packages/runtime/src/systems/__tests__/transparent-sort-config-set.test.ts
//   - packages/runtime/src/systems/__tests__/transparent-sort.test.ts
//   - packages/runtime/src/__tests__/render-system-multi-material.test.ts
//   - packages/runtime/src/__tests__/render-system-record-submesh.test.ts
//
// Paradigm: each block-scope wraps a source file. ancestorTitles[0] is the
// source-preserved inner describe (NOT the source filename for these 3 files
// — recovery path: vitest report ancestorTitles -> grep this file -> upstream
// `// ─── from <name>.test.ts ───` block separator -> source filename).
// Top-level imports merged + deduped.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimationPlayer } from '@forgeax/engine-animation';
import type { AssetRuntimeErrorCode } from '@forgeax/engine-assets-runtime';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World as WorldType } from '@forgeax/engine-ecs';
import { ENTITY_NULL_RAW, World } from '@forgeax/engine-ecs';
import { SpriteAnimationInvalidError } from '@forgeax/engine-ecs/projection';
import { mat4, vec3 } from '@forgeax/engine-math';
import type { RenderErrorCode, Renderer as RendererType } from '@forgeax/engine-render';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  MeshFilter,
  MeshRenderer,
  SkyboxBackground,
  Skylight,
} from '@forgeax/engine-render';
import type { BindGroupEntry, Buffer, Sampler, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok as rhiOk } from '@forgeax/engine-rhi';
import { ChildOf, Name, propagateTransforms, Transform } from '@forgeax/engine-scene';
import { TONEMAP_LUMINANCE_EPSILON } from '@forgeax/engine-shader';
import type { SkinErrorCode } from '@forgeax/engine-skinning';
import {
  Skin,
  SkinInstancesCoexistForbiddenError,
  SkinJointCountExceededError,
  SkinJointDespawnedError,
  SkinJointPathUnresolvedError,
} from '@forgeax/engine-skinning';
import type {
  Handle,
  MaterialAsset,
  MeshAsset,
  SkeletonAsset,
  TextureFormat,
} from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { worldInternal } from '../../../ecs/src/world-internal';
import {
  SPRITE_PLAYBACK_MODE_CLAMP,
  SPRITE_PLAYBACK_MODE_LOOP,
  SpriteAnimation,
  SpriteRegionOverride,
} from '../../../render/src/components';
import {
  type CameraProjection,
  cameraProjectionFromF32,
} from '../../../render/src/components/camera';
import {
  assembleMaterialWithSkylightEntries,
  createSkylightFallback,
  mergeSkylightIntoMaterialBgl,
} from '../../../render/src/ibl/skylight-bind-group';
import { buildPbrPipelineLayouts, buildUnlitMaterialBgl } from '../../../render/src/pbr-pipeline';
import { INSTANCE_STORAGE_STRIDE_FLOATS } from '../../../render/src/record/mesh-ssbo';
import { selectSwapChainFormat } from '../../../render/src/render-system';
import { createSkinPaletteAllocator } from '../../../render/src/systems/skin-palette-allocator';
import type { TransparentEntry } from '../../../render/src/systems/transparent-sort-config';
import { standardMaterialShaderVariants } from './helpers/standard-material-manifest';
import { drawWithOwners } from './renderer-test-utils';

function componentFieldType(component: { fields: Record<string, { type: string }> }, name: string) {
  return component.fields[name]?.type;
}

function componentFieldDefault(
  component: { fields: Record<string, { default?: unknown }> },
  name: string,
) {
  return component.fields[name]?.default;
}

function componentSchemaTypes(component: { fields: Record<string, { type: string }> }) {
  return Object.fromEntries(
    Object.entries(component.fields).map(([name, field]) => [name, field.type]),
  );
}

afterEach(() => vi.restoreAllMocks());

type RendererErrorObservation = {
  readonly code: string;
  readonly detail?: unknown;
  readonly hint?: string;
};

function unwrapRendererError(value: unknown): RendererErrorObservation {
  let current = value as RendererErrorObservation;
  while (
    current.detail !== undefined &&
    typeof current.detail === 'object' &&
    current.detail !== null
  ) {
    const cause = (current.detail as { cause?: unknown }).cause;
    if (
      cause === undefined ||
      typeof cause !== 'object' ||
      cause === null ||
      typeof (cause as { code?: unknown }).code !== 'string'
    ) {
      break;
    }
    current = cause as RendererErrorObservation;
  }
  return current;
}

function subscribeRendererErrors(
  renderer: RendererType,
  listener: (error: RendererErrorObservation) => void,
): () => void {
  return renderer.subscribe((event) => {
    if (event.kind === 'error') listener(unwrapRendererError(event.error));
  });
}

function drawPublished(renderer: RendererType, world: WorldType) {
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  world.update().unwrap();
  return drawWithOwners(renderer, world);
}

// feat-20260704-runtime-tier1-decomposition M2 / w12: reconstitute the
// eliminated top-level RuntimeErrorCode aggregate union (D-3) as a test-local
// alias so the exhaustive-switch bodies below stay byte-identical (AC-09).
type RuntimeLayerErrorCode = RenderErrorCode | AssetRuntimeErrorCode | SkinErrorCode;

import {
  AnimationTargetId,
  bindAnimationTargets,
  advanceAnimationPlayer as canonicalAdvanceAnimationPlayer,
} from '@forgeax/engine-animation';
import { deriveAnimationTargetId } from '@forgeax/engine-animation/target-id';
import { DeviceScope } from '../../../render/src/device/device-scope';
import { GpuBuffer } from '../../../render/src/gpu-resource';
import { getOrCreateIblCache, hasIblCache } from '../../../render/src/ibl/IblPipelineCache';
import {
  disposeInstanceBuffers,
  type InstanceBufferCacheEntry,
} from '../../../render/src/instance-buffer-cache';
import { standardPipeline as urpPipeline } from '../../../render/src/pipeline/standard-pipeline';
import { ZERO_CAMERA_CLEAR_FALLBACK } from '../../../render/src/record/frame-snapshot';
import {
  warnMultiLightDirectional,
  warnMultiLightPoint,
  warnMultiLightSpot,
} from '../../../render/src/record/helpers';
import type { CameraSnapshot } from '../../../render/src/render-contract';
import {
  type ExtractedLights,
  prepareExtractContext,
} from '../../../render/src/render-system-extract';
import { extractFrame, extractFrames } from '../../../render/src/render-system-extract-tail';
import {
  getTransparentSortConfig,
  setTransparentSortConfig,
  TRANSPARENT_SORT_CONFIG_KEY,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../../../render/src/systems/transparent-sort-config';
import { spriteAnimationTickSystem } from '../systems/sprite-animation-tick';
import { REC709_LUMA_WEIGHTS, tonemapReinhardLuminance } from '../systems/tonemap';
import { transparentSortEntries } from '../systems/transparent-sort';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

void [
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  AnimationPlayer,
  AnimationTargetId,
  AssetRegistry,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  ChildOf,
  DeviceScope,
  ENTITY_NULL_RAW,
  GpuBuffer,
  INSTANCE_STORAGE_STRIDE_FLOATS,
  MeshFilter,
  MeshRenderer,
  Name,
  REC709_LUMA_WEIGHTS,
  SPRITE_PLAYBACK_MODE_CLAMP,
  SPRITE_PLAYBACK_MODE_LOOP,
  Skin,
  SkinInstancesCoexistForbiddenError,
  SkinJointCountExceededError,
  SkinJointDespawnedError,
  SkinJointPathUnresolvedError,
  SkyboxBackground,
  Skylight,
  SpriteAnimation,
  SpriteAnimationInvalidError,
  SpriteRegionOverride,
  TONEMAP_LUMINANCE_EPSILON,
  TRANSPARENT_SORT_CONFIG_KEY,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
  Transform,
  World,
  ZERO_CAMERA_CLEAR_FALLBACK,
  afterEach,
  assembleMaterialWithSkylightEntries,
  beforeAll,
  beforeEach,
  bindAnimationTargets,
  buildPbrPipelineLayouts,
  buildUnlitMaterialBgl,
  cameraProjectionFromF32,
  canonicalAdvanceAnimationPlayer,
  componentFieldDefault,
  componentFieldType,
  componentSchemaTypes,
  createSkinPaletteAllocator,
  createSkylightFallback,
  deriveAnimationTargetId,
  describe,
  disposeInstanceBuffers,
  drawPublished,
  drawWithOwners,
  expect,
  extractFrame,
  extractFrames,
  fileURLToPath,
  getOrCreateIblCache,
  getTransparentSortConfig,
  hasIblCache,
  it,
  makeMockShaderRegistry,
  mat4,
  mergeSkylightIntoMaterialBgl,
  prepareExtractContext,
  propagateTransforms,
  readFileSync,
  resolve,
  rhiOk,
  selectSwapChainFormat,
  setTransparentSortConfig,
  spriteAnimationTickSystem,
  standardMaterialShaderVariants,
  subscribeRendererErrors,
  toShared,
  tonemapReinhardLuminance,
  transparentSortEntries,
  unwrapRendererError,
  urpPipeline,
  vec3,
  vi,
  warnMultiLightDirectional,
  warnMultiLightPoint,
  warnMultiLightSpot,
  worldInternal,
];
type __MergedKeep =
  | AssetRuntimeErrorCode
  | BindGroupEntry
  | Buffer
  | CameraProjection
  | CameraSnapshot
  | EntityHandle
  | ExtractedLights
  | Handle
  | InstanceBufferCacheEntry
  | MaterialAsset
  | MeshAsset
  | RenderErrorCode
  | RendererErrorObservation
  | RendererType
  | RuntimeLayerErrorCode
  | Sampler
  | SkeletonAsset
  | SkinErrorCode
  | Texture
  | TextureFormat
  | TextureView
  | TransparentEntry
  | WorldType;

{
  // --- from transparent-sort.test.ts ---

  function makeEntry(
    partial: Partial<TransparentEntry> & { entityIndex: number },
  ): TransparentEntry {
    return {
      entityIndex: partial.entityIndex,
      materialHandle: partial.materialHandle ?? 0,
      layer: partial.layer ?? 0,
      posX: partial.posX ?? 0,
      posY: partial.posY ?? 0,
      posZ: partial.posZ ?? 0,
      pivotY: partial.pivotY ?? 0.5,
      sizeY: partial.sizeY ?? 1,
      sortKey: partial.sortKey,
    };
  }

  describe('transparentSortEntries - mode=0 horizontal-z (AC-10 horizontal)', () => {
    it('sorts by (layer asc, posZ asc); 4 entries crossing 3 layers + 2 posZ tiers', () => {
      const world = new World();
      setTransparentSortConfig(world, {
        mode: TRANSPARENT_SORT_MODE_LAYER_Z,
        yzAlpha: 1.0,
      }).unwrap();

      const entries: TransparentEntry[] = [
        makeEntry({ entityIndex: 0, layer: -100, posZ: 1 }), // bg, mid Z
        makeEntry({ entityIndex: 1, layer: 0, posZ: 0 }), // default, near Z
        makeEntry({ entityIndex: 2, layer: 0, posZ: 2 }), // default, far Z
        makeEntry({ entityIndex: 3, layer: 100, posZ: 1 }), // fg, mid Z
      ];

      const sorted = transparentSortEntries(entries, world);
      // Expected order: layer -100 first (bg), then layer 0 nearest Z (1),
      // then layer 0 mid Z (2), then layer 100 (fg).
      expect(sorted.map((e) => e.entityIndex)).toEqual([0, 1, 2, 3]);
    });

    it('within the same layer, lower posZ draws first (back-to-front horizontal-z)', () => {
      const world = new World();
      setTransparentSortConfig(world, {
        mode: TRANSPARENT_SORT_MODE_LAYER_Z,
        yzAlpha: 1.0,
      }).unwrap();
      const entries: TransparentEntry[] = [
        makeEntry({ entityIndex: 0, layer: 0, posZ: 5 }),
        makeEntry({ entityIndex: 1, layer: 0, posZ: -3 }),
        makeEntry({ entityIndex: 2, layer: 0, posZ: 2 }),
      ];
      const sorted = transparentSortEntries(entries, world);
      expect(sorted.map((e) => e.entityIndex)).toEqual([1, 2, 0]);
    });
  });

  describe('transparentSortEntries - mode=1 Y-sort (AC-10 JRPG foot-pivot)', () => {
    it('sortValue = -(posY - pivot.y * size.y); deeper feet draw later', () => {
      const world = new World();
      setTransparentSortConfig(world, {
        mode: TRANSPARENT_SORT_MODE_LAYER_Y,
        yzAlpha: 1.0,
      }).unwrap();

      // foot Y = posY - pivot.y * size.y
      //   e0: posY=1, pivot.y=1.0, size.y=1 -> foot=0,  sortValue=  0
      //   e1: posY=2, pivot.y=0.5, size.y=1 -> foot=1.5, sortValue=-1.5
      //   e2: posY=0, pivot.y=0.5, size.y=1 -> foot=-0.5, sortValue=0.5
      // Ascending sortValue: -1.5 (e1) < 0 (e0) < 0.5 (e2)
      // Higher foot Y => smaller sortValue => drawn earlier; lower foot Y
      // (closer to camera in JRPG) => larger sortValue => drawn later
      // (back-to-front for occlusion correctness).
      const entries: TransparentEntry[] = [
        makeEntry({ entityIndex: 0, posY: 1, pivotY: 1.0, sizeY: 1 }),
        makeEntry({ entityIndex: 1, posY: 2, pivotY: 0.5, sizeY: 1 }),
        makeEntry({ entityIndex: 2, posY: 0, pivotY: 0.5, sizeY: 1 }),
      ];

      const sorted = transparentSortEntries(entries, world);
      expect(sorted.map((e) => e.entityIndex)).toEqual([1, 0, 2]);
    });
  });

  describe('transparentSortEntries - mode=2 Y-Z blend (AC-10 Don\u0027t-Starve / isometric)', () => {
    it('sortValue = (posY - pivot.y * size.y) + yzAlpha * posZ with yzAlpha=1.0', () => {
      const world = new World();
      setTransparentSortConfig(world, {
        mode: TRANSPARENT_SORT_MODE_LAYER_YZ,
        yzAlpha: 1.0,
      }).unwrap();

      //   e0: posY=0, posZ=0, pivot.y=0.5, size.y=1 -> foot=-0.5, +0 = -0.5
      //   e1: posY=2, posZ=1, pivot.y=1.0, size.y=1 -> foot= 1, +1 =  2
      //   e2: posY=1, posZ=-1, pivot.y=0.5, size.y=1 -> foot= 0.5, -1 = -0.5
      // sortValues: e0=-0.5, e1=2, e2=-0.5 (e0 + e2 tie; stable sort
      // preserves insertion order so e0 before e2). Ascending => [e0, e2, e1].
      const entries: TransparentEntry[] = [
        makeEntry({ entityIndex: 0, posY: 0, posZ: 0, pivotY: 0.5, sizeY: 1 }),
        makeEntry({ entityIndex: 1, posY: 2, posZ: 1, pivotY: 1.0, sizeY: 1 }),
        makeEntry({ entityIndex: 2, posY: 1, posZ: -1, pivotY: 0.5, sizeY: 1 }),
      ];

      const sorted = transparentSortEntries(entries, world);
      expect(sorted.map((e) => e.entityIndex)).toEqual([0, 2, 1]);
    });

    it('yzAlpha=0.5 halves the Z contribution (isometric tilt)', () => {
      const world = new World();
      setTransparentSortConfig(world, {
        mode: TRANSPARENT_SORT_MODE_LAYER_YZ,
        yzAlpha: 0.5,
      }).unwrap();
      //   e0: posY=2, posZ=2 pivot=0.5 sizeY=1 -> foot=1.5, +0.5*2=1 => 2.5
      //   e1: posY=0, posZ=4 pivot=0.5 sizeY=1 -> foot=-0.5, +0.5*4=2 => 1.5
      // Ascending => [e1, e0]
      const entries: TransparentEntry[] = [
        makeEntry({ entityIndex: 0, posY: 2, posZ: 2 }),
        makeEntry({ entityIndex: 1, posY: 0, posZ: 4 }),
      ];
      const sorted = transparentSortEntries(entries, world);
      expect(sorted.map((e) => e.entityIndex)).toEqual([1, 0]);
    });
  });

  describe('transparentSortEntries - SortKey override (AC-10 priority)', () => {
    it('entity with SortKey replaces mode-formula result; layer remains primary key', () => {
      const world = new World();
      setTransparentSortConfig(world, {
        mode: TRANSPARENT_SORT_MODE_LAYER_Y,
        yzAlpha: 1.0,
      }).unwrap();

      // Without override, e0 would compute sortValue from foot Y = -(10 - 0.5)
      // = -9.5. With sortKey=-99, the override pins it to -99 (drawn first
      // among the same layer). The same-layer baseline e1 has no override and
      // computes its sortValue from mode-1 formula.
      //   e0: posY=10, pivot=0.5, sizeY=1, layer=0 -> mode formula = -(10-0.5) = -9.5
      //        override -> sortValue = -99
      //   e1: posY=0,  pivot=0.5, sizeY=1, layer=0 -> mode formula = -(0-0.5) = 0.5
      //
      // Ascending: -99 (e0) < 0.5 (e1)
      const entries: TransparentEntry[] = [
        makeEntry({
          entityIndex: 0,
          layer: 0,
          posY: 10,
          pivotY: 0.5,
          sizeY: 1,
          sortKey: -99,
        }),
        makeEntry({ entityIndex: 1, layer: 0, posY: 0, pivotY: 0.5, sizeY: 1 }),
      ];

      const sorted = transparentSortEntries(entries, world);
      expect(sorted.map((e) => e.entityIndex)).toEqual([0, 1]);
    });

    it('SortKey does NOT cross layers (layer remains the primary key)', () => {
      const world = new World();
      setTransparentSortConfig(world, {
        mode: TRANSPARENT_SORT_MODE_LAYER_Y,
        yzAlpha: 1.0,
      }).unwrap();
      // e0 in layer 100 with sortKey=-9999 (would be far in front by sort
      // value alone) still draws AFTER e1 in layer 0 because layer dominates.
      const entries: TransparentEntry[] = [
        makeEntry({ entityIndex: 0, layer: 100, sortKey: -9999 }),
        makeEntry({ entityIndex: 1, layer: 0, sortKey: 9999 }),
      ];
      const sorted = transparentSortEntries(entries, world);
      expect(sorted.map((e) => e.entityIndex)).toEqual([1, 0]);
    });
  });

  describe('transparentSortEntries - default config + empty input (regression)', () => {
    it('KV-missing world reads mode=0 default (horizontal-z); empty input returns empty array', () => {
      const world = new World();
      const sorted = transparentSortEntries([], world);
      expect(sorted).toEqual([]);
    });

    it('KV-missing world sorts a non-empty input by posZ (mode=0 default)', () => {
      const world = new World();
      // No setTransparentSortConfig call -> falls back to {mode:0,yzAlpha:1.0}.
      const entries: TransparentEntry[] = [
        makeEntry({ entityIndex: 0, posZ: 3 }),
        makeEntry({ entityIndex: 1, posZ: 1 }),
        makeEntry({ entityIndex: 2, posZ: 2 }),
      ];
      const sorted = transparentSortEntries(entries, world);
      expect(sorted.map((e) => e.entityIndex)).toEqual([1, 2, 0]);
    });
  });

  // ─── w2: mode=3 distance sort (TDD red phase) ─────────────────────────

  // AC-04: mode=3 sorts by squared distance from cameraPos, back-to-front
  // (far objects drawn first -> near objects drawn last). The signature
  // `transparentSortEntries(entries, world, cameraPos)` does not exist yet
  // (red: 3-arg overload is missing, mode=3 branch in computeSortValue is
  // missing, TRANSPARENT_SORT_MODE_DISTANCE constant is missing).

  // Pre-compute mode=3 as a literal: after w6 this will be
  // `TRANSPARENT_SORT_MODE_DISTANCE`.
  const DISTANCE_MODE = 3;

  describe('transparentSortEntries - mode=3 distance back-to-front (AC-04)', () => {
    it('5 entries with different camera distances sort back-to-front (far first)', () => {
      const world = new World();
      setTransparentSortConfig(world, {
        mode: DISTANCE_MODE,
        yzAlpha: 1.0,
      }).unwrap();
      const cameraPos: readonly [number, number, number] = [0, 0, 0];

      // 5 entries at varying distances from camera at origin.
      // dist^2: e0(1,0,0)=1, e1(3,0,0)=9, e2(2,0,0)=4,
      //          e3(0,5,0)=25, e4(0,0,1)=1
      // sortValue = -dist^2: e3=-25, e1=-9, e2=-4, e0=-1, e4=-1
      // e0 and e4 tie; stable sort preserves insertion order (e0 before e4).
      // ASC comparator => far first => order [e3, e1, e2, e0, e4].
      const entries: TransparentEntry[] = [
        makeEntry({ entityIndex: 0, posX: 1, posY: 0, posZ: 0 }),
        makeEntry({ entityIndex: 1, posX: 3, posY: 0, posZ: 0 }),
        makeEntry({ entityIndex: 2, posX: 2, posY: 0, posZ: 0 }),
        makeEntry({ entityIndex: 3, posX: 0, posY: 5, posZ: 0 }),
        makeEntry({ entityIndex: 4, posX: 0, posY: 0, posZ: 1 }),
      ];

      // Red: 3-arg signature does not exist yet.
      const sorted = (
        transparentSortEntries as (
          entries: readonly TransparentEntry[],
          world: World,
          cameraPos?: readonly [number, number, number],
        ) => readonly TransparentEntry[]
      )(entries, world, cameraPos);

      expect(sorted.map((e) => e.entityIndex)).toEqual([3, 1, 2, 0, 4]);
    });

    it('mode=3 SortKey override still takes priority over distance formula', () => {
      const world = new World();
      setTransparentSortConfig(world, {
        mode: DISTANCE_MODE,
        yzAlpha: 1.0,
      }).unwrap();
      const cameraPos: readonly [number, number, number] = [0, 0, 0];

      // e0 at dist^2=1 but sortKey=-99 pins it first (far).
      // e1 at dist^2=16 -> sortValue=-16. e2 at dist^2=4 -> sortValue=-4.
      // ASC: -99 (e0) < -16 (e1) < -4 (e2) => [e0, e1, e2].
      const entries: TransparentEntry[] = [
        makeEntry({ entityIndex: 0, layer: 0, posX: 1, posY: 0, posZ: 0, sortKey: -99 }),
        makeEntry({ entityIndex: 1, layer: 0, posX: 4, posY: 0, posZ: 0 }),
        makeEntry({ entityIndex: 2, layer: 0, posX: 2, posY: 0, posZ: 0 }),
      ];

      const sorted = (
        transparentSortEntries as (
          entries: readonly TransparentEntry[],
          world: World,
          cameraPos?: readonly [number, number, number],
        ) => readonly TransparentEntry[]
      )(entries, world, cameraPos);

      expect(sorted.map((e) => e.entityIndex)).toEqual([0, 1, 2]);
    });

    it('mode=3 0 entry / 1 entry boundary', () => {
      const world = new World();
      setTransparentSortConfig(world, {
        mode: DISTANCE_MODE,
        yzAlpha: 1.0,
      }).unwrap();
      const cameraPos: readonly [number, number, number] = [0, 0, 0];

      // 0 entries.
      let sorted = (
        transparentSortEntries as (
          entries: readonly TransparentEntry[],
          world: World,
          cameraPos?: readonly [number, number, number],
        ) => readonly TransparentEntry[]
      )([], world, cameraPos);
      expect(sorted).toEqual([]);

      // 1 entry.
      const single: TransparentEntry[] = [makeEntry({ entityIndex: 0, posX: 5, posY: 1, posZ: 3 })];
      sorted = (
        transparentSortEntries as (
          entries: readonly TransparentEntry[],
          world: World,
          cameraPos?: readonly [number, number, number],
        ) => readonly TransparentEntry[]
      )(single, world, cameraPos);
      expect(sorted.map((e) => e.entityIndex)).toEqual([0]);
    });

    it('mode=3 distance result differs from mode=0 (horizontal-z) order', () => {
      const worldDist = new World();
      setTransparentSortConfig(worldDist, {
        mode: DISTANCE_MODE,
        yzAlpha: 1.0,
      }).unwrap();
      const worldZ = new World();
      setTransparentSortConfig(worldZ, {
        mode: TRANSPARENT_SORT_MODE_LAYER_Z,
        yzAlpha: 1.0,
      }).unwrap();
      const cameraPos: readonly [number, number, number] = [0, 0, 0];

      // Two entries: e0 far in X but medium Z; e1 near in X but far Z.
      // mode=0 posZ: e0.posZ=2 < e1.posZ=5 => [e0, e1].
      // mode=3 dist^2: e0(3,0,2)=13, e1(1,0,5)=26, -dist^2: e1(-26) < e0(-13) => [e1, e0].
      const entries: TransparentEntry[] = [
        makeEntry({ entityIndex: 0, posX: 3, posZ: 2 }),
        makeEntry({ entityIndex: 1, posX: 1, posZ: 5 }),
      ];
      const sortedZ = transparentSortEntries(entries, worldZ);
      const sortedDist = (
        transparentSortEntries as (
          entries: readonly TransparentEntry[],
          world: World,
          cameraPos?: readonly [number, number, number],
        ) => readonly TransparentEntry[]
      )(entries, worldDist, cameraPos);

      expect(sortedZ.map((e) => e.entityIndex)).toEqual([0, 1]);
      expect(sortedDist.map((e) => e.entityIndex)).toEqual([1, 0]);
      // mode=3 order truly differs from mode=0 (red proof: distance sort
      // is a distinct sorting dimension).
    });
  });
}
