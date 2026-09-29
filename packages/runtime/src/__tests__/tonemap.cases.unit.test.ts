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
  // --- from tonemap.test.ts ---

  function rec709Luma(rgb: readonly [number, number, number]): number {
    const wR = REC709_LUMA_WEIGHTS[0];
    const wG = REC709_LUMA_WEIGHTS[1];
    const wB = REC709_LUMA_WEIGHTS[2];
    return (rgb[0] ?? 0) * wR + (rgb[1] ?? 0) * wG + (rgb[2] ?? 0) * wB;
  }

  describe('tonemapReinhardLuminance — 6-sample ground truth (T-M3.2 / AC-04 / AC-05 / AC-06)', () => {
    it('row 1: black pixel L_in=(0,0,0) maps to (0,0,0) without NaN', () => {
      const out = tonemapReinhardLuminance([0, 0, 0], 1.0, 4.0);
      // Y = 0 hits the floor; scale = 0 / EPSILON = 0; out = exposed * 0 = 0.
      // The critical assertion is finiteness: no NaN, no Inf.
      expect(Number.isFinite(out[0])).toBe(true);
      expect(Number.isFinite(out[1])).toBe(true);
      expect(Number.isFinite(out[2])).toBe(true);
      expect(out[0]).toBeCloseTo(0, 6);
      expect(out[1]).toBeCloseTo(0, 6);
      expect(out[2]).toBeCloseTo(0, 6);
    });

    it('row 2: white L_in=(4,4,4), exposure=1, Lw=4 — Y_prime saturates to ~1 (extended-Reinhard knee)', () => {
      const lIn: [number, number, number] = [4, 4, 4];
      const out = tonemapReinhardLuminance(lIn, 1.0, 4.0);
      // Y = 4 (white * Rec.709 sums to 1, so Y = 4 * 1 = 4).
      // Y' = 4 * (1 + 4/16) / (1 + 4) = 4 * 1.25 / 5 = 1.0.
      // scale = 1.0 / 4.0 = 0.25; out = (4,4,4) * 0.25 = (1,1,1).
      expect(out[0]).toBeCloseTo(1, 4);
      expect(out[1]).toBeCloseTo(1, 4);
      expect(out[2]).toBeCloseTo(1, 4);
    });

    it('row 3: mid-grey L_in=(0.5,0.5,0.5), exposure=1, Lw=4 — monotone compression below 0.5', () => {
      const lIn: [number, number, number] = [0.5, 0.5, 0.5];
      const out = tonemapReinhardLuminance(lIn, 1.0, 4.0);
      // Y = 0.5; Y' = 0.5 * (1 + 0.5/16) / 1.5 = 0.5 * 1.03125 / 1.5 = 0.34375.
      // scale = 0.34375 / 0.5 = 0.6875; out = 0.5 * 0.6875 = 0.34375.
      expect(out[0]).toBeCloseTo(0.34375, 4);
      expect(out[1]).toBeCloseTo(0.34375, 4);
      expect(out[2]).toBeCloseTo(0.34375, 4);
      // Output luminance equals Y' by construction for grey samples.
      expect(rec709Luma(out)).toBeCloseTo(0.34375, 4);
    });

    it('row 4: high-intensity coloured L_in=(10,5,2), exposure=1, Lw=4 — per-channel ratio preserved', () => {
      const lIn: [number, number, number] = [10, 5, 2];
      const out = tonemapReinhardLuminance(lIn, 1.0, 4.0);
      // Per-channel ratio identical to the input ratio (only luminance scaled).
      const inRatioGR = (lIn[0] ?? 1) === 0 ? 0 : (lIn[1] ?? 0) / (lIn[0] ?? 1);
      const outRatioGR = (out[0] ?? 1) === 0 ? 0 : (out[1] ?? 0) / (out[0] ?? 1);
      expect(outRatioGR).toBeCloseTo(inRatioGR, 4);
      const inRatioBR = (lIn[0] ?? 1) === 0 ? 0 : (lIn[2] ?? 0) / (lIn[0] ?? 1);
      const outRatioBR = (out[0] ?? 1) === 0 ? 0 : (out[2] ?? 0) / (out[0] ?? 1);
      expect(outRatioBR).toBeCloseTo(inRatioBR, 4);
      // All channels finite.
      expect(Number.isFinite(out[0])).toBe(true);
      expect(Number.isFinite(out[1])).toBe(true);
      expect(Number.isFinite(out[2])).toBe(true);
    });

    it('row 5: exposure=2 + L halved equivalent to exposure=1 + L full (AC-05)', () => {
      const lFull: [number, number, number] = [10, 5, 2];
      const lHalf: [number, number, number] = [5, 2.5, 1];
      const outA = tonemapReinhardLuminance(lFull, 1.0, 4.0);
      const outB = tonemapReinhardLuminance(lHalf, 2.0, 4.0);
      expect(outB[0]).toBeCloseTo(outA[0] ?? 0, 4);
      expect(outB[1]).toBeCloseTo(outA[1] ?? 0, 4);
      expect(outB[2]).toBeCloseTo(outA[2] ?? 0, 4);
    });

    it('row 6: Lw=1 + L=1 grey degrades to basic Reinhard (Y_prime collapses to 1)', () => {
      const lIn: [number, number, number] = [1, 1, 1];
      const out = tonemapReinhardLuminance(lIn, 1.0, 1.0);
      // Y = 1. Y' = 1 * (1 + 1/1) / (1 + 1) = 2 / 2 = 1.
      // scale = 1 / 1 = 1; out = (1,1,1).
      expect(out[0]).toBeCloseTo(1, 4);
      expect(out[1]).toBeCloseTo(1, 4);
      expect(out[2]).toBeCloseTo(1, 4);
    });
  });

  describe('tonemapReinhardLuminance — degenerate input safety (D-O3 floor)', () => {
    it('exposure=0 collapses to zero output (Y == 0 path hits the floor without NaN)', () => {
      const out = tonemapReinhardLuminance([100, 50, 20], 0, 4.0);
      expect(Number.isFinite(out[0])).toBe(true);
      expect(out[0]).toBeCloseTo(0, 6);
      expect(out[1]).toBeCloseTo(0, 6);
      expect(out[2]).toBeCloseTo(0, 6);
    });

    it('shared TONEMAP_LUMINANCE_EPSILON constant matches WGSL byte-for-byte (D-O3)', () => {
      expect(TONEMAP_LUMINANCE_EPSILON).toBe(1e-5);
    });
  });
}
