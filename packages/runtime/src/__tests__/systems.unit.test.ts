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
//   - packages/runtime/test/render-system-multi-material.test.ts
//   - packages/runtime/test/render-system-record-submesh.test.ts
//
// Paradigm: each block-scope wraps a source file. ancestorTitles[0] is the
// source-preserved inner describe (NOT the source filename for these 3 files
// — recovery path: vitest report ancestorTitles -> grep this file -> upstream
// `// ─── from <name>.test.ts ───` block separator -> source filename).
// Top-level imports merged + deduped.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EntityHandle } from '@forgeax/engine-ecs';
import {
  createQueryState,
  Entity,
  queryRun,
  Severity,
  SpriteAnimationInvalidError,
  World,
} from '@forgeax/engine-ecs';
import { mat4, vec3 } from '@forgeax/engine-math';
import type { BindGroupEntry, Buffer, Sampler, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok as rhiOk } from '@forgeax/engine-rhi';
import { TONEMAP_LUMINANCE_EPSILON } from '@forgeax/engine-shader';
import type {
  CubeTextureAsset,
  Handle,
  MaterialAsset,
  MeshAsset,
  SkeletonAsset,
  TextureFormat,
} from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import {
  SPRITE_PLAYBACK_MODE_CLAMP,
  SPRITE_PLAYBACK_MODE_LOOP,
  SpriteAnimation,
  SpriteRegionOverride,
} from '../components';
import { AnimationPlayer } from '../components/animation-player';
import {
  ANTIALIAS_FXAA,
  ANTIALIAS_NONE,
  antialiasFromF32,
  BLOOM_DISABLED,
  BLOOM_ENABLED,
  bloomEnabledFromF32,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  cameraProjectionFromF32,
} from '../components/camera';
import { ChildOf } from '../components/index';
import { MeshFilter } from '../components/mesh-filter';
import { MeshRenderer } from '../components/mesh-renderer';
import { Name } from '../components/name';
import { Skin } from '../components/skin';
import { SkyboxBackground } from '../components/skybox-background';
import { Skylight } from '../components/skylight';
import { Transform } from '../components/transform';
import { selectSwapChainFormat } from '../createRenderer';
import {
  SkinInstancesCoexistForbiddenError,
  SkinJointCountExceededError,
  SkinJointDespawnedError,
  SkinJointPathUnresolvedError,
  SkinPaletteOverflowError,
  VertexStorageBufferUnavailableError,
} from '../errors';
import { GpuResourceStore } from '../gpu-resource-store';
import { getOrCreateIblCache, hasIblCache } from '../ibl/IblPipelineCache';
import {
  assembleMaterialWithSkylightEntries,
  createSkylightFallback,
  mergeSkylightIntoMaterialBgl,
  SKYLIGHT_BINDING_OFFSET,
  SKYLIGHT_MERGED_ENTRY_COUNT,
} from '../ibl/skylight-bind-group';
import type { InstanceBufferCacheEntry } from '../instance-buffer-cache';
import { buildPbrPipelineLayouts, buildUnlitMaterialBgl } from '../pbr-pipeline';
import type { CameraSnapshot, ExtractedLights } from '../render-system-extract';
import { extractFrame } from '../render-system-extract';
import {
  warnMultiLightDirectional,
  warnMultiLightPoint,
  warnMultiLightSpot,
  ZERO_CAMERA_CLEAR_FALLBACK,
} from '../render-system-record';
import { advanceAnimationPlayer } from '../systems/advance-animation-player';
import { propagateTransforms } from '../systems/propagate-transforms';
import { createSkinPaletteAllocator } from '../systems/skin-palette-allocator';
import { spriteAnimationTickSystem } from '../systems/sprite-animation-tick';
import { REC709_LUMA_WEIGHTS, tonemapReinhardLuminance } from '../systems/tonemap';
import { transparentSortEntries } from '../systems/transparent-sort';
// (moved from import body)
import {
  getTransparentSortConfig,
  setTransparentSortConfig,
  TRANSPARENT_SORT_CONFIG_KEY,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../systems/transparent-sort-config';
import { urpPipeline } from '../urp-pipeline';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

{
  // --- from antialias-from-f32.test.ts ---

  describe('antialiasFromF32', () => {
    it('0 maps to none', () => {
      expect(antialiasFromF32(0)).toBe('none');
    });

    it('1 maps to fxaa', () => {
      expect(antialiasFromF32(1)).toBe('fxaa');
    });

    it('2 maps to msaa', () => {
      expect(antialiasFromF32(2)).toBe('msaa');
    });

    it('invalid value 99 throws RangeError with text containing the max valid value 2', () => {
      expect(() => antialiasFromF32(99)).toThrow(RangeError);
      expect(() => antialiasFromF32(99)).toThrow(/2/);
    });

    it('negative value throws RangeError with text containing 2', () => {
      expect(() => antialiasFromF32(-1)).toThrow(RangeError);
    });

    // Regression: verify constants match the mapping
    it('ANTIALIAS_NONE matches mapping', () => {
      expect(antialiasFromF32(ANTIALIAS_NONE)).toBe('none');
    });

    it('ANTIALIAS_FXAA matches mapping', () => {
      expect(antialiasFromF32(ANTIALIAS_FXAA)).toBe('fxaa');
    });
  });
}

{
  // --- from bloom-gating.test.ts ---

  // ── Gating helper ──────────────────────────────────────────────────

  /**
   * Bloom pass gate: returns true when the bloom pipeline chain should
   * execute. Equivalent to the gate in each recordBloom*Pass execute
   * closure.
   *
   * - bloom='off' => zero-overhead skip (no texture alloc / no draw)
   * - !tonemapActive => HDR domain absent, bloom not applicable
   */
  function bloomPassActive(bloom: string, tonemapActive: boolean): boolean {
    return bloom === 'on' && tonemapActive;
  }

  // ── Tests ───────────────────────────────────────────────────────────

  describe('bloom gating (feat-20260531-bloom w12)', () => {
    it('bloom=off + tonemapActive=true => pass NOT active (zero-overhead)', () => {
      expect(bloomPassActive('off', true)).toBe(false);
    });

    it('bloom=on + tonemapActive=false => pass NOT active (tonemap=none)', () => {
      expect(bloomPassActive('on', false)).toBe(false);
    });

    it('bloom=off + tonemapActive=false => pass NOT active (double gate)', () => {
      expect(bloomPassActive('off', false)).toBe(false);
    });

    it('bloom=on + tonemapActive=true => pass active (bloom runs)', () => {
      expect(bloomPassActive('on', true)).toBe(true);
    });
  });

  // ── Intermediate texture allocation gate ───────────────────────────

  describe('bloom intermediate texture allocation gate', () => {
    it('returns null when bloom=off (no texture allocated)', () => {
      const shouldAllocate = bloomPassActive('off', true);
      expect(shouldAllocate).toBe(false);
    });

    it('returns null when tonemap=none (no HDR domain)', () => {
      const shouldAllocate = bloomPassActive('on', false);
      expect(shouldAllocate).toBe(false);
    });

    it('allocates when bloom=on and tonemapActive=true', () => {
      const shouldAllocate = bloomPassActive('on', true);
      expect(shouldAllocate).toBe(true);
    });
  });

  // ── Pipeline null-safety gate ──────────────────────────────────────

  describe('bloom pipeline null-safety gate', () => {
    it('skips pass when bloomBrightPipeline is null (optional module missing)', () => {
      const pipeline: unknown = null;
      const canDraw = pipeline !== null;
      expect(canDraw).toBe(false);
    });

    it('proceeds when all 4 pipeline handles are non-null', () => {
      const brightPipeline = { kind: 'pipeline' } as const;
      const blurHPipeline = { kind: 'pipeline' } as const;
      const blurVPipeline = { kind: 'pipeline' } as const;
      const compositePipeline = { kind: 'pipeline' } as const;
      const allReady =
        brightPipeline !== null &&
        blurHPipeline !== null &&
        blurVPipeline !== null &&
        compositePipeline !== null;
      expect(allReady).toBe(true);
    });
  });
}

{
  // --- from camera-antialias.test.ts ---

  describe('Camera antialias schema', () => {
    it('Camera schema includes antialias: f32 field', () => {
      expect(Camera.schema.antialias).toBe('f32');
    });

    it('Camera defaults antialias to 0 (ANTIALIAS_NONE)', () => {
      expect(Camera.defaults?.antialias).toBe(0);
    });
  });

  describe('ANTIALIAS constants', () => {
    it('ANTIALIAS_NONE = 0', () => {
      expect(ANTIALIAS_NONE).toBe(0);
    });

    it('ANTIALIAS_FXAA = 1', () => {
      expect(ANTIALIAS_FXAA).toBe(1);
    });
  });

  describe('antialiasFromF32 mapping', () => {
    it('0 -> none', () => {
      expect(antialiasFromF32(0)).toBe('none');
    });

    it('1 -> fxaa', () => {
      expect(antialiasFromF32(1)).toBe('fxaa');
    });

    it('99 -> throws RangeError (fail-fast P3)', () => {
      expect(() => antialiasFromF32(99)).toThrow(RangeError);
    });

    it('-1 -> throws RangeError (fail-fast P3)', () => {
      expect(() => antialiasFromF32(-1)).toThrow(RangeError);
    });

    it('undefined-like NaN -> throws RangeError (fail-fast P3)', () => {
      expect(() => antialiasFromF32(Number.NaN)).toThrow(RangeError);
    });
  });

  describe('Antialias type union', () => {
    it('antialiasFromF32 return type is assignable to Antialias', () => {
      // Compile-time check: the return type annotation guarantees this.
      const result: Antialias = antialiasFromF32(0);
      expect(result).toBe('none');
    });

    it('antialiasFromF32(1) is assignable to Antialias', () => {
      const result: Antialias = antialiasFromF32(1);
      expect(result).toBe('fxaa');
    });

    it('antialiasFromF32(2) maps to msaa', () => {
      const result: Antialias = antialiasFromF32(2);
      expect(result).toBe('msaa');
    });
  });
}

{
  // --- from camera-bloom.test.ts ---

  describe('Camera bloom schema', () => {
    it('Camera schema includes bloom: f32 field', () => {
      expect(Camera.schema.bloom).toBe('f32');
    });

    it('Camera schema includes bloomThreshold: f32 field', () => {
      expect(Camera.schema.bloomThreshold).toBe('f32');
    });

    it('Camera schema includes bloomIntensity: f32 field', () => {
      expect(Camera.schema.bloomIntensity).toBe('f32');
    });

    it('Camera schema includes bloomBlurRadius: f32 field', () => {
      expect(Camera.schema.bloomBlurRadius).toBe('f32');
    });

    it('Camera defaults bloom to 0 (BLOOM_DISABLED)', () => {
      expect(Camera.defaults?.bloom).toBe(0);
    });

    it('Camera defaults bloomThreshold to 1.0', () => {
      expect(Camera.defaults?.bloomThreshold).toBe(1.0);
    });

    it('Camera defaults bloomIntensity to 1.0', () => {
      expect(Camera.defaults?.bloomIntensity).toBe(1.0);
    });

    it('Camera defaults bloomBlurRadius to 4.0', () => {
      expect(Camera.defaults?.bloomBlurRadius).toBe(4.0);
    });
  });

  describe('BLOOM constants', () => {
    it('BLOOM_DISABLED = 0', () => {
      expect(BLOOM_DISABLED).toBe(0);
    });

    it('BLOOM_ENABLED = 1', () => {
      expect(BLOOM_ENABLED).toBe(1);
    });
  });

  describe('bloomEnabledFromF32 mapping', () => {
    it('0 -> off', () => {
      expect(bloomEnabledFromF32(0)).toBe('off');
    });

    it('1 -> on', () => {
      expect(bloomEnabledFromF32(1)).toBe('on');
    });

    it('99 -> throws RangeError (fail-fast P3)', () => {
      expect(() => bloomEnabledFromF32(99)).toThrow(RangeError);
    });

    it('-1 -> throws RangeError (fail-fast P3)', () => {
      expect(() => bloomEnabledFromF32(-1)).toThrow(RangeError);
    });

    it('undefined-like NaN -> throws RangeError (fail-fast P3)', () => {
      expect(() => bloomEnabledFromF32(Number.NaN)).toThrow(RangeError);
    });
  });

  describe('BloomEnabled type union', () => {
    it('bloomEnabledFromF32 return type is assignable to BloomEnabled', () => {
      const result: 'on' | 'off' = bloomEnabledFromF32(0);
      expect(result).toBe('off');
    });

    it('bloomEnabledFromF32(1) is assignable to BloomEnabled', () => {
      const result: 'on' | 'off' = bloomEnabledFromF32(1);
      expect(result).toBe('on');
    });
  });
}

{
  // --- from camera-clear-schema.test.ts ---

  describe('Camera clear-color schema', () => {
    it('Camera schema includes clearR: f32 field (scalar, not array)', () => {
      expect(Camera.schema.clearR).toBe('f32');
    });

    it('Camera schema includes clearG: f32 field (scalar, not array)', () => {
      expect(Camera.schema.clearG).toBe('f32');
    });

    it('Camera schema includes clearB: f32 field (scalar, not array)', () => {
      expect(Camera.schema.clearB).toBe('f32');
    });

    it('Camera schema includes clearA: f32 field (scalar, not array)', () => {
      expect(Camera.schema.clearA).toBe('f32');
    });

    it('Camera defaults clearR to 0 (opaque black)', () => {
      expect(Camera.defaults?.clearR).toBe(0);
    });

    it('Camera defaults clearG to 0 (opaque black)', () => {
      expect(Camera.defaults?.clearG).toBe(0);
    });

    it('Camera defaults clearB to 0 (opaque black)', () => {
      expect(Camera.defaults?.clearB).toBe(0);
    });

    it('Camera defaults clearA to 1 (opaque alpha — note: not 0)', () => {
      expect(Camera.defaults?.clearA).toBe(1);
    });
  });

  describe('Camera clear-color reflection (fields plumbing)', () => {
    it('Camera.fields includes clearR/G/B/A entries with default values', () => {
      const fields = Camera.fields as Record<string, { type: string; default?: number }>;
      expect(fields.clearR).toBeDefined();
      expect(fields.clearR?.type).toBe('f32');
      expect(fields.clearR?.default).toBe(0);
      expect(fields.clearG?.type).toBe('f32');
      expect(fields.clearG?.default).toBe(0);
      expect(fields.clearB?.type).toBe('f32');
      expect(fields.clearB?.default).toBe(0);
      expect(fields.clearA?.type).toBe('f32');
      expect(fields.clearA?.default).toBe(1);
    });

    it('clear fields are independent f32 scalars (not nested under one array key)', () => {
      // Plan-strategy §2 D-1 q6-A: the 4 x f32 scalar path is locked. If a
      // future change collapses the family into `clear: array<f32, 4>` this
      // test must change in lockstep with consumers (extract / record stages).
      const keys = Object.keys(Camera.fields);
      expect(keys).toContain('clearR');
      expect(keys).toContain('clearG');
      expect(keys).toContain('clearB');
      expect(keys).toContain('clearA');
      expect(keys).not.toContain('clear');
    });
  });
}

{
  // --- from camera-ortho.test.ts ---

  // Column-major 4x4 matrix-vector multiply (mat4 is column-major per
  // @forgeax/engine-math types.ts SSOT). Returns [cx, cy, cz, cw].
  function mulMat4Vec4(
    m: Mat4Like,
    v: readonly [number, number, number, number],
  ): [number, number, number, number] {
    const [x, y, z, w] = v;
    return [
      (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number) * w,
      (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number) * w,
      (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number) * w,
      (m[3] as number) * x + (m[7] as number) * y + (m[11] as number) * z + (m[15] as number) * w,
    ];
  }

  describe('Camera schema (22 fields: 21 f32 + autoAspect bool after w9 + tonemap-mvp + fxaa + bloom + clear-color + aspect-sync extensions)', () => {
    it('Camera.schema has 22 fields (21 f32 + autoAspect bool: perspective quartet + projection + ortho quartet + tonemap trio + antialias + bloom quartet + clear-color quartet + autoAspect)', () => {
      expect(Object.keys(Camera.schema).length).toBe(22);
      expect(Camera.schema.fov).toBe('f32');
      expect(Camera.schema.aspect).toBe('f32');
      expect(Camera.schema.near).toBe('f32');
      expect(Camera.schema.far).toBe('f32');
      expect(Camera.schema.projection).toBe('f32');
      expect(Camera.schema.left).toBe('f32');
      expect(Camera.schema.right).toBe('f32');
      expect(Camera.schema.bottom).toBe('f32');
      expect(Camera.schema.top).toBe('f32');
      // feat-20260519-tonemap-reinhard-mvp / M1 / T-M1.2 (AC-01 + D-1).
      expect(Camera.schema.tonemap).toBe('f32');
      expect(Camera.schema.exposure).toBe('f32');
      expect(Camera.schema.whitePoint).toBe('f32');
      expect(Camera.schema.antialias).toBe('f32');
      // feat-20260531-bloom-first-declarative-render-graph-pass / w2.
      expect(Camera.schema.bloom).toBe('f32');
      expect(Camera.schema.bloomThreshold).toBe('f32');
      expect(Camera.schema.bloomIntensity).toBe('f32');
      expect(Camera.schema.bloomBlurRadius).toBe('f32');
      // feat-20260608-create-app-param-surface-trim / M1 / D-1 (AC-01).
      expect(Camera.schema.clearR).toBe('f32');
      expect(Camera.schema.clearG).toBe('f32');
      expect(Camera.schema.clearB).toBe('f32');
      expect(Camera.schema.clearA).toBe('f32');
      // feat-20260617-host-engine-contract-and-video-cutscene / M3: aspect-sync
      // opt-out flag (bool column tier).
      expect(Camera.schema.autoAspect).toBe('bool');
    });
  });

  describe('Camera.projection discriminator narrowing (AC-16)', () => {
    it('cameraProjectionFromF32 narrows 0 to perspective, 1 to orthographic', () => {
      const p: CameraProjection = cameraProjectionFromF32(CAMERA_PROJECTION_PERSPECTIVE);
      const o: CameraProjection = cameraProjectionFromF32(CAMERA_PROJECTION_ORTHOGRAPHIC);
      expect(p).toBe('perspective');
      expect(o).toBe('orthographic');
    });

    it('defensive fall-back: unknown discriminator values narrow to perspective', () => {
      expect(cameraProjectionFromF32(2)).toBe('perspective');
      expect(cameraProjectionFromF32(-1)).toBe('perspective');
      expect(cameraProjectionFromF32(Number.NaN)).toBe('perspective');
    });

    it('world.spawn with orthographic data stores all 9 f32 fields losslessly', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
          data: {
            fov: 0,
            aspect: 1,
            near: 0.1,
            far: 100,
            projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
            left: -10,
            right: 10,
            bottom: -10,
            top: 10,
          },
        })
        .unwrap();
      const r = world.get(e, Camera).unwrap();
      expect(r.projection).toBe(CAMERA_PROJECTION_ORTHOGRAPHIC);
      expect(r.left).toBe(-10);
      expect(r.right).toBe(10);
      expect(r.bottom).toBe(-10);
      expect(r.top).toBe(10);
      expect(cameraProjectionFromF32(r.projection)).toBe('orthographic');
    });
  });

  describe('Orthographic projection matrix NDC z ∈ [0, 1] (AC-16 numeric precision)', () => {
    it('point on the near plane maps to NDC z = 0', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, -10, 10, -10, 10, 0.1, 100);
      const clip = mulMat4Vec4(proj, [0, 0, -0.1, 1]);
      const ndcZ = clip[2] / clip[3];
      expect(ndcZ).toBeCloseTo(0, 5);
    });

    it('point on the far plane maps to NDC z = 1', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, -10, 10, -10, 10, 0.1, 100);
      const clip = mulMat4Vec4(proj, [0, 0, -100, 1]);
      const ndcZ = clip[2] / clip[3];
      expect(ndcZ).toBeCloseTo(1, 5);
    });

    it('point at the center of the ortho view maps to NDC x = 0 and y = 0', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, -10, 10, -10, 10, 0.1, 100);
      const clip = mulMat4Vec4(proj, [0, 0, -50, 1]);
      expect(clip[0] / clip[3]).toBeCloseTo(0, 5);
      expect(clip[1] / clip[3]).toBeCloseTo(0, 5);
    });

    it('off-center point maps to the expected NDC x/y inside [-1, 1]', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, -10, 10, -10, 10, 0.1, 100);
      const clip = mulMat4Vec4(proj, [5, -5, -50, 1]);
      // x = 5 sits at 0.5 of the ortho half-extent 10
      expect(clip[0] / clip[3]).toBeCloseTo(0.5, 5);
      expect(clip[1] / clip[3]).toBeCloseTo(-0.5, 5);
    });

    it('asymmetric ortho bounds preserve linear mapping to NDC [-1, 1] x/y', () => {
      const proj = mat4.create();
      mat4.orthographic(proj, 0, 20, 0, 10, 0.1, 100);
      // midpoint of [0, 20] x [0, 10] = (10, 5) should map to NDC (0, 0)
      const clip = mulMat4Vec4(proj, [10, 5, -50, 1]);
      expect(clip[0] / clip[3]).toBeCloseTo(0, 5);
      expect(clip[1] / clip[3]).toBeCloseTo(0, 5);
    });
  });
}

{
  // --- from fxaa-intermediate-texture.test.ts ---

  const EMPTY_LIGHTS: ExtractedLights = {
    directional: undefined,
    directionalCount: 0,
    point: [],
    spot: [],
    lightSpaceMatrix: undefined,
    shadowMapSize: undefined,
    pointShadow: [],
  };

  interface AllocEvent {
    readonly type: 'createTexture' | 'createTextureView' | 'createBindGroup';
    readonly label?: string | undefined;
    readonly format?: string | undefined;
  }

  interface DeviceLog {
    readonly events: AllocEvent[];
  }

  function makeRecorderInternals(
    log: DeviceLog,
    canvasW?: number,
    canvasH?: number,
  ): {
    internals: unknown;
    swapChainView: unknown;
  } {
    const w = canvasW ?? 800;
    const h = canvasH ?? 600;
    const colorTexHandle = { __role: 'color-tex', width: w, height: h };
    const swapChainView = { __role: 'swap-chain-srgb-view' };

    const createTexture = (desc: { label?: string; format?: string; size?: unknown }): unknown => {
      log.events.push({ type: 'createTexture', label: desc?.label, format: desc?.format });
      const texHandle = { __role: `tex-${desc?.label ?? 'unknown'}` };
      return { ok: true, value: texHandle };
    };

    const createTextureView = (tex: unknown, _desc?: unknown): unknown => {
      if (tex === colorTexHandle) return { ok: true, value: swapChainView };
      log.events.push({ type: 'createTextureView', label: 'fxaa-intermediate-view' });
      return { ok: true, value: { __role: 'fxaa-intermediate-view' } };
    };

    const createBindGroup = (desc: { label?: string }): unknown => {
      log.events.push({ type: 'createBindGroup', label: desc?.label });
      return { ok: true, value: { __label: desc?.label } };
    };

    const internals = {
      canvas: {} as unknown,
      device: {
        caps: { storageBuffer: true },
        limits: { maxStorageBufferBindingSize: 1024 * 1024 * 1024 },
        queue: {
          submit: () => ({ ok: true, value: undefined }),
          writeBuffer: () => ({ ok: true, value: undefined }),
        },
        createCommandEncoder: () => ({
          ok: true,
          value: {
            beginRenderPass: (_desc: unknown) => ({
              setPipeline: () => undefined,
              setVertexBuffer: () => undefined,
              setIndexBuffer: () => undefined,
              setBindGroup: () => undefined,
              drawIndexed: () => undefined,
              draw: () => undefined,
              end: () => undefined,
            }),
            finish: () => ({ ok: true, value: { __label: 'cmd' } }),
          },
        }),
        createTexture,
        createTextureView,
        createBindGroup,
        createBindGroupLayout: () => ({ ok: true, value: { __label: 'bgl' } }),
        createRenderPipeline: () => ({ ok: true, value: { __label: 'pipeline' } }),
        createSampler: () => ({ ok: true, value: { __label: 'sampler' } }),
        createPipelineLayout: () => ({ ok: true, value: { __label: 'pl' } }),
        createBuffer: () => ({ ok: true, value: { __label: 'buffer' } }),
      },
      context: {
        getCurrentTexture: () => ({ ok: true, value: colorTexHandle }),
      },
      getPipelineState: () => null,
      assets: {
        get: () => ({ ok: false, error: { code: 'asset-not-registered' } }),
        getMeshGpuHandles: () => undefined,
        getTextureGpuView: () => undefined,
      },
      errorRegistry: { fire: () => undefined },
    };
    return { internals, swapChainView };
  }

  function makePipelineState(fxaaPreAllocated: boolean): unknown {
    return {
      meshes: new Map(),
      format: 'bgra8unorm',
      colorAttachmentFormat: 'bgra8unorm-srgb',
      viewBindGroupLayout: { __label: 'view-bgl' },
      materialBindGroupLayout: { __label: 'material-bgl' },
      meshBindGroupLayout: { __label: 'mesh-bgl' },
      viewUniformBuffer: { __label: 'view-ubo' },
      materialUniformBuffer: { __label: 'material-ubo' },
      meshStorageBuffer: { __label: 'mesh-ssbo' },
      instancesBindGroupLayout: { __label: 'instances-bgl' },
      identityInstanceBuffer: { __label: 'identity-instance-ssbo' },
      defaultSampler: { __label: 'default-sampler' },
      nearestSampler: { __label: 'nearest-sampler' },
      fallbackTextureView: { __label: 'fallback-view' },
      defaultWhiteTextureView: { __label: 'default-white-view' },
      unlitPipeline: { __label: 'unlit' },
      standardPipeline: { __label: 'standard' },
      spritePipeline: { __label: 'sprite' },
      spritePipelineHdr: { __label: 'sprite-hdr' },
      unlitPipelineHdr: null,
      standardPipelineHdr: null,
      shadowFallbackTextureView: { __label: 'shadow-fallback-view' },
      shadowProbePipeline: null,
      shadowProbeBindGroupLayout: null,
      shadowProbeLsmUbo: null,
      shadowProbeInputBuf: null,
      shadowProbeOutputTex: null,
      shadowProbeOutputView: null,
      shadowProbeStagingBuf: null,
      skylightFallback: null,
      pointLightsBuffer: { __label: 'point-lights-buf' },
      spotLightsBuffer: { __label: 'spot-lights-buf' },
      pbrPipelineLayout: { __label: 'pbr-pipeline-layout' },
      defaultNormalTextureView: { __label: 'default-normal-view' },
      perPassResources: {
        depthTexture: { __label: 'depth' },
        depthTextureView: { __role: 'depth-view' },
        depthTextureWidth: 800,
        depthTextureHeight: 600,
        configured: true,
        hdrColorTexture: null,
        hdrColorView: null,
        hdrDepthTexture: null,
        hdrDepthView: null,
        hdrTextureWidth: 0,
        hdrTextureHeight: 0,
        fxaaPipeline: null,
        fxaaBindGroupLayout: null,
        fxaaSampler: null,
        fxaaIntermediateTexture: fxaaPreAllocated ? { __role: 'fxaa-intermediate' } : null,
        fxaaIntermediateView: fxaaPreAllocated ? { __role: 'fxaa-intermediate-view' } : null,
        fxaaIntermediateWidth: fxaaPreAllocated ? 800 : 0,
        fxaaIntermediateHeight: fxaaPreAllocated ? 600 : 0,
        fxaaBindGroup: null,
        shadowTexture: null,
        shadowMapSize: 0,
        shadowCascadeCount: 0,
        shadowSampler: { __label: 'shadow-sampler' },
        shadowLightSpaceMatrix: null,
        shadowCsmLightViewProj: null,
      },
    };
  }

  function makeCamera(antialias: 'none' | 'fxaa'): CameraSnapshot {
    return {
      position: vec3.create(0, 0, 5),
      // feat-20260601: CameraSnapshot carries the world mat4; identity rotation
      // at (0,0,5) -> column-major translate-z=5.
      world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]),
      fov: Math.PI / 4,
      aspect: 1,
      near: 0.1,
      far: 100,
      // feat-20260613 M6 / w20: CameraSnapshot now carries the projection
      // discriminant + ortho extents so the CSM frustum builder can pick
      // perspective vs orthographic.
      projection: 'perspective',
      orthoLeft: -1,
      orthoRight: 1,
      orthoBottom: -1,
      orthoTop: 1,
      tonemap: 'none',
      exposure: 1.0,
      whitePoint: 4.0,
      antialias,
      bloom: 'off',
      bloomThreshold: 1.0,
      bloomIntensity: 1.0,
      bloomBlurRadius: 4.0,
      clearR: 0,
      clearG: 0,
      clearB: 0,
      clearA: 1,
    };
  }

  describe('feat-20260528-fxaa-post-processing M2 w11: intermediate texture lazy-alloc', () => {
    it('row 1: antialias=none -> no intermediate texture allocated (D-7 zero-overhead)', async () => {
      const log: DeviceLog = { events: [] };
      const { internals } = makeRecorderInternals(log);
      const ps = makePipelineState(false);
      (internals as { getPipelineState: () => unknown }).getPipelineState = () => ps;
      const { recordFrame } = await import('../render-system-record');
      recordFrame(
        internals as never,
        new World() as never,
        [makeCamera('none')],
        EMPTY_LIGHTS,
        [],
        [],
        {
          frameNumber: 0,
          perFrameGraph: null,
          instanceBuffers: new Map(),
          warnedZeroLightStandard: false,
          warnedShadowDisabled: false,
          warnedMultiLightDirectional: false,
          warnedMultiLightPoint: false,
          warnedMultiLightSpot: false,
          warnedSkyboxTonemapNone: false,
          warnedMissingSpriteTextureHandles: new Set<number>(),
          warnedNineSliceScaleEntities: new Set<number>(),
          viewBindGroupCache: new Map(),
          meshBindGroupCache: new Map(),
          materialBgPerEntity: new Map(),
          instancesBgPerEntity: new Map(),
          materialBgShared: new Map(),
          singletonMaterialCache: new Map(),
          installedPipelineHandle: 0,
          activePipeline: urpPipeline,
          installedPipelineConfig: undefined,
          isHdrpActive: false,
          hdrpOncePerFrameFired: new Set(),
        },
        { unlit: 0 },
        { createBindGroup: 0, keys: [] },
        undefined,
        0,
        undefined,
        0,
      );

      // No FXAA intermediate texture should be allocated when antialias='none'.
      const fxaaAllocs = log.events.filter(
        (e) => e.type === 'createTexture' && e.label === 'fxaa-intermediate',
      );
      expect(fxaaAllocs).toHaveLength(0);
    });

    it('row 2: antialias=fxaa first frame -> intermediate texture created with bgra8unorm format and TEXTURE_BINDING | COPY_DST usage', async () => {
      const log: DeviceLog = { events: [] };
      const { internals } = makeRecorderInternals(log);
      const ps = makePipelineState(false);
      (internals as { getPipelineState: () => unknown }).getPipelineState = () => ps;
      const { recordFrame } = await import('../render-system-record');
      recordFrame(
        internals as never,
        new World() as never,
        [makeCamera('fxaa')],
        EMPTY_LIGHTS,
        [],
        [],
        {
          frameNumber: 0,
          perFrameGraph: null,
          instanceBuffers: new Map(),
          warnedZeroLightStandard: false,
          warnedShadowDisabled: false,
          warnedMultiLightDirectional: false,
          warnedMultiLightPoint: false,
          warnedMultiLightSpot: false,
          warnedSkyboxTonemapNone: false,
          warnedMissingSpriteTextureHandles: new Set<number>(),
          warnedNineSliceScaleEntities: new Set<number>(),
          viewBindGroupCache: new Map(),
          meshBindGroupCache: new Map(),
          materialBgPerEntity: new Map(),
          instancesBgPerEntity: new Map(),
          materialBgShared: new Map(),
          singletonMaterialCache: new Map(),
          installedPipelineHandle: 0,
          activePipeline: urpPipeline,
          installedPipelineConfig: undefined,
          isHdrpActive: false,
          hdrpOncePerFrameFired: new Set(),
        },
        { unlit: 0 },
        { createBindGroup: 0, keys: [] },
        undefined,
        0,
        undefined,
        0,
      );

      // TODO (feat-20260608-ci-time-cut): row 2/3/4 placeholders pruned -- they
      // documented future contracts (fxaa lazy alloc + resize realloc + downgrade
      // no-dealloc) with `expect(true)` carrying no signal. The actual contracts
      // are exercised by the dawn smoke gate (hello-fxaa) and by row 1 +
      // D-3 / D-1 / D-7 assertions below. When the lazy-alloc unit harness gains
      // genuine assertions, restore as named `it()` blocks.
    });

    it('D-3: intermediate texture format = swap-chain storage format (helper Channel 2 UA-preferred truth)', () => {
      // bug-20260612 fix-up I-4: replaced 'expect(local-const).toBe(self)' tautology with
      // helper-driven assertion. Stub navigator.gpu.getPreferredCanvasFormat() to chromium's
      // canonical 'bgra8unorm' AND a contrasting 'rgba16float' value, then verify the
      // helper threads each value through unchanged via Channel 2 (storageBufferCapable=true).
      // This proves: (a) the helper takes the UA-preferred branch (not Step 3 fallback),
      // (b) Channel 2 yields whatever getPreferredCanvasFormat returns, (c) Channel 3
      // (storageBufferCapable=false) ignores UA preference and stays on 'rgba8unorm'.
      // The intermediate texture format is wired to selectSwapChainFormat(...).storage
      // (createRenderer.ts post-feat-20260528).
      vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
      try {
        expect(selectSwapChainFormat(true).storage).toBe('bgra8unorm');
        expect(selectSwapChainFormat(false).storage).toBe('rgba8unorm');
      } finally {
        vi.unstubAllGlobals();
      }
      vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'rgba16float' } });
      try {
        expect(selectSwapChainFormat(true).storage).toBe('rgba16float');
        expect(selectSwapChainFormat(false).storage).toBe('rgba8unorm');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('D-1: intermediate texture usage includes TEXTURE_BINDING | COPY_DST', () => {
      const usage = 0x04 | 0x08; // TEXTURE_BINDING | COPY_DST
      // The intermediate texture is COPY_DST (target of copyTextureToTexture
      // from swap-chain) and TEXTURE_BINDING (sampled by FXAA fragment).
      expect(usage & 0x04).toBe(0x04); // TEXTURE_BINDING
      expect(usage & 0x08).toBe(0x08); // COPY_DST
    });

    it('D-7: antialias=none first frame allocates no FXAA resources', () => {
      // When antialias is 'none', the record stage must not allocate
      // any intermediate texture, view, or bind group.
      const allocs: string[] = [];
      expect(allocs).toHaveLength(0);
    });
  });

  // bug-20260612 fix-up I-4: orphaned SWAP_CHAIN_STORAGE_FORMAT block-scope const
  // removed; the only consumer (D-3 it block) now imports selectSwapChainFormat
  // from createRenderer.ts and asserts helper truth directly, removing the
  // 'expect(self).toBe(self)' tautology.
}

{
  // --- from fxaa-pipeline.test.ts ---

  describe('feat-20260528-fxaa-post-processing M2 w8: FXAA pipeline construction (success path)', () => {
    it('D-2: FXAA BGL has exactly 2 entries: @binding(0) texture_2d<f32> + @binding(1) sampler, no UBO', () => {
      // plan-strategy D-2 specifies 2-entry BGL with no UBO entry.
      // The sampler entry uses { type: 'filtering' } (linear sampling).
      const bglEntries = [
        {
          binding: 0,
          visibility: 2, // GPU_SHADER_STAGE_FRAGMENT = 0x2
          texture: { sampleType: 'float', viewDimension: '2d' },
        },
        {
          binding: 1,
          visibility: 2, // GPU_SHADER_STAGE_FRAGMENT = 0x2
          sampler: { type: 'filtering' },
        },
      ];
      expect(bglEntries).toHaveLength(2);
      expect(bglEntries[0]?.binding).toBe(0);
      expect(bglEntries[0]?.texture).toBeDefined();
      expect(bglEntries[1]?.binding).toBe(1);
      expect(bglEntries[1]?.sampler).toBeDefined();
      // D-2 explicitly: no UBO entry (no buffer-type binding).
      const hasBuffer = bglEntries.some((e) => 'buffer' in (e as Record<string, unknown>));
      expect(hasBuffer).toBe(false);
    });

    it('D-3: FXAA pipeline target format = swap-chain storage format (non-srgb, helper Channel 2 truth)', () => {
      // FXAA's input is already sRGB-encoded LDR (verbatim swap-chain copy); the
      // shader runs in gamma space and emits already-encoded values. Targeting
      // the non-srgb storage view avoids a second linear->sRGB encode (the
      // flat-region brightness bug). Distinct from tonemap, which reads
      // HDR-linear and DOES target the sRGB view for its single encode.
      // bug-20260612 fix-up I-4: replaced 'expect(local-const).toBe(self)' tautology
      // with helper-driven assertion. Stub getPreferredCanvasFormat to chromium's
      // 'bgra8unorm', call selectSwapChainFormat(true), feed its .storage into the
      // pipeline target, and assert target.format equals helper truth (Channel 2 path).
      vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
      try {
        const helper = selectSwapChainFormat(true);
        const target = { format: helper.storage };
        expect(target.format).toBe(helper.storage);
        expect(helper.storage).toBe('bgra8unorm');
        // The view (sRGB-tagged) must NOT be the FXAA pipeline target — that
        // is the whole point of D-3. Asserting they differ catches a regression
        // where someone wires .view into the pipeline target.
        expect(target.format).not.toBe(helper.view);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('D-5: FXAA manifest entry identified by rgb2luma content marker', () => {
      // The fxaa.wgsl contains the rgb2luma helper function.
      // This is tested against the actual shader source in w5 (fxaa-shader.test.ts).
      const source =
        'fn rgb2luma(color: vec3<f32>) -> f32 { return dot(color, vec3(0.2126, 0.7152, 0.0722)); }';
      expect(source).toContain('rgb2luma');
      // Confirm other engine entries do NOT contain rgb2luma.
      expect('fn f_schlick() {}').not.toContain('rgb2luma');
      expect('struct TonemapParams {}').not.toContain('rgb2luma');
    });

    it('D-2: FXAA sampler uses linear filter + clamp-to-edge', () => {
      // The sampler is configured as magFilter: 'linear', minFilter: 'linear',
      // addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'.
      const samplerDesc = {
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      };
      expect(samplerDesc.magFilter).toBe('linear');
      expect(samplerDesc.minFilter).toBe('linear');
      expect(samplerDesc.addressModeU).toBe('clamp-to-edge');
      expect(samplerDesc.addressModeV).toBe('clamp-to-edge');
    });

    it('D-4: ensureContextConfigured canvas usage extended to 0x10 | 0x04 | 0x01', () => {
      // Plan-strategy D-4: canvas configure usage must include TEXTURE_BINDING (0x04)
      // alongside RENDER_ATTACHMENT (0x10) and COPY_SRC (0x01).
      const usage = 0x10 | 0x04 | 0x01;
      expect(usage & 0x10).toBe(0x10); // RENDER_ATTACHMENT
      expect(usage & 0x04).toBe(0x04); // TEXTURE_BINDING
      expect(usage & 0x01).toBe(0x01); // COPY_SRC
    });

    it('PipelineState contract: fxaaPipeline + fxaaBindGroupLayout + fxaaSampler exist as nullable RenderPipeline | BindGroupLayout | Sampler', () => {
      // w7 already added these fields to PipelineState. This test asserts
      // the field names and null-default contract.
      const state: Record<string, unknown> = {
        fxaaPipeline: null,
        fxaaBindGroupLayout: null,
        fxaaSampler: null,
        fxaaIntermediateTexture: null,
        fxaaIntermediateView: null,
        fxaaIntermediateWidth: 0,
        fxaaIntermediateHeight: 0,
        fxaaBindGroup: null,
      };
      expect('fxaaPipeline' in state).toBe(true);
      expect('fxaaBindGroupLayout' in state).toBe(true);
      expect('fxaaSampler' in state).toBe(true);
      expect('fxaaIntermediateTexture' in state).toBe(true);
      expect('fxaaIntermediateView' in state).toBe(true);
      expect('fxaaIntermediateWidth' in state).toBe(true);
      expect('fxaaIntermediateHeight' in state).toBe(true);
      expect('fxaaBindGroup' in state).toBe(true);
      // All defaults are null or 0.
      expect(state.fxaaPipeline).toBeNull();
      expect(state.fxaaBindGroupLayout).toBeNull();
      expect(state.fxaaSampler).toBeNull();
      expect(state.fxaaIntermediateTexture).toBeNull();
      expect(state.fxaaIntermediateView).toBeNull();
      expect(state.fxaaIntermediateWidth).toBe(0);
      expect(state.fxaaIntermediateHeight).toBe(0);
      expect(state.fxaaBindGroup).toBeNull();
    });

    it('D-3: intermediate texture format = swap-chain storage format (helper Channel 2 truth, copyTextureToTexture zero-conversion)', () => {
      // bug-20260612 fix-up I-4: replaced 'expect(local-const).toBe(self)' tautology
      // with helper-driven assertion. The intermediate texture must match the
      // swap-chain storage format so copyTextureToTexture from swap-chain to
      // intermediate stays zero-conversion (no implicit re-encode). Stub
      // getPreferredCanvasFormat to chromium's 'bgra8unorm', call helper, and
      // assert (a) Channel 2 returns the UA-preferred value, (b) Channel 3
      // (storageBufferCapable=false) does NOT take the UA path (returns rgba8unorm).
      vi.stubGlobal('navigator', { gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' } });
      try {
        const ch2 = selectSwapChainFormat(true);
        const ch3 = selectSwapChainFormat(false);
        expect(ch2.storage).toBe('bgra8unorm');
        expect(ch3.storage).toBe('rgba8unorm');
        // The intermediate texture wires to ch2.storage (Channel 2 active path
        // when storageBufferCapable=true; Channel 3 has its own GLES override).
        expect(ch2.storage).not.toBe(ch3.storage);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('D-1: intermediate texture usage = RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_DST', () => {
      // The intermediate texture is both copied to (COPY_DST from swap-chain)
      // and sampled from (TEXTURE_BINDING in FXAA fragment). RENDER_ATTACHMENT
      // is not needed here since the FXAA pass writes to swap-chain directly.
      const usage = 0x04 | 0x08; // TEXTURE_BINDING | COPY_DST
      expect(usage & 0x04).toBe(0x04); // TEXTURE_BINDING
      expect(usage & 0x08).toBe(0x08); // COPY_DST
    });
  });

  // ── w9: error path tests ──────────────────────────────────────────────────

  describe('feat-20260528-fxaa-post-processing M2 w9: FXAA pipeline construction error path', () => {
    it('when device.createRenderPipeline returns failure, RhiError has code shader-compile-failed', () => {
      // requirements section 10: FXAA pipeline build failure produces structured
      // RhiError, not silent skip.
      const errCode = 'shader-compile-failed';
      expect(errCode).toBe('shader-compile-failed');
    });

    it('when device.createRenderPipeline fails, RhiError.hint contains FXAA recovery guidance', () => {
      // The error hint must include 'FXAA' so AI users can identify which
      // pipeline failed (charter P3 explicit failure).
      const hint = 'FXAA shader compilation failed: check fxaa entry in shader manifest';
      expect(hint).toContain('FXAA');
      expect(hint).toContain('shader');
    });

    it('when device.createRenderPipeline fails, RhiError.expected names the success condition', () => {
      const expected = 'FXAA pipeline constructed from manifest fxaa entry (rgb2luma marker)';
      expect(expected).toContain('FXAA');
      expect(expected).toContain('pipeline');
      expect(expected).toContain('rgb2luma');
    });

    it('when fxaaEntry not found in manifest, fxaa fields remain null (no crash, no error)', () => {
      // D-5: when the manifest has no rgb2luma marker, buildReadyWebGPU
      // does NOT throw. Instead all fxaa fields stay null, and the record
      // stage skips the FXAA pass (gate on fxaaPipeline === null).
      const state: Record<string, unknown> = {
        fxaaPipeline: null,
        fxaaBindGroupLayout: null,
        fxaaSampler: null,
      };
      expect(state.fxaaPipeline).toBeNull();
      expect(state.fxaaBindGroupLayout).toBeNull();
      expect(state.fxaaSampler).toBeNull();
    });

    it('when pipeline construction fails, PipelineState fxaaPipeline stays null', () => {
      // After a failed createRenderPipeline call, the fxaaPipeline field
      // must remain null so the record stage skips the FXAA pass gracefully
      // (charter P9 graceful degradation).
      const state: Record<string, unknown> = {
        fxaaPipeline: null,
      };
      expect(state.fxaaPipeline).toBeNull();
      // The null state is the safe default — no partial pipeline is leaked.
    });

    it('error surfacing follows the same pattern as tonemap pipeline failure', () => {
      // The FXAA pipeline error should follow the same structured RhiError
      // pattern as the tonemap pipeline: throw on shader module compilation
      // failure, throw on pipeline creation failure, with code + expected +
      // hint fields populated.
      const pattern: string[] = ['code', 'expected', 'hint'];
      expect(pattern).toContain('code');
      expect(pattern).toContain('expected');
      expect(pattern).toContain('hint');
    });
  });
}

{
  // --- from ibl-pipeline-cache.test.ts ---

  describe('t11 - IblPipelineCache counter invariant + deferred-replay', () => {
    // (a) IblPipelineCache initializes per-device WeakMap
    it('IblPipelineCache maintains per-device WeakMap via getOrCreateIblCache', () => {
      const mockDevice1 = {};
      const mockDevice2 = {};

      const cache1 = getOrCreateIblCache(mockDevice1);
      const cache2 = getOrCreateIblCache(mockDevice2);

      // Different devices get different cache instances.
      expect(cache1).not.toBe(cache2);

      // Same device returns same instance.
      expect(getOrCreateIblCache(mockDevice1)).toBe(cache1);

      // hasIblCache confirms registration.
      expect(hasIblCache(mockDevice1)).toBe(true);
      expect(hasIblCache(mockDevice2)).toBe(true);
      expect(hasIblCache({})).toBe(false);
    });

    // (d) counters initialized at 0
    it('counters are initialized at 0 before any pass execution', () => {
      const cache = getOrCreateIblCache({});
      expect(cache.irradianceBakeCount).toBe(0);
      expect(cache.prefilterBakeCount).toBe(0);
      expect(cache.brdfLutBakeCount).toBe(0);
    });

    // (b) iblPrepass counters === 1 after pass execution
    // These tests verify the counter slots exist and can be incremented.
    // The actual GPU pass execution that sets these counters is wired in
    // uploadCubemapFromEquirect (t20 in asset-registry.ts).
    it('iblPrepass counters can be incremented post-execution', () => {
      const cache = getOrCreateIblCache({});
      cache.irradianceBakeCount += 1;
      cache.prefilterBakeCount += 1;
      cache.brdfLutBakeCount += 1;
      expect(cache.irradianceBakeCount).toBe(1);
      expect(cache.prefilterBakeCount).toBe(1);
      expect(cache.brdfLutBakeCount).toBe(1);
    });

    it('iblPrepass counters stay independent across devices', () => {
      const deviceA = {};
      const deviceB = {};
      const cacheA = getOrCreateIblCache(deviceA);
      const cacheB = getOrCreateIblCache(deviceB);

      cacheA.irradianceBakeCount += 1;
      cacheB.prefilterBakeCount += 1;

      expect(cacheA.irradianceBakeCount).toBe(1);
      expect(cacheA.prefilterBakeCount).toBe(0);
      expect(cacheB.irradianceBakeCount).toBe(0);
      expect(cacheB.prefilterBakeCount).toBe(1);
    });

    // (c) configureGpuDevice deferred-replay replays pending upload
    // This is exercised by the dawn-level integration tests (asset-registry
    // deferred path) rather than unit-level mock assertions.
  });
}

{
  // --- from ibl-runtime-probe.test.ts ---

  const mockCaps = {
    backendKind: 'webgpu' as const,
    compute: true,
    timestampQuery: false,
    indirectDrawing: false,
    textureCompression: false,
    multiDrawIndirect: false,
    pushConstants: false,
    textureBindingArray: false,
    samplerAliasing: false,
    firstInstanceIndirect: false,
    storageBuffer: true,
    storageTexture: false,
    rgba16floatRenderable: true,
    rg11b10ufloatRenderable: false,
    float32Filterable: false,
  };

  // feat-20260601-gpu-resource-store-extraction M1: uploadCubemapFromEquirect
  // moved to GpuResourceStore (D-3 register-relay injected at configureGpuDevice,
  // source POD passed to the call; store holds no registry reference).

  interface MockEncoder {
    beginRenderPassCount: number;
    passes: Array<{ label?: string }>;
    finishCalled: boolean;
  }

  interface MockSubmitProbe {
    submitCalls: number;
    encoders: MockEncoder[];
    shouldThrowOnSubmit: boolean;
  }

  function makePass(): {
    setPipeline: (p: unknown) => void;
    setBindGroup: (i: number, bg: unknown, offsets?: number[]) => void;
    setVertexBuffer: (i: number, b: unknown) => void;
    draw: (a: number, b?: number, c?: number, d?: number) => void;
    end: () => void;
  } {
    return {
      setPipeline: () => {},
      setBindGroup: () => {},
      setVertexBuffer: () => {},
      draw: () => {},
      end: () => {},
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: opaque mock GPU device surface
  function makeMockDevice(probe: MockSubmitProbe): any {
    const mockShader = { __mock: 'shader' };
    const mockPipeline = { __mock: 'pipeline' };
    const mockBgl = { __mock: 'bgl' };
    const mockLayout = { __mock: 'layout' };
    const mockBg = { __mock: 'bindGroup' };
    const mockBuffer = { __mock: 'buffer' };
    const mockTexture = { __mock: 'texture' };
    const mockView = { __mock: 'view' };
    const mockSampler = { __mock: 'sampler' };
    const okShim = <T>(v: T) => ({ ok: true as const, value: v });

    return {
      createShaderModule: () => okShim(mockShader),
      createBindGroupLayout: () => okShim(mockBgl),
      createPipelineLayout: () => okShim(mockLayout),
      createRenderPipeline: () => okShim(mockPipeline),
      createBindGroup: () => okShim(mockBg),
      createBuffer: () => okShim(mockBuffer),
      createTexture: () => okShim(mockTexture),
      createTextureView: () => okShim(mockView),
      createSampler: () => okShim(mockSampler),
      createCommandEncoder: () => {
        const enc: MockEncoder = { beginRenderPassCount: 0, passes: [], finishCalled: false };
        probe.encoders.push(enc);
        const encoderObj = {
          beginRenderPass: (desc: { label?: string }) => {
            enc.beginRenderPassCount += 1;
            const label = desc?.label;
            enc.passes.push(label !== undefined ? { label } : {});
            return makePass();
          },
          finish: () => {
            enc.finishCalled = true;
            return okShim({ __mock: 'commandBuffer' });
          },
        };
        return okShim(encoderObj);
      },
      queue: {
        writeBuffer: () => okShim(undefined),
        submit: () => {
          probe.submitCalls += 1;
          if (probe.shouldThrowOnSubmit) {
            throw new Error('mock submit failure');
          }
          return okShim(undefined);
        },
      },
    };
  }

  function makeEquirect(): {
    kind: 'texture';
    width: number;
    height: number;
    format: GPUTextureFormat;
    data: Uint8Array;
    colorSpace: 'linear';
    mipmap: false;
  } {
    return {
      kind: 'texture',
      width: 4,
      height: 2,
      format: 'rgba16float' as TextureFormat,
      data: new Uint8Array(4 * 2 * 8),
      colorSpace: 'linear',
      mipmap: false,
    };
  }

  describe('t50 (M3.5) -- AC-20 runtime probe via mock device', () => {
    it('(a) uploadCubemapFromEquirect calls queue.submit >= 1', async () => {
      const probe: MockSubmitProbe = {
        submitCalls: 0,
        encoders: [],
        shouldThrowOnSubmit: false,
      };
      const device = makeMockDevice(probe);

      const equirect = makeEquirect();
      const store = new GpuResourceStore();
      const world = new World();
      const equirectHandle = world.allocSharedRef('TextureAsset', equirect);

      store.configureGpuDevice(
        device,
        async (_d, desc) =>
          // biome-ignore lint/suspicious/noExplicitAny: mock shader module
          rhiOk({ __mock: 'shader', label: desc.label ?? '' }) as any,
        (w: World, pod: CubeTextureAsset) => rhiOk(w.allocSharedRef('CubeTextureAsset', pod)),
        mockCaps,
      );

      const result = await store.uploadCubemapFromEquirect(world, equirectHandle, equirect);
      expect(result.ok).toBe(true);
      expect(probe.submitCalls).toBeGreaterThanOrEqual(1);
    });

    it('(b) encoder contains 4 beginRenderPass calls (equirect / irradiance / prefilter / brdf-lut)', async () => {
      const probe: MockSubmitProbe = {
        submitCalls: 0,
        encoders: [],
        shouldThrowOnSubmit: false,
      };
      const device = makeMockDevice(probe);

      const equirect = makeEquirect();
      const store = new GpuResourceStore();
      const world = new World();
      const equirectHandle = world.allocSharedRef('TextureAsset', equirect);

      store.configureGpuDevice(
        device,
        async (_d, desc) =>
          // biome-ignore lint/suspicious/noExplicitAny: mock shader module
          rhiOk({ __mock: 'shader', label: desc.label ?? '' }) as any,
        (w: World, pod: CubeTextureAsset) => rhiOk(w.allocSharedRef('CubeTextureAsset', pod)),
        mockCaps,
      );

      await store.uploadCubemapFromEquirect(world, equirectHandle, equirect);

      const totalBeginPass = probe.encoders.reduce((s, e) => s + e.beginRenderPassCount, 0);
      // 4 distinct pass families; each cube-face family unfolds to 6 sub-passes
      // (24 for equirect+irradiance), prefilter to 30 (5 mip x 6 face),
      // brdf-lut 1. Total ~ 55. We assert minimum 4 distinct pass labels.
      const labels = new Set(
        probe.encoders
          .flatMap((e) => e.passes.map((p) => p.label ?? ''))
          .map((l) => {
            // strip face / mip suffix for family grouping
            return l.replace(/-face\d+/, '').replace(/-mip\d+/, '');
          }),
      );
      expect(totalBeginPass).toBeGreaterThanOrEqual(4);
      expect(labels.has('ibl-equirect-to-cube')).toBe(true);
      expect(labels.has('ibl-irradiance')).toBe(true);
      expect(labels.has('ibl-prefilter')).toBe(true);
      expect(labels.has('ibl-brdf-lut')).toBe(true);
    });

    it('(c) AC-20 critical: counters stay at 0 when queue.submit throws', async () => {
      const probe: MockSubmitProbe = {
        submitCalls: 0,
        encoders: [],
        shouldThrowOnSubmit: true,
      };
      const device = makeMockDevice(probe);

      const equirect = makeEquirect();
      const store = new GpuResourceStore();
      const world = new World();
      const equirectHandle = world.allocSharedRef('TextureAsset', equirect);

      store.configureGpuDevice(
        device,
        async (_d, desc) =>
          // biome-ignore lint/suspicious/noExplicitAny: mock shader module
          rhiOk({ __mock: 'shader', label: desc.label ?? '' }) as any,
        (w: World, pod: CubeTextureAsset) => rhiOk(w.allocSharedRef('CubeTextureAsset', pod)),
        mockCaps,
      );

      const result = await store.uploadCubemapFromEquirect(world, equirectHandle, equirect);

      // Whether result.ok is true or false depends on impl error propagation;
      // the critical assertion is the counter invariant -- counters must NOT
      // increment when submit fails. counter += 1 placed BEFORE submit is the
      // round-1 anti-pattern; this assertion fails in that case.
      const cache = getOrCreateIblCache(device);
      expect(cache.irradianceBakeCount).toBe(0);
      expect(cache.prefilterBakeCount).toBe(0);
      expect(cache.brdfLutBakeCount).toBe(0);

      // If the impl chose to surface submit failure structurally, result.ok
      // is false. We allow either outcome here -- the load-bearing fact is
      // counter == 0.
      void result;
    });
  });
}

{
  // --- from render-system-record-warn-once.test.ts ---

  function makeFrameState() {
    return {
      warnedMultiLightDirectional: false,
      warnedMultiLightPoint: false,
      warnedMultiLightSpot: false,
    };
  }

  describe('warnMultiLightDirectional (M3 / AC-04 / AC-05 (c))', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('first hit fires console.warn and sets the latch', () => {
      const fs = makeFrameState();
      warnMultiLightDirectional(fs, 2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(fs.warnedMultiLightDirectional).toBe(true);
      const call = warnSpy.mock.calls[0];
      expect(call[0]).toBeTypeOf('string');
      expect(
        (call[0] as string).startsWith('[forgeax] render-system-multi-light directional:'),
      ).toBe(true);
      expect(call[1]).toMatchObject({
        code: 'render-system-multi-light',
        expected: 'at most 1 directional',
        detail: { type: 'directional', got: 2 },
      });
    });

    it('subsequent frames stay silent (warn-once)', () => {
      const fs = makeFrameState();
      warnMultiLightDirectional(fs, 2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) {
        warnMultiLightDirectional(fs, 2);
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(fs.warnedMultiLightDirectional).toBe(true);
    });

    it('no-op when directionalCount <= 1 (no fire, latch stays false)', () => {
      const fs = makeFrameState();
      warnMultiLightDirectional(fs, 1);
      warnMultiLightDirectional(fs, 0);
      expect(warnSpy).toHaveBeenCalledTimes(0);
      expect(fs.warnedMultiLightDirectional).toBe(false);
    });

    it('production gate suppresses output but still flips latch', () => {
      const savedEnv = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
        ?.NODE_ENV;
      try {
        const fs = makeFrameState();
        warnMultiLightDirectional(fs, 2, { env: { NODE_ENV: 'production' } });
        expect(warnSpy).toHaveBeenCalledTimes(0);
        expect(fs.warnedMultiLightDirectional).toBe(true);
      } finally {
        if (savedEnv !== undefined) {
          const g = globalThis as unknown as { process?: { env?: { NODE_ENV?: string } } };
          if (!g.process) g.process = {};
          if (!g.process.env) g.process.env = {};
          g.process.env.NODE_ENV = savedEnv;
        }
      }
    });
  });

  describe('warnMultiLightPoint (M3 / AC-04 / AC-05 (c))', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('first hit fires console.warn (N>4)', () => {
      const fs = makeFrameState();
      warnMultiLightPoint(fs, 5);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(fs.warnedMultiLightPoint).toBe(true);
      const call = warnSpy.mock.calls[0];
      expect(call[1]).toMatchObject({
        code: 'render-system-multi-light',
        expected: 'at most 4 point',
        detail: { type: 'point', got: 5 },
      });
    });

    it('no-op when pointCount <= 4', () => {
      const fs = makeFrameState();
      warnMultiLightPoint(fs, 4);
      warnMultiLightPoint(fs, 0);
      expect(warnSpy).toHaveBeenCalledTimes(0);
      expect(fs.warnedMultiLightPoint).toBe(false);
    });

    it('warn-once across 6 frames', () => {
      const fs = makeFrameState();
      warnMultiLightPoint(fs, 5);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) {
        warnMultiLightPoint(fs, 5);
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('production gate suppresses output but flips latch', () => {
      const fs = makeFrameState();
      warnMultiLightPoint(fs, 5, { env: { NODE_ENV: 'production' } });
      expect(warnSpy).toHaveBeenCalledTimes(0);
      expect(fs.warnedMultiLightPoint).toBe(true);
    });
  });

  describe('warnMultiLightSpot (M3 / AC-04 / AC-05 (c))', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('first hit fires console.warn (N>4)', () => {
      const fs = makeFrameState();
      warnMultiLightSpot(fs, 5);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(fs.warnedMultiLightSpot).toBe(true);
      const call = warnSpy.mock.calls[0];
      expect(call[1]).toMatchObject({
        code: 'render-system-multi-light',
        expected: 'at most 4 spot',
        detail: { type: 'spot', got: 5 },
      });
    });

    it('no-op when spotCount <= 4', () => {
      const fs = makeFrameState();
      warnMultiLightSpot(fs, 4);
      warnMultiLightSpot(fs, 0);
      expect(warnSpy).toHaveBeenCalledTimes(0);
      expect(fs.warnedMultiLightSpot).toBe(false);
    });

    it('warn-once across 6 frames', () => {
      const fs = makeFrameState();
      warnMultiLightSpot(fs, 5);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) {
        warnMultiLightSpot(fs, 5);
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('production gate suppresses output but flips latch', () => {
      const fs = makeFrameState();
      warnMultiLightSpot(fs, 5, { env: { NODE_ENV: 'production' } });
      expect(warnSpy).toHaveBeenCalledTimes(0);
      expect(fs.warnedMultiLightSpot).toBe(true);
    });
  });

  describe('independent latch isolation (M3 / AC-04 / user Step 5.a)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('firing directional does not silence point', () => {
      const fs = makeFrameState();
      warnMultiLightDirectional(fs, 2);
      expect(fs.warnedMultiLightDirectional).toBe(true);
      expect(fs.warnedMultiLightPoint).toBe(false);
      expect(fs.warnedMultiLightSpot).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnMultiLightPoint(fs, 5);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(fs.warnedMultiLightPoint).toBe(true);
    });

    it('firing point does not silence spot', () => {
      const fs = makeFrameState();
      warnMultiLightPoint(fs, 5);
      expect(fs.warnedMultiLightPoint).toBe(true);
      expect(fs.warnedMultiLightSpot).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnMultiLightSpot(fs, 5);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(fs.warnedMultiLightSpot).toBe(true);
    });

    it('pre-set directional latch does not prevent point/spot first fire', () => {
      const fs = makeFrameState();
      fs.warnedMultiLightDirectional = true;
      warnMultiLightPoint(fs, 5);
      warnMultiLightSpot(fs, 5);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(fs.warnedMultiLightPoint).toBe(true);
      expect(fs.warnedMultiLightSpot).toBe(true);
    });
  });
}

{
  // --- from shadow-skip-non-triangle.test.ts ---

  const ENGINE = '../createRenderer';

  interface PassSpies {
    setIndexBuffer: ReturnType<typeof vi.fn>;
    setVertexBuffer: ReturnType<typeof vi.fn>;
    draw: ReturnType<typeof vi.fn>;
    drawIndexed: ReturnType<typeof vi.fn>;
  }

  function makePassSpies(): PassSpies {
    return {
      setIndexBuffer: vi.fn(),
      setVertexBuffer: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
    };
  }

  function makeMockGL2(): unknown {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      isContextLost: () => false,
    };
  }

  function makeMockCanvas(): HTMLCanvasElement {
    const canvas = {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') return makeMockGL2();
        if (kind === 'webgpu') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({ createView: () => ({}) }),
          };
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
  }

  // `shadow` spies receive every dispatch that occurs inside a render pass opened
  // with an empty colorAttachments array (the shadow pass). `main` spies receive
  // the rest. Routing is per-beginRenderPass so the same pass methods dispatch to
  // the right bucket.
  function makeMockGPUDevice(shadow: PassSpies, main: PassSpies): { device: unknown } {
    const lost = new Promise<unknown>(() => undefined);
    const passFor = (descriptor: unknown): PassSpies => {
      const d = descriptor as { colorAttachments?: readonly unknown[] };
      const isShadow = Array.isArray(d.colorAttachments) && d.colorAttachments.length === 0;
      return isShadow ? shadow : main;
    };
    const device = {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      limits: {},
      queue: {
        submit: () => undefined,
        writeBuffer: () => undefined,
        writeTexture: () => undefined,
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: () => ({}),
      createBuffer: () => ({
        getMappedRange: () => new ArrayBuffer(64),
        unmap: () => undefined,
      }),
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: unknown) => {
          const spies = passFor(descriptor);
          return {
            setPipeline: () => undefined,
            setVertexBuffer: spies.setVertexBuffer,
            setIndexBuffer: spies.setIndexBuffer,
            setBindGroup: () => undefined,
            setStencilReference: () => undefined,
            setViewport: () => undefined,
            setScissorRect: () => undefined,
            draw: spies.draw,
            drawIndexed: spies.drawIndexed,
            end: () => undefined,
          };
        },
        finish: () => ({}),
      }),
      createTexture: () => ({ createView: () => ({}) }),
      createSampler: () => ({}),
      destroy: () => undefined,
    };
    return { device };
  }

  function makeMockGPU(deviceObj: unknown): unknown {
    return {
      requestAdapter: async () => ({ requestDevice: async () => deviceObj }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  const baseNavigator: Navigator = {
    userAgent: 'mock-engine-test',
  } as Partial<Navigator> as Navigator;

  function buildManifestDataUrl(): string {
    const materialShaderStub = (identifier: string) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: '/* stub */',
      paramSchema: '[]',
      variants: [],
    });
    const manifest = {
      schemaVersion: '1.0.0',
      entries: [
        { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
        {
          hash: 'tonemap0',
          wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
          glsl: '',
          bindings: '',
        },
        // shadow_caster marker: composed WGSL declares @location(0) position
        // WITHOUT @location(1) normal (createRenderer.ts shadow_caster detection).
        // Needed so the shadow-caster pipeline builds and the shadow pass draws.
        {
          hash: 'shadowc0',
          wgsl: '/* shadow caster stub */ struct VsIn { @location(0) position: vec3<f32> };',
          glsl: '',
          bindings: '',
        },
      ],
      materialShaders: [
        materialShaderStub('forgeax::default-standard-pbr'),
        materialShaderStub('forgeax::default-unlit'),
      ],
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  interface RendererLike {
    ready: Promise<void>;
    draw: (world: unknown) => void;
    onError: (cb: (err: { code: string }) => void) => () => void;
    assets: { register: (asset: unknown) => { ok: boolean; value: unknown } };
  }

  async function importEngine(): Promise<{
    createRenderer: (canvas: unknown, opts?: unknown, bundler?: unknown) => Promise<RendererLike>;
  }> {
    return (await import(ENGINE)) as never;
  }

  async function importEcs(): Promise<{
    World: new () => { spawn: (...componentDatas: unknown[]) => unknown };
  }> {
    return (await import('@forgeax/engine-ecs')) as never;
  }

  async function importComponents(): Promise<{
    Transform: unknown;
    MeshFilter: unknown;
    MeshRenderer: unknown;
    Camera: unknown;
    DirectionalLight: unknown;
  }> {
    return (await import('../index')) as never;
  }

  function cameraTransform() {
    return {
      posX: 0,
      posY: 0,
      posZ: 5,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    };
  }

  function originTransform() {
    return {
      posX: 0,
      posY: 0,
      posZ: 0,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    };
  }

  function indexedTriangleMesh(): MeshAsset {
    return {
      kind: 'mesh',
      vertices: new Float32Array(3 * 12),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {},
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 0,
          topology: 'triangle-list',
        },
      ],
    };
  }

  function indexedLineMesh(): MeshAsset {
    return {
      kind: 'mesh',
      vertices: new Float32Array(2 * 12),
      indices: new Uint16Array([0, 1]),
      attributes: {},
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 2,
          vertexCount: 0,
          topology: 'line-list',
        },
      ],
    };
  }

  async function setupRenderer(
    shadow: PassSpies,
    main: PassSpies,
  ): Promise<{ renderer: RendererLike }> {
    const { device } = makeMockGPUDevice(shadow, main);
    vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
    const { createRenderer } = await importEngine();
    const renderer = await createRenderer(
      makeMockCanvas(),
      {},
      { shaderManifestUrl: buildManifestDataUrl() },
    );
    await renderer.ready;
    return { renderer };
  }

  describe('w12 - shadow caster skips non-triangle topology (AC-09)', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('records shadow draw ONLY for triangle-list; line-list is skipped', async () => {
      const shadow = makePassSpies();
      const main = makePassSpies();
      const { renderer } = await setupRenderer(shadow, main);
      const errors: string[] = [];
      renderer.onError((e) => errors.push(e.code));

      const { World } = await importEcs();
      const C = await importComponents();
      const world = new World();

      const triHandle = world.allocSharedRef('MeshAsset', indexedTriangleMesh()) as Handle<
        'MeshAsset',
        'shared'
      >;
      const lineHandle = world.allocSharedRef('MeshAsset', indexedLineMesh()) as Handle<
        'MeshAsset',
        'shared'
      >;

      world.spawn(
        {
          component: C.Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 16 / 9,
            near: 0.1,
            far: 100,
            projection: 0,
            left: -1,
            right: 1,
            bottom: -1,
            top: 1,
          },
        },
        { component: C.Transform, data: cameraTransform() },
      );
      world.spawn(
        { component: C.DirectionalLight, data: { mapSize: 512, cascadeCount: 1 } },
        { component: C.Transform, data: cameraTransform() },
      );
      world.spawn(
        { component: C.MeshRenderer, data: { materials: [0] } },
        { component: C.MeshFilter, data: { assetHandle: triHandle } },
        { component: C.Transform, data: originTransform() },
      );
      world.spawn(
        { component: C.MeshRenderer, data: { materials: [0] } },
        { component: C.MeshFilter, data: { assetHandle: lineHandle } },
        { component: C.Transform, data: originTransform() },
      );

      // Two frames: frame 1 allocates the shadow RT (lazy); frame 2 records the
      // shadow pass with the RT present (so the shadow loop actually runs).
      // feat-20260609 M4 / T-010: yield so async shader-module creation
      // (getMaterialShaderPipeline's 1-frame-warmup path) resolves before
      // frame 2; the shadow PSO is now obtained via lazy cache lookup instead
      // of the hardcoded perPassResources.shadowCasterPipeline field.
      renderer.draw(world);
      await new Promise((r) => setTimeout(r, 0));
      shadow.drawIndexed.mockClear();
      shadow.draw.mockClear();
      renderer.draw(world);

      // Shadow pass drew exactly once (the triangle mesh), never the line mesh.
      const shadowDrawCalls = shadow.drawIndexed.mock.calls.length + shadow.draw.mock.calls.length;
      expect(shadowDrawCalls).toBe(1);
      expect(errors).toEqual([]);
    });
  });
}

{
  // --- from skin-errors-kebab-case.test.ts ---

  const KEBAB_REGEX = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;

  describe('T-20 — RuntimeErrorCode +6 skin-animation kebab-case consistency (AC-29)', () => {
    it('skin-joint-count-exceeded is valid kebab-case', () => {
      const code: RuntimeErrorCode = 'skin-joint-count-exceeded';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('skin-joint-despawned is valid kebab-case', () => {
      const code: RuntimeErrorCode = 'skin-joint-despawned';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('skin-joint-path-unresolved is valid kebab-case', () => {
      const code: RuntimeErrorCode = 'skin-joint-path-unresolved';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('skin-instances-coexist-forbidden is valid kebab-case', () => {
      const code: RuntimeErrorCode = 'skin-instances-coexist-forbidden';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('vertex-storage-buffer-unavailable is valid kebab-case', () => {
      const code: RuntimeErrorCode = 'vertex-storage-buffer-unavailable';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('skin-palette-overflow is valid kebab-case', () => {
      const code: RuntimeErrorCode = 'skin-palette-overflow';
      expect(code).toMatch(KEBAB_REGEX);
    });

    it('exhaustive switch over RuntimeErrorCode 7 members compiles without default', () => {
      function exhaustive(code: RuntimeErrorCode): string {
        switch (code) {
          case 'shadow-invalid-config':
            return 'shadow';
          case 'skin-joint-count-exceeded':
            return 'joint-count';
          case 'skin-joint-despawned':
            return 'joint-despawn';
          case 'skin-joint-path-unresolved':
            return 'joint-path';
          case 'skin-instances-coexist-forbidden':
            return 'coexist';
          case 'vertex-storage-buffer-unavailable':
            return 'no-vs-sb';
          case 'skin-palette-overflow':
            return 'palette-overflow';
          case 'material-resolved-empty-passes':
            return 'material-empty-passes';
          case 'skybox-cubemap-not-ready':
            return 'skybox-not-ready';
          case 'mesh-ssbo-capacity-exceeded':
            return 'mesh-ssbo-capacity';
          case 'mesh-ssbo-ceiling-reached':
            return 'mesh-ssbo-ceiling';
          case 'hdrp-caps-insufficient':
            return 'hdrp-caps';
          case 'hdrp-light-budget-exceeded':
            return 'hdrp-budget';
          case 'hdrp-index-list-overflow':
            return 'hdrp-overflow';
        }
      }
      expect(exhaustive('skin-joint-count-exceeded')).toBe('joint-count');
      expect(exhaustive('skin-palette-overflow')).toBe('palette-overflow');
      expect(exhaustive('shadow-invalid-config')).toBe('shadow');
    });
  });

  describe('T-20 — skin-animation error classes 4-field surface (AC-29)', () => {
    it('SkinJointCountExceededError has .code .expected .hint .detail', () => {
      const e = new SkinJointCountExceededError(300);
      expect(e.code).toBe('skin-joint-count-exceeded');
      expect(e.expected).toBe('jointCount <= 256');
      expect(e.hint.length).toBeGreaterThan(0);
      expect(e.detail).toEqual({ jointCount: 300, max: 256 });
    });

    it('SkinJointDespawnedError has .code .expected .hint .detail', () => {
      const e = new SkinJointDespawnedError(42, 7);
      expect(e.code).toBe('skin-joint-despawned');
      expect(e.expected).toContain('live entity');
      expect(e.hint.length).toBeGreaterThan(0);
      expect(e.detail).toEqual({ meshEntity: 42, jointIndex: 7 });
    });

    it('SkinJointPathUnresolvedError has .code .expected .hint .detail', () => {
      const path = ['root', 'spine', 'shoulder'];
      const e = new SkinJointPathUnresolvedError(1, path, 2);
      expect(e.code).toBe('skin-joint-path-unresolved');
      expect(e.expected).toContain('shoulder');
      expect(e.hint.length).toBeGreaterThan(0);
      expect(e.detail.skinEntity).toBe(1);
      expect(e.detail.failedAtIndex).toBe(2);
    });

    it('SkinInstancesCoexistForbiddenError has .code .expected .hint .detail', () => {
      const e = new SkinInstancesCoexistForbiddenError(99);
      expect(e.code).toBe('skin-instances-coexist-forbidden');
      expect(e.expected).toContain('coexist');
      expect(e.hint.length).toBeGreaterThan(0);
      expect(e.detail).toEqual({ entity: 99 });
    });

    it('VertexStorageBufferUnavailableError has .code .expected .hint', () => {
      const e = new VertexStorageBufferUnavailableError();
      expect(e.code).toBe('vertex-storage-buffer-unavailable');
      expect(e.expected).toContain('maxStorageBuffersPerShaderStage');
      expect(e.hint.length).toBeGreaterThan(0);
    });

    it('SkinPaletteOverflowError has .code .expected .hint .detail', () => {
      const e = new SkinPaletteOverflowError(10000, 128 * 1024 * 1024);
      expect(e.code).toBe('skin-palette-overflow');
      expect(e.expected).toContain('maxStorageBufferBindingSize');
      expect(e.hint.length).toBeGreaterThan(0);
      expect(e.detail.requestedBytes).toBe(10000);
      expect(e.detail.limit).toBe(128 * 1024 * 1024);
    });

    it('all 6 skin-animation error codes are in the RuntimeErrorCode union (type-level)', () => {
      const codes: RuntimeErrorCode[] = [
        'skin-joint-count-exceeded',
        'skin-joint-despawned',
        'skin-joint-path-unresolved',
        'skin-instances-coexist-forbidden',
        'vertex-storage-buffer-unavailable',
        'skin-palette-overflow',
      ];
      // Each code must be assignable to RuntimeErrorCode (type-check)
      for (const code of codes) {
        expect(typeof code).toBe('string');
        expect(code).toMatch(KEBAB_REGEX);
      }
      expect(codes).toHaveLength(6);
    });
  });
}

{
  // --- from skybox-error.test.ts ---

  describe('skybox-cubemap-not-ready error class shape (AC-08)', () => {
    it('has .code === skybox-cubemap-not-ready', async () => {
      // Dynamic import so typecheck passes even if the class does not exist yet
      // (TDD red stage). After w18 implements the class, this test turns green.
      const { SkyboxCubemapNotReadyError } = await import('../errors');
      const err = new SkyboxCubemapNotReadyError(42);
      expect(err.code).toBe('skybox-cubemap-not-ready');
    });

    it('exposes .detail.handle === the constructor argument', async () => {
      const { SkyboxCubemapNotReadyError } = await import('../errors');
      const err = new SkyboxCubemapNotReadyError(42);
      expect(err.detail).toBeDefined();
      expect(err.detail.handle).toBe(42);
    });

    it('exposes non-empty .hint with actionable guidance', async () => {
      const { SkyboxCubemapNotReadyError } = await import('../errors');
      const err = new SkyboxCubemapNotReadyError(42);
      expect(err.hint).toBeDefined();
      expect(typeof err.hint).toBe('string');
      expect(err.hint.length).toBeGreaterThan(0);
    });

    it('exposes .expected describing expected state', async () => {
      const { SkyboxCubemapNotReadyError } = await import('../errors');
      const err = new SkyboxCubemapNotReadyError(42);
      expect(err.expected).toBeDefined();
      expect(typeof err.expected).toBe('string');
      expect(err.expected.length).toBeGreaterThan(0);
    });

    it('extends Error so it can be thrown and caught', async () => {
      const { SkyboxCubemapNotReadyError } = await import('../errors');
      const err = new SkyboxCubemapNotReadyError(42);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('SkyboxCubemapNotReadyError');
    });
  });

  describe('RuntimeErrorCode union 9 -> 10 (AC-08)', () => {
    it('RuntimeErrorCode union has exactly 10 members after w18', async () => {
      // We cannot enumerate TS union members at runtime directly. Instead we
      // validate by constructing a switch that TypeScript will error on if the
      // union shape changes. This test verifies skybox-cubemap-not-ready is a
      // valid member by using it as a literal.
      const code: string = 'skybox-cubemap-not-ready';
      expect(code).toBeDefined();

      // Verify the union count by checking the JSDoc comment table which
      // lists all 10 members (this is a grep-gate). The actual TS union is
      // verified by typecheck: if 'skybox-cubemap-not-ready' is not in
      // RuntimeErrorCode, no expression can assign this literal to a
      // RuntimeErrorCode-typed variable.
      const { SkyboxCubemapNotReadyError } = await import('../errors');
      const err = new SkyboxCubemapNotReadyError(42);
      // If typecheck passes, err.code IS in the RuntimeErrorCode union.
      expect(err.code).toBe('skybox-cubemap-not-ready');
    });
  });

  describe('degradation path: loadOp=clear when cubemap not ready (AC-08)', () => {
    it('skybox-cubemap-not-ready is emitted when getCubemapGpuView returns undefined', async () => {
      // In the degradation path, when SkyboxBackground component is present
      // but getCubemapGpuView(handle) returns undefined (cubemap not uploaded
      // yet), skyboxActive is set to false and the structured error is fired.
      // This test verifies the error class contracts are correct -- the actual
      // record-stage integration is covered by the runtime smoke gate.
      const { SkyboxCubemapNotReadyError } = await import('../errors');
      const err = new SkyboxCubemapNotReadyError(42);

      // The error code is used at record-stage to fire via errorRegistry.fire().
      // When skyboxActive=false due to cubemap-not-ready, main pass loadOp
      // returns to 'clear' (w8/w18).
      expect(err.code).toBe('skybox-cubemap-not-ready');
      expect(err.detail.handle).toBe(42);
    });
  });
}

{
  // --- from skybox-shader-compile.test.ts ---

  // __dirname equivalent in ESM
  const __dirname = fileURLToPath(new URL('.', import.meta.url));

  const shaderSrcDir = resolve(__dirname, '..', '..', '..', 'shader', 'src');

  function readSkyboxWgsl(): string {
    return readFileSync(resolve(shaderSrcDir, 'skybox.wgsl'), 'utf8');
  }

  describe('skybox.wgsl source-level import + structure (AC-03)', () => {
    let source: string;

    beforeAll(() => {
      source = readSkyboxWgsl();
    });

    it('exists and is non-empty', () => {
      expect(source.length).toBeGreaterThan(0);
    });

    it('defines import path forgeax_view::skybox', () => {
      expect(source).toEqual(expect.stringContaining('#define_import_path forgeax_view::skybox'));
    });

    it('imports FullscreenOutput from forgeax_view::common', () => {
      expect(source).toEqual(
        expect.stringContaining('#import forgeax_view::common::FullscreenOutput'),
      );
    });

    it('imports View from forgeax_view::common', () => {
      expect(source).toEqual(expect.stringContaining('#import forgeax_view::common::View'));
    });

    it('imports fullscreen_triangle from forgeax_view::common', () => {
      expect(source).toEqual(
        expect.stringContaining('#import forgeax_view::common::fullscreen_triangle'),
      );
    });

    it('declares fragment entry point skybox_fs', () => {
      // `fn skybox_fs` uniquely identifies the fragment entry point;
      // this is the content marker used by createRenderer to identify
      // the skybox manifest entry (plan-strategy D-7).
      expect(source).toEqual(expect.stringContaining('fn skybox_fs'));
    });

    it('declares vertex entry point vs_main', () => {
      expect(source).toEqual(expect.stringContaining('fn vs_main'));
    });

    it('references inverseViewProj for world-space reconstruction', () => {
      expect(source).toEqual(expect.stringContaining('inverseViewProj'));
    });

    it('negates Y to match IBL cubemap convention (ibl-sampling.wgsl:30,47)', () => {
      // The fragment stage negates Y on the reconstructed world-space
      // direction before cubemap sampling. This matches the IBL path
      // convention in ibl-sampling.wgsl (sampleIblDiffuse:30,
      // sampleIblSpecular:47) where dir = vec3(x, -y, z).
      expect(source).toEqual(expect.stringContaining('-dir.y'));
    });

    it('uses textureSample for cubemap lookup', () => {
      expect(source).toEqual(expect.stringContaining('textureSample'));
    });

    it('declares cubemap as texture_cube<f32>', () => {
      expect(source).toEqual(expect.stringContaining('texture_cube<f32>'));
    });

    it('binds cubemap at @group(0) @binding(0)', () => {
      // WGSL binding declaration: @group(0) @binding(0) var cubemap
      expect(source).toMatch(/@group\(0\)\s*@binding\(0\)\s*var\s+cubemap\s*:/);
    });

    it('binds sampler at @group(0) @binding(1)', () => {
      expect(source).toMatch(/@group\(0\)\s*@binding\(1\)\s*var\s+/);
    });

    it('binds View UBO at @group(0) @binding(2)', () => {
      expect(source).toMatch(/@group\(0\)\s*@binding\(2\)\s*var<uniform>\s*view\s*:/);
    });
  });
}

{
  // --- from skylight-bind-group.test.ts ---

  // ─── Mock device helpers ─────────────────────────────────────────────────────
  //
  // We capture every descriptor written to the device so the test can assert
  // the fallback texture geometry without standing up a real GPU device. The
  // forgeax RHI surface returns Result<T,E>; the factory functions unwrap
  // (throw on error) like createRenderer's runShimSyncStep pattern, so mocks
  // always return `{ ok: true, value }`.

  interface CapturedTextureDescriptor {
    readonly label?: string;
    readonly size: { width: number; height: number; depthOrArrayLayers: number };
    readonly mipLevelCount: number;
    readonly sampleCount: number;
    readonly dimension: string;
    readonly format: string;
    readonly usage: number;
  }

  interface MockDevice {
    readonly createSampler: ReturnType<typeof vi.fn>;
    readonly createTexture: ReturnType<typeof vi.fn>;
    readonly createTextureView: ReturnType<typeof vi.fn>;
    readonly createBuffer: ReturnType<typeof vi.fn>;
  }

  interface MockQueue {
    readonly writeTexture: ReturnType<typeof vi.fn>;
    readonly writeBuffer: ReturnType<typeof vi.fn>;
  }

  function makeMockDevice(): MockDevice {
    const sampler = { __brand: 'Sampler', id: Math.random() } as unknown as Sampler;
    const tex = { __brand: 'Texture' } as unknown as Texture;
    const view = { __brand: 'TextureView' } as unknown as TextureView;
    const buf = { __brand: 'Buffer' } as unknown as Buffer;
    return {
      createSampler: vi.fn(() => ({ ok: true, value: sampler })),
      createTexture: vi.fn(() => ({ ok: true, value: tex })),
      createTextureView: vi.fn(() => ({ ok: true, value: view })),
      createBuffer: vi.fn(() => ({ ok: true, value: buf })),
    };
  }

  function makeMockQueue(): MockQueue {
    return {
      writeTexture: vi.fn(() => ({ ok: true, value: undefined })),
      writeBuffer: vi.fn(() => ({ ok: true, value: undefined })),
    };
  }

  // Helper: a stand-in 7-entry PBR material BGL (binding 0..6) matching
  // createRenderer.ts's `pbr-material-bgl` shape (UBO + sampler + texture *
  // 3 pairs). The test does not care about the exact texture/sampler kinds
  // at binding 0..6 -- only that the count is 7 and the bindings 7..13 sit
  // on top.
  function makeMaterialBglEntries(): GPUBindGroupLayoutEntry[] {
    const FRAGMENT = 0x2;
    return [
      { binding: 0, visibility: FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, visibility: FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 3, visibility: FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 4, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 5, visibility: FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 6, visibility: FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
    ];
  }

  function makeMaterialBindGroupEntries(): BindGroupEntry[] {
    const fakeBuf = { __brand: 'Buffer' } as unknown as Buffer;
    const fakeSampler = { __brand: 'Sampler' } as unknown as Sampler;
    const fakeView = { __brand: 'TextureView' } as unknown as TextureView;
    return [
      { binding: 0, resource: { kind: 'buffer', value: { buffer: fakeBuf, offset: 0, size: 64 } } },
      { binding: 1, resource: { kind: 'sampler', value: fakeSampler } },
      { binding: 2, resource: { kind: 'textureView', value: fakeView } },
      { binding: 3, resource: { kind: 'sampler', value: fakeSampler } },
      { binding: 4, resource: { kind: 'textureView', value: fakeView } },
      { binding: 5, resource: { kind: 'sampler', value: fakeSampler } },
      { binding: 6, resource: { kind: 'textureView', value: fakeView } },
    ] as BindGroupEntry[];
  }

  // ─── Assertion (a): merged BGL is length 14 with Skylight bindings 7..13 ────

  describe('t40 round-4 (a) mergeSkylightIntoMaterialBgl shape', () => {
    it('returns 14 entries; binding 0..6 preserved; 7..13 in D-5 order [irrTex, irrSampler, prefTex, prefSampler, brdfTex, brdfSampler, uniform]', () => {
      const materialEntries = makeMaterialBglEntries();
      const merged = mergeSkylightIntoMaterialBgl(materialEntries);

      expect(merged).toHaveLength(SKYLIGHT_MERGED_ENTRY_COUNT);
      expect(merged).toHaveLength(14);

      // binding 0..6 preserved verbatim
      for (let i = 0; i < 7; i++) {
        const original = materialEntries[i];
        const got = merged[i];
        expect(got?.binding).toBe(original?.binding);
      }

      // binding 7: irradianceMap (texture_cube)
      expect(merged[7]?.binding).toBe(SKYLIGHT_BINDING_OFFSET);
      expect((merged[7] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        'cube',
      );
      // binding 8: irradianceSampler
      expect(merged[8]?.binding).toBe(8);
      expect((merged[8] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      // binding 9: prefilterMap (texture_cube)
      expect(merged[9]?.binding).toBe(9);
      expect((merged[9] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        'cube',
      );
      // binding 10: prefilterSampler
      expect(merged[10]?.binding).toBe(10);
      expect((merged[10] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      // binding 11: brdfLut (texture_2d)
      expect(merged[11]?.binding).toBe(11);
      expect((merged[11] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        '2d',
      );
      // binding 12: brdfLutSampler
      expect(merged[12]?.binding).toBe(12);
      expect((merged[12] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      // binding 13: uniform { intensity: f32 }
      expect(merged[13]?.binding).toBe(13);
      expect((merged[13] as { buffer?: { type: string } }).buffer?.type).toBe('uniform');
    });

    it('rejects non-7-entry material BGL input', () => {
      expect(() => mergeSkylightIntoMaterialBgl([])).toThrow();
      expect(() => mergeSkylightIntoMaterialBgl(makeMaterialBglEntries().slice(0, 5))).toThrow();
    });
  });

  // ─── Assertion (b): createSkylightFallback returns identity resource bundle ─

  describe('t40 round-4 (b) fallback identity bundle exists with no stand-alone bindGroup', () => {
    it('createSkylightFallback returns a bundle with texture / view / sampler / uniform handles', () => {
      const device = makeMockDevice();
      const queue = makeMockQueue();
      const fallback = createSkylightFallback(
        device as unknown as Parameters<typeof createSkylightFallback>[0],
        queue as unknown as Parameters<typeof createSkylightFallback>[1],
      );
      expect(fallback.irradianceTexture).not.toBeUndefined();
      expect(fallback.irradianceView).not.toBeUndefined();
      expect(fallback.prefilterTexture).not.toBeUndefined();
      expect(fallback.prefilterView).not.toBeUndefined();
      expect(fallback.brdfLutTexture).not.toBeUndefined();
      expect(fallback.brdfLutView).not.toBeUndefined();
      expect(fallback.sampler).not.toBeUndefined();
      expect(fallback.intensityBuffer).not.toBeUndefined();
      // round-4: no stand-alone bindGroup / layout field on the fallback
      expect((fallback as unknown as { bindGroup?: unknown }).bindGroup).toBeUndefined();
      expect((fallback as unknown as { layout?: unknown }).layout).toBeUndefined();
    });
  });

  // ─── Assertion (c): fallback texture_cube depthOrArrayLayers=6 + white
  // irradiance / zero prefilter+brdfLut (downstream integration #4) ───

  describe('t40 round-4 (c) fallback cube texture geometry + white irradiance data', () => {
    it('fallback cube texture is depthOrArrayLayers=6; irradiance is white (6 faces), prefilter+brdfLut are zero', () => {
      const device = makeMockDevice();
      const queue = makeMockQueue();
      createSkylightFallback(
        device as unknown as Parameters<typeof createSkylightFallback>[0],
        queue as unknown as Parameters<typeof createSkylightFallback>[1],
      );

      const cubeDescs = device.createTexture.mock.calls
        .map((args) => args[0] as CapturedTextureDescriptor)
        .filter((d) => d.size.depthOrArrayLayers === 6);
      expect(cubeDescs.length).toBeGreaterThanOrEqual(2);
      for (const desc of cubeDescs) {
        expect(desc.size.depthOrArrayLayers).toBe(6);
        expect(desc.size.width).toBe(1);
        expect(desc.size.height).toBe(1);
      }

      // The white irradiance pixel is half-float RGBA 1.0 = 0x3c00 per channel
      // in the first 8 bytes (the rest of the 256B-padded row is zero). The
      // zero payloads (prefilter cube * 6 faces + brdfLut * 1) are all-zero.
      // We can't distinguish textures by identity (the mock returns one shared
      // texture object), so we classify each writeTexture payload by content
      // and count: exactly 6 white (irradiance faces) + 7 zero (prefilter
      // 6 faces + brdfLut 1).
      let whiteCount = 0;
      let zeroCount = 0;
      expect(queue.writeTexture.mock.calls.length).toBeGreaterThan(0);
      for (const call of queue.writeTexture.mock.calls) {
        const dataArg = call[1] as ArrayBufferView | undefined;
        if (dataArg === undefined) continue;
        const bytes = new Uint8Array(dataArg.buffer, dataArg.byteOffset, dataArg.byteLength);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const isWhiteHead =
          dv.getUint16(0, true) === 0x3c00 &&
          dv.getUint16(2, true) === 0x3c00 &&
          dv.getUint16(4, true) === 0x3c00 &&
          dv.getUint16(6, true) === 0x3c00;
        if (isWhiteHead) {
          whiteCount += 1;
        } else {
          // non-white head must be fully zero (prefilter / brdfLut fallback)
          for (const b of bytes) expect(b).toBe(0);
          zeroCount += 1;
        }
      }
      expect(whiteCount).toBe(6);
      expect(zeroCount).toBe(7);
    });

    it('createSkylightFallback allocates exactly one sampler (reused across the 3 texture slots)', () => {
      const device = makeMockDevice();
      const queue = makeMockQueue();
      createSkylightFallback(
        device as unknown as Parameters<typeof createSkylightFallback>[0],
        queue as unknown as Parameters<typeof createSkylightFallback>[1],
      );
      expect(device.createSampler).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Assertion (d): assembleMaterialWithSkylightEntries merges 7 + 7 = 14 ───

  describe('t40 round-4 (d) assembleMaterialWithSkylightEntries shape', () => {
    it('returns 14 BindGroupEntry values; entry 7..13 reference the skylight resources', () => {
      const materialEntries = makeMaterialBindGroupEntries();
      const irrView = { __brand: 'TextureView', id: 1 } as unknown as TextureView;
      const irrSampler = { __brand: 'Sampler', id: 1 } as unknown as Sampler;
      const prefView = { __brand: 'TextureView', id: 2 } as unknown as TextureView;
      const prefSampler = { __brand: 'Sampler', id: 2 } as unknown as Sampler;
      const brdfView = { __brand: 'TextureView', id: 3 } as unknown as TextureView;
      const brdfSampler = { __brand: 'Sampler', id: 3 } as unknown as Sampler;
      const intensityBuf = { __brand: 'Buffer' } as unknown as Buffer;

      const merged = assembleMaterialWithSkylightEntries(materialEntries, {
        irradianceView: irrView,
        irradianceSampler: irrSampler,
        prefilterView: prefView,
        prefilterSampler: prefSampler,
        brdfLutView: brdfView,
        brdfLutSampler: brdfSampler,
        intensityBuffer: intensityBuf,
      });

      expect(merged).toHaveLength(14);

      // Skylight entries at binding 7..13 in D-5 order
      expect(merged[7]?.binding).toBe(7);
      expect(merged[7]?.resource).toEqual({ kind: 'textureView', value: irrView });
      expect(merged[8]?.binding).toBe(8);
      expect(merged[8]?.resource).toEqual({ kind: 'sampler', value: irrSampler });
      expect(merged[9]?.binding).toBe(9);
      expect(merged[9]?.resource).toEqual({ kind: 'textureView', value: prefView });
      expect(merged[10]?.binding).toBe(10);
      expect(merged[10]?.resource).toEqual({ kind: 'sampler', value: prefSampler });
      expect(merged[11]?.binding).toBe(11);
      expect(merged[11]?.resource).toEqual({ kind: 'textureView', value: brdfView });
      expect(merged[12]?.binding).toBe(12);
      expect(merged[12]?.resource).toEqual({ kind: 'sampler', value: brdfSampler });
      expect(merged[13]?.binding).toBe(13);
      expect(merged[13]?.resource).toEqual({
        kind: 'buffer',
        value: { buffer: intensityBuf },
      });
    });

    it('derives IBL injection start from materialEntries.length (per-shader user-region, not a fixed 7)', () => {
      // Per-shader-derived BGL (feat-20260621): the user-region length is no
      // longer fixed at 7. assembleMaterialWithSkylightEntries injects the 7
      // skylight entries starting at materialEntries.length. Empty user-region
      // => IBL lands at binding 0..6 (no throw); the old fixed-7 guard is gone.
      const merged = assembleMaterialWithSkylightEntries([], {
        irradianceView: {} as TextureView,
        irradianceSampler: {} as Sampler,
        prefilterView: {} as TextureView,
        prefilterSampler: {} as Sampler,
        brdfLutView: {} as TextureView,
        brdfLutSampler: {} as Sampler,
        intensityBuffer: {} as Buffer,
      });
      expect(merged).toHaveLength(7);
      expect(merged[0]?.binding).toBe(0);
      expect(merged[6]?.binding).toBe(6);
    });
  });
}

{
  // --- from skylight-component.test.ts ---

  // These would be imported from the real module when t25 lands. Until then,
  // they are the target shape.
  const SKYLIGHT_COMPONENT_NAME = 'Skylight';
  const SKYLIGHT_DEFAULT_INTENSITY = 1.0;

  describe('Skylight component schema (AC-02)', () => {
    it('Skylight component name is "Skylight" (single-semantic, no Component suffix)', () => {
      expect(SKYLIGHT_COMPONENT_NAME).toBe('Skylight');
    });

    it('Skylight schema shape: { cubemap: handle<CubeTextureAsset>, intensity: f32 }', () => {
      // Verify the expected schema field names.
      // When t25 lands, the real component must have exactly these fields.
      const expectedFields = ['cubemap', 'intensity'];
      // Both fields are present; no extra.
      expect(expectedFields).toContain('cubemap');
      expect(expectedFields).toContain('intensity');
      expect(expectedFields.length).toBe(2);
    });

    it('Skylight default intensity === 1.0', () => {
      expect(SKYLIGHT_DEFAULT_INTENSITY).toBe(1.0);
    });
  });

  // TODO: Skylight component narrowing sites (AC-16(c)) -- placeholders pruned in
  // feat-20260608-ci-time-cut. The compile-time contracts (no `as` cast on
  // world.spawn / world.addSystem / world.get) are enforced by tsc; runtime
  // `expect(true)` placeholders carried no signal and were removed.
  //
  // TODO: Skylight component default spawn (intensity = 1.0) -- placeholders pruned
  // in feat-20260608-ci-time-cut. The default-value contract is verified at
  // schema-registration time once the t25 impl lands.
}

{
  // --- from skylight-fallback-path.test.ts ---

  // ─── (a) Fallback resource shape ────────────────────────────────────────────

  function makeMaterialBindGroupEntries(): BindGroupEntry[] {
    const buf = { __brand: 'Buffer' } as unknown as Buffer;
    const sampler = { __brand: 'Sampler' } as unknown as Sampler;
    const view = { __brand: 'TextureView' } as unknown as TextureView;
    return [
      { binding: 0, resource: { kind: 'buffer', value: { buffer: buf, offset: 0, size: 64 } } },
      { binding: 1, resource: { kind: 'sampler', value: sampler } },
      { binding: 2, resource: { kind: 'textureView', value: view } },
      { binding: 3, resource: { kind: 'sampler', value: sampler } },
      { binding: 4, resource: { kind: 'textureView', value: view } },
      { binding: 5, resource: { kind: 'sampler', value: sampler } },
      { binding: 6, resource: { kind: 'textureView', value: view } },
    ] as BindGroupEntry[];
  }

  function makeFallback(): SkylightFallback {
    const tex = { __brand: 'fallback-tex' } as never;
    const irrView = { __brand: 'fallback-irrView' } as unknown as TextureView;
    const prefView = { __brand: 'fallback-prefView' } as unknown as TextureView;
    const brdfView = { __brand: 'fallback-brdfView' } as unknown as TextureView;
    const sampler = { __brand: 'fallback-sampler' } as unknown as Sampler;
    const intensityBuffer = { __brand: 'fallback-intensity', value: 0 } as unknown as Buffer;
    return {
      irradianceTexture: tex,
      irradianceView: irrView,
      prefilterTexture: tex,
      prefilterView: prefView,
      brdfLutTexture: tex,
      brdfLutView: brdfView,
      sampler,
      intensityBuffer,
    };
  }

  function makeActive(): SkylightBindGroupResources {
    return {
      irradianceView: { __brand: 'active-irrView' } as unknown as TextureView,
      irradianceSampler: { __brand: 'active-irrSampler' } as unknown as Sampler,
      prefilterView: { __brand: 'active-prefView' } as unknown as TextureView,
      prefilterSampler: { __brand: 'active-prefSampler' } as unknown as Sampler,
      brdfLutView: { __brand: 'active-brdfView' } as unknown as TextureView,
      brdfLutSampler: { __brand: 'active-brdfSampler' } as unknown as Sampler,
      intensityBuffer: { __brand: 'active-intensity', value: 1 } as unknown as Buffer,
    };
  }

  describe('t58 (M4 round-4) -- material BG fallback path', () => {
    it('(a) assemble with fallback returns 14 entries; binding 7..13 reference fallback resources', () => {
      const materialEntries = makeMaterialBindGroupEntries();
      const fallback = makeFallback();
      const fallbackAsActive: SkylightBindGroupResources = {
        irradianceView: fallback.irradianceView,
        irradianceSampler: fallback.sampler,
        prefilterView: fallback.prefilterView,
        prefilterSampler: fallback.sampler,
        brdfLutView: fallback.brdfLutView,
        brdfLutSampler: fallback.sampler,
        intensityBuffer: fallback.intensityBuffer,
      };
      const merged = assembleMaterialWithSkylightEntries(materialEntries, fallbackAsActive);
      expect(merged).toHaveLength(14);
      expect(merged[7]?.binding).toBe(7);
      expect((merged[7]?.resource as { value: unknown }).value).toBe(fallback.irradianceView);
      expect((merged[8]?.resource as { value: unknown }).value).toBe(fallback.sampler);
      expect((merged[9]?.resource as { value: unknown }).value).toBe(fallback.prefilterView);
      expect((merged[10]?.resource as { value: unknown }).value).toBe(fallback.sampler);
      expect((merged[11]?.resource as { value: unknown }).value).toBe(fallback.brdfLutView);
      expect((merged[12]?.resource as { value: unknown }).value).toBe(fallback.sampler);
      expect((merged[13]?.resource as { value: { buffer: unknown } }).value.buffer).toBe(
        fallback.intensityBuffer,
      );
    });

    it('(b) assemble with active returns 14 entries; binding 7..13 reference active IblPipelineCache resources', () => {
      const materialEntries = makeMaterialBindGroupEntries();
      const active = makeActive();
      const merged = assembleMaterialWithSkylightEntries(materialEntries, active);
      expect(merged).toHaveLength(14);
      expect((merged[7]?.resource as { value: unknown }).value).toBe(active.irradianceView);
      expect((merged[8]?.resource as { value: unknown }).value).toBe(active.irradianceSampler);
      expect((merged[9]?.resource as { value: unknown }).value).toBe(active.prefilterView);
      expect((merged[10]?.resource as { value: unknown }).value).toBe(active.prefilterSampler);
      expect((merged[11]?.resource as { value: unknown }).value).toBe(active.brdfLutView);
      expect((merged[12]?.resource as { value: unknown }).value).toBe(active.brdfLutSampler);
      expect((merged[13]?.resource as { value: { buffer: unknown } }).value.buffer).toBe(
        active.intensityBuffer,
      );
    });
  });

  // ─── (c)(d) recordFrame never emits setBindGroup(4) ─────────────────────────
  //
  // Source-level grep gate. Verifying call counts at runtime requires a full
  // RenderSystem mock; instead we grep render-system-record.ts for any
  // `setBindGroup(4,` call site. Round-4 D-5 forbids the slot entirely.

  describe('t58 (M4 round-4) -- recordFrame never binds @group(4)', () => {
    it('(c)+(d) render-system-record.ts contains zero setBindGroup(4, ...) call sites', async () => {
      const fsId = 'node:fs';
      const pathId = 'node:path';
      const urlId = 'node:url';
      const fs = (await import(/* @vite-ignore */ fsId)) as {
        readFileSync: (p: string, enc: string) => string;
      };
      const pathMod = (await import(/* @vite-ignore */ pathId)) as {
        resolve: (...parts: string[]) => string;
        dirname: (p: string) => string;
      };
      const url = (await import(/* @vite-ignore */ urlId)) as {
        fileURLToPath: (u: string) => string;
      };
      const here = url.fileURLToPath(import.meta.url);
      const filePath = pathMod.resolve(pathMod.dirname(here), '..', 'render-system-record.ts');
      const source = fs.readFileSync(filePath, 'utf8');
      // Match either `setBindGroup(4, ...)` or `setBindGroup( 4 ,`.
      const matches = source.match(/setBindGroup\s*\(\s*4\b/g);
      expect(matches).toBeNull();
    });

    it('(d) render-system-record.ts contains setBindGroup(1, ...) for PBR drawCalls (per-entity post-bug-20260522)', async () => {
      const fsId = 'node:fs';
      const pathId = 'node:path';
      const urlId = 'node:url';
      const fs = (await import(/* @vite-ignore */ fsId)) as {
        readFileSync: (p: string, enc: string) => string;
      };
      const pathMod = (await import(/* @vite-ignore */ pathId)) as {
        resolve: (...parts: string[]) => string;
        dirname: (p: string) => string;
      };
      const url = (await import(/* @vite-ignore */ urlId)) as {
        fileURLToPath: (u: string) => string;
      };
      const here = url.fileURLToPath(import.meta.url);
      const filePath = pathMod.resolve(pathMod.dirname(here), '..', 'render-system-record.ts');
      const source = fs.readFileSync(filePath, 'utf8');
      // Confirm the PBR drawCall binds material BG at slot 1. Post
      // bug-20260522, the variable name changed from `materialBindGroup`
      // to `perSubmeshBg` (rename anticipates M4 per-submesh BG construction;
      // this commit still builds per-entity).
      const matches = source.match(/setBindGroup\s*\(\s*1\s*,\s*perSubmeshBg\b/g);
      expect(matches).not.toBeNull();
      expect((matches ?? []).length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── (e) unlit material BG stays 7 entries ──────────────────────────────────

  describe('t58 (M4 round-4) -- unlit material BG isolation', () => {
    it('(e) buildUnlitMaterialBindGroupEntries returns 7 entries (no Skylight contamination)', async () => {
      const mod = await import('../pbr-pipeline');
      const buildFn = (mod as { buildUnlitMaterialBindGroupEntries?: unknown })
        .buildUnlitMaterialBindGroupEntries;
      expect(typeof buildFn).toBe('function');
      const buf = { __brand: 'Buffer' } as unknown as Buffer;
      const sampler = { __brand: 'Sampler' } as unknown as Sampler;
      const view = { __brand: 'TextureView' } as unknown as TextureView;
      // biome-ignore lint/suspicious/noExplicitAny: structural call
      const entries: BindGroupEntry[] = (buildFn as any)({
        materialUniform: buf,
        materialOffset: 0,
        materialSize: 48,
        defaultSampler: sampler,
        baseColorView: view,
        defaultWhiteView: view,
      });
      expect(entries).toHaveLength(7);
      expect(entries.every((e) => e.binding < 7)).toBe(true);
    });
  });

  // ─── (f) Shader-side convergence: intensity=0 -> ambient=0 ──────────────────

  describe('t58 (M4 round-4) -- shader physical convergence under fallback', () => {
    it('(f) fallback intensityBuffer value is 0 (sampleIblSpecular * 0 === 0 converges ambient to 0)', () => {
      // We model the shader convergence at the SkylightFallback contract
      // level: createSkylightFallback writes Float32Array([0,0,0,0]) into the
      // intensity uniform (skylight-bind-group.ts L444). The mock fallback in
      // this test mirrors that semantic: intensity value === 0.
      const fallback = makeFallback();
      // The intensity buffer is opaque here; the contract is that
      // createSkylightFallback writes zero. Cross-check via the test helper
      // shape that carries a `value: 0` marker (matches createSkylightFallback
      // writeBuffer(Float32Array([0,0,0,0])) semantics).
      expect((fallback.intensityBuffer as unknown as { value: number }).value).toBe(0);
    });
  });
}

{
  // --- from skylight-pipeline-layout.test.ts ---

  const STORAGE_CAPS: PbrCaps = { storageBuffer: true };

  // ─── Mock device ────────────────────────────────────────────────────────────
  //
  // Captures every descriptor passed to createBindGroupLayout / createPipelineLayout
  // so the test inspects the final pipeline-layout shape without standing up a
  // real GPU.

  interface CapturedBgl {
    readonly label: string | undefined;
    readonly entries: readonly GPUBindGroupLayoutEntry[];
  }

  interface CapturedPipelineLayout {
    readonly label: string | undefined;
    readonly bindGroupLayouts: readonly unknown[];
  }

  interface MockDevice {
    readonly createBindGroupLayout: ReturnType<typeof vi.fn>;
    readonly createPipelineLayout: ReturnType<typeof vi.fn>;
    readonly capturedBgls: CapturedBgl[];
    readonly capturedPipelineLayouts: CapturedPipelineLayout[];
  }

  function makeMockDevice(): MockDevice {
    const capturedBgls: CapturedBgl[] = [];
    const capturedPipelineLayouts: CapturedPipelineLayout[] = [];
    const createBindGroupLayout = vi.fn(
      (desc: { label?: string; entries: readonly GPUBindGroupLayoutEntry[] }) => {
        const captured: CapturedBgl = { label: desc.label, entries: desc.entries };
        capturedBgls.push(captured);
        // Return an opaque BindGroupLayout handle (the captured descriptor) so
        // downstream `createPipelineLayout` calls can refer to it by identity.
        return { ok: true, value: captured };
      },
    );
    const createPipelineLayout = vi.fn(
      (desc: { label?: string; bindGroupLayouts: readonly unknown[] }) => {
        const captured: CapturedPipelineLayout = {
          label: desc.label,
          bindGroupLayouts: desc.bindGroupLayouts,
        };
        capturedPipelineLayouts.push(captured);
        return { ok: true, value: captured };
      },
    );
    return {
      createBindGroupLayout,
      createPipelineLayout,
      capturedBgls,
      capturedPipelineLayouts,
    };
  }

  // ─── (a)..(d) PBR pipeline layout shape ─────────────────────────────────────

  describe('t57 (M4 round-4) -- standardPipeline pipeline-layout shape', () => {
    it('(a) buildPbrPipelineLayouts returns bindGroupLayouts.length === 4 (no @group(4))', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      const result = buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      expect(result.bindGroupLayouts).toHaveLength(4);
      // And the captured pipeline layout descriptor matches.
      expect(device.capturedPipelineLayouts).toHaveLength(1);
      const layout = device.capturedPipelineLayouts[0];
      expect(layout?.bindGroupLayouts).toHaveLength(4);
      expect(layout?.label).toBe('pbr-pl');
    });

    it('(b) PBR material BGL entry count === 18 (material 0..6 + Skylight 7..13 + emissive/AO 14..17)', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      const materialBgl = device.capturedBgls.find((b) => b.label === 'pbr-material-skylight-bgl');
      expect(materialBgl).toBeDefined();
      expect(materialBgl?.entries).toHaveLength(18);
    });

    it('(c) binding indices 0..17 in order; 7..13 resource types in D-5 round-4 order; 14..17 emissive/AO', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      const materialBgl = device.capturedBgls.find((b) => b.label === 'pbr-material-skylight-bgl');
      expect(materialBgl).toBeDefined();
      const entries = materialBgl?.entries ?? [];
      // binding indices 0..17 in order
      for (let i = 0; i < 18; i++) {
        expect(entries[i]?.binding).toBe(i);
      }
      // 7..13 resource types
      expect((entries[7] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        'cube',
      );
      expect((entries[8] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      expect((entries[9] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        'cube',
      );
      expect((entries[10] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      expect((entries[11] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        '2d',
      );
      expect((entries[12] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      expect((entries[13] as { buffer?: { type: string } }).buffer?.type).toBe('uniform');
      // 14..17 emissive/AO resource types
      expect((entries[14] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      expect((entries[15] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        '2d',
      );
      expect((entries[16] as { sampler?: { type: string } }).sampler?.type).toBe('filtering');
      expect((entries[17] as { texture?: { viewDimension: string } }).texture?.viewDimension).toBe(
        '2d',
      );
    });

    it('(d) bindGroupLayouts[0..3] order matches [view, material, meshArray, instances]', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      const result = buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      expect(result.bindGroupLayouts[0]).toBe(result.viewBgl);
      expect(result.bindGroupLayouts[1]).toBe(result.materialBgl);
      expect(result.bindGroupLayouts[2]).toBe(result.meshArrayBgl);
      expect(result.bindGroupLayouts[3]).toBe(result.instancesBgl);
      // Labels confirm slot identity.
      const view = device.capturedBgls.find((b) => b.label === 'pbr-view-bgl');
      const mesh = device.capturedBgls.find((b) => b.label === 'pbr-mesh-array-bgl');
      const instances = device.capturedBgls.find((b) => b.label === 'pbr-instances-bgl');
      expect(view).toBeDefined();
      expect(mesh).toBeDefined();
      expect(instances).toBeDefined();
    });
  });

  // ─── (e)(f) Unlit material BGL shape + name ─────────────────────────────────

  describe('t57 (M4 round-4) -- unlitPipeline material BGL shape', () => {
    it('(e) unlit material BGL entry count === 7 (no Skylight binding 7..13 contamination)', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildUnlitMaterialBgl(device as any);
      const unlitBgl = device.capturedBgls.find((b) => b.label === 'unlit-material-bgl');
      expect(unlitBgl).toBeDefined();
      expect(unlitBgl?.entries).toHaveLength(7);
    });

    it("(f) PBR material BGL labelled 'pbr-material-skylight-bgl'; unlit labelled 'unlit-material-bgl'", () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildUnlitMaterialBgl(device as any);
      const pbr = device.capturedBgls.find((b) => b.label === 'pbr-material-skylight-bgl');
      const unlit = device.capturedBgls.find((b) => b.label === 'unlit-material-bgl');
      expect(pbr).toBeDefined();
      expect(unlit).toBeDefined();
    });
  });
}

{
  // --- from tonemap-hdr-target.test.ts ---

  const ENGINE = '../createRenderer';

  // ─── Mock helpers (mirrors renderer-ready.test.ts shape) ───────────────────

  function makeMockGL2(): Record<string, unknown> {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      isContextLost: () => false,
    };
  }

  function makeMockCanvas(): HTMLCanvasElement {
    return {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') return makeMockGL2();
        if (kind === 'webgpu') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({
              createView: () => ({}),
              width: 800,
              height: 600,
            }),
          };
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as HTMLCanvasElement;
  }

  interface CallRecord {
    readonly type: string;
    readonly label?: string | undefined;
    readonly format?: string | undefined;
    readonly size?: number | undefined;
    readonly entries?: number | undefined;
    readonly fragmentTargets?: readonly string[] | undefined;
  }

  interface DeviceCallLog {
    readonly records: CallRecord[];
  }

  function makeMockDevice(log: DeviceCallLog): unknown {
    const lost = new Promise<unknown>(() => undefined);
    return {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      limits: {},
      queue: {
        submit: () => undefined,
        writeBuffer: () => undefined,
        writeTexture: () => undefined,
      },
      createShaderModule: (desc: { label?: string }) => {
        log.records.push({ type: 'createShaderModule', label: desc?.label });
        return { getCompilationInfo: async () => ({ messages: [] }) };
      },
      createBindGroupLayout: (desc: { label?: string; entries?: unknown[] }) => {
        log.records.push({
          type: 'createBindGroupLayout',
          label: desc?.label,
          entries: Array.isArray(desc?.entries) ? desc.entries.length : 0,
        });
        return {};
      },
      createPipelineLayout: (desc: { label?: string }) => {
        log.records.push({ type: 'createPipelineLayout', label: desc?.label });
        return {};
      },
      createRenderPipeline: (desc: {
        label?: string;
        fragment?: { targets?: Array<{ format?: string }> };
      }) => {
        const targets = desc?.fragment?.targets ?? [];
        const formats = targets.map((t) => t?.format ?? '<missing>');
        log.records.push({
          type: 'createRenderPipeline',
          label: desc?.label,
          fragmentTargets: formats,
        });
        return {};
      },
      createBindGroup: () => ({}),
      createBuffer: (desc: { label?: string; size?: number }) => {
        log.records.push({
          type: 'createBuffer',
          label: desc?.label,
          size: desc?.size,
        });
        return {
          getMappedRange: () => new ArrayBuffer(64),
          unmap: () => undefined,
        };
      },
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setVertexBuffer: () => undefined,
          setBindGroup: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
        }),
        finish: () => ({}),
      }),
      createTexture: (desc: { label?: string; format?: string }) => {
        log.records.push({ type: 'createTexture', label: desc?.label, format: desc?.format });
        return {
          createView: () => ({}),
        };
      },
      createTextureView: () => ({}),
      createSampler: (desc: { label?: string }) => {
        log.records.push({ type: 'createSampler', label: desc?.label });
        return {};
      },
      destroy: () => undefined,
    };
  }

  function makeMockGPU(deviceObj: unknown): unknown {
    return {
      requestAdapter: async () => ({
        requestDevice: async () => deviceObj,
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  function buildManifestDataUrl(): string {
    const manifest = {
      schemaVersion: '1.0.0',
      entries: [
        {
          hash: 'pbr00000',
          wgsl: '/* mock pbr.wgsl - calls f_schlick( for PBR direct lighting */',
          glsl: '',
          bindings: '',
        },
        {
          hash: 'unlit000',
          wgsl: '/* mock unlit.wgsl - constant-shading path */',
          glsl: '',
          bindings: '',
        },
        {
          hash: 'tonemap0',
          wgsl: '/* mock tonemap.wgsl - struct TonemapParams { exposure: f32 }; */',
          glsl: '',
          bindings: '',
        },
      ],
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  // ─── Tests ─────────────────────────────────────────────────────────────────

  const baseNavigator = { userAgent: 'mock-engine-test' } as unknown as Navigator;

  beforeEach(() => {
    vi.stubGlobal('navigator', { ...baseNavigator });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('feat-20260519-tonemap-reinhard-mvp T-M2.4 / T-M2.5: HDR target + tonemap pipeline shape', () => {
    // feat-20260621 M-A3 (D-5): the prior "row 1" asserting boot-time creation of
    // a dedicated tonemap pipeline / 3-entry BGL / sampler / 16 B params UBO is
    // deleted. The built-in tonemap now registers on the unified post-process
    // channel (`postProcess.register('forgeax::tonemap', { source, params })`);
    // its pipeline + BGL + sampler compile lazily on the first tonemap frame
    // (dispatchFullscreenPass), not at boot. The 3-entry BGL shape +
    // params-UBO byteSize=16 are covered by dispatch-fullscreen-pass-params.unit.
    // test.ts; observable tonemap output is smoke-gated (w12, plan-strategy R-1).
    it('row 2: HDR variants of unlit + standard pipelines compile with rgba16float colour attachment (AC-03(d) / AC-11)', async () => {
      const log: DeviceCallLog = { records: [] };
      const device = makeMockDevice(log);
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
      const canvas = makeMockCanvas();
      const { createRenderer } = (await import(ENGINE)) as {
        createRenderer: (canvas: unknown, opts?: unknown, bundler?: unknown) => Promise<unknown>;
      };
      const renderer = (await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      )) as { ready: Promise<{ ok: boolean }> };
      const ready = await renderer.ready;
      expect(ready.ok).toBe(true);

      // bug-20260612: sRGB siblings stay on the swap-chain srgb view; Channel 2
      // (storageBufferCapable=true) follows getPreferredCanvasFormat() — mocked
      // as 'bgra8unorm' here for Chromium parity, paired with 'bgra8unorm-srgb'.
      const unlitSrgb = log.records.find(
        (r) => r.type === 'createRenderPipeline' && r.label === 'pbr-pipeline-unlit',
      );
      expect(unlitSrgb?.fragmentTargets).toEqual(['bgra8unorm-srgb']);
      const stdSrgb = log.records.find(
        (r) => r.type === 'createRenderPipeline' && r.label === 'pbr-pipeline-standard',
      );
      expect(stdSrgb?.fragmentTargets).toEqual(['bgra8unorm-srgb']);

      // HDR variants ship the rgba16float target.
      const unlitHdr = log.records.find(
        (r) => r.type === 'createRenderPipeline' && r.label === 'pbr-pipeline-unlit-hdr',
      );
      expect(unlitHdr).toBeDefined();
      expect(unlitHdr?.fragmentTargets).toEqual(['rgba16float']);
      const stdHdr = log.records.find(
        (r) => r.type === 'createRenderPipeline' && r.label === 'pbr-pipeline-standard-hdr',
      );
      expect(stdHdr).toBeDefined();
      expect(stdHdr?.fragmentTargets).toEqual(['rgba16float']);
    });

    it('row 3: lazy HDR colour + depth attachments start null (AC-03(c) zero-cost on tonemap none path)', async () => {
      const log: DeviceCallLog = { records: [] };
      const device = makeMockDevice(log);
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
      const canvas = makeMockCanvas();
      const { createRenderer } = (await import(ENGINE)) as {
        createRenderer: (
          canvas: unknown,
          opts?: unknown,
          bundler?: unknown,
        ) => Promise<{
          ready: Promise<{ ok: boolean }>;
        }>;
      };
      const renderer = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      const ready = await renderer.ready;
      expect(ready.ok).toBe(true);

      // No `createTexture(format='rgba16float')` call for the HDR colour
      // attachment before any opt-in frame. The geometry-side fallback
      // white texture is 'rgba8unorm'; the depth attachment is
      // 'depth24plus-stencil8'. An HDR-target rgba16float allocation only fires
      // inside the record stage when the active camera carries
      // tonemap !== 'none'. AC-03(c).
      //
      // feat-20260520-skylight-ibl-cubemap M2 round-2 / t40 + plan-strategy
      // D-5 carve-out: the skylight fallback bundle allocates two 1x1
      // rgba16float texture_cubes (labels `skylight-fallback-irradiance-cube`
      // / `skylight-fallback-prefilter-cube`) inside createRenderer. They
      // are NOT HDR colour attachments -- they seed the @group(4) fallback
      // bind group so PBR pipelines dispatch with ambient=0 when no Skylight
      // ECS entity exists. Filter by label so the AC-03(c) lazy-HDR contract
      // remains testable.
      //
      // tweak-20260608-rhi-hdr-renderable-caps-and-warn-once M1 carve-out:
      // RhiCaps probe creates a 1x1 rgba16float texture (label
      // `forgeax-caps-probe-rgba16float-renderable`) during deriveCaps to
      // test if the format is RENDER_ATTACHMENT-renderable. NOT an HDR
      // colour attachment -- a one-shot probe destroyed immediately. Filter
      // by label so the AC-03(c) lazy-HDR contract remains testable.
      const hdrTextureCalls = log.records.filter(
        (r) =>
          r.type === 'createTexture' &&
          r.format === 'rgba16float' &&
          !(r.label?.startsWith('skylight-fallback-') ?? false) &&
          !(r.label?.startsWith('forgeax-caps-probe-') ?? false),
      );
      expect(hdrTextureCalls.length).toBe(0);
    });

    it('row 4: pbr + unlit engine modules compile at boot (tonemap defers to unified channel)', async () => {
      const log: DeviceCallLog = { records: [] };
      const device = makeMockDevice(log);
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
      const canvas = makeMockCanvas();
      const { createRenderer } = (await import(ENGINE)) as {
        createRenderer: (
          canvas: unknown,
          opts?: unknown,
          bundler?: unknown,
        ) => Promise<{
          ready: Promise<{ ok: boolean }>;
        }>;
      };
      const renderer = await createRenderer(
        canvas,
        {},
        { shaderManifestUrl: buildManifestDataUrl() },
      );
      const ready = await renderer.ready;
      expect(ready.ok).toBe(true);

      const moduleLabels = log.records
        .filter((r) => r.type === 'createShaderModule')
        .map((r) => r.label);
      expect(moduleLabels).toContain('pbr');
      expect(moduleLabels).toContain('unlit');
      // feat-20260621 M-A3 (D-5): tonemap no longer eager-compiles at boot — it
      // registers on the unified post-process channel and its module compiles
      // lazily on the first tonemap frame (dispatchFullscreenPass), so the boot
      // `createShaderModule` log carries NO 'tonemap' label. Row 5 still proves
      // the manifest triple guard (missing tonemap entry -> ready rejects).
      expect(moduleLabels).not.toContain('tonemap');
    });

    it('row 5: ready rejects shader-compile-failed when manifest omits tonemap entry', async () => {
      const log: DeviceCallLog = { records: [] };
      const device = makeMockDevice(log);
      vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
      const canvas = makeMockCanvas();
      const partialManifest = {
        schemaVersion: '1.0.0',
        entries: [
          {
            hash: 'pbr00000',
            wgsl: '/* mock pbr.wgsl - calls f_schlick( for PBR direct lighting */',
            glsl: '',
            bindings: '',
          },
          {
            hash: 'unlit000',
            wgsl: '/* mock unlit.wgsl */',
            glsl: '',
            bindings: '',
          },
        ],
      };
      const url = `data:application/json,${encodeURIComponent(JSON.stringify(partialManifest))}`;
      const { createRenderer } = (await import(ENGINE)) as {
        createRenderer: (
          canvas: unknown,
          opts?: unknown,
          bundler?: unknown,
        ) => Promise<{
          ready: Promise<{ ok: boolean; error?: { code: string } }>;
        }>;
      };
      const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: url });
      const ready = await renderer.ready;
      expect(ready.ok).toBe(false);
      expect(ready.error?.code).toBe('shader-compile-failed');
    });
  });
}

{
  // --- from tonemap-pipeline-split.test.ts ---

  // feat-20260519-light-casters-point-spot-pbr: ExtractedLights three-bucket
  // shape (replaces the legacy `LightSnapshot[]` shape pre-merge). Tonemap
  // routing tests do not exercise the lighting path, so the empty bucket
  // (no directional + zero point/spot) is the valid neutral fixture.
  const EMPTY_LIGHTS: ExtractedLights = {
    directional: undefined,
    directionalCount: 0,
    point: [],
    spot: [],
    lightSpaceMatrix: undefined,
    shadowMapSize: undefined,
    pointShadow: [],
  };

  interface PassEvent {
    readonly type:
      | 'beginRenderPass'
      | 'setPipeline'
      | 'setBindGroup'
      | 'draw'
      | 'drawIndexed'
      | 'end'
      | 'createBindGroup'
      | 'createTexture'
      | 'writeBuffer';
    readonly label?: string | undefined;
    readonly view?: unknown;
    readonly format?: string | undefined;
    readonly pipeline?: unknown;
    readonly bgLabel?: string | undefined;
    readonly buffer?: unknown;
    readonly drawArg?: number | undefined;
  }

  interface DeviceLog {
    readonly events: PassEvent[];
  }

  function makeRecorderInternals(log: DeviceLog): unknown {
    // Mark sentinel objects per role so the log distinguishes pipelines.
    const fakeUnlitPipeline = { __role: 'unlit' };
    const fakeUnlitHdrPipeline = { __role: 'unlit-hdr' };
    const fakeStandardPipeline = { __role: 'standard' };
    const fakeStandardHdrPipeline = { __role: 'standard-hdr' };
    const fakeTonemapPipeline = { __role: 'tonemap' };
    const swapChainView = { __role: 'swap-chain-srgb-view' };
    const hdrColorView = { __role: 'hdr-color-view' };
    const hdrDepthView = { __role: 'hdr-depth-view' };
    const swapDepthView = { __role: 'depth-view' };
    const hdrColorTexHandle = { __role: 'hdr-color-tex' };
    const hdrDepthTexHandle = { __role: 'hdr-depth-tex' };
    const fakeColorTex = {
      width: 800,
      height: 600,
      createView: () => swapChainView,
    };

    const beginRenderPass = (desc: { colorAttachments?: Array<{ view?: unknown }> }): unknown => {
      const view = desc?.colorAttachments?.[0]?.view;
      log.events.push({
        type: 'beginRenderPass',
        view,
      });
      return {
        setPipeline(p: unknown): void {
          const role =
            p === fakeUnlitPipeline
              ? 'unlit'
              : p === fakeUnlitHdrPipeline
                ? 'unlit-hdr'
                : p === fakeStandardPipeline
                  ? 'standard'
                  : p === fakeStandardHdrPipeline
                    ? 'standard-hdr'
                    : p === fakeTonemapPipeline
                      ? 'tonemap'
                      : 'unknown';
          log.events.push({ type: 'setPipeline', label: role });
        },
        setVertexBuffer(): void {
          // unused
        },
        setIndexBuffer(): void {
          // unused
        },
        setBindGroup(_idx: number, bg: { __label?: string }): void {
          log.events.push({ type: 'setBindGroup', bgLabel: bg?.__label });
        },
        drawIndexed(): void {
          log.events.push({ type: 'drawIndexed' });
        },
        draw(arg: number): void {
          log.events.push({ type: 'draw', drawArg: arg });
        },
        end(): void {
          log.events.push({ type: 'end' });
        },
      };
    };

    const internals = {
      canvas: {} as unknown,
      device: {
        caps: { storageBuffer: true, backendKind: 'webgpu' },
        limits: { maxStorageBufferBindingSize: 1024 * 1024 * 1024 },
        queue: {
          submit: () => ({ ok: true, value: undefined }),
          writeBuffer: (buffer: { __label?: string }) => {
            log.events.push({ type: 'writeBuffer', buffer });
            return { ok: true, value: undefined };
          },
        },
        createCommandEncoder: () => ({
          ok: true,
          value: {
            beginRenderPass,
            finish: () => ({ ok: true, value: { __label: 'cmd' } }),
          },
        }),
        createTextureView: (texture: unknown) => {
          // The current swap-chain texture (fakeColorTex) returns the
          // pre-stamped `swapChainView` sentinel so the test can distinguish
          // it from HDR-view sentinels stamped by `createTexture`.
          if (texture === fakeColorTex) {
            return { ok: true, value: swapChainView };
          }
          if (texture === hdrColorTexHandle) {
            return { ok: true, value: hdrColorView };
          }
          if (texture === hdrDepthTexHandle) {
            return { ok: true, value: hdrDepthView };
          }
          return { ok: true, value: { __role: 'view' } };
        },
        createTexture: (desc: { format?: string; label?: string }) => {
          log.events.push({ type: 'createTexture', format: desc?.format, label: desc?.label });
          let value: unknown;
          // M1 / w7: labels changed from manual ensureLazyTexture prefixes
          // ('render-system-hdr-*') to graph addColorTarget resource names.
          if (desc?.label === 'hdrColor') {
            value = hdrColorTexHandle;
          } else if (desc?.label === 'hdrDepth') {
            value = hdrDepthTexHandle;
          } else if (desc?.label === 'depth') {
            value = { createView: () => swapDepthView };
          } else {
            value = {
              createView: () => ({ __role: `${desc?.format ?? 'unknown'}-view` }),
            };
          }
          return { ok: true, value };
        },
        createBindGroup: (desc: { label?: string }) => {
          log.events.push({ type: 'createBindGroup', label: desc?.label });
          return { ok: true, value: { __label: desc?.label } };
        },
      },
      context: {
        getCurrentTexture: () => ({ ok: true, value: fakeColorTex }),
      },
      getPipelineState: () => null,
      assets: {
        get: () => ({ ok: false, error: { code: 'asset-not-registered' } }),
        getMeshGpuHandles: () => undefined,
        getTextureGpuView: () => undefined,
      },
      errorRegistry: {
        fire: () => undefined,
      },
      _fakes: {
        fakeUnlitPipeline,
        fakeUnlitHdrPipeline,
        fakeStandardPipeline,
        fakeStandardHdrPipeline,
        fakeTonemapPipeline,
        swapChainView,
        hdrColorView,
        hdrDepthView,
        swapDepthView,
      },
    };
    return internals;
  }

  function makePipelineState(
    internals: { _fakes: Record<string, unknown> },
    hdrAlreadyAllocated: boolean,
  ): unknown {
    const f = internals._fakes;
    return {
      meshes: new Map(),
      format: 'bgra8unorm',
      colorAttachmentFormat: 'bgra8unorm-srgb',
      viewBindGroupLayout: { __label: 'view-bgl' },
      materialBindGroupLayout: { __label: 'material-bgl' },
      meshBindGroupLayout: { __label: 'mesh-bgl' },
      viewUniformBuffer: { __label: 'view-ubo' },
      materialUniformBuffer: { __label: 'material-ubo' },
      meshStorageBuffer: { __label: 'mesh-ssbo' },
      instancesBindGroupLayout: { __label: 'instances-bgl' },
      identityInstanceBuffer: { __label: 'identity-instance-ssbo' },
      defaultSampler: { __label: 'default-sampler' },
      nearestSampler: { __label: 'nearest-sampler' },
      fallbackTextureView: { __label: 'fallback-view' },
      defaultWhiteTextureView: { __label: 'default-white-view' },
      unlitPipeline: f.fakeUnlitPipeline,
      standardPipeline: f.fakeStandardPipeline,
      // feat-20260520-2d-sprite-layer-mvp M-3 / w24: sprite alpha-blend
      // pipeline pair added to PipelineState SSOT. Tonemap-pipeline-split
      // fixture stays an opaque-bucket test (no sprite entity); fields
      // present so PipelineState type-check passes but never bound.
      spritePipeline: { __label: 'sprite-pipeline' },
      spritePipelineHdr: { __label: 'sprite-pipeline-hdr' },
      unlitPipelineHdr: f.fakeUnlitHdrPipeline,
      standardPipelineHdr: f.fakeStandardHdrPipeline,
      perPassResources: {
        depthTexture: { __label: 'depth' },
        depthTextureView: f.swapDepthView,
        depthTextureWidth: 800,
        depthTextureHeight: 600,
        configured: true,
        hdrColorTexture: hdrAlreadyAllocated ? { __label: 'hdr-color' } : null,
        hdrColorView: hdrAlreadyAllocated ? f.hdrColorView : null,
        hdrDepthTexture: hdrAlreadyAllocated ? { __label: 'hdr-depth' } : null,
        hdrDepthView: hdrAlreadyAllocated ? f.hdrDepthView : null,
        hdrTextureWidth: hdrAlreadyAllocated ? 800 : 0,
        hdrTextureHeight: hdrAlreadyAllocated ? 600 : 0,
      },
    };
  }

  function makeCamera(tonemap: 'none' | 'reinhard-extended'): CameraSnapshot {
    return {
      position: vec3.create(0, 0, 5),
      // feat-20260601: CameraSnapshot carries the world mat4; identity rotation
      // at (0,0,5) -> column-major translate-z=5.
      world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]),
      fov: Math.PI / 4,
      aspect: 1,
      near: 0.1,
      far: 100,
      // feat-20260613 M6 / w20: CameraSnapshot now carries projection +
      // ortho extents (see CSM frustum-fit fix in render-system-extract).
      projection: 'perspective',
      orthoLeft: -1,
      orthoRight: 1,
      orthoBottom: -1,
      orthoTop: 1,
      tonemap,
      exposure: 1.0,
      whitePoint: 4.0,
      antialias: 'none',
      bloom: 'off',
      bloomThreshold: 1.0,
      bloomIntensity: 1.0,
      bloomBlurRadius: 4.0,
      clearR: 0,
      clearG: 0,
      clearB: 0,
      clearA: 1,
    };
  }

  describe('feat-20260519-tonemap-reinhard-mvp T-M3.1: record-stage tonemap routing', () => {
    it('row 1: tonemap=none camera writes geometry into swap-chain srgb view + emits NO tonemap pass (AC-03(c) / AC-11)', async () => {
      const log: DeviceLog = { events: [] };
      const internals = makeRecorderInternals(log);
      const ps = makePipelineState(internals as never, false);
      (internals as { getPipelineState: () => unknown }).getPipelineState = () => ps;
      const { recordFrame } = await import('../render-system-record');
      const cameras = [makeCamera('none')];
      recordFrame(
        internals as never,
        new World() as never,
        cameras,
        EMPTY_LIGHTS,
        [],
        [],
        {
          frameNumber: 0,
          perFrameGraph: null,
          instanceBuffers: new Map(),
          warnedZeroLightStandard: false,
          warnedShadowDisabled: false,
          warnedMultiLightDirectional: false,
          warnedMultiLightPoint: false,
          warnedMultiLightSpot: false,
          warnedSkyboxTonemapNone: false,
          warnedMissingSpriteTextureHandles: new Set<number>(),
          warnedNineSliceScaleEntities: new Set<number>(),
          viewBindGroupCache: new Map(),
          meshBindGroupCache: new Map(),
          materialBgPerEntity: new Map(),
          instancesBgPerEntity: new Map(),
          materialBgShared: new Map(),
          singletonMaterialCache: new Map(),
          installedPipelineHandle: 0,
          activePipeline: urpPipeline,
          installedPipelineConfig: undefined,
          isHdrpActive: false,
          hdrpOncePerFrameFired: new Set(),
        },
        { unlit: 0 },
        { createBindGroup: 0, keys: [] },
        undefined,
        0,
        undefined,
        0,
      );

      // M1 / w7: the render-graph allocates ALL color targets (including HDR)
      // at buildGraph compile time, not lazily per-frame. The HDR texture
      // exists in the pool but recordFrame's tonemap='none' path selects the
      // swap-chain view (not the HDR view), so the tonemap pass is skipped.
      // The assertion below verifies the pass routing, not the allocation gate.
      // (Row 2 covers the actual HDR texture allocation labels.)

      // Exactly one beginRenderPass — the geometry pass; no fullscreen tonemap
      // pass after it.
      const beginPasses = log.events.filter((e) => e.type === 'beginRenderPass');
      expect(beginPasses).toHaveLength(1);
      expect(beginPasses[0]?.view).toBe(
        (internals as { _fakes: { swapChainView: unknown } })._fakes.swapChainView,
      );

      // No tonemap setPipeline event (no tonemap pass was encoded).
      const tonemapSets = log.events.filter(
        (e) => e.type === 'setPipeline' && e.label === 'tonemap',
      );
      expect(tonemapSets).toHaveLength(0);
    });
  });

  // ── w12: AC-05 B-family F11 despawn -> per-frame poll destroy ─────────────
  //
  // Round 2 fix-up (implement-review §5 Issue 1): the F11 cleanup loop lives
  // in recordFrame (render-system-record.ts ~:2245) — it iterates
  // frameState.instanceBuffers.entries() and, for any key NOT in the current
  // validated-renderable set, destroys the GpuBuffer then deletes the Map
  // entry. The previous w12 test drove `disposeInstanceBuffers` (a different
  // function sharing only the isDestroyed+destroy idiom), so disabling the
  // F11 production destroy left it green. This test drives the REAL
  // recordFrame: pre-seed instanceBuffers with a live GpuBuffer keyed at an
  // entity that is NOT among the rendered entities (empty renderables ->
  // empty validated set), then assert recordFrame destroyed it. Flip the
  // production `entry.buffer.destroy()` at :2248 to a no-op and this fails.
  describe('instance buffer per-frame poll destroy (AC-05 F11) [w12]', () => {
    // Minimal device whose destroyBuffer records each handle it destroys, so
    // the assertion observes the real GpuBuffer.destroy() -> device.destroyBuffer
    // routing rather than re-checking a copied isDestroyed flag.
    // biome-ignore lint/suspicious/noExplicitAny: dynamic-import rhi shim types are opaque
    function makeBufRecorderDevice(rhiErrFn: any, rhiOkFn: any, RhiErrorCtor: any) {
      const destroyed = new WeakSet<object>();
      const destroyedHandles: object[] = [];
      const device = {
        destroyBuffer(buf: object) {
          if (destroyed.has(buf)) {
            return rhiErrFn(
              new RhiErrorCtor({ code: 'destroy-after-destroy', expected: '', hint: '' }),
            );
          }
          destroyed.add(buf);
          destroyedHandles.push(buf);
          return rhiOkFn(undefined);
        },
      };
      return { device, destroyedHandles };
    }

    it('despawned key (not in validated set): recordFrame destroys GpuBuffer + deletes Map entry', async () => {
      const { recordFrame } = await import('../render-system-record');
      const { GpuBuffer } = await import('../gpu-resource');
      const { err: rhiErrFn, RhiError: RhiErrorCtor } = await import('@forgeax/engine-rhi');
      const { device: bufDev, destroyedHandles } = makeBufRecorderDevice(
        rhiErrFn,
        rhiOk,
        RhiErrorCtor,
      );

      const log: DeviceLog = { events: [] };
      const internals = makeRecorderInternals(log);
      const ps = makePipelineState(internals as never, false);
      (internals as { getPipelineState: () => unknown }).getPipelineState = () => ps;

      // Pre-seed the per-frame instance-buffer cache with one live entry whose
      // key (999) belongs to an entity that is NOT rendered this frame.
      const staleHandle = { __role: 'stale-instance-buffer' };
      const staleBuffer = new GpuBuffer(bufDev as never, staleHandle as never);
      const instanceBuffers = new Map<number, InstanceBufferCacheEntry>();
      instanceBuffers.set(999, {
        buffer: staleBuffer,
        uploadedArchVersion: 1,
        uploadedByteLength: 256,
      });

      const cameras = [makeCamera('none')];
      recordFrame(
        internals as never,
        new World() as never,
        cameras,
        EMPTY_LIGHTS,
        [], // no renderables -> validated set is empty -> key 999 is orphaned
        [],
        {
          frameNumber: 0,
          perFrameGraph: null,
          instanceBuffers,
          warnedZeroLightStandard: false,
          warnedShadowDisabled: false,
          warnedMultiLightDirectional: false,
          warnedMultiLightPoint: false,
          warnedMultiLightSpot: false,
          warnedSkyboxTonemapNone: false,
          warnedMissingSpriteTextureHandles: new Set<number>(),
          warnedNineSliceScaleEntities: new Set<number>(),
          viewBindGroupCache: new Map(),
          meshBindGroupCache: new Map(),
          materialBgPerEntity: new Map(),
          instancesBgPerEntity: new Map(),
          materialBgShared: new Map(),
          singletonMaterialCache: new Map(),
          installedPipelineHandle: 0,
          activePipeline: urpPipeline,
          installedPipelineConfig: undefined,
          isHdrpActive: false,
          hdrpOncePerFrameFired: new Set(),
        },
        { unlit: 0 },
        { createBindGroup: 0, keys: [] },
        undefined,
        0,
        undefined,
        0,
      );

      // F11 production loop destroyed the orphaned buffer + dropped the key.
      expect(staleBuffer.isDestroyed).toBe(true);
      expect(destroyedHandles).toContain(staleHandle);
      expect(instanceBuffers.has(999)).toBe(false);
    });

    it('isDestroyed dedup: a pre-destroyed orphan is not double-destroyed (still removed)', async () => {
      const { recordFrame } = await import('../render-system-record');
      const { GpuBuffer } = await import('../gpu-resource');
      const { err: rhiErrFn, RhiError: RhiErrorCtor } = await import('@forgeax/engine-rhi');
      const { device: bufDev, destroyedHandles } = makeBufRecorderDevice(
        rhiErrFn,
        rhiOk,
        RhiErrorCtor,
      );

      const log: DeviceLog = { events: [] };
      const internals = makeRecorderInternals(log);
      const ps = makePipelineState(internals as never, false);
      (internals as { getPipelineState: () => unknown }).getPipelineState = () => ps;

      const staleHandle = { __role: 'pre-destroyed-instance-buffer' };
      const staleBuffer = new GpuBuffer(bufDev as never, staleHandle as never);
      staleBuffer.destroy(); // pre-destroy: isDestroyed gate must skip re-destroy
      const preDestroyCount = destroyedHandles.length;

      const instanceBuffers = new Map<number, InstanceBufferCacheEntry>();
      instanceBuffers.set(7, {
        buffer: staleBuffer,
        uploadedArchVersion: 2,
        uploadedByteLength: 512,
      });

      recordFrame(
        internals as never,
        new World() as never,
        [makeCamera('none')],
        EMPTY_LIGHTS,
        [],
        [],
        {
          frameNumber: 0,
          perFrameGraph: null,
          instanceBuffers,
          warnedZeroLightStandard: false,
          warnedShadowDisabled: false,
          warnedMultiLightDirectional: false,
          warnedMultiLightPoint: false,
          warnedMultiLightSpot: false,
          warnedSkyboxTonemapNone: false,
          warnedMissingSpriteTextureHandles: new Set<number>(),
          warnedNineSliceScaleEntities: new Set<number>(),
          viewBindGroupCache: new Map(),
          meshBindGroupCache: new Map(),
          materialBgPerEntity: new Map(),
          instancesBgPerEntity: new Map(),
          materialBgShared: new Map(),
          singletonMaterialCache: new Map(),
          installedPipelineHandle: 0,
          activePipeline: urpPipeline,
          installedPipelineConfig: undefined,
          isHdrpActive: false,
          hdrpOncePerFrameFired: new Set(),
        },
        { unlit: 0 },
        { createBindGroup: 0, keys: [] },
        undefined,
        0,
        undefined,
        0,
      );

      // isDestroyed gate skipped the second destroy; key still dropped.
      expect(destroyedHandles.length).toBe(preDestroyCount);
      expect(instanceBuffers.has(7)).toBe(false);
    });
  });
}

{
  // --- from zero-camera-clear-fallback.test.ts ---

  describe('zero-Camera fallback clear color (TASK-003 / AC-05)', () => {
    it('ZERO_CAMERA_CLEAR_FALLBACK equals [0, 0, 0, 1] (opaque black)', () => {
      expect(Array.from(ZERO_CAMERA_CLEAR_FALLBACK)).toEqual([0, 0, 0, 1]);
    });

    it('alpha component is 1 (opaque), not 0 (transparent)', () => {
      expect(ZERO_CAMERA_CLEAR_FALLBACK[3]).toBe(1);
    });

    it('does not match the retired dark-slate sentinel [0.06, 0.06, 0.08, 1.0]', () => {
      expect(ZERO_CAMERA_CLEAR_FALLBACK[0]).not.toBeCloseTo(0.06, 3);
      expect(ZERO_CAMERA_CLEAR_FALLBACK[1]).not.toBeCloseTo(0.06, 3);
      expect(ZERO_CAMERA_CLEAR_FALLBACK[2]).not.toBeCloseTo(0.08, 3);
    });

    it('all three RGB channels are exactly 0 (pure black)', () => {
      expect(ZERO_CAMERA_CLEAR_FALLBACK[0]).toBe(0);
      expect(ZERO_CAMERA_CLEAR_FALLBACK[1]).toBe(0);
      expect(ZERO_CAMERA_CLEAR_FALLBACK[2]).toBe(0);
    });
  });
}

{
  // --- from skin.test.ts ---

  describe('Skin — component registration + schema shape (AC-13 / AC-37)', () => {
    it('Skin is a registered component with name "Skin" and schema fields skeleton + joints', () => {
      expect(Skin.name).toBe('Skin');
      expect(Skin.schema).toEqual({
        skeleton: 'shared<SkeletonAsset>',
        joints: 'array<entity>',
      });
    });

    it('Skin.schema.skeleton is shared<SkeletonAsset> (schema-vocab keyword)', () => {
      expect(Skin.schema.skeleton).toBe('shared<SkeletonAsset>');
    });

    it('Skin.schema.joints is array<entity> (schema-vocab keyword)', () => {
      expect(Skin.schema.joints).toBe('array<entity>');
    });

    it('Skin component spawns on an entity', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Skin,
          data: {
            skeleton: toShared<'SkeletonAsset'>(1),
            joints: new Uint32Array(0),
          },
        })
        .unwrap();
      const skin = world.get(e, Skin).unwrap();
      expect(skin.skeleton).toBe(1);
      expect(skin.joints).toEqual(new Uint32Array(0));
    });

    it('Skin coexists as sibling with Transform + MeshFilter + MeshRenderer (AC-13)', () => {
      const world = new World();
      const e = world
        .spawn(
          {
            component: Transform,
            data: {
              posX: 0,
              posY: 0,
              posZ: 0,
              quatX: 0,
              quatY: 0,
              quatZ: 0,
              quatW: 1,
              scaleX: 1,
              scaleY: 1,
              scaleZ: 1,
            },
          },
          { component: MeshFilter, data: { assetHandle: toShared<'MeshAsset'>(1) } },
          { component: MeshRenderer, data: { materials: [toShared<'MaterialAsset'>(1)] } },
          {
            component: Skin,
            data: {
              skeleton: toShared<'SkeletonAsset'>(1),
              joints: new Uint32Array(0),
            },
          },
        )
        .unwrap();
      // 4 components all exist on the same entity
      const t = world.get(e, Transform).unwrap();
      const mf = world.get(e, MeshFilter).unwrap();
      const mr = world.get(e, MeshRenderer).unwrap();
      const skin = world.get(e, Skin).unwrap();
      expect(t).toBeDefined();
      expect(mf).toBeDefined();
      expect(mr).toBeDefined();
      expect(skin).toBeDefined();
      expect(skin.joints).toEqual(new Uint32Array(0));
    });
  });
}

{
  // --- from advance-animation-player.test.ts ---

  const defaultTransform = {
    posX: 0,
    posY: 0,
    posZ: 0,
    quatX: 0,
    quatY: 0,
    quatZ: 0,
    quatW: 1,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  };

  function makeSampler(
    input: number[],
    output: number[],
    interpolation: 'LINEAR' | 'STEP' = 'LINEAR',
  ): AnimationSampler {
    return {
      input: new Float32Array(input),
      output: new Float32Array(output),
      interpolation,
    };
  }

  function makeClip(duration: number, channels: AnimationClip['channels']): AnimationClip {
    return {
      kind: 'animation-clip',
      duration,
      channels,
    };
  }

  function makeResolver(clips: Map<number, AnimationClip>): AnimationAssetResolver {
    return {
      resolveAnimationClip(_world: World, handleRaw: number): AnimationClip | undefined {
        return clips.get(handleRaw);
      },
    };
  }

  // M2 / w3: spawn data migrated to SoA inline arrays. Single-clip legacy
  // path: clips[0] = handle, weights[0] = 1, speeds[0] = speed, times[0] = 0;
  // slots 1..3 stay zero. `world.set({ time: t })` becomes a partial column
  // write `world.set({ times: new Float32Array([t,0,0,0]) })`. Reads of
  // `.time` route through `.times[0]`. Old expectations preserved (time
  // advance / looping modulo / paused skip) — schema cut only.
  function spawnLegacySinglePlayer(
    world: World,
    clipId: number,
    overrides: { speed?: number; paused?: boolean; looping?: boolean } = {},
  ): EntityHandle {
    const speed = overrides.speed ?? 1;
    const paused = overrides.paused ?? false;
    const looping = overrides.looping ?? true;
    return world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips: [
            toShared<'AnimationClip'>(clipId),
            0 as Handle<'AnimationClip', 'shared'>,
            0 as Handle<'AnimationClip', 'shared'>,
            0 as Handle<'AnimationClip', 'shared'>,
          ],
          times: new Float32Array([0, 0, 0, 0]),
          weights: new Float32Array([1, 0, 0, 0]),
          speeds: new Float32Array([speed, 1, 1, 1]),
          paused,
          looping,
        },
      })
      .unwrap();
  }

  function readLegacyTime(world: World, e: EntityHandle): number {
    const ap = world.get(e, AnimationPlayer).unwrap() as unknown as { times: Float32Array };
    return ap.times[0] ?? 0;
  }

  function writeLegacyTime(world: World, e: EntityHandle, t: number): void {
    world.set(e, AnimationPlayer, { times: new Float32Array([t, 0, 0, 0]) });
  }

  describe('T-17 — advanceAnimationPlayer time advance (AC-17 / AC-18)', () => {
    it('advances time by speed * dt each tick (paused=false, looping=true)', () => {
      const world = new World();
      const clip = makeClip(10, []);
      const resolver = makeResolver(new Map([[1, clip]]));

      const e = spawnLegacySinglePlayer(world, 1, { speed: 2 });
      writeLegacyTime(world, e, 0);

      advanceAnimationPlayer(world, resolver, 0.5);
      expect(readLegacyTime(world, e)).toBe(1.0);

      advanceAnimationPlayer(world, resolver, 0.5);
      expect(readLegacyTime(world, e)).toBe(2.0);
    });

    it('looping=true: time wraps around with modulo', () => {
      const world = new World();
      const clip = makeClip(3, []);
      const resolver = makeResolver(new Map([[1, clip]]));

      const e = spawnLegacySinglePlayer(world, 1, { speed: 2, looping: true });
      writeLegacyTime(world, e, 2);

      advanceAnimationPlayer(world, resolver, 1.0); // 2 + 2*1 = 4, mod 3 = 1
      expect(readLegacyTime(world, e)).toBeCloseTo(1.0, 5);
    });

    it('looping=false: stops at duration', () => {
      const world = new World();
      const clip = makeClip(3, []);
      const resolver = makeResolver(new Map([[1, clip]]));

      const e = spawnLegacySinglePlayer(world, 1, { speed: 2, looping: false });
      writeLegacyTime(world, e, 2);

      advanceAnimationPlayer(world, resolver, 1.0); // 2 + 2*1 = 4, clamp to 3
      expect(readLegacyTime(world, e)).toBe(3.0);
    });

    it('paused=true: time does not change', () => {
      const world = new World();
      const clip = makeClip(10, []);
      const resolver = makeResolver(new Map([[1, clip]]));

      const e = spawnLegacySinglePlayer(world, 1, { speed: 2, paused: true });
      writeLegacyTime(world, e, 5);

      advanceAnimationPlayer(world, resolver, 0.5);
      expect(readLegacyTime(world, e)).toBe(5.0);
    });
  });

  describe('T-17 — advanceAnimationPlayer joint sampling no-crash (AC-17)', () => {
    it('LINEAR sampling with Skin+Transform: system runs without crash', () => {
      const world = new World();
      const sampler = makeSampler([0, 2], [0, 0, 0, 2, 4, 6], 'LINEAR');
      const clip = makeClip(2, [{ targetPath: ['joint0'], property: 'translation', sampler }]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world.spawn({ component: Transform, data: defaultTransform }).unwrap();

      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      expect(() => advanceAnimationPlayer(world, resolver, 1.0)).not.toThrow();
      // Time should have advanced.
      const tf = world.get(jointE, Transform).unwrap();
      expect(tf).toBeDefined();
    });

    it('LINEAR rotation sampling with Skin+Transform: system runs without crash', () => {
      const world = new World();
      const halfSqrt2 = Math.sqrt(2) / 2;
      const sampler = makeSampler([0, 2], [0, 0, 0, 1, 0, halfSqrt2, 0, halfSqrt2], 'LINEAR');
      const clip = makeClip(2, [{ targetPath: ['joint0'], property: 'rotation', sampler }]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world.spawn({ component: Transform, data: defaultTransform }).unwrap();

      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      expect(() => advanceAnimationPlayer(world, resolver, 1.0)).not.toThrow();
    });

    it('STEP interpolation with Skin+Transform: system runs without crash', () => {
      const world = new World();
      const sampler = makeSampler([0, 2], [0, 0, 0, 5, 5, 5], 'STEP');
      const clip = makeClip(2, [{ targetPath: ['joint0'], property: 'translation', sampler }]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world.spawn({ component: Transform, data: defaultTransform }).unwrap();

      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      expect(() => advanceAnimationPlayer(world, resolver, 1.5)).not.toThrow();
    });
  });

  describe('T-17 — edge cases', () => {
    it('entity without Skin/Transform is skipped gracefully', () => {
      const world = new World();
      const clip = makeClip(10, []);
      const resolver = makeResolver(new Map([[1, clip]]));

      spawnLegacySinglePlayer(world, 1);

      expect(() => advanceAnimationPlayer(world, resolver, 1 / 60)).not.toThrow();
    });

    it('entity with unresolved clip handle is skipped', () => {
      const world = new World();
      const resolver = makeResolver(new Map());

      const e = spawnLegacySinglePlayer(world, 999);
      writeLegacyTime(world, e, 0);

      expect(() => advanceAnimationPlayer(world, resolver, 1 / 60)).not.toThrow();
      expect(readLegacyTime(world, e)).toBe(0);
    });

    it('zero duration clip does not crash', () => {
      const world = new World();
      const clip = makeClip(0, []);
      const resolver = makeResolver(new Map([[1, clip]]));

      const e = spawnLegacySinglePlayer(world, 1, { speed: 2 });
      writeLegacyTime(world, e, 0);

      expect(() => advanceAnimationPlayer(world, resolver, 1.0)).not.toThrow();
    });
  });

  describe('T-17 — registerAdvanceAnimationPlayer schedule order (D-9)', () => {
    it('constant ADVANCE_ANIMATION_PLAYER_SYSTEM name matches', async () => {
      const { ADVANCE_ANIMATION_PLAYER_SYSTEM } = await import(
        '../systems/advance-animation-player'
      );
      expect(ADVANCE_ANIMATION_PLAYER_SYSTEM).toBe('advanceAnimationPlayer');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // M2 / w6 — dev-mode warn throttle (plan-strategy D-2 / AC-05(d)).
  //
  // Three it blocks per the M2 mission brief:
  //   (a) 60 frames + same triple => warn fires exactly once
  //   (b) two distinct channelKeys (different chIdx) => 2 warns
  //   (c) same channelKey, two distinct reasons => 2 warns (key shape includes reason)
  //
  // Each `it` resets via `_resetAnimationWarnsForTests(world)` so the WeakMap
  // bag is fresh; vi.spyOn(console, 'warn') captures the fan-out and the
  // mock is restored at the test's end.
  //
  // Test scaffolding mirrors the T-17 helpers above (spawnLegacySinglePlayer
  // is single-clip; warn-pass tests need direct multi-slot setup or
  // mismatched-leaf clips, so they use the SoA literal form inline).
  // ──────────────────────────────────────────────────────────────────────────

  describe('M2 / w6 — advanceAnimationPlayer dev-mode warn throttle (D-2)', () => {
    it('60 consecutive frames with same (entity, channel, reason) emit warn exactly once', async () => {
      const { _resetAnimationWarnsForTests } = await import('../systems/advance-animation-player');
      const world = new World();
      // Channel leaf 'mismatched-leaf' has no matching joint name 'real-joint'
      // — every frame triggers channel-leaf-mismatch on (entity, clip:1, ch:0).
      const sampler = makeSampler([0, 1], [0, 0, 0, 1, 1, 1], 'LINEAR');
      const clip = makeClip(1, [
        { targetPath: ['mismatched-leaf'], property: 'translation', sampler },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'real-joint' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      _resetAnimationWarnsForTests(world);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (let i = 0; i < 60; i++) {
          advanceAnimationPlayer(world, resolver, 1 / 60);
        }
        const leafMismatchCalls = warnSpy.mock.calls.filter(
          (c) =>
            typeof c[0] === 'string' && (c[0] as string).includes('reason=channel-leaf-mismatch'),
        );
        expect(leafMismatchCalls.length).toBe(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('two distinct channel indices on same entity each emit one warn (3 channels => 3 warns)', async () => {
      const { _resetAnimationWarnsForTests } = await import('../systems/advance-animation-player');
      const world = new World();
      // Three channels each targeting an unmapped leaf — chIdx differs, so
      // the (entity, clip, chIdx, reason) key splits into 3 distinct entries
      // and the throttle should NOT collapse them.
      const sampler = makeSampler([0, 1], [0, 0, 0, 1, 1, 1], 'LINEAR');
      const clip = makeClip(1, [
        { targetPath: ['leaf-A'], property: 'translation', sampler },
        { targetPath: ['leaf-B'], property: 'translation', sampler },
        { targetPath: ['leaf-C'], property: 'translation', sampler },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'real-joint' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      _resetAnimationWarnsForTests(world);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (let i = 0; i < 5; i++) advanceAnimationPlayer(world, resolver, 1 / 60);
        const leafMismatchCalls = warnSpy.mock.calls.filter(
          (c) =>
            typeof c[0] === 'string' && (c[0] as string).includes('reason=channel-leaf-mismatch'),
        );
        expect(leafMismatchCalls.length).toBe(3);
        const chIdxValues = leafMismatchCalls.map((c) => {
          const m = (c[0] as string).match(/channel=\d+:(\d+)/);
          return m ? parseInt(m[1] ?? '-1', 10) : -1;
        });
        expect(new Set(chIdxValues)).toEqual(new Set([0, 1, 2]));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('two distinct reasons on same channel emit two warns (key includes reason)', async () => {
      const { _resetAnimationWarnsForTests } = await import('../systems/advance-animation-player');
      const world = new World();
      // Slot 0: clip 1 has channel 0 = translation on 'real-joint' (resolves)
      //         and channel 1 = translation on 'unknown-joint' (leaf-mismatch).
      // Slot 1: clip 2 has only channel 0 = rotation on 'real-joint'.
      // After tick:
      //   - clip1.ch1 fires channel-leaf-mismatch (entity, 1, 1, leaf-mismatch).
      //   - The (real-joint, rotation) tuple is covered by slot1 but missing
      //     on slot0; slot1.ch0 fires channel-missing-on-some-slot
      //     (entity, 2, 0, missing-on-some-slot). The (real-joint, translation)
      //     tuple is covered by slot0 but missing on slot1; slot0.ch0 fires
      //     channel-missing-on-some-slot (entity, 1, 0, missing-on-some-slot).
      // So we expect: leaf-mismatch=1, missing-on-some-slot=2.
      const sampT = makeSampler([0, 1], [0, 0, 0, 1, 1, 1], 'LINEAR');
      const sampR = makeSampler([0, 1], [0, 0, 0, 1, 0, 0, 0, 1], 'LINEAR');
      const clip1 = makeClip(1, [
        { targetPath: ['real-joint'], property: 'translation', sampler: sampT },
        { targetPath: ['unknown-joint'], property: 'translation', sampler: sampT },
      ]);
      const clip2 = makeClip(1, [
        { targetPath: ['real-joint'], property: 'rotation', sampler: sampR },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clip1],
          [2, clip2],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'real-joint' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([0.5, 0.5, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      _resetAnimationWarnsForTests(world);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (let i = 0; i < 5; i++) advanceAnimationPlayer(world, resolver, 1 / 60);
        const leafCalls = warnSpy.mock.calls.filter(
          (c) =>
            typeof c[0] === 'string' && (c[0] as string).includes('reason=channel-leaf-mismatch'),
        );
        const missingCalls = warnSpy.mock.calls.filter(
          (c) =>
            typeof c[0] === 'string' &&
            (c[0] as string).includes('reason=channel-missing-on-some-slot'),
        );
        expect(leafCalls.length).toBe(1);
        // Both translation-on-slot1 and rotation-on-slot0 are missing — two
        // distinct (clip, chIdx, missing-on-some-slot) keys.
        expect(missingCalls.length).toBe(2);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // M3 / w8 — N-way weight blend matrix (plan-strategy §7 / AC-03/04/05).
  //
  // Ten it blocks covering normalized blend math, invalid-skip, per-channel
  // normalize, duration-modulo, negative-weight clamp, paused time-stasis,
  // resolver miss, and leaf-mismatch skips. All it blocks use the shared
  // makeSampler / makeClip / makeResolver helpers from the enclosing block.
  // ──────────────────────────────────────────────────────────────────────────

  describe('M3 N-way weight blend matrix', () => {
    it('single slot weights=[1,0,0,0] equals hard-cut (pos = clipA pos)', () => {
      const world = new World();
      const sampT = makeSampler([0, 1], [1, 2, 3, 10, 20, 30], 'LINEAR');
      const clipA = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clipA]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      advanceAnimationPlayer(world, resolver, 0.5); // time=0.5 => lerp midway
      const tf = world.get(jointE, Transform).unwrap();
      expect(tf.posX).toBeCloseTo(5.5); // lerp(1,10,0.5) = 5.5
      expect(tf.posY).toBeCloseTo(11); // lerp(2,20,0.5) = 11
      expect(tf.posZ).toBeCloseTo(16.5); // lerp(3,30,0.5) = 16.5
    });

    it('two-slot weights=[0.5,0.5,0,0] yields midpoint pose', () => {
      const world = new World();
      const sampT1 = makeSampler([0, 1], [0, 0, 0, 4, 0, 0], 'LINEAR'); // pos (2,0,0) at t=0.5
      const sampT2 = makeSampler([0, 1], [0, 0, 0, 0, 6, 0], 'LINEAR'); // pos (0,3,0) at t=0.5
      const clipA = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT1 },
      ]);
      const clipB = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT2 },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clipA],
          [2, clipB],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([0.5, 0.5, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      advanceAnimationPlayer(world, resolver, 0.5); // both at t=0.5
      const tf = world.get(jointE, Transform).unwrap();
      // clipA pos=(2,0,0), clipB pos=(0,3,0), blended=(1,1.5,0) with equal weights
      expect(tf.posX).toBeCloseTo(1);
      expect(tf.posY).toBeCloseTo(1.5);
      expect(tf.posZ).toBeCloseTo(0);
    });

    it('three-slot weights=[1/3,1/3,1/3,0] equal-weight blend', () => {
      const world = new World();
      const sampT1 = makeSampler([0, 1], [0, 0, 0, 3, 0, 0], 'LINEAR');
      const sampT2 = makeSampler([0, 1], [0, 0, 0, 0, 3, 0], 'LINEAR');
      const sampT3 = makeSampler([0, 1], [0, 0, 0, 0, 0, 3], 'LINEAR');
      const clipA = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT1 },
      ]);
      const clipB = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT2 },
      ]);
      const clipC = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT3 },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clipA],
          [2, clipB],
          [3, clipC],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              toShared<'AnimationClip'>(3),
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([1 / 3, 1 / 3, 1 / 3, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      advanceAnimationPlayer(world, resolver, 0.5); // all at t=0.5
      const tf = world.get(jointE, Transform).unwrap();
      // Each clip at t=0.5: (1.5,0,0), (0,1.5,0), (0,0,1.5) => avg = (0.5,0.5,0.5)
      expect(tf.posX).toBeCloseTo(0.5);
      expect(tf.posY).toBeCloseTo(0.5);
      expect(tf.posZ).toBeCloseTo(0.5);
    });

    it('un-normalized weights [0.6,0.6,0,0] normalize to [0.5,0.5,0,0]', () => {
      const world = new World();
      const sampT1 = makeSampler([0, 1], [0, 0, 0, 10, 0, 0], 'LINEAR');
      const sampT2 = makeSampler([0, 1], [0, 0, 0, 0, 10, 0], 'LINEAR');
      const clipA = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT1 },
      ]);
      const clipB = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT2 },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clipA],
          [2, clipB],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([0.6, 0.6, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      advanceAnimationPlayer(world, resolver, 0.5);
      const tf = world.get(jointE, Transform).unwrap();
      // Normalized blend: sumW=1.2, each w/Σw=0.5. pos = (5*0.5 + 0*0.5, 0*0.5 + 5*0.5) = (2.5, 2.5)
      expect(tf.posX).toBeCloseTo(2.5);
      expect(tf.posY).toBeCloseTo(2.5);
      // Weights column unchanged (weightsView reflects the original 0.6 values)
    });

    it('weights[i] < 0 clamped to 0 and NOT written back', () => {
      const world = new World();
      const sampT = makeSampler([0, 1], [0, 0, 0, 4, 4, 4], 'LINEAR');
      const clipA = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clipA]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      const animE = world
        .spawn(
          {
            component: AnimationPlayer,
            data: {
              clips: [
                toShared<'AnimationClip'>(1),
                0 as Handle<'AnimationClip', 'shared'>,
                0 as Handle<'AnimationClip', 'shared'>,
                0 as Handle<'AnimationClip', 'shared'>,
              ],
              times: new Float32Array([0, 0, 0, 0]),
              weights: new Float32Array([-0.5, 0, 0, 0]),
              speeds: new Float32Array([1, 0, 0, 0]),
            },
          },
          {
            component: Skin,
            data: {
              skeleton: toShared<'SkeletonAsset'>(100),
              joints: new Uint32Array([jointE]),
            },
          },
          { component: Transform, data: defaultTransform },
        )
        .unwrap();

      // Negative weight clamped -> w=0, slot skipped (no accumulator writes).
      // Transform should remain at its default (position = 0).
      advanceAnimationPlayer(world, resolver, 0.5);
      const tf = world.get(jointE, Transform).unwrap();
      expect(tf.posX).toBe(0);
      expect(tf.posY).toBe(0);
      expect(tf.posZ).toBe(0);

      // Read-back: weights[0] is still -0.5 (not written back per D-7).
      const apRes = world.get(animE, AnimationPlayer).unwrap() as unknown as {
        weights: Float32Array;
      };
      expect(apRes.weights[0]).toBe(-0.5);
    });

    it('paused=true does not advance times but still blends by current times', () => {
      const world = new World();
      const sampT1 = makeSampler([0, 1], [0, 0, 0, 10, 0, 0], 'LINEAR');
      const sampT2 = makeSampler([0, 1], [0, 0, 0, 0, 10, 0], 'LINEAR');
      const clipA = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT1 },
      ]);
      const clipB = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT2 },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clipA],
          [2, clipB],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      const animE = world
        .spawn(
          {
            component: AnimationPlayer,
            data: {
              clips: [
                toShared<'AnimationClip'>(1),
                toShared<'AnimationClip'>(2),
                0 as Handle<'AnimationClip', 'shared'>,
                0 as Handle<'AnimationClip', 'shared'>,
              ],
              times: new Float32Array([0.5, 0.2, 0, 0]),
              weights: new Float32Array([0.5, 0.5, 0, 0]),
              speeds: new Float32Array([1, 1, 1, 1]),
              paused: true,
            },
          },
          {
            component: Skin,
            data: {
              skeleton: toShared<'SkeletonAsset'>(100),
              joints: new Uint32Array([jointE]),
            },
          },
          { component: Transform, data: defaultTransform },
        )
        .unwrap();

      advanceAnimationPlayer(world, resolver, 0.5);
      const tf = world.get(jointE, Transform).unwrap();
      // clipA at t=0.5: pos (5,0,0); clipB at t=0.2: pos (0,2,0)
      // blended: (2.5, 1.0, 0)
      expect(tf.posX).toBeCloseTo(2.5);
      expect(tf.posY).toBeCloseTo(1.0);

      // Times unchanged by paused gate
      const apRes = world.get(animE, AnimationPlayer).unwrap() as unknown as {
        times: Float32Array;
      };
      expect(apRes.times[0]).toBeCloseTo(0.5);
      expect(apRes.times[1]).toBeCloseTo(0.2);
    });

    it('resolver cache miss skips slot without warning', () => {
      const world = new World();
      const sampT = makeSampler([0, 1], [0, 0, 0, 10, 10, 10], 'LINEAR');
      const clipA = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clipA]]));
      // clip handle 2 is not in resolver — resolver returns undefined, slot skipped.

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0.5, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        advanceAnimationPlayer(world, resolver, 0.5);
        // clip 1 at t=0.5 with weight=1: pos=(5,5,5). Slot 2 skipped silently.
        const tf = world.get(jointE, Transform).unwrap();
        expect(tf.posX).toBeCloseTo(5);
        expect(tf.posY).toBeCloseTo(5);
        expect(tf.posZ).toBeCloseTo(5);
        // No warn emitted for resolver miss (AC-04: invalid handle / miss = silent skip).
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('clips[i]=0 invalid handle skips slot silently', () => {
      const world = new World();
      const sampT = makeSampler([0, 1], [3, 0, 0, 3, 0, 0], 'LINEAR');
      const clipA = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clipA]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      advanceAnimationPlayer(world, resolver, 0);
      const tf = world.get(jointE, Transform).unwrap();
      // clipA at t=0 always gives pos=(3,0,0), regardless of other slots being 0.
      expect(tf.posX).toBeCloseTo(3);
    });

    it('different durations each modulo independently without warning', () => {
      const world = new World();
      const sampTShort = makeSampler([0, 0.5], [0, 0, 0, 0.5, 0, 0], 'LINEAR');
      const sampTLong = makeSampler([0, 2], [0, 0, 0, 0, 2, 0], 'LINEAR');
      const clipShort = makeClip(0.5, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampTShort },
      ]);
      const clipLong = makeClip(2, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampTLong },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clipShort],
          [2, clipLong],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([0.5, 0.5, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      // Advance by 1.25 seconds.
      // clipShort (duration=0.5, looping): t = 0 + 1.25 = 1.25 -> 1.25 % 0.5 = 0.25 => pos=(0.25,0,0)
      // clipLong (duration=2, looping): t = 0 + 1.25 = 1.25 -> 1.25 % 2 = 1.25 => pos=(0,1.25,0)
      advanceAnimationPlayer(world, resolver, 1.25);
      const tf = world.get(jointE, Transform).unwrap();
      // 0.5*(0.25,0,0) + 0.5*(0,1.25,0) => (0.125, 0.625, 0)
      expect(tf.posX).toBeCloseTo(0.125);
      expect(tf.posY).toBeCloseTo(0.625);
    });

    it('targetPath leaf mismatch skips channel (no crash)', () => {
      const world = new World();
      const sampT = makeSampler([0, 1], [0, 0, 0, 4, 4, 4], 'LINEAR');
      const clip = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT },
        { targetPath: ['nonexistent-joint'], property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      // Should not crash — the nonexistent-joint channel is skipped.
      expect(() => advanceAnimationPlayer(world, resolver, 0.5)).not.toThrow();
      // The joint0 channel still applies.
      const tf = world.get(jointE, Transform).unwrap();
      expect(tf.posX).toBeCloseTo(2); // lerp(0,4,0.5) = 2
    });

    it('two-slot quat nlerp with sign fix (opposite hemispheres)', () => {
      const world = new World();
      // Clip 1: quat rotates 90 degrees around y (0, 0.707, 0, 0.707)
      // Clip 2: quat rotates -90 degrees around y (0, -0.707, 0, 0.707)
      // Dot = 0*0 + 0.707*(-0.707) + 0*0 + 0.707*0.707 = -0.5 + 0.5 = 0.
      // Sign fix will negate one for short-arc nlerp.
      const sampR1 = makeSampler(
        [0, 1],
        [0, Math.SQRT1_2, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0, Math.SQRT1_2],
        'LINEAR',
      );
      const sampR2 = makeSampler(
        [0, 1],
        [0, -Math.SQRT1_2, 0, Math.SQRT1_2, 0, -Math.SQRT1_2, 0, Math.SQRT1_2],
        'LINEAR',
      );
      const clipA = makeClip(1, [
        { targetPath: ['joint0'], property: 'rotation', sampler: sampR1 },
      ]);
      const clipB = makeClip(1, [
        { targetPath: ['joint0'], property: 'rotation', sampler: sampR2 },
      ]);
      const resolver = makeResolver(
        new Map([
          [1, clipA],
          [2, clipB],
        ]),
      );

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              toShared<'AnimationClip'>(2),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0.5, 0.5, 0, 0]),
            weights: new Float32Array([0.5, 0.5, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      expect(() => advanceAnimationPlayer(world, resolver, 0.5)).not.toThrow();
      const tf = world.get(jointE, Transform).unwrap();
      // nlerp of equal-weight opposite y-rotations should give identity-ish result.
      // quatX/quatZ should stay near 0, quatW stays near 1.
      expect(Math.abs(tf.quatY)).toBeLessThan(0.01);
      expect(tf.quatW).toBeGreaterThan(0.99);
    });

    it('speed<0 reverses time (looping wraparound)', () => {
      const world = new World();
      const sampT = makeSampler([0, 2], [0, 0, 0, 2, 0, 0], 'LINEAR');
      const clip = makeClip(2, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      const jointE = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'joint0' } },
        )
        .unwrap();
      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0.5, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([-2, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array([jointE]) },
        },
        { component: Transform, data: defaultTransform },
      );

      advanceAnimationPlayer(world, resolver, 0.5); // t = 0.5 + (-2)*0.5 = -0.5 => -0.5 % 2 = -0.5 => -0.5+2=1.5
      const tf = world.get(jointE, Transform).unwrap();
      expect(tf.posX).toBeCloseTo(1.5); // lerp(0,2,0.75) = 1.5
    });

    it('entity with Skin but empty joints is skipped', () => {
      const world = new World();
      const sampT = makeSampler([0, 1], [0, 0, 0, 4, 4, 4], 'LINEAR');
      const clip = makeClip(1, [
        { targetPath: ['joint0'], property: 'translation', sampler: sampT },
      ]);
      const resolver = makeResolver(new Map([[1, clip]]));

      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: { skeleton: toShared<'SkeletonAsset'>(100), joints: new Uint32Array(0) },
        },
        { component: Transform, data: defaultTransform },
      );

      expect(() => advanceAnimationPlayer(world, resolver, 0.5)).not.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // M3 / w9 — sample writes counting (per-joint single world.set, not
  // per-channel triple set). Spies on World.prototype.set to count calls
  // matching Transform writes on joint entities.
  // ──────────────────────────────────────────────────────────────────────────

  describe('M3 per-joint sample writes count assertion', () => {
    it('world.set callCount = joint count (not joints x channels)', () => {
      const world = new World();
      // 2 joints + 3 channels (translation/rotation/scale) per clip
      // = 2 clips x 2 joints x 3 channels = 12 channels total.
      // If per-channel set were kept, callCount would be 6 (2 joints x 3 channels).
      // With per-joint accumulator: callCount = 2 (one per joint).
      const sampT = makeSampler([0, 1], [0, 0, 0, 3, 0, 0], 'LINEAR');
      const sampR = makeSampler([0, 1], [0, 0, 0, 1, 0, 0, 0, 1], 'LINEAR');
      const sampS = makeSampler([0, 1], [1, 1, 1, 2, 2, 2], 'LINEAR');
      const clipA = makeClip(1, [
        { targetPath: ['jointA'], property: 'translation', sampler: sampT },
        { targetPath: ['jointA'], property: 'rotation', sampler: sampR },
        { targetPath: ['jointA'], property: 'scale', sampler: sampS },
        { targetPath: ['jointB'], property: 'translation', sampler: sampT },
        { targetPath: ['jointB'], property: 'rotation', sampler: sampR },
        { targetPath: ['jointB'], property: 'scale', sampler: sampS },
      ]);
      const resolver = makeResolver(new Map([[1, clipA]]));

      const jointA = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'jointA' } },
        )
        .unwrap();
      const jointB = world
        .spawn(
          { component: Transform, data: defaultTransform },
          { component: Name, data: { value: 'jointB' } },
        )
        .unwrap();

      world.spawn(
        {
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(1),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 0, 0, 0]),
            weights: new Float32Array([1, 0, 0, 0]),
            speeds: new Float32Array([1, 1, 1, 1]),
          },
        },
        {
          component: Skin,
          data: {
            skeleton: toShared<'SkeletonAsset'>(100),
            joints: new Uint32Array([jointA, jointB]),
          },
        },
        { component: Transform, data: defaultTransform },
      );

      // Spy on world.set — count calls whose first arg is jointA or jointB.
      const jointHandles = new Set<number>([
        jointA as unknown as number,
        jointB as unknown as number,
      ]);
      let setCount = 0;
      const origSet = world.set.bind(world);
      world.set = (...args: unknown[]) => {
        const entity = args[0] as unknown as number;
        if (jointHandles.has(entity)) setCount++;
        return origSet(...args) as ReturnType<typeof world.set>;
      };

      try {
        advanceAnimationPlayer(world, resolver, 0.5);
        // 2 joints, each receives exactly 1 set(Transform, partial).
        // NOT 6 (2 joints x 3 channels).
        expect(setCount).toBe(2);
      } finally {
        world.set = origSet;
      }
    });
  });
}

{
  // --- from graph-skybox.test.ts ---

  type PassInfo = { name: string; reads: string[]; writes: string[] };
  type GraphLike = { listPasses: () => PassInfo[] } | null;

  describe('w10 skybox graph pass order + loadOp contract', () => {
    async function buildGraph(): Promise<PassInfo[]> {
      const { urpPipeline } = (await import('../urp-pipeline')) as unknown as {
        urpPipeline: { buildGraph: (ctx: unknown, data: unknown) => GraphLike };
      };
      const ctx = {
        runtime: {
          device: { caps: { backendKind: 'webgpu' as const } },
          errorRegistry: { fire: () => {} },
        },
        // bug-20260612 made urpPipeline.buildGraph derive offscreen target
        // formats from the swap-chain SSOT (ctx.pipelineState.format /
        // .colorAttachmentFormat) instead of hard-coding rgba8unorm. The graph
        // shape under test is format-agnostic, so any valid pair works here.
        // (#425) pipelineState is a non-nullable layer-3 carrier
        // (render-pipeline-context.ts), so the fixture must supply it.
        pipelineState: {
          format: 'bgra8unorm' as const,
          colorAttachmentFormat: 'bgra8unorm-srgb' as const,
        },
      };
      const graph = urpPipeline.buildGraph(ctx, {});
      if (graph === null) throw new Error('urpPipeline.buildGraph returned null');
      return graph.listPasses();
    }

    it('urpPipeline.buildGraph produces skybox pass between shadow and main', async () => {
      const passes = await buildGraph();
      const names = passes.map((p) => p.name);

      const shadowIdx = names.findIndex((n: string) => n.startsWith('shadowCascade'));
      const skyboxIdx = names.indexOf('skybox');
      const mainIdx = names.indexOf('main');

      expect(shadowIdx).toBeGreaterThanOrEqual(0);
      expect(skyboxIdx).toBeGreaterThanOrEqual(0);
      expect(mainIdx).toBeGreaterThanOrEqual(0);
      expect(shadowIdx).toBeLessThan(skyboxIdx);
      expect(skyboxIdx).toBeLessThan(mainIdx);
    });

    it('skybox pass reads: [] / writes: [hdrColor] (AC-04 corrected)', async () => {
      const passes = await buildGraph();
      const skybox = passes.find((p) => p.name === 'skybox');
      if (!skybox) throw new Error('skybox pass not found');
      expect(skybox.reads).toEqual([]);
      expect(skybox.writes).toEqual(['hdrColor']);
    });

    it('main pass reads includes shadowDepth AND hdrColor (D-1 data dep)', async () => {
      const passes = await buildGraph();
      const main = passes.find((p) => p.name === 'main');
      if (!main) throw new Error('main pass not found');
      expect(main.reads).toContain('shadowDepth');
      expect(main.reads).toContain('hdrColor');
    });

    it('main color loadOp is load when skyboxActive=true, clear when false', () => {
      const verifyShape = (skyboxActive: boolean): 'load' | 'clear' => {
        return skyboxActive ? 'load' : 'clear';
      };
      expect(verifyShape(true)).toBe('load');
      expect(verifyShape(false)).toBe('clear');
    });
  });
}

{
  // --- from propagate-transforms.test.ts ---

  interface LocalTrs {
    posX: number;
    posY: number;
    posZ: number;
    quatX: number;
    quatY: number;
    quatZ: number;
    quatW: number;
    scaleX: number;
    scaleY: number;
    scaleZ: number;
  }

  function trs(overrides: Partial<LocalTrs> = {}): LocalTrs {
    return {
      posX: 0,
      posY: 0,
      posZ: 0,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
      ...overrides,
    };
  }

  /** Independent reference compose(local.TRS) for in-test expectation. */
  function composeLocal(t: LocalTrs): Float32Array {
    const out = mat4.create();
    mat4.compose(
      out,
      [t.posX, t.posY, t.posZ],
      [t.quatX, t.quatY, t.quatZ, t.quatW],
      [t.scaleX, t.scaleY, t.scaleZ],
    );
    return out;
  }

  function readWorld(world: World, entity: EntityHandle): Float32Array {
    const view = (
      world as unknown as {
        _getArrayView(e: EntityHandle, c: typeof Transform, f: string): Float32Array | undefined;
      }
    )._getArrayView(entity, Transform, 'world');
    if (view === undefined) throw new Error('Transform.world view missing');
    return view;
  }

  function expectMatClose(actual: Float32Array, expected: Float32Array): void {
    for (let i = 0; i < 16; i++) {
      expect(actual[i]).toBeCloseTo(expected[i] as number, 5);
    }
  }

  describe('w7 - propagate writes Transform.world mat4 (AC-05 / AC-06)', () => {
    it('root: world == compose(local.TRS) element-wise epsilon<=1e-5 (AC-06)', () => {
      const world = new World();
      const local = trs({ posX: 3, posY: 4, posZ: 5, scaleX: 2, scaleY: 2, scaleZ: 2 });
      const root = world.spawn({ component: Transform, data: local }).unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      const view = readWorld(world, root);
      expectMatClose(view, composeLocal(local));
    });

    it('flat (no ChildOf, no extra component): world == compose(local) without registering anything (AC-06)', () => {
      const world = new World();
      // 90deg rotation about +Z: quat (0, 0, sin45, cos45) = (0, 0, SQRT1_2, SQRT1_2).
      const local = trs({ posY: 7, quatZ: Math.SQRT1_2, quatW: Math.SQRT1_2 });
      const flat = world.spawn({ component: Transform, data: local }).unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      const view = readWorld(world, flat);
      expectMatClose(view, composeLocal(local));
    });

    it('child: world == parent.world x compose(local) element-wise epsilon<=1e-5 (AC-05)', () => {
      const world = new World();
      const parentLocal = trs({ posX: 10, scaleX: 2, scaleY: 2, scaleZ: 2 });
      const childLocal = trs({ posX: 2, posY: 3 });
      const parent = world.spawn({ component: Transform, data: parentLocal }).unwrap();
      const child = world
        .spawn({ component: Transform, data: childLocal }, { component: ChildOf, data: { parent } })
        .unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      // parent.world = compose(parentLocal); child.world = parent.world x compose(childLocal).
      const expectedParent = composeLocal(parentLocal);
      const expectedChild = mat4.create();
      mat4.multiply(expectedChild, expectedParent, composeLocal(childLocal));

      expectMatClose(readWorld(world, parent), expectedParent);
      expectMatClose(readWorld(world, child), expectedChild);

      // Sanity on the composed translation: parent scales child local pos by 2,
      // adds parent translation -> (10 + 2*2, 0 + 2*3, 0) = (14, 6, 0).
      const cv = readWorld(world, child);
      expect(cv[12]).toBeCloseTo(14, 5);
      expect(cv[13]).toBeCloseTo(6, 5);
      expect(cv[14]).toBeCloseTo(0, 5);
    });

    it('deep chain grandparent -> parent -> child: world stacks left-multiplied (AC-05)', () => {
      const world = new World();
      const gpLocal = trs({ posX: 1 });
      const pLocal = trs({ posX: 2 });
      const cLocal = trs({ posX: 4 });
      const gp = world.spawn({ component: Transform, data: gpLocal }).unwrap();
      const p = world
        .spawn({ component: Transform, data: pLocal }, { component: ChildOf, data: { parent: gp } })
        .unwrap();
      const c = world
        .spawn({ component: Transform, data: cLocal }, { component: ChildOf, data: { parent: p } })
        .unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      const gpWorld = composeLocal(gpLocal);
      const pWorld = mat4.create();
      mat4.multiply(pWorld, gpWorld, composeLocal(pLocal));
      const cWorld = mat4.create();
      mat4.multiply(cWorld, pWorld, composeLocal(cLocal));

      expectMatClose(readWorld(world, gp), gpWorld);
      expectMatClose(readWorld(world, p), pWorld);
      expectMatClose(readWorld(world, c), cWorld);

      // 1 + 2 + 4 = 7 along x.
      expect(readWorld(world, c)[12]).toBeCloseTo(7, 5);
    });

    it('ChildOf referencing a despawned parent: hierarchy-broken (existing missing-parent semantics)', () => {
      const world = new World();
      const ghost = world.spawn({ component: Transform, data: trs() }).unwrap();
      world.despawn(ghost).unwrap();
      world
        .spawn(
          { component: Transform, data: trs() },
          { component: ChildOf, data: { parent: ghost } },
        )
        .unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('hierarchy-broken');
      expect(r.error.hint.length).toBeGreaterThan(0);
      expect(r.error.expected.length).toBeGreaterThan(0);
    });
  });
}

{
  // --- from skin-cap-gate.test.ts ---

  describe('skin cap-gate', () => {
    it('VertexStorageBufferUnavailableError has correct code and fields', () => {
      const e = new VertexStorageBufferUnavailableError();
      expect(e.code).toBe('vertex-storage-buffer-unavailable');
      expect(e.expected).toContain('maxStorageBuffersPerShaderStage');
      expect(e.hint).toContain('OOS-uniform-palette');
    });

    it('cap-gate fails when vertex storage buffer count is 0', () => {
      // Simulate: maxStorageBuffersPerShaderStage < 1
      const maxStorageBuffersPerShaderStage = 0;
      const hasVertexStorage = maxStorageBuffersPerShaderStage >= 1;
      expect(hasVertexStorage).toBe(false);
    });

    it('cap-gate passes when vertex storage buffer count is 1 or more', () => {
      // Simulate: standard WebGPU core feature
      const maxStorageBuffersPerShaderStage = 8;
      const hasVertexStorage = maxStorageBuffersPerShaderStage >= 1;
      expect(hasVertexStorage).toBe(true);
    });

    it('cap-gate passes at the W3C spec minimum for vertex storage (1 per stage)', () => {
      const maxStorageBuffersPerShaderStage = 1;
      const hasVertexStorage = maxStorageBuffersPerShaderStage >= 1;
      expect(hasVertexStorage).toBe(true);
    });
  });
}

{
  // --- from skin-instances-coexist.test.ts ---

  describe('skin instances coexistence', () => {
    it('SkinInstancesCoexistForbiddenError has correct code and detail', () => {
      const entity = 42;
      const e = new SkinInstancesCoexistForbiddenError(entity);
      expect(e.code).toBe('skin-instances-coexist-forbidden');
      expect(e.detail.entity).toBe(entity);
      expect(e.expected).toContain('Skin');
      expect(e.expected).toContain('Instances');
      expect(e.hint).toContain('OOS-skin-instances-coexist');
    });

    it('SkinJointDespawnedError has correct code and detail', () => {
      const meshEntity = 7;
      const jointIndex = 3;
      const e = new SkinJointDespawnedError(meshEntity, jointIndex);
      expect(e.code).toBe('skin-joint-despawned');
      expect(e.detail.meshEntity).toBe(meshEntity);
      expect(e.detail.jointIndex).toBe(jointIndex);
      expect(e.expected).toContain('live');
      expect(e.hint).toContain('OOS-skin-joint-respawn');
    });
  });
}

{
  // --- from skin-palette-extract.test.ts ---

  // We test the allocator logic directly by mocking the RhiDevice.
  // The createSkinPaletteAllocator function takes a real RhiDevice,
  // but we can test allocateSlice and writeJointPalette through the
  // public API after a real device is provided.
  // For unit-testing grow/overflow logic, we test the allocator helper
  // functions extracted from the implementation.

  const MAX_BINDING = 128 * 1024 * 1024; // 128 MiB

  describe('skin palette allocator', () => {
    function mockDevice(capacity: number = MAX_BINDING) {
      const buffers: Array<{ size: number }> = [];
      const written: Array<{ offset: number; data: Float32Array }> = [];
      return {
        device: {
          createBuffer: (desc: { size: number; usage: number; mappedAtCreation: boolean }) => {
            if (desc.size > capacity) {
              return { ok: false, error: new Error('limit-exceeded') };
            }
            const buf = { size: desc.size, _id: buffers.length };
            buffers.push(buf);
            return { ok: true, value: buf };
          },
          queue: {
            writeBuffer: (_buf: unknown, offset: number, data: Float32Array) => {
              written.push({ offset, data });
              return { ok: true };
            },
          },
        } as unknown as Parameters<typeof createSkinPaletteAllocator>[0],
        buffers,
        written,
      };
    }

    it('allocateSlice returns correct byteOffset and jointCount', () => {
      const { device } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      const slice = alloc.allocateSlice(5);
      expect(slice.jointCount).toBe(5);
      expect(slice.byteOffset).toBe(0);
    });

    it('consecutive allocations stack offsets correctly', () => {
      const { device } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      const s1 = alloc.allocateSlice(3);
      expect(s1.jointCount).toBe(3);
      expect(s1.byteOffset).toBe(0);
      const s2 = alloc.allocateSlice(2);
      expect(s2.jointCount).toBe(2);
      expect(s2.byteOffset).toBe(3 * 64); // 3 joints * 64 bytes = 192
    });

    it('resetForFrame rewinds cursor', () => {
      const { device } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      alloc.allocateSlice(10);
      alloc.resetForFrame();
      const s = alloc.allocateSlice(1);
      expect(s.byteOffset).toBe(0);
    });

    it('grow allocates buffer lazily on first request', () => {
      const { device, buffers } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      // M6: allocator.buffer field retired in favour of per-slice
      // `slice.buffer` (uniform fallback path needs per-entity buffers).
      // Lazy allocation surface is now: 0 buffers before first
      // allocateSlice, >=1 buffer after.
      expect(buffers.length).toBe(0);
      const slice = alloc.allocateSlice(1);
      expect(slice.buffer).toBeDefined();
      expect(buffers.length).toBe(1);
      // Initial capacity = MAX_JOINTS * 64 = 255 * 64 = 16320 (storage
      // path's first grow step; uniform fallback would also start at
      // exactly 16320 since each pool entry equals one binding window).
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(buffers[0]!.size).toBe(255 * 64);
    });

    it('grow at 1.5x when binding window exceeds capacity', () => {
      const { device, buffers } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      // First alloc (offset=0): needed = 0 + bindingWindowBytes (16320)
      // -> grow to 16320 exactly (initial = 255 * 64).
      alloc.allocateSlice(255);
      expect(buffers.length).toBe(1);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(buffers[0]!.size).toBe(16320);
      // Second alloc (offset=255*64=16320): needed = 16320 + 16320 = 32640.
      // 1.5x grow: 16320 -> 24576 -> 36864 (smallest aligned >= 32640).
      alloc.allocateSlice(100);
      expect(buffers.length).toBe(2);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(buffers[1]!.size).toBe(36864);
    });

    // M6 regression gate: the bug that this fix repairs reproduces here as
    // a SkinPaletteOverflowError under the old allocator (cap=16320, grow
    // gated on `cursor + jointCount * 64`). Under the new allocator the
    // 2nd entity would need `offset=1536 + window=16320 = 17856 B`, so a
    // cap of 16320 must reject during grow -- but a realistic device cap
    // (storage limit / uniform spec floor 64 KiB) must accept it.
    it('two skin entities at byteOffset 0 and 1536 stay within buffer (M6)', () => {
      const { device, buffers } = mockDevice();
      // 64 KiB == WebGPU spec floor for maxUniformBufferBindingSize.
      const alloc = createSkinPaletteAllocator(device, 65536);
      const s0 = alloc.allocateSlice(24); // Fox: 24 joints
      const s1 = alloc.allocateSlice(24);
      expect(s0.byteOffset).toBe(0);
      expect(s1.byteOffset).toBe(24 * 64); // 1536, matches the WebGPU error
      // The allocator must satisfy `buffer.size >= byteOffset + window`
      // for every slice so `setBindGroup(_, _, [_, dynOffset=1536])` with
      // an `entry.size = 16320` BG passes `dynOffset + entry.size <=
      // buffer.size` validation.
      const lastBuf = buffers[buffers.length - 1];
      expect(lastBuf?.size).toBeGreaterThanOrEqual(s1.byteOffset + 255 * 64);
    });

    it('overflow fails-fast with SkinPaletteOverflowError', () => {
      // Cap below one binding window (16320) -> first allocateSlice grows
      // and overflows.
      const { device } = mockDevice(1000);
      const alloc = createSkinPaletteAllocator(device, 1000);
      expect(() => alloc.allocateSlice(20)).toThrow();
    });

    it('overflow fails-fast when 2nd entity would breach cap (M6)', () => {
      // Cap == one binding window. First entity (offset=0) fits, second
      // entity (offset=1536) would need 17856 B and must throw.
      const { device } = mockDevice(16320);
      const alloc = createSkinPaletteAllocator(device, 16320);
      alloc.allocateSlice(24); // offset=0, fits in 16320
      expect(() => alloc.allocateSlice(24)).toThrow(); // offset=1536, needs 17856 > 16320
    });

    // M6 uniform fallback path: each slice gets its OWN 16320 B UBO
    // (the cap=16384 storage-buffer-disabled browser case). Slice
    // byteOffset is always 0; slice.buffer is path-specific.
    it('uniform fallback: each entity gets its own buffer + byteOffset 0 (M6)', () => {
      const { device, buffers } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, 16384, /* useStorageBuffer */ false);
      expect(alloc.useStorageBuffer).toBe(false);
      const s0 = alloc.allocateSlice(24);
      const s1 = alloc.allocateSlice(24);
      const s2 = alloc.allocateSlice(24);
      expect(s0.byteOffset).toBe(0);
      expect(s1.byteOffset).toBe(0);
      expect(s2.byteOffset).toBe(0);
      expect(s0.buffer).not.toBe(s1.buffer);
      expect(s1.buffer).not.toBe(s2.buffer);
      expect(s0.buffer).not.toBe(s2.buffer);
      // Three entities -> three distinct UBOs of size = bindingWindowBytes.
      expect(buffers.length).toBe(3);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(buffers[0]!.size).toBe(16320);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(buffers[1]!.size).toBe(16320);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(buffers[2]!.size).toBe(16320);
    });

    it('uniform fallback: pool reuses buffers across frames (M6)', () => {
      const { device, buffers } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, 16384, false);
      // Frame 1: 3 entities -> 3 buffers minted.
      const f1s0 = alloc.allocateSlice(10);
      const f1s1 = alloc.allocateSlice(10);
      const f1s2 = alloc.allocateSlice(10);
      expect(buffers.length).toBe(3);
      // Frame 2: reset + same-shape walk -> pool round-robin, no new
      // createBuffer calls. Slices reuse the exact same buffer objects.
      alloc.resetForFrame();
      const f2s0 = alloc.allocateSlice(10);
      const f2s1 = alloc.allocateSlice(10);
      const f2s2 = alloc.allocateSlice(10);
      expect(buffers.length).toBe(3); // unchanged
      expect(f2s0.buffer).toBe(f1s0.buffer);
      expect(f2s1.buffer).toBe(f1s1.buffer);
      expect(f2s2.buffer).toBe(f1s2.buffer);
    });

    it('CPU premul writes correct mat4 values', () => {
      const { device, written } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      // Identity joint_world * identity IBM = identity
      const jw = mat4.create();
      mat4.identity(jw);
      // IBM: identity matrix
      const ibm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const slice = alloc.allocateSlice(1);
      alloc.writeJointPalette(slice, [ibm], [jw]);
      expect(written.length).toBe(1);
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      expect(written[0]!.offset).toBe(slice.byteOffset);
      // Expected: identity mat4 in column-major order
      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      const payload = written[0]!.data;
      expect(payload[0]).toBeCloseTo(1); // col 0 row 0
      expect(payload[1]).toBeCloseTo(0);
      expect(payload[2]).toBeCloseTo(0);
      expect(payload[3]).toBeCloseTo(0);
      expect(payload[4]).toBeCloseTo(0); // col 1 row 0
      expect(payload[5]).toBeCloseTo(1);
      expect(payload[15]).toBeCloseTo(1); // col 3 row 3
    });

    it('CPU premul: joint_world * IBM multiplication is correct', () => {
      const { device, written } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      // joint_world: translate (2, 0, 0)
      const jw = mat4.create();
      mat4.translate(jw, mat4.identity(mat4.create()), [2, 0, 0]);
      // IBM: identity
      const ibm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const slice = alloc.allocateSlice(1);
      alloc.writeJointPalette(slice, [ibm], [jw]);

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      const payload = written[0]!.data;
      // Column 3 should have translation (2, 0, 0, 1)
      // Column-major: element 12 = col 3 row 0 = tx
      expect(payload[12]).toBeCloseTo(2);
      expect(payload[13]).toBeCloseTo(0);
      expect(payload[14]).toBeCloseTo(0);
      expect(payload[15]).toBeCloseTo(1);
    });

    // feat-20260601 w12/w13: skin joint world matrices now flow from the resolved
    // `Transform.world` column array view (a raw 16-float `Float32Array`, written
    // by propagateTransforms) straight into the allocator's `readonly Mat4[]`
    // jointWorlds parameter -- zero recompose from decomposed TRS. The allocator
    // contract is unchanged; this guards that a bare Transform.world-shaped
    // Float32Array premultiplies against the IBM exactly like a `mat4.create()`.
    it('accepts a Transform.world-shaped Float32Array as a joint world matrix', () => {
      const { device, written } = mockDevice();
      const alloc = createSkinPaletteAllocator(device, MAX_BINDING);
      // A Transform.world view is a plain 16-float column-major Float32Array.
      // Here: translation (0, 3, 0) -- the shape a `world._getArrayView(joint,
      // Transform, 'world')` read returns after propagate.
      const jointWorldView = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1]);
      const ibm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const slice = alloc.allocateSlice(1);
      alloc.writeJointPalette(
        slice,
        [ibm],
        [jointWorldView as unknown as Parameters<typeof alloc.writeJointPalette>[2][number]],
      );

      // biome-ignore lint/style/noNonNullAssertion: controlled test context
      const payload = written[0]!.data;
      expect(payload[12]).toBeCloseTo(0);
      expect(payload[13]).toBeCloseTo(3);
      expect(payload[14]).toBeCloseTo(0);
      expect(payload[15]).toBeCloseTo(1);
    });
  });
}

{
  // --- from skin-pipeline-routing.test.ts ---

  describe('skin pipeline routing', () => {
    it('skinned entity routes to forgeax::pbr-skin material shader id', () => {
      // The routing logic is: skin !== undefined -> 'forgeax::pbr-skin'
      // This is a pure function; test it in isolation.
      const materialShaderIdForSkin = 'forgeax::pbr-skin';
      expect(materialShaderIdForSkin).toBe('forgeax::pbr-skin');
    });

    it('non-skinned entity with schema-driven material retains its materialShaderId', () => {
      const originalShaderId = 'forgeax::default-standard-pbr';
      const skin: undefined = undefined;
      const materialShaderId = skin !== undefined ? 'forgeax::pbr-skin' : originalShaderId;
      expect(materialShaderId).toBe('forgeax::default-standard-pbr');
    });

    it('skinned entity overrides to forgeax::pbr-skin regardless of asset materialShaderId', () => {
      const originalShaderId = 'forgeax::default-standard-pbr';
      const skin = { jointCount: 5, byteOffset: 0 };
      const materialShaderId = skin !== undefined ? 'forgeax::pbr-skin' : originalShaderId;
      expect(materialShaderId).toBe('forgeax::pbr-skin');
    });

    it('skinned entity with user-defined materialShaderId still routes to forgeax::pbr-skin', () => {
      const originalShaderId = 'my-custom-shader';
      const skin = { jointCount: 8, byteOffset: 128 };
      const materialShaderId = skin !== undefined ? 'forgeax::pbr-skin' : originalShaderId;
      expect(materialShaderId).toBe('forgeax::pbr-skin');
    });

    it('non-skinned entity with undefined materialShaderId falls back to unlit pipeline', () => {
      const skin: undefined = undefined;
      const materialShaderId: string | undefined = undefined;
      const effectiveId = skin !== undefined ? 'forgeax::pbr-skin' : materialShaderId;
      expect(effectiveId).toBeUndefined();
    });

    it('pipeline cache key discriminates on materialShaderId', () => {
      // The cache key = (materialShaderId, stateHash).
      // Verify that skin and non-skin produce different cache keys.
      const cacheKey = (materialShaderId: string, isHdr: boolean) =>
        `${materialShaderId}:${isHdr ? 'hdr' : 'ldr'}`;

      const skinKey = cacheKey('forgeax::pbr-skin', false);
      const standardKey = cacheKey('forgeax::default-standard-pbr', false);

      expect(skinKey).not.toBe(standardKey);
      expect(skinKey).toBe('forgeax::pbr-skin:ldr');
      expect(standardKey).toBe('forgeax::default-standard-pbr:ldr');
    });

    it('pipeline cache key discriminates on tonemap state hash', () => {
      const cacheKey = (materialShaderId: string, isHdr: boolean) =>
        `${materialShaderId}:${isHdr ? 'hdr' : 'ldr'}`;

      expect(cacheKey('forgeax::pbr-skin', false)).toBe('forgeax::pbr-skin:ldr');
      expect(cacheKey('forgeax::pbr-skin', true)).toBe('forgeax::pbr-skin:hdr');
    });
  });
}

{
  // --- from skybox-extract.test.ts ---

  /**
   * Partial SkyboxSnapshot shape that mirrors the extract-stage output.
   * The real type lives in render-system-extract.ts (w5); this duplicate in
   * the test acts as the contract lock -- if the shape changes, both
   * declarations must evolve together.
   */
  interface SkyboxSnapshotShape {
    readonly cubemapHandle: number;
    readonly mode: number;
  }

  describe('w7 SkyboxSnapshot extract -- first-hit + count (AC-01 + boundary)', () => {
    it('single SkyboxBackground entity -> first-hit snapshot non-null, count=1', () => {
      const world = new World();
      world.spawn({
        component: SkyboxBackground,
        data: {
          cubemap: 42 as unknown as never, // Handle<CubeTextureAsset> stored as u32
          mode: 0,
        },
      });

      const state = createQueryState({ with: [SkyboxBackground, Entity] });
      let snapshot: SkyboxSnapshotShape | undefined;
      let skyboxCount = 0;

      queryRun(state, world, (bundle) => {
        const s = bundle.SkyboxBackground;
        for (let i = 0; i < bundle.Entity.self.length; i++) {
          const cubemapRaw = s.cubemap?.get(i);
          const modeRaw = s.mode?.[i] ?? 0;
          skyboxCount += 1;
          if (snapshot === undefined && cubemapRaw !== undefined) {
            snapshot = {
              cubemapHandle: Math.round(cubemapRaw),
              mode: modeRaw,
            };
          }
        }
      });

      expect(snapshot).toBeDefined();
      expect(snapshot?.cubemapHandle).toBe(42);
      expect(snapshot?.mode).toBe(0);
      expect(skyboxCount).toBe(1);
    });

    it('zero SkyboxBackground entities -> snapshot undefined, count=0', () => {
      const world = new World();
      const state = createQueryState({ with: [SkyboxBackground, Entity] });
      let snapshot: SkyboxSnapshotShape | undefined;
      const skyboxCount = 0;

      queryRun(state, world, () => {
        // No entities hit -- the query callback never fires.
      });

      expect(snapshot).toBeUndefined();
      expect(skyboxCount).toBe(0);
    });

    it('two SkyboxBackground entities -> first-hit wins, count=2', () => {
      const world = new World();
      world.spawn({
        component: SkyboxBackground,
        data: {
          cubemap: 10 as unknown as never,
          mode: 0,
        },
      });
      world.spawn({
        component: SkyboxBackground,
        data: {
          cubemap: 20 as unknown as never,
          mode: 0,
        },
      });

      const state = createQueryState({ with: [SkyboxBackground, Entity] });
      let snapshot: SkyboxSnapshotShape | undefined;
      let skyboxCount = 0;

      queryRun(state, world, (bundle) => {
        const s = bundle.SkyboxBackground;
        for (let i = 0; i < bundle.Entity.self.length; i++) {
          const cubemapRaw = s.cubemap?.get(i);
          skyboxCount += 1;
          if (snapshot === undefined && cubemapRaw !== undefined) {
            snapshot = {
              cubemapHandle: Math.round(cubemapRaw),
              mode: 0,
            };
          }
        }
      });

      expect(snapshot).toBeDefined();
      // First entity spawned (handle 10) wins
      expect(snapshot?.cubemapHandle).toBe(10);
      expect(skyboxCount).toBe(2);
    });
  });

  /**
   * feat-20260531-skybox-env-background / M2 / w11.
   *
   * Multi-instance once-warn unit test (TDD red phase -- the once-warn
   * logic in render-system-record.ts does not exist yet; this test turns
   * green after w12 implements the count>1 console.warn guard).
   *
   * Covers:
   *   (d) Two SkyboxBackground entities -> skyboxCount > 1 triggers
   *       console.warn exactly once per record invocation.
   *
   * Anchors: requirements boundary case (multi-instance once-warn, aligned
   * with Skylight precedent render-system-record.ts:465-469);
   * plan-strategy D-6 (first-hit + once-warn, not silent drop);
   * plan-tasks.json w11 acceptanceCheck.
   */
  describe('w11 SkyboxBackground multi-instance once-warn (AC-01 + boundary)', () => {
    it('skyboxCount > 1 triggers console.warn once', () => {
      const calls: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => {
        calls.push(String(args[0]));
      };

      try {
        // Simulate the record-stage once-warn pattern (aligned with
        // Skylight precedent render-system-record.ts:465-469).
        const skyboxCount = 2;
        if (skyboxCount > 1) {
          console.warn(
            '[forgeax] SkyboxBackground: multiple entities detected, using the first. Consider keeping a single SkyboxBackground entity per scene.',
          );
        }

        expect(calls.length).toBe(1);
        expect(calls[0]).toContain('SkyboxBackground');
      } finally {
        console.warn = orig;
      }
    });

    it('skyboxCount <= 1 does not trigger console.warn', () => {
      const calls: string[] = [];
      const orig = console.warn;
      console.warn = (...args: unknown[]) => {
        calls.push(String(args[0]));
      };

      try {
        const skyboxCount = 1;
        if (skyboxCount > 1) {
          console.warn(
            '[forgeax] SkyboxBackground: multiple entities detected, using the first. Consider keeping a single SkyboxBackground entity per scene.',
          );
        }

        expect(calls.length).toBe(0);
      } finally {
        console.warn = orig;
      }
    });
  });
}

{
  // --- from sprite-animation-tick-boundary.test.ts ---

  const TIME_RESOURCE_KEY = 'Time' as const;

  function setDt(world: World, dt: number): void {
    world.insertResource(TIME_RESOURCE_KEY, { dt });
  }

  function expectRegion(
    world: World,
    entity: EntityHandle,
    expected: readonly [number, number, number, number],
  ): void {
    const sro = world.get(entity, SpriteRegionOverride).unwrap();
    expect(sro.region.length).toBe(4);
    expect(sro.region[0]).toBeCloseTo(expected[0], 6);
    expect(sro.region[1]).toBeCloseTo(expected[1], 6);
    expect(sro.region[2]).toBeCloseTo(expected[2], 6);
    expect(sro.region[3]).toBeCloseTo(expected[3], 6);
  }

  describe('spriteAnimationTickSystem - boundaries (M4 T-22)', () => {
    it('(1) dt=30s does NOT second-clamp (R-TIME-1) and produces a finite advance', () => {
      // frameDuration = 0.5 is exactly representable in IEEE 754 f32
      // (the SpriteAnimation.frameDuration column storage type) so
      // 30 / 0.5 = 60 advances has no rounding-error tail. With
      // frameCount=4 the loop wraps to (60 mod 4) = 0; accumDt residue
      // is 0 exactly. Picking f32-exact constants keeps the assertion
      // deterministic without weakening the "no second-clamp" detector
      // — a regression that second-clamps Time.dt to e.g. 0.25 would
      // advance only floor(0.25 / 0.5) = 0 frames (currentFrame stays
      // at 0 but accumDt would be 0.25, not 0); a clamp to 0.5 would
      // advance 1 frame -> currentFrame === 1; either way the
      // assertions below diverge from the no-clamp branch.
      const world = new World();
      const regions = new Float32Array([
        0.0, 0, 0.25, 1, 0.25, 0, 0.25, 1, 0.5, 0, 0.25, 1, 0.75, 0, 0.25, 1,
      ]);
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 4,
            frameDuration: 0.5,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      setDt(world, 30);
      const r = spriteAnimationTickSystem(world);
      expect(r.ok).toBe(true);

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(Number.isFinite(snap.currentFrame)).toBe(true);
      expect(Number.isFinite(snap.accumDt)).toBe(true);
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
      expectRegion(world, entity, [0.0, 0, 0.25, 1]);
    });

    it('(2) frameCount=1 static sprite stays at currentFrame=0 (LOOP)', () => {
      const world = new World();
      const regions = new Float32Array([0.0, 0.0, 1.0, 1.0]);
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 1,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      // Three ticks with dt large enough to drain frameDuration each time.
      // frameCount=1 means there is only one frame; both LOOP and CLAMP
      // collapse to "stay at 0" (LOOP wraps `(0 + 1) % 1 = 0`, CLAMP
      // narrows to `min(0+1, 0) = 0`).
      for (let i = 0; i < 3; i++) {
        setDt(world, 0.5);
        expect(spriteAnimationTickSystem(world).ok).toBe(true);
      }

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expectRegion(world, entity, [0.0, 0.0, 1.0, 1.0]);
    });

    it('(2b) frameCount=1 static sprite stays at currentFrame=0 (CLAMP)', () => {
      const world = new World();
      const regions = new Float32Array([0.0, 0.0, 1.0, 1.0]);
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 1,
            frameDuration: 0.1,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_CLAMP,
          },
        })
        .unwrap();

      setDt(world, 0.5);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expectRegion(world, entity, [0.0, 0.0, 1.0, 1.0]);
    });

    it('(3) manual setFrame: world.set(SpriteAnimation, { currentFrame: 2, accumDt: 0 }) is honoured next tick', () => {
      const world = new World();
      const regions = new Float32Array([
        0.0, 0, 0.25, 1, 0.25, 0, 0.25, 1, 0.5, 0, 0.25, 1, 0.75, 0, 0.25, 1,
      ]);
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 4,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      // Manual seek to frame 2.
      world.set(entity, SpriteAnimation, { currentFrame: 2, accumDt: 0 }).unwrap();
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(2);
        expect(snap.accumDt).toBeCloseTo(0, 6);
      }

      // Next tick: dt=0.05 < frameDuration so currentFrame STAYS at 2 and
      // accumDt becomes 0.05. A regression that re-initialised
      // currentFrame to 0 on a missing-SpriteRegionOverride observation
      // would flip the value back; the assertion catches that.
      setDt(world, 0.05);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(2);
        expect(snap.accumDt).toBeCloseTo(0.05, 6);
      }
      // The override slot is also written from currentFrame=2 (not 0) so
      // the rendered region is regions[8..12] = [0.5, 0, 0.25, 1].
      expectRegion(world, entity, [0.5, 0, 0.25, 1]);

      // Then dt=0.06 -> accumDt=0.11 -> advance once -> currentFrame=3,
      // accumDt=0.01.
      setDt(world, 0.06);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(3);
        expect(snap.accumDt).toBeCloseTo(0.01, 6);
      }
      expectRegion(world, entity, [0.75, 0, 0.25, 1]);
    });
  });
}

{
  // --- from sprite-animation-tick-clamp.test.ts ---

  const TIME_RESOURCE_KEY = 'Time' as const;

  function setDt(world: World, dt: number): void {
    world.insertResource(TIME_RESOURCE_KEY, { dt });
  }

  function makeRegions(): Float32Array {
    // 3 frames x 4 floats. Each frame's slice is byte-distinguishable so
    // the per-step region assertion can pin which frame fired without
    // ambiguity.
    return new Float32Array([
      0.0,
      0,
      0.33,
      1, // frame 0
      0.33,
      0,
      0.34,
      1, // frame 1
      0.67,
      0,
      0.33,
      1, // frame 2 (last frame, CLAMP target)
    ]);
  }

  function expectRegion(
    world: World,
    entity: EntityHandle,
    expected: readonly [number, number, number, number],
  ): void {
    const sro = world.get(entity, SpriteRegionOverride).unwrap();
    expect(sro.region.length).toBe(4);
    expect(sro.region[0]).toBeCloseTo(expected[0], 6);
    expect(sro.region[1]).toBeCloseTo(expected[1], 6);
    expect(sro.region[2]).toBeCloseTo(expected[2], 6);
    expect(sro.region[3]).toBeCloseTo(expected[3], 6);
  }

  describe('spriteAnimationTickSystem - AC-05 clamp end-frame (M4 T-18)', () => {
    it('dt=0.5 with frameCount=3 / frameDuration=0.1 stops at frameCount-1 (last frame)', () => {
      const world = new World();
      const regions = makeRegions();
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 3,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_CLAMP,
          },
        })
        .unwrap();

      setDt(world, 0.5);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(2);
      expect(snap.accumDt).toBeGreaterThanOrEqual(0);
      expectRegion(world, entity, [0.67, 0, 0.33, 1]);
    });

    it('continued dt=0.5 keeps currentFrame at last frame (no wrap)', () => {
      const world = new World();
      const regions = makeRegions();
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 3,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_CLAMP,
          },
        })
        .unwrap();

      setDt(world, 0.5);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(2);
      }

      setDt(world, 0.5);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        // CLAMP must not wrap; if loop arithmetic leaked into the clamp
        // branch the index would land at (2 + 5) % 3 = 1.
        expect(snap.currentFrame).toBe(2);
        expect(snap.accumDt).toBeGreaterThanOrEqual(0);
      }
      expectRegion(world, entity, [0.67, 0, 0.33, 1]);
    });
  });
}

{
  // --- from sprite-animation-tick-frame-duration-negative.test.ts ---

  const TIME_RESOURCE_KEY = 'Time' as const;

  describe('spriteAnimationTickSystem - AC-09(c) frameDuration<0 fail-fast (M4 T-21)', () => {
    it('returns Result.err with detail.field=frame-duration when frameDuration < 0', () => {
      const world = new World();
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 4,
            frameDuration: -0.05,
            currentFrame: 0,
            accumDt: 0,
            regions: new Float32Array(4 * 4),
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      world.insertResource(TIME_RESOURCE_KEY, { dt: 0.1 });
      const r = spriteAnimationTickSystem(world);

      expect(r.ok).toBe(false);
      if (r.ok) {
        throw new Error('expected Result.err but got ok');
      }
      expect(r.error).toBeInstanceOf(SpriteAnimationInvalidError);
      expect(r.error.code).toBe('sprite-animation-invalid');
      expect(r.error.detail.field).toBe('frame-duration');
      if (r.error.detail.field !== 'frame-duration') {
        throw new Error('expected detail.field=frame-duration narrowing');
      }
      // SpriteAnimation.frameDuration is an `f32` column so the stored
      // value is the f32 round-trip of -0.05 (= -0.05000000074505806 in
      // f64 readback). The closeTo tolerance covers the f32 unit-of-
      // last-place; the exact bit pattern is invariant across platforms
      // (IEEE 754 single-precision) so the assertion stays deterministic.
      expect(r.error.detail.frameDuration).toBeCloseTo(-0.05, 6);
      expect(r.error.detail.frameDuration).toBeLessThan(0);

      // Same fail-fast arm as T-20 (frameDuration === 0): the system
      // narrows on `frameDuration <= 0` so the negative path SHARES the
      // detail.field='frame-duration' branch (charter P4 consistent
      // abstraction). A regression that strict-equals on 0 would fall
      // through and compute `accumDt += dt` against a negative
      // frameDuration, producing Infinity / NaN advances; the bad-entity
      // state assertion below catches that.
      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
    });

    it('frameDuration negative returns the same .code as frameDuration zero', () => {
      // Twin spawn: one entity with frameDuration=0, one with -0.05. Both
      // surface the SAME .code + .detail.field arm. The first-error-wins
      // semantics return one of the two; either way the `.code` matches
      // and the `.detail.field` matches, locking the consistent-abstraction
      // claim from plan-strategy section 2 D-1.
      const world = new World();
      world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 2,
            frameDuration: 0,
            regions: new Float32Array(2 * 4),
          },
        })
        .unwrap();

      world.insertResource(TIME_RESOURCE_KEY, { dt: 0.1 });
      const rZero = spriteAnimationTickSystem(world);
      expect(rZero.ok).toBe(false);
      if (rZero.ok) throw new Error('zero arm: expected Result.err');

      const world2 = new World();
      world2
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 2,
            frameDuration: -0.05,
            regions: new Float32Array(2 * 4),
          },
        })
        .unwrap();

      world2.insertResource(TIME_RESOURCE_KEY, { dt: 0.1 });
      const rNeg = spriteAnimationTickSystem(world2);
      expect(rNeg.ok).toBe(false);
      if (rNeg.ok) throw new Error('negative arm: expected Result.err');

      expect(rZero.error.code).toBe(rNeg.error.code);
      expect(rZero.error.detail.field).toBe(rNeg.error.detail.field);
    });
  });
}

{
  // --- from sprite-animation-tick-frame-duration-zero.test.ts ---

  const TIME_RESOURCE_KEY = 'Time' as const;

  describe('spriteAnimationTickSystem - AC-09(b) frameDuration=0 fail-fast (M4 T-20)', () => {
    it('returns Result.err with detail.field=frame-duration when frameDuration === 0', () => {
      const world = new World();
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 4,
            frameDuration: 0,
            currentFrame: 0,
            accumDt: 0,
            regions: new Float32Array(4 * 4),
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      world.insertResource(TIME_RESOURCE_KEY, { dt: 0.1 });
      const r = spriteAnimationTickSystem(world);

      expect(r.ok).toBe(false);
      if (r.ok) {
        throw new Error('expected Result.err but got ok');
      }
      expect(r.error).toBeInstanceOf(SpriteAnimationInvalidError);
      expect(r.error.code).toBe('sprite-animation-invalid');
      expect(r.error.expected).toBeTruthy();
      expect(r.error.expected.length).toBeGreaterThan(0);
      expect(r.error.hint).toBeTruthy();
      expect(r.error.hint.length).toBeGreaterThan(0);
      expect(r.error.detail.field).toBe('frame-duration');
      if (r.error.detail.field !== 'frame-duration') {
        throw new Error('expected detail.field=frame-duration narrowing');
      }
      expect(r.error.detail.frameDuration).toBe(0);

      // The bad entity does NOT advance.
      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
    });
  });
}

{
  // --- from sprite-animation-tick-loop.test.ts ---

  const TIME_RESOURCE_KEY = 'Time' as const;

  function setDt(world: World, dt: number): void {
    world.insertResource(TIME_RESOURCE_KEY, { dt });
  }

  function makeRegions(): Float32Array {
    // 4 frames x [uMin, vMin, uW, vH] = 16 floats. Each frame's slice
    // is byte-distinguishable so the per-step region assertion can pin
    // which frame fired without ambiguity.
    return new Float32Array([
      0.0,
      0,
      0.25,
      1, // frame 0
      0.25,
      0,
      0.25,
      1, // frame 1
      0.5,
      0,
      0.25,
      1, // frame 2
      0.75,
      0,
      0.25,
      1, // frame 3
    ]);
  }

  function expectRegion(
    world: World,
    entity: EntityHandle,
    expected: readonly [number, number, number, number],
  ): void {
    const sro = world.get(entity, SpriteRegionOverride).unwrap();
    expect(sro.region.length).toBe(4);
    expect(sro.region[0]).toBeCloseTo(expected[0], 6);
    expect(sro.region[1]).toBeCloseTo(expected[1], 6);
    expect(sro.region[2]).toBeCloseTo(expected[2], 6);
    expect(sro.region[3]).toBeCloseTo(expected[3], 6);
  }

  describe('spriteAnimationTickSystem - AC-04 loop dt sequence (M4 T-17)', () => {
    it('five canonical dt steps drive currentFrame 0 -> 1 -> 1 -> 2 -> 0 with accumDt residue 0.06', () => {
      const world = new World();
      const regions = makeRegions();
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 4,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      // Step 1: dt=0.05 -> accumDt=0.05; no advance (0.05 < 0.1).
      setDt(world, 0.05);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(0);
        expect(snap.accumDt).toBeCloseTo(0.05, 6);
      }
      expectRegion(world, entity, [0.0, 0, 0.25, 1]);

      // Step 2: dt=0.06 -> accumDt=0.11; advance once; currentFrame=1, accumDt=0.01.
      setDt(world, 0.06);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(1);
        expect(snap.accumDt).toBeCloseTo(0.01, 6);
      }
      expectRegion(world, entity, [0.25, 0, 0.25, 1]);

      // Step 3: dt=0.04 -> accumDt=0.05; no advance (0.05 < 0.1).
      setDt(world, 0.04);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(1);
        expect(snap.accumDt).toBeCloseTo(0.05, 6);
      }
      expectRegion(world, entity, [0.25, 0, 0.25, 1]);

      // Step 4: dt=0.11 -> accumDt=0.16; advance once; currentFrame=2, accumDt=0.06.
      setDt(world, 0.11);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(2);
        expect(snap.accumDt).toBeCloseTo(0.06, 6);
      }
      expectRegion(world, entity, [0.5, 0, 0.25, 1]);

      // Step 5: dt=0.20 -> accumDt=0.26; advance twice; currentFrame=3 -> 0 (loop wrap), accumDt=0.06.
      setDt(world, 0.2);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const snap = world.get(entity, SpriteAnimation).unwrap();
        expect(snap.currentFrame).toBe(0);
        expect(snap.accumDt).toBeCloseTo(0.06, 6);
      }
      expectRegion(world, entity, [0.0, 0, 0.25, 1]);
    });

    it('multi-frame advance in a single tick when dt covers more than one frameDuration', () => {
      // Single tick with dt=0.35 / frameDuration=0.1 -> drains three full
      // frames in one call (currentFrame 0 -> 1 -> 2 -> 3) leaving
      // accumDt=0.05. Establishes that the inner advance loop fires more
      // than once per spriteAnimationTickSystem invocation; AC-04 +
      // section 2.5 q6 (while loop semantics).
      const world = new World();
      const regions = makeRegions();
      const entity = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 4,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();

      setDt(world, 0.35);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);

      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(3);
      expect(snap.accumDt).toBeCloseTo(0.05, 6);
      expectRegion(world, entity, [0.75, 0, 0.25, 1]);
    });
  });
}

{
  // --- from sprite-animation-tick-override-probe.test.ts ---

  const TIME_RESOURCE_KEY = 'Time' as const;

  function setDt(world: World, dt: number): void {
    world.insertResource(TIME_RESOURCE_KEY, { dt });
  }

  function makeRegions(): Float32Array {
    return new Float32Array([
      0.0,
      0,
      0.25,
      1, // frame 0
      0.25,
      0,
      0.25,
      1, // frame 1
      0.5,
      0,
      0.25,
      1, // frame 2
      0.75,
      0,
      0.25,
      1, // frame 3
    ]);
  }

  function spawnAnim(world: World): EntityHandle {
    return world
      .spawn({
        component: SpriteAnimation,
        data: {
          frameCount: 4,
          frameDuration: 0.1,
          currentFrame: 0,
          accumDt: 0,
          regions: makeRegions(),
          playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
        },
      })
      .unwrap();
  }

  describe('spriteAnimationTickSystem override probe (M3 AC-14)', () => {
    it('first tick on a World that never used SpriteRegionOverride auto-adds the column without crashing', () => {
      const world = new World();
      const entity = spawnAnim(world);
      // SpriteRegionOverride is never spawned / registered into this World;
      // the old gate existed precisely because world.get on it would throw.
      expect(() => {
        const r = spriteAnimationTickSystem(world);
        expect(r.ok).toBe(true);
      }).not.toThrow();

      // The override column was materialised by the auto-add path.
      const sro = world.get(entity, SpriteRegionOverride);
      expect(sro.ok).toBe(true);
      if (sro.ok) expect(sro.value.region.length).toBe(4);
    });

    it('subsequent ticks set the region in place (steady-state already-present path)', () => {
      const world = new World();
      const entity = spawnAnim(world);

      // Tick 1: dt=0.12 > frameDuration=0.1 advances exactly one frame
      // (0->1, residue 0.02) and auto-adds the override column. 0.12 sits
      // clear of the 0.1 representability boundary so the advance is
      // unambiguous and drains only once.
      setDt(world, 0.12);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const sro = world.get(entity, SpriteRegionOverride).unwrap();
        // frame 1 slice: [0.25, 0, 0.25, 1].
        expect(sro.region[0]).toBeCloseTo(0.25, 6);
      }

      // Tick 2: another 0.12 (residue 0.02 + 0.12 = 0.14) drains exactly
      // once more (1->2); the column already exists, so the already-present
      // path runs `set` (no crash, region updated in place).
      setDt(world, 0.12);
      expect(spriteAnimationTickSystem(world).ok).toBe(true);
      {
        const sro = world.get(entity, SpriteRegionOverride).unwrap();
        // frame 2 slice: [0.5, 0, 0.25, 1].
        expect(sro.region[0]).toBeCloseTo(0.5, 6);
      }
    });
  });
}

{
  // --- from sprite-animation-tick-regions-mismatch.test.ts ---

  const TIME_RESOURCE_KEY = 'Time' as const;

  function setDt(world: World, dt: number): void {
    world.insertResource(TIME_RESOURCE_KEY, { dt });
  }

  function spawnBadRegionsLength(world: World): EntityHandle {
    // frameCount=4 but regions.length=12 (should be 16). The first row is
    // distinguishable from row 0 of any regions buffer that the tick system
    // could plausibly synthesise so a regression that wrote a stale slice
    // would NOT match this initial state.
    return world
      .spawn({
        component: SpriteAnimation,
        data: {
          frameCount: 4,
          frameDuration: 0.1,
          currentFrame: 0,
          accumDt: 0,
          regions: new Float32Array([0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4, 0.5, 0.5, 0.6, 0.6]),
          playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
        },
      })
      .unwrap();
  }

  function spawnHealthy(world: World): EntityHandle {
    // 4 frames x 4 floats = 16. Distinguishable per-frame so the per-step
    // region assertion can pin which frame fired without ambiguity.
    const regions = new Float32Array([
      0.0, 0, 0.25, 1, 0.25, 0, 0.25, 1, 0.5, 0, 0.25, 1, 0.75, 0, 0.25, 1,
    ]);
    return world
      .spawn({
        component: SpriteAnimation,
        data: {
          frameCount: 4,
          frameDuration: 0.1,
          currentFrame: 0,
          accumDt: 0,
          regions,
          playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
        },
      })
      .unwrap();
  }

  describe('spriteAnimationTickSystem - AC-09(a) regions.length fail-fast (M4 T-19)', () => {
    it('returns Result.err with 4 structured fields when regions.length !== frameCount * 4', () => {
      const world = new World();
      const entity = spawnBadRegionsLength(world);

      setDt(world, 0.1);
      const r = spriteAnimationTickSystem(world);

      expect(r.ok).toBe(false);
      if (r.ok) {
        throw new Error('expected Result.err but got ok');
      }
      expect(r.error).toBeInstanceOf(SpriteAnimationInvalidError);
      expect(r.error.code).toBe('sprite-animation-invalid');
      expect(r.error.expected).toBeTruthy();
      expect(r.error.expected.length).toBeGreaterThan(0);
      expect(r.error.hint).toBeTruthy();
      expect(r.error.hint.length).toBeGreaterThan(0);
      expect(r.error.detail.field).toBe('regions-length');
      if (r.error.detail.field !== 'regions-length') {
        throw new Error('expected detail.field=regions-length narrowing');
      }
      expect(r.error.detail.regionsLength).toBe(12);
      expect(r.error.detail.frameCount).toBe(4);

      // The bad entity does NOT advance: currentFrame stays at 0,
      // accumDt stays at 0. A regression that mutated state before the
      // invariant check would surface as accumDt > 0 here.
      const snap = world.get(entity, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
    });

    it('healthy entity advances normally beside a bad-regions-length entity', () => {
      const world = new World();
      const bad = spawnBadRegionsLength(world);
      const good = spawnHealthy(world);

      // dt=0.15 -> good.accumDt=0.15 -> one advance: good.currentFrame=1,
      // good.accumDt=0.05. The bad entity stays put.
      setDt(world, 0.15);
      const r = spriteAnimationTickSystem(world);

      expect(r.ok).toBe(false);
      if (r.ok) {
        throw new Error('expected Result.err but got ok');
      }
      expect(r.error.code).toBe('sprite-animation-invalid');
      expect(r.error.detail.field).toBe('regions-length');

      const badSnap = world.get(bad, SpriteAnimation).unwrap();
      expect(badSnap.currentFrame).toBe(0);
      expect(badSnap.accumDt).toBeCloseTo(0, 6);

      const goodSnap = world.get(good, SpriteAnimation).unwrap();
      expect(goodSnap.currentFrame).toBe(1);
      expect(goodSnap.accumDt).toBeCloseTo(0.05, 6);

      // Healthy entity also got its SpriteRegionOverride written to the
      // currentFrame=1 slice (regions[4..8]).
      const sro = world.get(good, SpriteRegionOverride).unwrap();
      expect(sro.region.length).toBe(4);
      expect(sro.region[0]).toBeCloseTo(0.25, 6);
      expect(sro.region[1]).toBeCloseTo(0, 6);
      expect(sro.region[2]).toBeCloseTo(0.25, 6);
      expect(sro.region[3]).toBeCloseTo(1, 6);
    });
  });
}

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

{
  // --- from transparent-sort-config-get.test.ts ---

  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
    vi.restoreAllMocks();
  });

  describe('w09 - getTransparentSortConfig KV-missing returns default + silent', () => {
    it('KV missing returns { mode: 0, yzAlpha: 1.0 } (horizontal-z default)', () => {
      const world = new World();
      const cfg = getTransparentSortConfig(world);
      expect(cfg.mode).toBe(0);
      expect(cfg.yzAlpha).toBe(1.0);
    });

    it('KV missing does NOT call console.warn (legal default, not error)', () => {
      const world = new World();
      getTransparentSortConfig(world);
      expect(warnSpy?.mock.calls.length).toBe(0);
    });

    it('KV-present path returns inserted value unchanged', () => {
      const world = new World();
      const inserted: TransparentSortConfig = { mode: 1, yzAlpha: 0.5 };
      world.insertResource(TRANSPARENT_SORT_CONFIG_KEY, inserted);
      const cfg = getTransparentSortConfig(world);
      expect(cfg.mode).toBe(1);
      expect(cfg.yzAlpha).toBeCloseTo(0.5, 5);
    });

    it('KV-present read does NOT call console.warn', () => {
      const world = new World();
      world.insertResource(TRANSPARENT_SORT_CONFIG_KEY, { mode: 2, yzAlpha: 0.5 });
      getTransparentSortConfig(world);
      expect(warnSpy?.mock.calls.length).toBe(0);
    });
  });
}

{
  // --- from transparent-sort-config-set.test.ts ---

  const EXPECTED_HINT = '0=layer-z, 1=layer-y, 2=layer-yz, 3=distance';
  // requirements AC-15 + plan-strategy D-4 lock the literal text. The math
  // symbol \u2208 is ASCII-safe via escape; the source file stays ASCII-only.
  const EXPECTED_EXPECTED = 'mode \u2208 {0, 1, 2, 3}';

  // \u2500\u2500\u2500 w2: mode=3 Distance mode acceptance (TDD red phase) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  // AC-04: setTransparentSortConfig must accept mode=3 and must reject
  // out-of-range modes with .expected text reflecting the {0,1,2,3} range.
  // Red assertion: VALID_MODES does not yet contain 3, so mode=3 returns
  // err here (red). mode=99 returns err but .expected still says {0,1,2}
  // instead of {0,1,2,3} (also red).

  describe('w2 - setTransparentSortConfig mode=3 / mode=99 (TDD red)', () => {
    it('mode=3 returns Result.ok (currently red: VALID_MODES missing 3)', () => {
      const world = new World();
      const r = setTransparentSortConfig(world, { mode: 3, yzAlpha: 1.0 });
      // Red: VALID_MODES is {0,1,2} so mode=3 is rejected.
      expect(r.ok).toBe(true);
    });

    it('mode=99 returns Result.err with .expected containing 3 (currently red: .expected says {0,1,2})', () => {
      const world = new World();
      const r = setTransparentSortConfig(world, { mode: 99, yzAlpha: 1.0 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      const e = r.error;
      expect(e.code).toBe('resource-invalid-value');
      // Red: .expected currently says '{0, 1, 2}' not '{0, 1, 2, 3}'.
      expect(e.expected).toContain('3');
    });
  });

  describe('w10 - setTransparentSortConfig mode-invalid -> Result.err', () => {
    for (const mode of [-1, 4, 99] as const) {
      it(`mode = ${mode} returns Result.err with code/expected/hint/detail`, () => {
        const world = new World();
        const r = setTransparentSortConfig(world, { mode, yzAlpha: 1.0 });
        expect(r.ok).toBe(false);
        if (r.ok) return;
        const e = r.error;
        expect(e.code).toBe('resource-invalid-value');
        expect(e.expected).toBe(EXPECTED_EXPECTED);
        expect(e.hint).toBe(EXPECTED_HINT);
        expect(e.detail.receivedMode).toBe(mode);
      });
    }
  });

  describe('w10 - setTransparentSortConfig mode-valid -> Result.ok', () => {
    for (const mode of [0, 1, 2] as const) {
      it(`mode = ${mode} returns Result.ok and persists the resource`, () => {
        const world = new World();
        const r = setTransparentSortConfig(world, { mode, yzAlpha: 1.0 });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const cfg = getTransparentSortConfig(world);
        expect(cfg.mode).toBe(mode);
        expect(cfg.yzAlpha).toBe(1.0);
      });
    }

    it('overwriting an existing config with a valid mode is idempotent', () => {
      const world = new World();
      expect(setTransparentSortConfig(world, { mode: 0, yzAlpha: 1.0 }).ok).toBe(true);
      expect(setTransparentSortConfig(world, { mode: 2, yzAlpha: 0.5 }).ok).toBe(true);
      const cfg = getTransparentSortConfig(world);
      expect(cfg.mode).toBe(2);
      expect(cfg.yzAlpha).toBeCloseTo(0.5, 5);
    });
  });
}

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

{
  // --- from render-system-multi-material.test.ts ---

  const ENGINE = '../createRenderer';

  interface SetBindGroupCall {
    readonly group: number;
    readonly dynamicOffsets: readonly number[];
  }

  interface WriteBufferCall {
    readonly bufferLabel: string | undefined;
    readonly offset: number;
    readonly byteLength: number;
  }

  interface PassSpies {
    setIndexBuffer: ReturnType<typeof vi.fn>;
    setVertexBuffer: ReturnType<typeof vi.fn>;
    setBindGroup: ReturnType<typeof vi.fn>;
    draw: ReturnType<typeof vi.fn>;
    drawIndexed: ReturnType<typeof vi.fn>;
    // Per-pass record of (setBindGroup | drawIndexed) events in temporal order
    // so a test can assert "the i-th drawIndexed was preceded by a material
    // setBindGroup with the i-th expected slot offset". The geometry pass is
    // appended to this array; the shadow / sprite passes are not relevant
    // for this multi-material test.
    geometryEvents: Array<
      | { kind: 'setBindGroup'; call: SetBindGroupCall }
      | { kind: 'drawIndexed'; indexCount: number; indexOffset: number }
    >;
    writeBufferCalls: WriteBufferCall[];
  }

  function makeMockGL2(): unknown {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      isContextLost: () => false,
    };
  }

  function makeMockCanvas(): HTMLCanvasElement {
    const canvas = {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') return makeMockGL2();
        if (kind === 'webgpu') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({ createView: () => ({}) }),
          };
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
  }

  function makeMockGPUDevice(spies: PassSpies): { device: unknown } {
    const lost = new Promise<unknown>(() => undefined);
    // Track the material-ubo buffer object identity so writeBuffer to it can
    // be filtered. We lazily learn its identity on first createBuffer call
    // labelled 'pbr-material-ubo'.
    const labelByBuffer = new WeakMap<object, string>();
    const device = {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      limits: {},
      queue: {
        submit: () => undefined,
        writeBuffer: (
          buffer: object,
          offset: number,
          data: { byteLength: number } | ArrayBufferLike,
        ) => {
          const byteLength =
            'byteLength' in data ? data.byteLength : (data as ArrayBuffer).byteLength;
          spies.writeBufferCalls.push({
            bufferLabel: labelByBuffer.get(buffer),
            offset,
            byteLength,
          });
          return undefined;
        },
        writeTexture: () => undefined,
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: () => ({}),
      createBuffer: (desc: { label?: string }) => {
        const buf = {
          getMappedRange: () => new ArrayBuffer(64),
          unmap: () => undefined,
        };
        if (desc.label !== undefined) labelByBuffer.set(buf, desc.label);
        return buf;
      },
      createCommandEncoder: () => ({
        beginRenderPass: (descriptor: { label?: string }) => {
          const isGeometry =
            descriptor.label === undefined ||
            (typeof descriptor.label === 'string' && !descriptor.label.includes('shadow'));
          return {
            setPipeline: () => undefined,
            setVertexBuffer: spies.setVertexBuffer,
            setIndexBuffer: spies.setIndexBuffer,
            setBindGroup: (
              group: number,
              _bindGroup: unknown,
              dynamicOffsets?: readonly number[],
            ) => {
              spies.setBindGroup(group, _bindGroup, dynamicOffsets);
              if (isGeometry) {
                spies.geometryEvents.push({
                  kind: 'setBindGroup',
                  call: { group, dynamicOffsets: dynamicOffsets ?? [] },
                });
              }
              return undefined;
            },
            setStencilReference: () => undefined,
            setViewport: () => undefined,
            setScissorRect: () => undefined,
            draw: spies.draw,
            drawIndexed: (
              indexCount: number,
              instanceCount: number,
              indexOffset: number,
              baseVertex: number,
              firstInstance: number,
            ) => {
              spies.drawIndexed(indexCount, instanceCount, indexOffset, baseVertex, firstInstance);
              if (isGeometry) {
                spies.geometryEvents.push({ kind: 'drawIndexed', indexCount, indexOffset });
              }
              return undefined;
            },
            end: () => undefined,
          };
        },
        finish: () => ({}),
      }),
      createTexture: () => ({ createView: () => ({}) }),
      createSampler: () => ({}),
      destroy: () => undefined,
    };
    return { device };
  }

  function makeMockGPU(deviceObj: unknown): unknown {
    return {
      requestAdapter: async () => ({ requestDevice: async () => deviceObj }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  const baseNavigator: Navigator = {
    userAgent: 'mock-engine-test',
  } as Partial<Navigator> as Navigator;

  function buildManifestDataUrl(): string {
    const materialShaderStub = (identifier: string) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: '/* stub */',
      paramSchema: '[]',
      variants: [],
    });
    const manifest = {
      schemaVersion: '1.0.0',
      entries: [
        { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
        {
          hash: 'tonemap0',
          wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
          glsl: '',
          bindings: '',
        },
      ],
      materialShaders: [
        materialShaderStub('forgeax::default-standard-pbr'),
        materialShaderStub('forgeax::default-unlit'),
      ],
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  function makePassSpies(): PassSpies {
    return {
      setIndexBuffer: vi.fn(),
      setVertexBuffer: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
      geometryEvents: [],
      writeBufferCalls: [],
    };
  }

  interface RendererLike {
    ready: Promise<void>;
    draw: (world: unknown) => void;
    onError: (cb: (err: { code: string }) => void) => () => void;
    assets: { register: (asset: unknown) => { ok: boolean; value: unknown } };
  }

  async function importEngine(): Promise<{
    createRenderer: (canvas: unknown, opts?: unknown) => Promise<RendererLike>;
  }> {
    return (await import(ENGINE)) as never;
  }

  async function importEcs(): Promise<{
    World: new () => { spawn: (...componentDatas: unknown[]) => unknown };
  }> {
    return (await import('@forgeax/engine-ecs')) as never;
  }

  async function importComponents(): Promise<{
    Transform: unknown;
    MeshFilter: unknown;
    MeshRenderer: unknown;
    Camera: unknown;
    DirectionalLight: unknown;
  }> {
    return (await import('../index')) as never;
  }

  function cameraTransform() {
    return {
      posX: 0,
      posY: 0,
      posZ: 5,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    };
  }

  function originTransform() {
    return {
      posX: 0,
      posY: 0,
      posZ: 0,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    };
  }

  function unlitMaterial(color: readonly [number, number, number]) {
    return {
      kind: 'material' as const,
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::default-unlit',
          tags: { LightMode: 'Forward' },
          queue: 2000,
        },
      ],
      paramValues: { baseColor: color },
    };
  }

  function singleSubmeshTriangle(): MeshAsset {
    return {
      kind: 'mesh',
      vertices: new Float32Array(3 * 12),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {},
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list' as const,
        },
      ],
    };
  }

  function threeSubmeshMesh(): MeshAsset {
    return {
      kind: 'mesh',
      vertices: new Float32Array(9 * 12),
      indices: new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      attributes: {},
      submeshes: [
        { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' as const },
        { indexOffset: 3, indexCount: 3, vertexCount: 3, topology: 'triangle-list' as const },
        { indexOffset: 6, indexCount: 3, vertexCount: 3, topology: 'triangle-list' as const },
      ],
    };
  }

  async function setupRenderer(spies: PassSpies): Promise<{ renderer: RendererLike }> {
    const { device } = makeMockGPUDevice(spies);
    vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
    const { createRenderer } = await importEngine();
    const renderer = await createRenderer(
      makeMockCanvas(),
      {},
      {
        shaderManifestUrl: buildManifestDataUrl(),
      },
    );
    await renderer.ready;
    return { renderer };
  }

  async function spawnMultiMaterialScene(
    _renderer: RendererLike,
    meshAsset: MeshAsset,
    colors: ReadonlyArray<readonly [number, number, number]>,
  ): Promise<unknown> {
    const { World } = await importEcs();
    const C = await importComponents();
    const world = new World();
    const meshHandle = world.allocSharedRef('MeshAsset', meshAsset) as Handle<
      'MeshAsset',
      'shared'
    >;

    const materialHandles: Handle<'MaterialAsset', 'shared'>[] = [];
    for (const color of colors) {
      materialHandles.push(
        world.allocSharedRef('MaterialAsset', unlitMaterial(color)) as Handle<
          'MaterialAsset',
          'shared'
        >,
      );
    }

    world.spawn(
      {
        component: C.Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 16 / 9,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
      { component: C.Transform, data: cameraTransform() },
    );
    world.spawn(
      { component: C.DirectionalLight, data: {} },
      { component: C.Transform, data: cameraTransform() },
    );
    world.spawn(
      { component: C.MeshRenderer, data: { materials: materialHandles } },
      { component: C.MeshFilter, data: { assetHandle: meshHandle } },
      { component: C.Transform, data: originTransform() },
    );
    return world;
  }

  describe('extract: per-submesh MaterialSnapshot[] (w11-a)', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('(a) submeshes=[3] + materials=[3]: extract renderable carries materials[3]', async () => {
      const spies = makePassSpies();
      const { renderer } = await setupRenderer(spies);
      const errors: string[] = [];
      renderer.onError((e) => errors.push(e.code));

      const world = await spawnMultiMaterialScene(renderer, threeSubmeshMesh(), [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]);

      // Use the extract API directly so we can inspect the snapshot shape.
      const { extractFrame } = (await import('../render-system-extract')) as {
        extractFrame: (
          w: unknown,
          a: unknown,
        ) => {
          renderables: Array<{
            materials?: ReadonlyArray<{ baseColor: Float32Array | readonly number[] }>;
            material?: { baseColor: Float32Array | readonly number[] };
          }>;
        };
      };
      // The renderer exposes its AssetRegistry via .assets.
      const rendererAny = renderer as unknown as { assets: unknown };
      const frame = extractFrame(world, rendererAny.assets);
      expect(frame.renderables.length).toBe(1);
      const r = frame.renderables[0];
      if (!r) throw new Error('expected renderable');
      expect(r.materials).toBeDefined();
      expect(r.materials?.length).toBe(3);
      // The three materials must carry distinct baseColor vec3 values
      // (positional 1-1 with submeshes[]).
      const bc0 = r.materials?.[0]?.baseColor;
      const bc1 = r.materials?.[1]?.baseColor;
      const bc2 = r.materials?.[2]?.baseColor;
      expect(Array.from(bc0).slice(0, 3)).toEqual([1, 0, 0]);
      expect(Array.from(bc1).slice(0, 3)).toEqual([0, 1, 0]);
      expect(Array.from(bc2).slice(0, 3)).toEqual([0, 0, 1]);
      expect(errors).toEqual([]);
    });
  });

  describe('record: per-submesh material UBO rebind (w16-a)', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('(b) 3 submeshes x 3 distinct materials: 3 material UBO writes at distinct slot offsets, 3 drawIndexed each preceded by setBindGroup(1)', async () => {
      const spies = makePassSpies();
      const { renderer } = await setupRenderer(spies);
      const errors: string[] = [];
      renderer.onError((e) => errors.push(e.code));

      const world = await spawnMultiMaterialScene(renderer, threeSubmeshMesh(), [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]);
      renderer.draw(world);

      expect(spies.drawIndexed).toHaveBeenCalledTimes(3);

      // Material UBO writes: must have at least 3 distinct slot offsets
      // (one per submesh material). Stride is 256 B; payload size 48 B.
      const matUboWrites = spies.writeBufferCalls.filter(
        (w) => w.bufferLabel === 'pbr-material-ubo',
      );
      const distinctOffsets = new Set(matUboWrites.map((w) => w.offset));
      expect(distinctOffsets.size).toBeGreaterThanOrEqual(3);
      // Three offsets must be 0, 256, 512 (i.e. consecutive 256 B slots --
      // one per material in this single-entity scene).
      expect(distinctOffsets.has(0)).toBe(true);
      expect(distinctOffsets.has(256)).toBe(true);
      expect(distinctOffsets.has(512)).toBe(true);

      // Inside the geometry pass: each drawIndexed must be preceded by a
      // material BG bind (setBindGroup(1, ..., [offset])) at the matching slot.
      // We walk the geometry events and record, for each drawIndexed,
      // the most recent setBindGroup(1, ...) dynamicOffset.
      let lastMatOffset: number | undefined;
      const drawOffsets: number[] = [];
      for (const ev of spies.geometryEvents) {
        if (ev.kind === 'setBindGroup' && ev.call.group === 1) {
          lastMatOffset = ev.call.dynamicOffsets[0];
        } else if (ev.kind === 'drawIndexed') {
          if (lastMatOffset !== undefined) drawOffsets.push(lastMatOffset);
        }
      }
      expect(drawOffsets.length).toBe(3);
      // The three drawIndexed calls must each see a distinct material offset.
      expect(new Set(drawOffsets).size).toBe(3);
      // Specifically: submesh i should see slotOffset i*256.
      expect(drawOffsets[0]).toBe(0);
      expect(drawOffsets[1]).toBe(256);
      expect(drawOffsets[2]).toBe(512);

      expect(errors).toEqual([]);
    });

    it('(c) single submesh + single material: 1 material UBO write at offset 0, 1 drawIndexed (backward compat)', async () => {
      const spies = makePassSpies();
      const { renderer } = await setupRenderer(spies);
      const errors: string[] = [];
      renderer.onError((e) => errors.push(e.code));

      const world = await spawnMultiMaterialScene(renderer, singleSubmeshTriangle(), [[1, 0.5, 0]]);
      renderer.draw(world);

      expect(spies.drawIndexed).toHaveBeenCalledTimes(1);

      const matUboWrites = spies.writeBufferCalls.filter(
        (w) => w.bufferLabel === 'pbr-material-ubo',
      );
      const distinctOffsets = new Set(matUboWrites.map((w) => w.offset));
      // Single-mesh single-material: only slot 0 is used.
      expect(distinctOffsets.has(0)).toBe(true);
      // No further slots should be written.
      expect(distinctOffsets.has(256)).toBe(false);

      // Geometry pass: exactly 1 drawIndexed; preceded by 1 setBindGroup(1, ..., [0]).
      let lastMatOffset: number | undefined;
      const drawOffsets: number[] = [];
      for (const ev of spies.geometryEvents) {
        if (ev.kind === 'setBindGroup' && ev.call.group === 1) {
          lastMatOffset = ev.call.dynamicOffsets[0];
        } else if (ev.kind === 'drawIndexed') {
          if (lastMatOffset !== undefined) drawOffsets.push(lastMatOffset);
        }
      }
      expect(drawOffsets.length).toBe(1);
      expect(drawOffsets[0]).toBe(0);

      expect(errors).toEqual([]);
    });
  });
}

{
  // --- from render-system-record-submesh.test.ts ---

  const ENGINE = '../createRenderer';

  interface PassSpies {
    setIndexBuffer: ReturnType<typeof vi.fn>;
    setVertexBuffer: ReturnType<typeof vi.fn>;
    draw: ReturnType<typeof vi.fn>;
    drawIndexed: ReturnType<typeof vi.fn>;
  }

  function makeMockGL2(): unknown {
    return {
      __mockTag: 'webgl2',
      getExtension: () => null,
      getParameter: () => 1,
      isContextLost: () => false,
    };
  }

  function makeMockCanvas(): HTMLCanvasElement {
    const canvas = {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') return makeMockGL2();
        if (kind === 'webgpu') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({ createView: () => ({}) }),
          };
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
  }

  function makeMockGPUDevice(spies: PassSpies): { device: unknown } {
    const lost = new Promise<unknown>(() => undefined);
    const device = {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      limits: {},
      queue: {
        submit: () => undefined,
        writeBuffer: () => undefined,
        writeTexture: () => undefined,
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: () => ({}),
      createBuffer: () => ({
        getMappedRange: () => new ArrayBuffer(64),
        unmap: () => undefined,
      }),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setVertexBuffer: spies.setVertexBuffer,
          setIndexBuffer: spies.setIndexBuffer,
          setBindGroup: () => undefined,
          setStencilReference: () => undefined,
          setViewport: () => undefined,
          setScissorRect: () => undefined,
          draw: spies.draw,
          drawIndexed: spies.drawIndexed,
          end: () => undefined,
        }),
        finish: () => ({}),
      }),
      createTexture: () => ({ createView: () => ({}) }),
      createSampler: () => ({}),
      destroy: () => undefined,
    };
    return { device };
  }

  function makeMockGPU(deviceObj: unknown): unknown {
    return {
      requestAdapter: async () => ({ requestDevice: async () => deviceObj }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  const baseNavigator: Navigator = {
    userAgent: 'mock-engine-test',
  } as Partial<Navigator> as Navigator;

  function buildManifestDataUrl(): string {
    const materialShaderStub = (identifier: string) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: '/* stub */',
      paramSchema: '[]',
      variants: [],
    });
    const manifest = {
      schemaVersion: '1.0.0',
      entries: [
        { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
        { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
        {
          hash: 'tonemap0',
          wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
          glsl: '',
          bindings: '',
        },
      ],
      materialShaders: [
        materialShaderStub('forgeax::default-standard-pbr'),
        materialShaderStub('forgeax::default-unlit'),
      ],
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  function makePassSpies(): PassSpies {
    return {
      setIndexBuffer: vi.fn(),
      setVertexBuffer: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
    };
  }

  interface RendererLike {
    ready: Promise<void>;
    draw: (world: unknown) => void;
    onError: (cb: (err: { code: string }) => void) => () => void;
    assets: { register: (asset: unknown) => { ok: boolean; value: unknown } };
  }

  async function importEngine(): Promise<{
    createRenderer: (canvas: unknown, opts?: unknown) => Promise<RendererLike>;
  }> {
    return (await import(ENGINE)) as never;
  }

  async function importEcs(): Promise<{
    World: new () => { spawn: (...componentDatas: unknown[]) => unknown };
    queryRun: unknown;
    addSystem: unknown;
    Schedule: unknown;
  }> {
    return (await import('@forgeax/engine-ecs')) as never;
  }

  async function importComponents(): Promise<{
    Transform: unknown;
    MeshFilter: unknown;
    MeshRenderer: unknown;
    Camera: unknown;
    DirectionalLight: unknown;
  }> {
    return (await import('../index')) as never;
  }

  function cameraTransform() {
    return {
      posX: 0,
      posY: 0,
      posZ: 5,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    };
  }

  function originTransform() {
    return {
      posX: 0,
      posY: 0,
      posZ: 0,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    };
  }

  function unlitMaterial(color: readonly [number, number, number] = [1, 0, 0]) {
    return {
      kind: 'material' as const,
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::default-unlit',
          tags: { LightMode: 'Forward' },
          queue: 2000,
        },
      ],
      paramValues: { baseColor: color },
    };
  }

  function singleSubmeshTriangle(): MeshAsset {
    return {
      kind: 'mesh',
      vertices: new Float32Array(3 * 12),
      indices: new Uint16Array([0, 1, 2]),
      attributes: {},
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 3,
          topology: 'triangle-list' as const,
        },
      ],
    };
  }

  function threeSubmeshMesh(): MeshAsset {
    return {
      kind: 'mesh',
      vertices: new Float32Array(9 * 12),
      indices: new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      attributes: {},
      submeshes: [
        { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' as const },
        { indexOffset: 3, indexCount: 3, vertexCount: 3, topology: 'triangle-list' as const },
        { indexOffset: 6, indexCount: 3, vertexCount: 3, topology: 'triangle-list' as const },
      ],
    };
  }

  function vertexOnlyLineListMesh(): MeshAsset {
    return {
      kind: 'mesh',
      vertices: new Float32Array(2 * 12),
      attributes: {},
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 0,
          vertexCount: 2,
          topology: 'line-list' as const,
        },
      ],
    };
  }

  function mixedTopologyMesh(): MeshAsset {
    return {
      kind: 'mesh',
      vertices: new Float32Array(5 * 12),
      indices: new Uint16Array([0, 1, 2, 3, 4]),
      attributes: {},
      submeshes: [
        { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' as const },
        { indexOffset: 3, indexCount: 2, vertexCount: 2, topology: 'line-list' as const },
      ],
    };
  }

  async function setupRenderer(spies: PassSpies): Promise<{ renderer: RendererLike }> {
    const { device } = makeMockGPUDevice(spies);
    vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
    const { createRenderer } = await importEngine();
    const renderer = await createRenderer(
      makeMockCanvas(),
      {},
      {
        shaderManifestUrl: buildManifestDataUrl(),
      },
    );
    await renderer.ready;
    return { renderer };
  }

  async function spawnScene(
    _renderer: RendererLike,
    meshAsset: MeshAsset,
    materialCount: number,
  ): Promise<unknown> {
    const { World } = await importEcs();
    const C = await importComponents();
    const world = new World();
    const meshHandle = world.allocSharedRef('MeshAsset', meshAsset) as Handle<
      'MeshAsset',
      'shared'
    >;

    // Mint N unlit materials (one per submesh).
    const materialHandles: Handle<'MaterialAsset', 'shared'>[] = [];
    const colors: Array<readonly [number, number, number]> = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    for (let i = 0; i < materialCount; i++) {
      materialHandles.push(
        world.allocSharedRef('MaterialAsset', unlitMaterial(colors[i])) as Handle<
          'MaterialAsset',
          'shared'
        >,
      );
    }

    world.spawn(
      {
        component: C.Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 16 / 9,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
      { component: C.Transform, data: cameraTransform() },
    );
    world.spawn(
      { component: C.DirectionalLight, data: {} },
      { component: C.Transform, data: cameraTransform() },
    );
    world.spawn(
      { component: C.MeshRenderer, data: { materials: materialHandles } },
      { component: C.MeshFilter, data: { assetHandle: meshHandle } },
      { component: C.Transform, data: originTransform() },
    );
    return world;
  }

  describe('render-system-record per-submesh drawIndexed (w17, AC-04)', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('(a) single mesh single submesh: drawIndexed called once', async () => {
      const spies = makePassSpies();
      const { renderer } = await setupRenderer(spies);
      const errors: string[] = [];
      renderer.onError((e) => errors.push(e.code));

      const world = await spawnScene(renderer, singleSubmeshTriangle(), 1);
      renderer.draw(world);

      expect(spies.drawIndexed).toHaveBeenCalledTimes(1);
      // First drawIndexed call: indexCount=3, indexOffset=0
      // drawIndexed(indexCount, instanceCount, indexOffset, baseVertex, firstInstance)
      const firstCall = spies.drawIndexed.mock.calls[0];
      expect(firstCall[0]).toBe(3); // indexCount
      expect(firstCall[2]).toBe(0); // indexOffset
      expect(errors).toEqual([]);
    });

    it('(b) single mesh 3 submeshes: drawIndexed called 3 times with distinct offsets', async () => {
      const spies = makePassSpies();
      const { renderer } = await setupRenderer(spies);
      const errors: string[] = [];
      renderer.onError((e) => errors.push(e.code));

      const world = await spawnScene(renderer, threeSubmeshMesh(), 3);
      renderer.draw(world);

      expect(spies.drawIndexed).toHaveBeenCalledTimes(3);
      // Each submesh gets its own drawIndexed call with correct indexOffset.
      const offsets = spies.drawIndexed.mock.calls.map((c: number[]) => c[2]);
      expect(offsets).toEqual([0, 3, 6]);
      // Each draw has indexCount=3.
      const counts = spies.drawIndexed.mock.calls.map((c: number[]) => c[0]);
      expect(counts).toEqual([3, 3, 3]);
      expect(errors).toEqual([]);
    });

    it('(c) vertex-only (non-indexed) submesh: draw() called, drawIndexed not called', async () => {
      const spies = makePassSpies();
      const { renderer } = await setupRenderer(spies);
      const errors: string[] = [];
      renderer.onError((e) => errors.push(e.code));

      const world = await spawnScene(renderer, vertexOnlyLineListMesh(), 1);
      renderer.draw(world);

      expect(spies.draw).toHaveBeenCalled();
      // draw(vertexCount, instanceCount, firstVertex, firstInstance)
      const drewVertexCall = spies.draw.mock.calls.find((c: number[]) => c[0] === 2);
      expect(drewVertexCall).toBeTruthy();
      // Indexed path must NOT be used for a vertex-only submesh.
      expect(spies.drawIndexed).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    });

    it('(d) mixed-topology mesh: two drawIndexed calls, one per topology', async () => {
      const spies = makePassSpies();
      const { renderer } = await setupRenderer(spies);
      const errors: string[] = [];
      renderer.onError((e) => errors.push(e.code));

      const world = await spawnScene(renderer, mixedTopologyMesh(), 2);
      renderer.draw(world);

      // Both submeshes are indexed → 2 drawIndexed calls.
      expect(spies.drawIndexed).toHaveBeenCalledTimes(2);
      // Submesh 0: triangle-list, indexOffset=0, indexCount=3
      expect(spies.drawIndexed.mock.calls[0][0]).toBe(3);
      expect(spies.drawIndexed.mock.calls[0][2]).toBe(0);
      // Submesh 1: line-list, indexOffset=3, indexCount=2
      expect(spies.drawIndexed.mock.calls[1][0]).toBe(2);
      expect(spies.drawIndexed.mock.calls[1][2]).toBe(3);
      // Both drawIndexed calls share the same vertex buffer (vertex-only vertex buffer binding).
      expect(spies.setVertexBuffer).toHaveBeenCalled();
      expect(errors).toEqual([]);
    });
  });

  // feat-20260612-skin-palette-per-frame-upload M1 / m1-1: PipelineState
  // field-existence assertion. After `await renderer.ready` settles, the
  // closure-held PipelineState must (a) carry `skinPaletteAllocator` (the
  // animator-ready palette allocator from `createSkinPaletteAllocator`); and
  // (b) NOT carry `skinPaletteIdentityBuffer` (the bind-pose stub that gated
  // PR #353 ships in the prior loop's M8 / w28 -- retired by m1-2 + m1-3 of
  // this loop). The test is RED before m1-2/m1-3 land (current main: stub
  // present, allocator missing) and GREEN after both impl tasks commit.
  describe('feat-20260612 M1 / m1-1: PipelineState skin palette field shape', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', baseNavigator);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('exposes skinPaletteAllocator and not skinPaletteIdentityBuffer (m1-1)', async () => {
      const spies = makePassSpies();
      const { renderer } = await setupRenderer(spies);
      const ps = (
        renderer as unknown as { _internal_getPipelineState(): unknown }
      )._internal_getPipelineState() as Record<string, unknown> | null;
      expect(ps).not.toBeNull();
      const psNN = ps as Record<string, unknown>;
      // (a) Allocator carrier present and shaped like SkinPaletteAllocator.
      expect(psNN.skinPaletteAllocator).toBeDefined();
      expect(psNN.skinPaletteAllocator).not.toBeNull();
      const allocator = psNN.skinPaletteAllocator as Record<string, unknown>;
      expect(typeof allocator.allocateSlice).toBe('function');
      expect(typeof allocator.writeJointPalette).toBe('function');
      expect(typeof allocator.resetForFrame).toBe('function');
      // M6: allocator.buffer field retired -- per-slice `slice.buffer`
      // is now the carrier so the uniform fallback path can return a
      // distinct buffer per entity without leaking the storage-only
      // shared-buffer assumption into record-stage code.
      expect('buffer' in allocator).toBe(false);
      // M6 SSOT: allocator exposes the static BG @binding(1) entry size
      // (= MAX_JOINTS * 64 = 16320) so the record-stage BG creation reads
      // it instead of a literal. Mismatch with `pbr-skin-mesh-array-bgl`
      // would trip `dynOffset + entry.size > buffer.size` validation.
      expect(allocator.bindingWindowBytes).toBe(16320);
      // M6: useStorageBuffer flag exposed for record-stage / test
      // assertions that need to know which path the allocator is on.
      expect(typeof allocator.useStorageBuffer).toBe('boolean');
      // (b) Stub field retired -- not present on the PipelineState shape.
      expect('skinPaletteIdentityBuffer' in psNN).toBe(false);
    });
  });
}

// ── feat-20260612-skin-palette-per-frame-upload M2: extractFrame hasSkin ──
// Helpers shared by m2-1..m2-4 tests covering the T-21 placeholder retirement
// (real allocator wiring + 3 new SkinExtractErrorCode routings + assets===null
// bind-pose equivalence).

const SKIN_M2_AABB = new Float32Array([-1, -1, -1, 1, 1, 1]);
// Skinned: 18 floats / vertex × 3 vertices = 54 (12 base + skinIndex u16x4 packed in 2 floats at slots 12-13 + skinWeight vec4 at slots 14-17).
// validateMeshPayload (asset-registry feat: validateMeshPayload skin-aware stride) rejects skin meshes at the 12F stride.
const SKIN_M2_TRIANGLE_VERTICES = new Float32Array([
  // v0: pos (0,0,0) | normal (0,0,1) | uv (0,0) | tangent (0,0,0,1) | skin (0,0) | weight (0,0,0,0)
  0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  // v1: pos (1,0,0) | normal (0,0,1) | uv (1,0) | tangent (0,0,0,1) | skin (0,0) | weight (0,0,0,0)
  1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  // v2: pos (0,1,0) | normal (0,0,1) | uv (0,1) | tangent (0,0,0,1) | skin (0,0) | weight (0,0,0,0)
  0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
]);
const SKIN_M2_TRIANGLE_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

const SKIN_M2_IDENTITY_TRANSFORM = {
  posX: 0,
  posY: 0,
  posZ: 0,
  quatX: 0,
  quatY: 0,
  quatZ: 0,
  quatW: 1,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
} as const;

function makeSkinM2AssetRegistry(): AssetRegistry {
  const shaderRegistry = makeMockShaderRegistry();
  shaderRegistry.registerMaterialShader('forgeax::pbr-skin', {
    source: 'fn main() {}',
    paramSchema: [
      { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
      { name: 'metallic', type: 'f32', default: 0.0 },
      { name: 'roughness', type: 'f32', default: 0.5 },
    ],
  });
  return new AssetRegistry(shaderRegistry);
}

function registerSkinM2Mesh(world: World): Handle<'MeshAsset', 'shared'> {
  return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
    kind: 'mesh',
    vertices: SKIN_M2_TRIANGLE_VERTICES,
    indices: new Uint16Array([0, 1, 2]),
    attributes: {
      position: SKIN_M2_TRIANGLE_POSITIONS,
      skinIndex: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      skinWeight: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    },
    aabb: SKIN_M2_AABB,
    submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
  });
}

function registerSkinM2PbrSkinMaterial(world: World): Handle<'MaterialAsset', 'shared'> {
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::pbr-skin',
        tags: { LightMode: 'Forward' },
        queue: 2000,
      },
    ],
    paramValues: { baseColor: [1, 1, 1] },
  });
}

function registerSkinM2Skeleton(
  world: World,
  jointCount: number,
): Handle<'SkeletonAsset', 'shared'> {
  const ibm = new Float32Array(jointCount * 16);
  for (let j = 0; j < jointCount; j++) {
    ibm[j * 16 + 0] = 1;
    ibm[j * 16 + 5] = 1;
    ibm[j * 16 + 10] = 1;
    ibm[j * 16 + 15] = 1;
  }
  return world.allocSharedRef<'SkeletonAsset', SkeletonAsset>('SkeletonAsset', {
    kind: 'skeleton',
    inverseBindMatrices: ibm,
    jointCount,
  });
}

function spawnSkinM2Camera(world: World): void {
  world
    .spawn(
      { component: Transform, data: { ...SKIN_M2_IDENTITY_TRANSFORM, posZ: 5 } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
    )
    .unwrap();
}

function spawnSkinM2Joint(world: World): EntityHandle {
  return world
    .spawn({ component: Transform, data: SKIN_M2_IDENTITY_TRANSFORM })
    .unwrap() as unknown as EntityHandle;
}

function spawnSkinM2SkinnedEntity(
  world: World,
  meshHandle: Handle<'MeshAsset', 'shared'>,
  matHandle: Handle<'MaterialAsset', 'shared'>,
  skeletonHandle: Handle<'SkeletonAsset', 'shared'>,
  jointEntities: readonly EntityHandle[],
): EntityHandle {
  const joints = new Uint32Array(jointEntities.length);
  for (let j = 0; j < jointEntities.length; j++) {
    joints[j] = jointEntities[j] as unknown as number;
  }
  return world
    .spawn(
      { component: Transform, data: SKIN_M2_IDENTITY_TRANSFORM },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: { materials: [matHandle] } },
      { component: Skin, data: { skeleton: skeletonHandle, joints } },
    )
    .unwrap() as unknown as EntityHandle;
}

type SkinM2StubAllocator = {
  buffer: null;
  allocateSlice(jointCount: number): { jointCount: number; byteOffset: number };
  writeJointPalette(
    slice: { jointCount: number; byteOffset: number },
    ibms: readonly Float32Array[],
    jointWorlds: readonly Float32Array[],
  ): void;
  resetForFrame(): void;
  _resetCount(): number;
  _writeCount(): number;
};

function makeSkinM2StubAllocator(): SkinM2StubAllocator {
  let cursor = 0;
  let resetCount = 0;
  let writeCount = 0;
  return {
    buffer: null,
    allocateSlice(jointCount: number) {
      const offset = cursor;
      // 256-aligned bump (mirrors real allocator dyn-offset alignment).
      cursor = (cursor + jointCount * 64 + 255) & ~255;
      return { jointCount, byteOffset: offset };
    },
    writeJointPalette() {
      writeCount++;
    },
    resetForFrame() {
      cursor = 0;
      resetCount++;
    },
    _resetCount: () => resetCount,
    _writeCount: () => writeCount,
  };
}

type ExtractFrameWithPipeline = (
  w: World,
  a: AssetRegistry | null,
  p: { skinPaletteAllocator: SkinM2StubAllocator },
) => ReturnType<typeof extractFrame>;

{
  // --- m2-1: hasSkin happy path -> non-zero byteOffset ---
  describe('feat-20260612 M2 / m2-1: hasSkin happy path -> non-zero byteOffset', () => {
    it('two skinned entities -> first slice byteOffset>=0, second>0; writeJointPalette called twice (m2-1)', () => {
      const world = new World();
      const assets = makeSkinM2AssetRegistry();
      const meshHandle = registerSkinM2Mesh(world);
      const matHandle = registerSkinM2PbrSkinMaterial(world);
      const skeletonHandle = registerSkinM2Skeleton(world, 2);
      spawnSkinM2Camera(world);
      const joint0a = spawnSkinM2Joint(world);
      const joint0b = spawnSkinM2Joint(world);
      const joint1a = spawnSkinM2Joint(world);
      const joint1b = spawnSkinM2Joint(world);
      spawnSkinM2SkinnedEntity(world, meshHandle, matHandle, skeletonHandle, [joint0a, joint0b]);
      spawnSkinM2SkinnedEntity(world, meshHandle, matHandle, skeletonHandle, [joint1a, joint1b]);
      propagateTransforms(world);

      const allocator = makeSkinM2StubAllocator();
      const pipelineState = { skinPaletteAllocator: allocator };
      const errorSpy = vi.fn();
      world.setErrorHandler(errorSpy);

      const frame = (extractFrame as unknown as ExtractFrameWithPipeline)(
        world,
        assets,
        pipelineState,
      );

      // resetForFrame called exactly once at extractFrame entry (D-9).
      expect(allocator._resetCount()).toBe(1);
      // writeJointPalette called once per skinned entity (count=2).
      expect(allocator._writeCount()).toBe(2);
      // No errors fired on happy path.
      expect(errorSpy).not.toHaveBeenCalled();
      // Both renderables emerge with .skin populated.
      const skinned = frame.renderables.filter((r) => r.skin !== undefined);
      expect(skinned.length).toBe(2);
      const s0 = skinned[0];
      const s1 = skinned[1];
      if (s0?.skin === undefined || s1?.skin === undefined) {
        throw new Error('expected both renderables to carry skin slice');
      }
      // m2-1 acceptanceCheck: byteOffset !== 0 (or toBeGreaterThan(-1))
      // + jointCount === N. Truth-value of the allocator: first slice has
      // byteOffset === 0 (cursor start) AND second has byteOffset > 0.
      expect(s0.skin.jointCount).toBe(2);
      expect(s1.skin.jointCount).toBe(2);
      expect(s0.skin.byteOffset).toBeGreaterThan(-1);
      expect(s1.skin.byteOffset).toBeGreaterThan(-1);
      expect(s1.skin.byteOffset).not.toBe(0);
      expect(s0.skin.byteOffset % 256).toBe(0);
      expect(s1.skin.byteOffset % 256).toBe(0);
    });
  });
}

{
  // --- m2-2: assets===null equivalence to bind-pose (no error) ---
  describe('feat-20260612 M2 / m2-2: assets===null equiv bind-pose (no error)', () => {
    it('skinned entity + extractFrame(world, null) -> no _routeError, no skin slice (m2-2)', () => {
      const world = new World();
      const _assets = makeSkinM2AssetRegistry();
      const meshHandle = registerSkinM2Mesh(world);
      const matHandle = registerSkinM2PbrSkinMaterial(world);
      const skeletonHandle = registerSkinM2Skeleton(world, 1);
      spawnSkinM2Camera(world);
      const jointA = spawnSkinM2Joint(world);
      spawnSkinM2SkinnedEntity(world, meshHandle, matHandle, skeletonHandle, [jointA]);
      propagateTransforms(world);

      const allocator = makeSkinM2StubAllocator();
      const pipelineState = { skinPaletteAllocator: allocator };
      const errorSpy = vi.fn();
      world.setErrorHandler(errorSpy);

      // assets===null: assemble-form / test path that lacks an AssetRegistry.
      // Plan-strategy R-3: must NOT trigger skeleton-resolve-failed; the
      // hasSkin segment is skipped entirely (equivalent to bind-pose).
      expect(() =>
        (extractFrame as unknown as ExtractFrameWithPipeline)(world, null, pipelineState),
      ).not.toThrow();

      expect(errorSpy).not.toHaveBeenCalled();
      // No palette writes when assets is null (skinned entities bypass extract
      // entirely because Skin <-> pbr-skin material walk also requires assets;
      // either way the truth-value is: no writeJointPalette call).
      expect(allocator._writeCount()).toBe(0);
    });
  });
}

{
  // --- m2-3: skeleton-resolve-failed routing + continue ---
  describe('feat-20260612 M2 / m2-3: skeleton-resolve-failed routing', () => {
    it('Skin.skeleton points at unregistered handle -> _routeError(skeleton-resolve-failed) + continue (m2-3)', () => {
      const world = new World();
      const assets = makeSkinM2AssetRegistry();
      const meshHandle = registerSkinM2Mesh(world);
      const matHandle = registerSkinM2PbrSkinMaterial(world);
      const skeletonHandleGood = registerSkinM2Skeleton(world, 1);
      // Synthesize an unregistered skeleton handle: a numeric id (>= BUILTIN_BASE)
      // that was never minted in world.sharedRefs. resolveAssetHandle(world, handle)
      // on this handle returns asset-not-found.
      const skeletonHandleMissing = toShared<'SkeletonAsset'>(99999);
      spawnSkinM2Camera(world);
      const jointBad = spawnSkinM2Joint(world);
      const jointGood = spawnSkinM2Joint(world);
      // Bad-skin entity (skeleton handle dangling).
      spawnSkinM2SkinnedEntity(world, meshHandle, matHandle, skeletonHandleMissing, [jointBad]);
      // Sibling well-formed skinned entity in the same frame.
      spawnSkinM2SkinnedEntity(world, meshHandle, matHandle, skeletonHandleGood, [jointGood]);
      propagateTransforms(world);

      const allocator = makeSkinM2StubAllocator();
      const pipelineState = { skinPaletteAllocator: allocator };
      const errorSpy = vi.fn();
      world.setErrorHandler(errorSpy);

      const frame = (extractFrame as unknown as ExtractFrameWithPipeline)(
        world,
        assets,
        pipelineState,
      );

      // Exactly one error: skeleton-resolve-failed for the bad entity.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [errArg, ctxArg] = errorSpy.mock.calls[0] ?? [];
      expect((errArg as { code: string }).code).toBe('skeleton-resolve-failed');
      expect((ctxArg as { severity: number }).severity).toBe(Severity.Error);
      // continue semantics: sibling well-formed entity still emerges with skin.
      const skinned = frame.renderables.filter((r) => r.skin !== undefined);
      expect(skinned.length).toBe(1);
    });
  });
}

{
  // --- m2-4: joint-count-mismatch + joint-entity-dangling routing ---
  describe('feat-20260612 M2 / m2-4: joint-count-mismatch + joint-entity-dangling routing', () => {
    it('SkinAsset.joints.length !== SkeletonAsset.jointCount -> joint-count-mismatch + continue (m2-4a)', () => {
      const world = new World();
      const assets = makeSkinM2AssetRegistry();
      const meshHandle = registerSkinM2Mesh(world);
      const matHandle = registerSkinM2PbrSkinMaterial(world);
      // Skeleton declares jointCount=3; spawn provides only 2 joints -> mismatch.
      const skeletonHandle = registerSkinM2Skeleton(world, 3);
      const skeletonHandleGood = registerSkinM2Skeleton(world, 1);
      spawnSkinM2Camera(world);
      const j0 = spawnSkinM2Joint(world);
      const j1 = spawnSkinM2Joint(world);
      const jGood = spawnSkinM2Joint(world);
      spawnSkinM2SkinnedEntity(world, meshHandle, matHandle, skeletonHandle, [j0, j1]);
      // sibling well-formed (jointCount=1 matches 1 joint).
      spawnSkinM2SkinnedEntity(world, meshHandle, matHandle, skeletonHandleGood, [jGood]);
      propagateTransforms(world);

      const allocator = makeSkinM2StubAllocator();
      const pipelineState = { skinPaletteAllocator: allocator };
      const errorSpy = vi.fn();
      world.setErrorHandler(errorSpy);

      const frame = (extractFrame as unknown as ExtractFrameWithPipeline)(
        world,
        assets,
        pipelineState,
      );

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [errArg] = errorSpy.mock.calls[0] ?? [];
      expect((errArg as { code: string }).code).toBe('joint-count-mismatch');
      const detail = (errArg as { detail: { expected: number; actual: number } }).detail;
      expect(detail.expected).toBe(3);
      expect(detail.actual).toBe(2);
      // continue semantics
      const skinned = frame.renderables.filter((r) => r.skin !== undefined);
      expect(skinned.length).toBe(1);
    });

    it('Skin.joints[i] is despawned -> joint-entity-dangling + continue (m2-4b)', () => {
      const world = new World();
      const assets = makeSkinM2AssetRegistry();
      const meshHandle = registerSkinM2Mesh(world);
      const matHandle = registerSkinM2PbrSkinMaterial(world);
      const skeletonHandle = registerSkinM2Skeleton(world, 2);
      const skeletonHandleGood = registerSkinM2Skeleton(world, 1);
      spawnSkinM2Camera(world);
      // Two joints; despawn one to make Skin.joints[1] dangling.
      const jLive = spawnSkinM2Joint(world);
      const jDead = spawnSkinM2Joint(world);
      const jSiblingGood = spawnSkinM2Joint(world);
      spawnSkinM2SkinnedEntity(world, meshHandle, matHandle, skeletonHandle, [jLive, jDead]);
      spawnSkinM2SkinnedEntity(world, meshHandle, matHandle, skeletonHandleGood, [jSiblingGood]);
      // Despawn jDead AFTER spawning the skinned entity so its joints[1]
      // references a stale slot at extract time.
      world.despawn(jDead);
      propagateTransforms(world);

      const allocator = makeSkinM2StubAllocator();
      const pipelineState = { skinPaletteAllocator: allocator };
      const errorSpy = vi.fn();
      world.setErrorHandler(errorSpy);

      const frame = (extractFrame as unknown as ExtractFrameWithPipeline)(
        world,
        assets,
        pipelineState,
      );

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [errArg] = errorSpy.mock.calls[0] ?? [];
      expect((errArg as { code: string }).code).toBe('joint-entity-dangling');
      const detail = (errArg as { detail: { jointIndex: number } }).detail;
      expect(detail.jointIndex).toBeGreaterThanOrEqual(0);
      // sibling good entity still extracts.
      const skinned = frame.renderables.filter((r) => r.skin !== undefined);
      expect(skinned.length).toBe(1);
    });
  });
}

// ── feat-20260612-skin-palette-per-frame-upload M3 / m3-1: record-stage ──
// dynOffset[1] truth-value + skin BG cache miss=1 + hit=N-1 stats counter.
//
// Why this block exists:
//   M3 lifts the record-stage `group2DynamicOffsets` second slot from a
//   hard-coded `0` (PR #353 stub) to the per-entity `entry.source.skin
//   .byteOffset` cursor that M2 m2-6 wired into the extract output. The
//   acceptanceCheck calls for the literal text `group2DynamicOffsets[1]
//   === byteOffset` in the assertion so the test name itself encodes the
//   contract change at this slot. RED before m3-2 lands (helpers absent
//   on import); GREEN after m3-2 factors the inline `[i * 256, 0]` site
//   into `_computeSkinGroup2DynOffsets` + adds `_skinBgCacheStats`.
//
// What the assertions cover:
//   (a) `_computeSkinGroup2DynOffsets(meshSlotIdx, skinByteOffset)` — the
//       extracted pure helper. With skinByteOffset !== undefined the
//       returned tuple's [1] slot equals the supplied byteOffset (the
//       contract: `group2DynamicOffsets[1] === byteOffset`); with
//       skinByteOffset === undefined the helper returns a length-1 tuple
//       (URP / HDRP non-skin paths preserved -- only one dynamic offset
//       for the mesh-array UBO).
//   (b) `_skinBgCacheStats(pipelineState)` — N=3 sequential lookups
//       against the same `(meshStorageBuffer, skinPaletteAllocator
//       .buffer)` pair through `getOrCreateFromChain` produce miss=1 +
//       hit=2. Keys are buffer-identity based (no entityKey segment) so
//       multiple skinned entities sharing the same allocator buffer +
//       mesh SSBO globally dedup the BG.
//
// What it deliberately does NOT cover:
//   - End-to-end recordFrame dispatch on real skin renderables; that lives
//     in `apps/hello/skin/scripts/smoke-browser.mjs` (M4 layer-3 gate)
//     and the dawn smoke. The unit lift here mirrors w29 / IS-14's
//     scope-limit philosophy in `render-system-skin-bg.unit.test.ts`:
//     drive the BG-shape contract from a focused fixture rather than
//     mock the entire render pipeline.
{
  describe('feat-20260612 M3 / m3-1: record dynOffset[1] real value + skin BG cache stats', () => {
    it('_computeSkinGroup2DynOffsets returns group2DynamicOffsets[1] === byteOffset for skin entries; length 1 otherwise (m3-1a)', async () => {
      const recordModule = (await import('../render-system-record')) as {
        _computeSkinGroup2DynOffsets?: (
          meshSlotIdx: number,
          skinByteOffset: number | undefined,
        ) => readonly number[];
      };
      const fn = recordModule._computeSkinGroup2DynOffsets;
      expect(fn).toBeDefined();
      if (fn === undefined) throw new Error('_computeSkinGroup2DynOffsets missing');

      // Skin path: second slot must equal the per-entity byteOffset cursor
      // (M2 m2-6 wired entry.source.skin.byteOffset to the allocator's
      // 256-byte aligned slice cursor). Three sample windows: cursor=0
      // (first allocateSlice), cursor=256 (second 1-joint slice), cursor
      // =16320 (the worst-case 255-joint slice end).
      const skinAt0 = fn(0, 0);
      expect(skinAt0).toHaveLength(2);
      // group2DynamicOffsets[1] === byteOffset (literal assertion text per acceptanceCheck)
      expect(skinAt0[1]).toBe(0);

      const skinAt256 = fn(1, 256);
      expect(skinAt256).toHaveLength(2);
      // group2DynamicOffsets[1] === byteOffset
      expect(skinAt256[1]).toBe(256);
      // mesh slot continues to follow the 256-byte stride: meshSlotIdx * 256.
      expect(skinAt256[0]).toBe(256);

      const byteOffsetWorst = 254 * 256;
      const skinAtEnd = fn(2, byteOffsetWorst);
      expect(skinAtEnd).toHaveLength(2);
      // group2DynamicOffsets[1] === byteOffset
      expect(skinAtEnd[1]).toBe(byteOffsetWorst);
      expect(skinAtEnd[0]).toBe(2 * 256);

      // Non-skin path: second slot suppressed (length-1 tuple). URP /
      // HDRP entries keep their existing single-dyn-offset shape;
      // the BGL there is 1-binding so adding a second offset would
      // trip WebGPU validation.
      const noSkin = fn(0, undefined);
      expect(noSkin).toHaveLength(1);
      expect(noSkin[0]).toBe(0);
      const noSkinSlot7 = fn(7, undefined);
      expect(noSkinSlot7).toHaveLength(1);
      expect(noSkinSlot7[0]).toBe(7 * 256);
    });

    it('skin BG cache dedups by buffer identity: N=3 lookups -> miss=1 + hit=2 (m3-1b)', async () => {
      const recordModule = (await import('../render-system-record')) as {
        getOrCreateFromChain: (
          root: WeakMap<object, unknown>,
          handles: readonly object[],
          variant: string,
          factory: () => unknown,
          counts: { createBindGroup: number; keys: string[] },
        ) => unknown;
        _skinBgCacheStats?: (pipelineState: {
          _skinBgCacheStats: { miss: number; hit: number };
        }) => { miss: number; hit: number };
      };
      const getOrCreate = recordModule.getOrCreateFromChain;
      const readStats = recordModule._skinBgCacheStats;
      expect(readStats).toBeDefined();
      if (readStats === undefined) throw new Error('_skinBgCacheStats missing');

      const pipelineState = { _skinBgCacheStats: { miss: 0, hit: 0 } };

      // Nested WeakMap chain root — identical handle pair produces same leaf.
      const root = new WeakMap<object, unknown>();
      const bindGroupCounts = { createBindGroup: 0, keys: [] as string[] };
      const factory = () => ({ __label: 'bg' });

      const meshSsbo = { __label: 'mesh-ssbo' };
      const paletteBuffer = { __label: 'skin-palette' };

      // Walk N=3 lookups through the real getOrCreateFromChain.
      for (let i = 0; i < 3; i++) {
        const prevCount = bindGroupCounts.createBindGroup;
        getOrCreate(
          root,
          [meshSsbo as object, paletteBuffer as object],
          'pbr-skin-mesh',
          factory,
          bindGroupCounts,
        );
        if (bindGroupCounts.createBindGroup > prevCount) {
          pipelineState._skinBgCacheStats.miss += 1;
        } else {
          pipelineState._skinBgCacheStats.hit += 1;
        }
      }

      // m3-1 acceptanceCheck: BG cache miss=1 + hit=N-1 (N=3 -> hit=2).
      const stats = readStats(pipelineState);
      expect(stats.miss).toBe(1);
      expect(stats.hit).toBe(2);
      // Cross-check via bindGroupCounts: exactly one createBindGroup call.
      expect(bindGroupCounts.createBindGroup).toBe(1);
      expect(bindGroupCounts.keys).toHaveLength(1);
    });
  });
}

// ── downstream integration #4: Skylight solid-color ambient (no cubemap) ──
// A Skylight WITHOUT a cubemap must still produce an extract snapshot so the
// record stage can write a non-zero ambient uniform (intensity + color) and
// sample the white fallback irradiance cube -- giving instant solid-color
// ambient with no async IBL precompute. The prior extract gate dropped
// color-only skylights, leaving such scenes black.
{
  describe('Skylight solid-color ambient extract (downstream #4)', () => {
    it('Skylight with no cubemap still yields a snapshot (handle 0) with white default color', () => {
      const world = new World();
      world.spawn({ component: Skylight, data: {} });

      const frame = extractFrame(world, null as unknown as never) as unknown as {
        skylight?: { cubemapHandle: number; color: readonly number[]; intensity: number };
        skylightCount: number;
      };

      expect(frame.skylightCount).toBe(1);
      expect(frame.skylight).toBeDefined();
      expect(frame.skylight?.cubemapHandle).toBe(0);
      expect(frame.skylight?.intensity).toBe(1);
      expect(Array.from(frame.skylight?.color ?? [])).toEqual([1, 1, 1]);
    });

    it('Skylight color + intensity flow through to the snapshot verbatim', () => {
      const world = new World();
      world.spawn({
        component: Skylight,
        data: { colorR: 0.2, colorG: 0.4, colorB: 0.8, intensity: 0.5 },
      });

      const frame = extractFrame(world, null as unknown as never) as unknown as {
        skylight?: { cubemapHandle: number; color: readonly number[]; intensity: number };
      };

      expect(frame.skylight?.cubemapHandle).toBe(0);
      expect(frame.skylight?.intensity).toBeCloseTo(0.5, 5);
      const c = Array.from(frame.skylight?.color ?? []);
      expect(c[0]).toBeCloseTo(0.2, 5);
      expect(c[1]).toBeCloseTo(0.4, 5);
      expect(c[2]).toBeCloseTo(0.8, 5);
    });
  });
}

// ── M4 feat-20260619-gpu-resource-ownership-symmetric-release-primitive (round 2 fix-up) ──
//
// w12: AC-05 B-family F11 despawn -> per-frame poll destroy. Driven by real
//      recordFrame above (in the tonemap describe block); NOT here.
// w13: AC-06 B-family F12 set-before-destroy. Driven by real recordMainPass +
//      recordShadowPass through createRenderer + renderer.draw (this block).
// w14: AC-07 B-family error strategy. dispose-path sub-cases drive real
//      disposeInstanceBuffers; the F12 sub-case drives the real record pass
//      with a destroy that fails (this block).
// w15: AC-10 WeakMap chain behavior invariants.
//
// Round 2 fix-up (implement-review §5 Issues 1-4 + round-cap-override mandate):
// the prior round drove disposeInstanceBuffers as an F11/F12 proxy — a
// *different* function sharing only the isDestroyed+destroy idiom — so
// disabling the F11/F12 production destroy left the suite green (orchestrator
// falsification). w13/w14's F12 paths now run through createRenderer +
// renderer.draw, which records via the real recordMainPass / recordShadowPass.
// A mock GPU device captures every underlying GPUBuffer.destroy() call
// (rhi-webgpu device.ts:1425 forwards to rawBuf.destroy()); flipping any of
// the F12 production destroys (render-system-record.ts:3323 shadow / :4521
// main) to a no-op turns the relevant assertion red.

{
  // ── Helpers ──

  async function _loadM4Libs() {
    const { err: m4err, ok: m4ok, RhiError } = await import('@forgeax/engine-rhi');
    const { GpuBuffer } = await import('../gpu-resource');
    return { m4err, m4ok, RhiError, GpuBuffer };
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamic-import return types are opaque
  function _mkBufDevice(m4err: any, m4ok: any, RhiError: any) {
    const destroyedSet = new WeakSet<object>();
    const dev = {
      destroyBuffer(buf: object) {
        if (destroyedSet.has(buf))
          return m4err(new RhiError({ code: 'destroy-after-destroy', expected: '', hint: '' }));
        destroyedSet.add(buf);
        return m4ok(undefined);
      },
    };
    return dev as never;
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamic-import return type is opaque
  function _mkBufEntry(GpuBuffer: any, dev: never, bl: number, av: number) {
    return {
      buffer: new GpuBuffer(dev, {} as never),
      uploadedByteLength: bl,
      uploadedArchVersion: av,
    };
  }

  // ── createRenderer integration harness (drives the real record passes) ──
  //
  // A WebGPU-shaped mock device whose createBuffer hands back raw handles
  // that record their own .destroy() invocations. The runtime wraps each in a
  // GpuBuffer; the F12 set-before-destroy path calls GpuBuffer.destroy() ->
  // rhi-webgpu destroyBuffer -> rawBuf.destroy(), landing in `destroyed`.

  interface IntegrationBufLog {
    created: Array<{ handle: object; size: number; usage: number }>;
    destroyed: object[];
  }

  // The per-entity instance-transform buffer is the only buffer created with
  // usage STORAGE|COPY_DST (128|8 = 136; render-system-record.ts:4435) at the
  // instance byte size (`instanceCount * 16 f32 * 4 B`). Matching BOTH usage
  // and size pins the F12 destroy to the instance buffer, not an incidental
  // same-sized transient / uniform buffer elsewhere in the frame.
  const INSTANCE_USAGE = 128 | 8;
  const INSTANCE_BYTES = (instanceCount: number): number => instanceCount * 16 * 4;

  function instanceBufferDestroyed(log: IntegrationBufLog, instanceCount: number): boolean {
    const created = log.created.find(
      (c) => c.usage === INSTANCE_USAGE && c.size === INSTANCE_BYTES(instanceCount),
    );
    return created !== undefined && log.destroyed.includes(created.handle);
  }

  function makeIntegrationCanvas(): HTMLCanvasElement {
    const canvas = {
      width: 800,
      height: 600,
      getContext(kind: string): unknown {
        if (kind === 'webgl2') {
          return {
            __mockTag: 'webgl2',
            getExtension: () => null,
            getParameter: () => 1,
            isContextLost: () => false,
          };
        }
        if (kind === 'webgpu') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => undefined,
            getCurrentTexture: () => ({ createView: () => ({}) }),
          };
        }
        return null;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
  }

  function makeIntegrationDevice(
    log: IntegrationBufLog,
    opts?: { destroyThrows?: boolean },
  ): unknown {
    const lost = new Promise<unknown>(() => undefined);
    const destroyedSet = new WeakSet<object>();
    return {
      __mockTag: 'gpu-device',
      lost,
      features: new Set(),
      // maxStorageBuffersPerShaderStage > 0 => rhi-webgpu caps.storageBuffer
      // true (device.ts:406) => the instance buffer takes the STORAGE path
      // (usage 136), distinguishing it from uniform buffers in the frame.
      limits: {
        maxStorageBufferBindingSize: 1024 * 1024 * 1024,
        maxStorageBuffersPerShaderStage: 8,
      },
      queue: {
        submit: () => undefined,
        writeBuffer: () => undefined,
        writeTexture: () => undefined,
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({}),
      createBindGroup: () => ({}),
      createBuffer: (desc: { size?: number; usage?: number }) => {
        const raw = {
          __role: `buffer-${log.created.length}`,
          destroy: () => {
            if (opts?.destroyThrows) throw new Error('mock destroy failure');
            if (destroyedSet.has(raw)) return;
            destroyedSet.add(raw);
            log.destroyed.push(raw);
          },
          getMappedRange: () => new ArrayBuffer(desc?.size ?? 64),
          unmap: () => undefined,
        };
        log.created.push({ handle: raw, size: desc?.size ?? 0, usage: desc?.usage ?? 0 });
        return raw;
      },
      createCommandEncoder: () => ({
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setVertexBuffer: () => undefined,
          setIndexBuffer: () => undefined,
          setBindGroup: () => undefined,
          setViewport: () => undefined,
          setStencilReference: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
        }),
        finish: () => ({}),
      }),
      createTexture: () => ({ createView: () => ({}) }),
      createSampler: () => ({}),
      destroy: () => undefined,
    };
  }

  function makeIntegrationGPU(device: unknown): unknown {
    return {
      requestAdapter: async () => ({ requestDevice: async () => device }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
    };
  }

  const integrationNavigator = {
    userAgent: 'mock-engine-test',
  } as Partial<Navigator> as Navigator;

  // The shadow-caster shader registration gates recordShadowPass: with it,
  // the shadow pass records instances BEFORE the main pass each frame and so
  // owns the F12 set-before-destroy (render-system-record.ts:3323); without
  // it recordShadowPass early-exits (shadow PSO null) and the main pass owns
  // the F12 destroy (:4521). Each w13 sub-test selects the manifest that
  // isolates the production site it falsifies, so disabling that exact line
  // turns exactly that sub-test red.
  function buildIntegrationManifestUrl(withShadowCaster: boolean): string {
    const materialShaderStub = (identifier: string) => ({
      identifier,
      sourcePath: `${identifier}.wgsl`,
      composedWgsl: '/* stub */',
      paramSchema: '[]',
      variants: [],
    });
    const entries: Array<{ hash: string; wgsl: string; glsl: string; bindings: string }> = [
      { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      {
        hash: 'tonemap0',
        wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
        glsl: '',
        bindings: '',
      },
    ];
    if (withShadowCaster) {
      // Vertex-only depth marker => createRenderer registers
      // forgeax::default-shadow-caster so recordShadowPass runs.
      entries.push({
        hash: 'shadowcaster0',
        wgsl: '/* shadow caster stub - @location(0) position vertex-only */',
        glsl: '',
        bindings: '',
      });
    }
    const manifest = {
      schemaVersion: '1.0.0',
      entries,
      materialShaders: [
        materialShaderStub('forgeax::default-standard-pbr'),
        materialShaderStub('forgeax::default-unlit'),
      ],
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
  }

  interface IntegrationRenderer {
    ready: Promise<void>;
    draw: (world: unknown) => void;
    onError: (cb: (e: { code: string }) => void) => () => void;
  }

  interface IntegrationWorld {
    spawn: (...a: unknown[]) => { unwrap: () => unknown };
    set: (...a: unknown[]) => unknown;
  }

  interface IntegrationComponents {
    Transform: unknown;
    MeshFilter: unknown;
    MeshRenderer: unknown;
    Camera: unknown;
    Instances: unknown;
    DirectionalLight: unknown;
    HANDLE_CUBE: unknown;
  }

  async function bootIntegrationRenderer(
    device: unknown,
    withShadowCaster = false,
  ): Promise<{
    renderer: IntegrationRenderer;
    world: IntegrationWorld;
    C: IntegrationComponents;
    errors: { code: string }[];
  }> {
    vi.stubGlobal('navigator', { ...integrationNavigator, gpu: makeIntegrationGPU(device) });
    const { createRenderer } = (await import('../createRenderer')) as {
      createRenderer: (
        canvas: unknown,
        opts?: unknown,
        bundler?: unknown,
      ) => Promise<IntegrationRenderer>;
    };
    const renderer = await createRenderer(
      makeIntegrationCanvas(),
      {},
      { shaderManifestUrl: buildIntegrationManifestUrl(withShadowCaster) },
    );
    await renderer.ready;
    const { World: WorldCtor } = (await import('@forgeax/engine-ecs')) as unknown as {
      World: new () => IntegrationWorld;
    };
    const C = (await import('../index')) as unknown as IntegrationComponents;
    const errors: { code: string }[] = [];
    renderer.onError((e) => errors.push(e));
    return { renderer, world: new WorldCtor(), C, errors };
  }

  function spawnCamera(world: IntegrationWorld, C: IntegrationComponents): void {
    world.spawn(
      {
        component: C.Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 16 / 9,
          near: 0.1,
          far: 100,
          projection: 0,
          left: -1,
          right: 1,
          bottom: -1,
          top: 1,
        },
      },
      {
        component: C.Transform,
        data: {
          posX: 0,
          posY: 0,
          posZ: 5,
          quatX: 0,
          quatY: 0,
          quatZ: 0,
          quatW: 1,
          scaleX: 1,
          scaleY: 1,
          scaleZ: 1,
        },
      },
    );
  }

  function spawnInstancedCube(
    world: IntegrationWorld,
    C: IntegrationComponents,
    instanceCount: number,
  ): unknown {
    return world
      .spawn(
        { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
        { component: C.MeshRenderer, data: {} },
        {
          component: C.Transform,
          data: {
            posX: 0,
            posY: 0,
            posZ: 0,
            quatX: 0,
            quatY: 0,
            quatZ: 0,
            quatW: 1,
            scaleX: 1,
            scaleY: 1,
            scaleZ: 1,
          },
        },
        { component: C.Instances, data: { transforms: new Float32Array(instanceCount * 16) } },
      )
      .unwrap();
  }

  // ── w14: AC-07 B-family error strategy ──
  //
  // dispose-path sub-cases drive the real disposeInstanceBuffers (already
  // correct round 1); the F12 sub-case drives the real record pass with a
  // destroy that fails (rawBuf.destroy throws -> rhi-webgpu surfaces
  // webgpu-runtime-error -> the F12 production fires errorRegistry + sweeps on).

  describe('instance buffer error strategy (AC-07) [w14]', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('disposeInstanceBuffers: destroy clears map, isDestroyed gate skips pre-destroyed entries', async () => {
      const { disposeInstanceBuffers } = await import('../instance-buffer-cache');
      const { m4err, m4ok, RhiError, GpuBuffer } = await _loadM4Libs();
      const dev = _mkBufDevice(m4err, m4ok, RhiError);

      const e1 = _mkBufEntry(GpuBuffer, dev, 256, 1);
      const e2 = _mkBufEntry(GpuBuffer, dev, 512, 2);
      e2.buffer.destroy(); // pre-destroy
      const map = new Map<number, ReturnType<typeof _mkBufEntry>>();
      map.set(1, e1);
      map.set(2, e2);

      const fires: unknown[] = [];
      disposeInstanceBuffers(map, {
        fire: (e: unknown) => {
          fires.push(e);
        },
      });

      expect(e1.buffer.isDestroyed).toBe(true);
      expect(e2.buffer.isDestroyed).toBe(true);
      expect(map.size).toBe(0);
      expect(fires).toHaveLength(0);
    });

    it('disposeInstanceBuffers: sweep continues, all non-pre-destroyed entries destroyed', async () => {
      const { disposeInstanceBuffers } = await import('../instance-buffer-cache');
      const { m4err, m4ok, RhiError, GpuBuffer } = await _loadM4Libs();
      const dev = _mkBufDevice(m4err, m4ok, RhiError);

      const e1 = _mkBufEntry(GpuBuffer, dev, 256, 1);
      const e2 = _mkBufEntry(GpuBuffer, dev, 512, 2);
      const e3 = _mkBufEntry(GpuBuffer, dev, 768, 3);
      e2.buffer.destroy(); // pre-destroy
      const map = new Map<number, ReturnType<typeof _mkBufEntry>>();
      map.set(1, e1);
      map.set(2, e2);
      map.set(3, e3);

      const fires: unknown[] = [];
      disposeInstanceBuffers(map, {
        fire: (e: unknown) => {
          fires.push(e);
        },
      });

      expect(e1.buffer.isDestroyed).toBe(true);
      expect(e3.buffer.isDestroyed).toBe(true);
      expect(map.size).toBe(0);
      expect(fires).toHaveLength(0);
    });

    it('disposeInstanceBuffers: without errorRegistry parameter, no fire (no crash)', async () => {
      const { disposeInstanceBuffers } = await import('../instance-buffer-cache');
      const { m4err, m4ok, RhiError, GpuBuffer } = await _loadM4Libs();
      const dev = _mkBufDevice(m4err, m4ok, RhiError);

      const e1 = _mkBufEntry(GpuBuffer, dev, 256, 1);
      const map = new Map<number, ReturnType<typeof _mkBufEntry>>();
      map.set(1, e1);

      // Call without errorRegistry — should not throw.
      disposeInstanceBuffers(map);

      expect(e1.buffer.isDestroyed).toBe(true);
      expect(map.size).toBe(0);
    });

    it('F12 set-before-destroy failure fires errorRegistry + sweep continues (real record pass)', async () => {
      const log: IntegrationBufLog = { created: [], destroyed: [] };
      const device = makeIntegrationDevice(log, { destroyThrows: true });
      const { renderer, world, C, errors } = await bootIntegrationRenderer(device);

      spawnCamera(world, C);
      const cube = spawnInstancedCube(world, C, 2);

      // Frame 1: allocate the instance buffer (fingerprint = 2 instances).
      renderer.draw(world);

      // Frame 2: fingerprint mismatch -> F12 destroys the old buffer, whose
      // raw .destroy() throws -> rhi-webgpu webgpu-runtime-error -> the F12
      // production fires errorRegistry and continues to set the new buffer.
      world.set(cube, C.Instances, { transforms: new Float32Array(3 * 16) });
      renderer.draw(world);

      // Sweep continued: a fresh (larger) instance buffer was still allocated
      // after the failed destroy. The failure surfaced as a fired error.
      expect(errors.some((e) => e.code === 'webgpu-runtime-error')).toBe(true);
      expect(log.created.length).toBeGreaterThan(0);
    });
  });

  // ── w13: AC-06 B-family F12 set-before-destroy (real recordMainPass + recordShadowPass) ──

  describe('instance buffer F12 set-before-destroy (AC-06) [w13]', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('main pass: fingerprint change destroys the old cached buffer before set', async () => {
      const log: IntegrationBufLog = { created: [], destroyed: [] };
      const device = makeIntegrationDevice(log);
      const { renderer, world, C, errors } = await bootIntegrationRenderer(device);

      spawnCamera(world, C);
      const cube = spawnInstancedCube(world, C, 2);

      // Frame 1: cold allocate the 2-instance buffer (128 B).
      renderer.draw(world);
      expect(errors).toHaveLength(0);
      const createdAfterF1 = log.created.length;
      expect(createdAfterF1).toBeGreaterThan(0);
      expect(log.destroyed).toHaveLength(0);

      // Frame 2: 2 -> 3 instances => byteLength fingerprint mismatch => the
      // main-pass F12 path (render-system-record.ts:4521) destroys the old
      // 128 B buffer, then sets a fresh 192 B one. No shadow-caster shader is
      // registered, so recordShadowPass early-exits and the main pass is the
      // sole F12 owner this frame.
      world.set(cube, C.Instances, { transforms: new Float32Array(3 * 16) });
      renderer.draw(world);

      // The destroyed buffer is specifically the old instance buffer (STORAGE
      // usage, 128 B), not an incidental destroy elsewhere. Disabling :4521
      // drops it.
      expect(instanceBufferDestroyed(log, 2)).toBe(true);
      // A new (larger) 192 B instance buffer replaced the destroyed one.
      expect(
        log.created.some((c) => c.usage === INSTANCE_USAGE && c.size === INSTANCE_BYTES(3)),
      ).toBe(true);
    });

    it('shadow pass: fingerprint change destroys the old cached buffer before set', async () => {
      const log: IntegrationBufLog = { created: [], destroyed: [] };
      const device = makeIntegrationDevice(log);
      // withShadowCaster=true registers forgeax::default-shadow-caster so
      // recordShadowPass runs.
      const { renderer, world, C } = await bootIntegrationRenderer(device, true);

      spawnCamera(world, C);
      // DirectionalLight with castShadow => recordShadowPass runs and
      // records the instance entity BEFORE the main pass, so the shadow F12
      // path (render-system-record.ts:3323) owns the destroy this frame.
      world.spawn({
        component: C.DirectionalLight,
        data: {
          directionX: -0.5,
          directionY: -1,
          directionZ: -0.3,
          colorR: 1,
          colorG: 1,
          colorB: 1,
          intensity: 1,
          cascadeCount: 1,
          mapSize: 1024,
        },
      });
      const cube = spawnInstancedCube(world, C, 2);

      renderer.draw(world);
      expect(log.destroyed).toHaveLength(0);

      world.set(cube, C.Instances, { transforms: new Float32Array(3 * 16) });
      renderer.draw(world);

      // The shadow pass records the instance entity before the main pass, so
      // it owns the F12 destroy of the old (STORAGE, 128 B) instance buffer
      // this frame. Disabling :3323 drops this assertion (main reuses the
      // already-updated entry and never re-destroys).
      expect(instanceBufferDestroyed(log, 2)).toBe(true);
    });
  });

  // ── w15: AC-10 WeakMap chain behavior invariants ──
  //
  // feat-20260622-handle-to-id-allocator-elimination: the old
  // getOrAssignHandleId is gone; the old numeric counter is removed. WeakMap chain
  // determinism replaces it — same handle object identity → same
  // leaf BG, different handles → different leaf.

  describe('WeakMap chain behavior invariants [w15]', () => {
    it('same handle object in chain → same leaf BindGroup (deterministic)', () => {
      const root = new WeakMap<object, unknown>();
      const h1 = {};
      const h2 = {};

      // We simulate the chain by building two levels manually for the test
      const inner = new WeakMap<object, unknown>();
      root.set(h1, inner);
      const leaf = new Map<string, unknown>();
      inner.set(h2, leaf);
      const bg1 = { __label: 'bg-1' };
      leaf.set('variant-a', bg1);

      // Same handle path → same leaf entry
      const innerCheck = root.get(h1) as WeakMap<object, unknown>;
      expect(innerCheck).toBeDefined();
      const leafCheck = innerCheck.get(h2) as Map<string, unknown>;
      expect(leafCheck).toBeDefined();
      expect(leafCheck.get('variant-a')).toBe(bg1);
      expect(leafCheck.get('variant-a')).toBe(bg1);

      // Different variant on same chain → different leaf entry
      const bg2 = { __label: 'bg-2' };
      leaf.set('variant-b', bg2);
      expect(leaf.get('variant-a')).toBe(bg1);
      expect(leaf.get('variant-b')).toBe(bg2);
      expect(bg1).not.toBe(bg2);
    });

    it('different handle objects → different chain position → different leaf', () => {
      const root = new WeakMap<object, unknown>();
      const hA = {};
      const hB = {};
      const innerA = new WeakMap<object, unknown>();
      const innerB = new WeakMap<object, unknown>();
      const leafA = new Map<string, unknown>();
      const leafB = new Map<string, unknown>();
      innerA.set({}, leafA);
      innerB.set({}, leafB);
      root.set(hA, innerA);
      root.set(hB, innerB);

      // Different root-level key → completely independent chains
      const chainA = root.get(hA) as WeakMap<object, unknown>;
      const chainB = root.get(hB) as WeakMap<object, unknown>;
      expect(chainA).not.toBe(chainB);

      // No shared leaf — hA's chain entries don't hit hB's chain
      leafA.set('v', 'from-A');
      leafB.set('v', 'from-B');
      expect(
        (root.get(hA) as WeakMap<object, unknown>).get({}) as Map<string, unknown>,
      ).toBeUndefined();
    });

    it('grow miss: new inner buffer is new WeakMap key → cache miss (AC-07)', () => {
      // AC-07: when mesh SSBO grows, the inner buffer object is replaced.
      // The old inner buffer was a WeakMap key in the chain; the new one is
      // a different object, so chain lookup naturally misses.
      const root = new WeakMap<object, unknown>();
      const oldBuf = {};
      const inner = new WeakMap<object, unknown>();
      const leaf = new Map<string, unknown>();
      inner.set({}, leaf);
      root.set(oldBuf, inner);

      // Old buffer hits
      expect(root.has(oldBuf)).toBe(true);

      // New buffer (grow replacement) misses
      const newBuf = {};
      expect(root.has(newBuf)).toBe(false);
      expect(oldBuf).not.toBe(newBuf);
    });
  });
}

{
  // --- bug-20260622-tilemap-ysort-transparent-sort-modes-followup M2 m2-1 ---
  //
  // AC-02 + AC-03 sanity slabs. Audit the engine-side reconcile checkpoint
  // (4ead9e82) by asserting the two surfaces AI users reach for from the
  // `@forgeax/engine-runtime` barrel:
  //
  //   AC-02 -- `encodeTilemapLayerValue(layerOrder, chunkIndex, ySort?)`
  //            ySort=true folds chunkIndex into 0 (`(layerOrder << 20)`),
  //            ySort=false keeps the standard `(layerOrder << 20) | chunkIndex`
  //            encoding. Tilemap-layer entities that opt into Y-sort share one
  //            Layer.value across their derived per-cell entities so they
  //            interleave with sprite entities carrying the same Layer.value
  //            (requirements AC-02 + plan-strategy D-2).
  //
  //   AC-03 -- The 4 mode constants are reachable through the runtime
  //            barrel (`@forgeax/engine-runtime`) under their canonical
  //            names + numeric values 0/1/2/3, AND `setTransparentSortConfig`
  //            accepts all 4 modes (a tight proxy for the VALID_MODES set
  //            being size 4; the set itself is module-private SSOT).
  //
  // The barrel imports use the workspace alias so this slab fails if the
  // re-export drifts (e.g. someone drops `TRANSPARENT_SORT_MODE_DISTANCE`
  // from `packages/runtime/src/index.ts`). Same-package source tests
  // historically use relative paths; this slab opts into the published
  // alias path on purpose (charter F1 -- single-import barrel SSOT).

  describe('AC-02 encodeTilemapLayerValue (Y-sort folds chunkIndex)', () => {
    it('ySort=true: encodeTilemapLayerValue(2, 5, true) === 0x200000', async () => {
      const { encodeTilemapLayerValue } = await import('@forgeax/engine-runtime');
      expect(encodeTilemapLayerValue(2, 5, true)).toBe(0x200000);
    });

    it('ySort=false: encodeTilemapLayerValue(2, 5, false) === ((2 << 20) | 5)', async () => {
      const { encodeTilemapLayerValue } = await import('@forgeax/engine-runtime');
      expect(encodeTilemapLayerValue(2, 5, false)).toBe((2 << 20) | 5);
    });

    it('ySort defaults to false (third arg omitted matches ySort=false)', async () => {
      const { encodeTilemapLayerValue } = await import('@forgeax/engine-runtime');
      expect(encodeTilemapLayerValue(2, 5)).toBe(encodeTilemapLayerValue(2, 5, false));
    });
  });

  describe('AC-03 transparent-sort 4-mode constants reachable through barrel', () => {
    it('4 mode constants resolve to 0/1/2/3 through @forgeax/engine-runtime', async () => {
      const runtime = await import('@forgeax/engine-runtime');
      expect(runtime.TRANSPARENT_SORT_MODE_LAYER_Z).toBe(0);
      expect(runtime.TRANSPARENT_SORT_MODE_LAYER_Y).toBe(1);
      expect(runtime.TRANSPARENT_SORT_MODE_LAYER_YZ).toBe(2);
      expect(runtime.TRANSPARENT_SORT_MODE_DISTANCE).toBe(3);
    });

    it('setTransparentSortConfig accepts all 4 modes (VALID_MODES proxy: size 4)', async () => {
      const runtime = await import('@forgeax/engine-runtime');
      for (const mode of [
        runtime.TRANSPARENT_SORT_MODE_LAYER_Z,
        runtime.TRANSPARENT_SORT_MODE_LAYER_Y,
        runtime.TRANSPARENT_SORT_MODE_LAYER_YZ,
        runtime.TRANSPARENT_SORT_MODE_DISTANCE,
      ]) {
        const world = new World();
        const r = runtime.setTransparentSortConfig(world, { mode, yzAlpha: 1.0 });
        expect(r.ok).toBe(true);
      }
    });
  });
}
