// Consolidated by feat-20260608-ci-time-cut M5 w13/w14: merges
//   - render-system-record-pbr-ubo-stable.test.ts
//   - render-system-record-scale-too-small.test.ts
//   - render-system-record-sprite-region-override.test.ts
//   - render-system-record-sprite-ubo-bytes.test.ts
// Each original file body sits in its own block-scope so helper names
// cannot collide; describe() inside still registers globally with vitest.

import { World } from '@forgeax/engine-ecs';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import type {
  Handle,
  MaterialAsset,
  MaterialPassDescriptor,
  MeshAsset,
  PassSelector,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { Camera, MeshFilter, MeshRenderer, Transform } from '../components';
import { SpriteRegionOverride } from '../components/sprite-region-override';
import { createEngineMetrics } from '../engine-metrics';
import type { DispatchEntry } from '../render-system-extract';
import { extractFrame, type MaterialSnapshot } from '../render-system-extract';
import * as recordModule from '../render-system-record';
import { detectNineSliceScaleTooSmall } from '../render-system-record';
import { propagateTransforms } from '../systems/propagate-transforms';
import { createDefaultLoaderRegistry } from '../wire-default-loaders';

// ─── from render-system-record-pbr-ubo-stable.test.ts ───
{
  // render-system-record-pbr-ubo-stable - feat-20260527-sprite-nineslice M2 / w6.
  //
  // PBR Material UBO 80 B byte-sequence regression net (D-7 isolation):
  // any deviation in the PBR write path's byte sequence (even 1 byte) caused
  // by the sprite-branch schema-driven UBO extension (w11) MUST fail this test
  // — that triggers R-8 fallback (revert D-7 to physically isolated sprite
  // write function).
  //
  // w11 will extract the inline PBR UBO write path
  // (render-system-record.ts:2194-2277 -- baseColor, metallic, roughness,
  // channelMap u32 packing, emissive, occlusionStrength, paramSnapshot
  // schema-driven overlay) into a pure helper
  // `buildPbrMaterialUboPayload(material) -> ArrayBuffer(80B)` so this
  // regression test can exercise the PBR write byte-for-byte.
  //
  // The helper MUST produce the exact byte sequence the inline path produced
  // pre-feat (no slices-related side effects on the PBR layout). This test
  // asserts the PBR baseline against literal byte values.
  //
  // Coverage:
  //   - 80 B payload (STANDARD_PBR_UBO_SIZE)
  //   - slot 0 = baseColor.rgb + 1 (alpha hardcoded)
  //   - slot 1 first 8 B = metallic, roughness (f32x2)
  //   - slot 1 last 4 u32 (channelMap) = [2, 1, 0, 0]
  //   - slot 2 = emissive.rgb + emissiveIntensity
  //   - slot 3 first 4 B = occlusionStrength; rest stays 0 (no schema overlay
  //     in default-standard-pbr path; paramSnapshot reuses slot 0/1/2 by
  //     position).
  //
  // Anchors: plan-strategy §R-8, §5.3 key tests #2; AGENTS.md §Error model
  // (closed-union AssetErrorCode unchanged, baseline test does not depend on
  // new error members).

  const mod = recordModule as unknown as {
    buildPbrMaterialUboPayload?: (material: MaterialSnapshot) => ArrayBuffer;
  };

  function makePbrSnapshot(opts: {
    baseColor?: readonly [number, number, number, number];
    metallic?: number;
    roughness?: number;
    emissive?: readonly [number, number, number];
    emissiveIntensity?: number;
    occlusionStrength?: number;
  }): MaterialSnapshot {
    return {
      baseColor: opts.baseColor ?? [0.5, 0.6, 0.7, 1],
      metallic: opts.metallic ?? 0.1,
      roughness: opts.roughness ?? 0.4,
      shadingModel: undefined,
      materialShaderId: 'forgeax::default-standard-pbr',
      paramSnapshot: undefined,
      ...(opts.emissive !== undefined && { emissive: opts.emissive }),
      ...(opts.emissiveIntensity !== undefined && { emissiveIntensity: opts.emissiveIntensity }),
      ...(opts.occlusionStrength !== undefined && { occlusionStrength: opts.occlusionStrength }),
    } as unknown as MaterialSnapshot;
  }

  describe('PBR Material UBO byte sequence regression net (M2 / w6, D-7 isolation)', () => {
    it('export: buildPbrMaterialUboPayload helper is exported from render-system-record', () => {
      expect(typeof mod.buildPbrMaterialUboPayload).toBe('function');
    });

    it('80 B payload size + standard PBR slot layout (baseline)', () => {
      if (typeof mod.buildPbrMaterialUboPayload !== 'function') {
        throw new Error('helper not exported yet');
      }
      const snap = makePbrSnapshot({
        baseColor: [0.5, 0.6, 0.7, 1],
        metallic: 0.1,
        roughness: 0.4,
        emissive: [0, 0, 0],
        emissiveIntensity: 0,
        occlusionStrength: 1,
      });
      const buf = mod.buildPbrMaterialUboPayload(snap);
      expect(buf.byteLength).toBe(80);
      const f32 = new Float32Array(buf);
      // feat-20260613 fix-issue-1 (D-8 channelMap split): the 4 channelMap
      // u32 slots collapse into 4 independent f32 channel selectors at
      // f32[6..9] (metallicChannel/roughnessChannel/aoChannel/extraChannel).
      // baseColor.rgb + alpha=1 (alpha hardcoded in PBR write path).
      expect(f32[0]).toBeCloseTo(0.5);
      expect(f32[1]).toBeCloseTo(0.6);
      expect(f32[2]).toBeCloseTo(0.7);
      expect(f32[3]).toBe(1);
      // metallic + roughness (first 8 B of slot 1).
      expect(f32[4]).toBeCloseTo(0.1);
      expect(f32[5]).toBeCloseTo(0.4);
      // 4 channel selectors as f32 (default = B/G/R/_ glTF packing).
      expect(f32[6]).toBe(2); // metallicChannel  <- B
      expect(f32[7]).toBe(1); // roughnessChannel <- G
      expect(f32[8]).toBe(0); // aoChannel        <- R
      expect(f32[9]).toBe(0); // extraChannel     <- reserved
      // offsets 40..47 implicit pad (vec3 align=16 before emissive).
      expect(f32[10]).toBe(0);
      expect(f32[11]).toBe(0);
      // emissive.rgb + emissiveIntensity (offset 48..63).
      expect(f32[12]).toBe(0);
      expect(f32[13]).toBe(0);
      expect(f32[14]).toBe(0);
      expect(f32[15]).toBe(0);
      // occlusionStrength (offset 64..67).
      expect(f32[16]).toBe(1);
      // trailing pad (offset 68..79 to 16 B align).
      expect(f32[17]).toBe(0);
      expect(f32[18]).toBe(0);
      expect(f32[19]).toBe(0);
    });

    it('byte-stable across two equivalent PBR snapshots (idempotent write)', () => {
      if (typeof mod.buildPbrMaterialUboPayload !== 'function') {
        throw new Error('helper not exported yet');
      }
      const snap = makePbrSnapshot({
        baseColor: [0.2, 0.3, 0.4, 1],
        metallic: 0.5,
        roughness: 0.5,
      });
      const a = mod.buildPbrMaterialUboPayload(snap);
      const b = mod.buildPbrMaterialUboPayload(snap);
      expect(new Uint8Array(a)).toEqual(new Uint8Array(b));
    });
  });
}

// ─── from render-system-record-scale-too-small.test.ts ───
{
  // render-system-record-scale-too-small — feat-20260527-sprite-nineslice M4 / w17 (a).
  //
  // AC-16 end-to-end: when a 9-slice sprite entity carries a Transform.scale
  // below the four corner anchors, the detection path bumps
  // `renderer.metrics.snapshot()['nineslice.scale-too-small']` once per offending
  // renderableIndex per RenderSystem lifetime. AI users observe the breach
  // through the EngineMetrics counter rather than parsing console.warn text
  // (charter P3 machine-readable signals).
  //
  // The test exercises `detectNineSliceScaleTooSmall` (the pure helper extracted
  // from recordFrame in w17 prep) so the assertion runs without a GPU device.
  // recordFrame's inline call site forwards the same arguments to this helper,
  // so the unit test reflects production behaviour byte-for-byte.
  //
  // Anchors: requirements §AC-16; plan-strategy §5.3 key tests #9; plan-strategy
  // §D-5 EngineMetrics machine-readable counter.

  function diagonalWorld(scaleX: number, scaleY: number): Float32Array {
    // Column-major mat4 with diagonal scale, no rotation/translation.
    // biome-ignore format: matrix layout
    return new Float32Array([
    scaleX, 0, 0, 0,
    0, scaleY, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  }

  describe('detectNineSliceScaleTooSmall (M4 / w17, AC-16 E2E)', () => {
    it('single offending entity bumps the counter to 1', () => {
      const metrics = createEngineMetrics();
      const seen = new Set<number>();
      // anchor budget: |0.3| + |0.3| = 0.6 horizontal / 0.6 vertical.
      // scale 0.4 < 0.6 -> breach on both axes.
      detectNineSliceScaleTooSmall(diagonalWorld(0.4, 0.4), [0.3, 0.3, 0.3, 0.3], 0, seen, metrics);
      expect(metrics.snapshot()['nineslice.scale-too-small']).toBe(1);
    });

    it('repeat call on the SAME renderableIndex stays at 1 (warn-once anchor)', () => {
      const metrics = createEngineMetrics();
      const seen = new Set<number>();
      for (let i = 0; i < 10; i++) {
        detectNineSliceScaleTooSmall(
          diagonalWorld(0.4, 0.4),
          [0.3, 0.3, 0.3, 0.3],
          0,
          seen,
          metrics,
        );
      }
      expect(metrics.snapshot()['nineslice.scale-too-small']).toBe(1);
    });

    it('N distinct offending entities yield counter === N', () => {
      const metrics = createEngineMetrics();
      const seen = new Set<number>();
      for (let r = 0; r < 5; r++) {
        detectNineSliceScaleTooSmall(
          diagonalWorld(0.4, 0.4),
          [0.3, 0.3, 0.3, 0.3],
          r,
          seen,
          metrics,
        );
      }
      expect(metrics.snapshot()['nineslice.scale-too-small']).toBe(5);
    });

    it('compliant scale (>= anchor) does NOT bump the counter', () => {
      const metrics = createEngineMetrics();
      const seen = new Set<number>();
      detectNineSliceScaleTooSmall(diagonalWorld(1.0, 1.0), [0.3, 0.3, 0.3, 0.3], 0, seen, metrics);
      expect(metrics.snapshot()['nineslice.scale-too-small']).toBeUndefined();
    });

    it('all-zero slices is a no-op (legacy quad path, no detection)', () => {
      const metrics = createEngineMetrics();
      const seen = new Set<number>();
      // Even with a tiny scale the all-zero slices means "this is not a 9-slice"
      detectNineSliceScaleTooSmall(diagonalWorld(0.01, 0.01), [0, 0, 0, 0], 0, seen, metrics);
      expect(metrics.snapshot()['nineslice.scale-too-small']).toBeUndefined();
    });

    it('tile-mode sentinel (slices.w < 0) consumed via abs() — no false negative', () => {
      const metrics = createEngineMetrics();
      const seen = new Set<number>();
      // sliceMode=1 negates slices.w; the helper takes abs() so the anchor budget
      // still totals 0.6 on the vertical axis (|0.3| + |-0.3|).
      detectNineSliceScaleTooSmall(
        diagonalWorld(0.4, 0.4),
        [0.3, 0.3, 0.3, -0.3],
        0,
        seen,
        metrics,
      );
      expect(metrics.snapshot()['nineslice.scale-too-small']).toBe(1);
    });
  });
}

// ─── from render-system-record-sprite-region-override.test.ts ───
{
  // render-system-record-sprite-region-override — feat-20260527-sprite-nineslice M4 / w17 (b).
  //
  // AC-14: SpriteRegionOverride per-entity UV sub-rectangle composes with 9-slice.
  // When the entity carries the override component, the extract stage replaces
  // the asset-side `paramValues.region` with the override's 4-float region
  // before downstream snapshot construction; downstream 9-slice paths therefore
  // measure slices against the override's region.zw, not the asset's. Two
  // renderables sharing the same MaterialAsset can render with different
  // effective regions when only one carries the override.
  //
  // Coverage:
  //   (1) entity WITHOUT SpriteRegionOverride uses the asset-side region as the
  //       effective region in the snapshot.
  //   (2) entity WITH SpriteRegionOverride uses the override's region in the
  //       snapshot — a half-region [0, 0, 0.5, 1] flows through verbatim,
  //       displacing the asset's [0, 0, 1, 1].
  //   (3) Two renderables sharing the same material asset diverge on effective
  //       region — the override-bearing entity sees the override; the other
  //       sees the asset's region. Slices=[0.25,0.25,0.25,0.25] flow through
  //       both unchanged (slices remain in the [0..1] local-UV unit; the
  //       effective region only governs UV sampling, not the slices unit).
  //
  // Anchors: requirements §AC-14; plan-strategy §5.3 key tests #8.

  function makeShaderRegistryWithSprite(): ShaderRegistry {
    const mockDevice: ShaderRegistryDevice = {
      createShaderModule() {
        return {
          ok: true,
          value: undefined,
          unwrap: () => undefined,
          unwrapOr: (d: unknown) => d,
        } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
      },
    };
    const sr = new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
    sr.registerMaterialShader('forgeax::sprite', {
      source: 'fn main() {}',
      paramSchema: [
        { name: 'baseColor', type: 'color', default: [1.0, 1.0, 1.0, 1.0] },
        { name: 'texture', type: 'texture2d' },
        { name: 'sampler', type: 'sampler', default: null },
        { name: 'region', type: 'vec4', default: [0.0, 0.0, 1.0, 1.0] },
        { name: 'pivot', type: 'vec2', default: [0.5, 0.5] },
        { name: 'flipX', type: 'f32', default: 0.0 },
        { name: 'flipY', type: 'f32', default: 0.0 },
        { name: 'slices', type: 'vec4', default: [0.0, 0.0, 0.0, 0.0] },
        { name: 'sliceMode', type: 'f32', default: 0.0 },
      ],
    });
    return sr;
  }

  const SPRITE_PASS: MaterialPassDescriptor = {
    name: 'Sprite',
    shader: 'forgeax::sprite',
    queue: 3000,
  };

  function identity() {
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

  function registerSpriteMesh(world: World): Handle<'MeshAsset', 'shared'> {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    return world.allocSharedRef<'MeshAsset', MeshAsset>('MeshAsset', {
      kind: 'mesh',
      vertices: new Float32Array([
        0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0,
        1, 0, 0, 0, 0,
      ]),
      indices: new Uint16Array([0, 1, 2]),
      attributes: { position: positions },
      aabb: new Float32Array([0, 0, 0, 1, 1, 1]),
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 36,
          topology: 'triangle-list',
        },
      ],
    });
  }

  function spawnCamera(world: World): void {
    world
      .spawn(
        { component: Transform, data: { ...identity(), posZ: 5 } },
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

  describe('SpriteRegionOverride compose 9-slice (M4 / w17b, AC-14)', () => {
    it('(1) entity without override uses asset-side region', () => {
      const world = new World();
      const assets = new AssetRegistry(
        makeShaderRegistryWithSprite(),
        createDefaultLoaderRegistry(),
      );
      const mesh = registerSpriteMesh(world);
      const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
        kind: 'material',
        passes: [SPRITE_PASS],
        paramValues: { region: [0.1, 0.1, 0.8, 0.8] },
      });
      spawnCamera(world);
      world
        .spawn(
          { component: Transform, data: identity() },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [matHandle] } },
        )
        .unwrap();
      propagateTransforms(world);
      const frame = extractFrame(world, assets);
      const sprite = frame.renderables.find((r) => r.material.shadingModel === 'sprite');
      expect(sprite).toBeDefined();
      expect(sprite?.material.spriteFields?.region).toEqual([0.1, 0.1, 0.8, 0.8]);
    });

    it('(2) entity with override uses the override region in the snapshot', () => {
      const world = new World();
      const assets = new AssetRegistry(
        makeShaderRegistryWithSprite(),
        createDefaultLoaderRegistry(),
      );
      const mesh = registerSpriteMesh(world);
      const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
        kind: 'material',
        passes: [SPRITE_PASS],
        paramValues: { region: [0.0, 0.0, 1.0, 1.0] },
      });
      spawnCamera(world);
      world
        .spawn(
          { component: Transform, data: identity() },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [matHandle] } },
          {
            component: SpriteRegionOverride,
            data: { region: new Float32Array([0.0, 0.0, 0.5, 1.0]) },
          },
        )
        .unwrap();
      propagateTransforms(world);
      const frame = extractFrame(world, assets);
      const sprite = frame.renderables.find((r) => r.material.shadingModel === 'sprite');
      expect(sprite).toBeDefined();
      // The override displaces the asset-side [0, 0, 1, 1] region with the
      // half-width [0, 0, 0.5, 1] override, so downstream consumers (record
      // stage UBO write, 9-slice anchor budget) see the override values.
      expect(sprite?.material.spriteFields?.region).toEqual([0, 0, 0.5, 1]);
    });

    it('(3) two entities sharing one material diverge on effective region (compose with 9-slice)', () => {
      const world = new World();
      const assets = new AssetRegistry(
        makeShaderRegistryWithSprite(),
        createDefaultLoaderRegistry(),
      );
      const mesh = registerSpriteMesh(world);
      const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
        kind: 'material',
        passes: [SPRITE_PASS],
        paramValues: {
          region: [0.0, 0.0, 1.0, 1.0],
          slices: [0.25, 0.25, 0.25, 0.25],
          sliceMode: 0,
        },
      });
      spawnCamera(world);
      // entity A: no override, sees the asset-side region.
      world
        .spawn(
          { component: Transform, data: { ...identity(), posX: -1 } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [matHandle] } },
        )
        .unwrap();
      // entity B: half-width override, sees the override region.
      world
        .spawn(
          { component: Transform, data: { ...identity(), posX: 1 } },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [matHandle] } },
          {
            component: SpriteRegionOverride,
            data: { region: new Float32Array([0.0, 0.0, 0.5, 1.0]) },
          },
        )
        .unwrap();
      propagateTransforms(world);
      const frame = extractFrame(world, assets);
      const sprites = frame.renderables.filter((r) => r.material.shadingModel === 'sprite');
      expect(sprites.length).toBe(2);
      const regions = sprites.map((s) => s.material.spriteFields?.region);
      // One renderable lands on the asset-side region; the other lands on the
      // override. Order is archetype-walk order (we check the set, not which is
      // which, so the test stays robust to archetype iteration order).
      expect(regions).toContainEqual([0, 0, 1, 1]);
      expect(regions).toContainEqual([0, 0, 0.5, 1]);
      // Slices ride through unchanged on both renderables — slices stay in the
      // [0..1] local-UV unit; the effective region only governs UV sampling,
      // not the slices unit (charter P5: producer/consumer split).
      for (const s of sprites) {
        expect(s.material.spriteFields?.slices).toEqual([0.25, 0.25, 0.25, 0.25]);
        expect(s.material.spriteFields?.sliceMode).toBe(0);
      }
    });
  });
}

// ─── from render-system-record-sprite-ubo-bytes.test.ts ───
{
  // render-system-record-sprite-ubo-bytes - feat-20260527-sprite-nineslice M2 / w5 (b).
  //
  // TDD-red: sprite Material UBO byte-stable across three sentinel states
  // (plan-strategy §D-3 / §D-7):
  //   (1) no slices                      -> slot 3 = [0, 0, 0, 0]
  //   (2) stretch [.25,.25,.25,.25] m=0  -> slot 3 = [.25, .25, .25, .25]
  //   (3) tile    [.25,.25,.25,.25] m=1  -> slot 3 = [.25, .25, .25, -.25]
  //
  // The first 48 B (colorTint / region / pivotAndSize) MUST be byte-identical
  // across all three states (D-7 isolation: 9-slice expressions live only in
  // slot 3).
  //
  // Approach: w11 will extract the inline sprite UBO write path
  // (render-system-record.ts:2091-2193) into a pure helper
  // `buildSpriteMaterialUboPayload(material, transformWorld) -> ArrayBuffer(80B)`
  // so this test can exercise it without a GPU. RED before w11 (helper not yet
  // exported); the dynamic import below resolves at test time.
  //
  // Anchors: plan-strategy §5.3 key tests #1 + #7; §R-5 sentinel three-state.

  const mod = recordModule as unknown as {
    buildSpriteMaterialUboPayload?: (
      material: MaterialSnapshot,
      transformWorld: Float32Array,
    ) => ArrayBuffer;
  };

  function identityWorld(scaleX = 1, scaleY = 1): Float32Array {
    // Column-major 4x4 with diagonal scale (column 0 = scaleX-axis basis,
    // column 1 = scaleY-axis basis).
    // biome-ignore format: matrix layout
    return new Float32Array([
    scaleX, 0, 0, 0,
    0, scaleY, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]);
  }

  function makeSpriteSnapshot(spriteFields: {
    colorTintAlpha?: number;
    region?: readonly [number, number, number, number];
    pivot?: readonly [number, number];
    flipX?: boolean;
    flipY?: boolean;
    slices?: readonly [number, number, number, number];
    sliceMode?: number;
  }): MaterialSnapshot {
    return {
      baseColor: [1, 1, 1, 1] as const,
      metallic: 0,
      roughness: 1,
      shadingModel: 'sprite',
      spriteFields: {
        colorTintAlpha: spriteFields.colorTintAlpha ?? 1,
        region: spriteFields.region ?? [0, 0, 1, 1],
        pivot: spriteFields.pivot ?? [0.5, 0.5],
        flipX: spriteFields.flipX ?? false,
        flipY: spriteFields.flipY ?? false,
        ...(spriteFields.slices !== undefined && { slices: spriteFields.slices }),
        ...(spriteFields.sliceMode !== undefined && { sliceMode: spriteFields.sliceMode }),
      },
    } as unknown as MaterialSnapshot;
  }

  describe('sprite Material UBO byte-stable three-state (M2 / w5b, D-3/D-7)', () => {
    it('export: buildSpriteMaterialUboPayload helper is exported from render-system-record', () => {
      expect(typeof mod.buildSpriteMaterialUboPayload).toBe('function');
    });

    it('(1) no slices -> 80 B; slot 3 = [0,0,0,0]; first 48 B = baseline', () => {
      if (typeof mod.buildSpriteMaterialUboPayload !== 'function') {
        throw new Error('helper not exported yet (red phase)');
      }
      const snap = makeSpriteSnapshot({});
      const buf = mod.buildSpriteMaterialUboPayload(snap, identityWorld());
      expect(buf.byteLength).toBe(80);
      const f32 = new Float32Array(buf);
      // slot 3 = [12..15]
      expect(Array.from(f32.slice(12, 16))).toEqual([0, 0, 0, 0]);
      // colorTint slot 0
      expect(Array.from(f32.slice(0, 4))).toEqual([1, 1, 1, 1]);
      // region slot 1 - identity region (no flip applied)
      expect(Array.from(f32.slice(4, 8))).toEqual([0, 0, 1, 1]);
      // pivotAndSize slot 2: pivotX=0.5 pivotY=0.5 sourceScaleX=1 sourceScaleY=1
      expect(Array.from(f32.slice(8, 12))).toEqual([0.5, 0.5, 1, 1]);
    });

    it('(2) stretch slices [.25,.25,.25,.25] sliceMode=0 -> slot 3 verbatim; first 48 B unchanged', () => {
      if (typeof mod.buildSpriteMaterialUboPayload !== 'function') {
        throw new Error('helper not exported yet (red phase)');
      }
      const baseline = mod.buildSpriteMaterialUboPayload(makeSpriteSnapshot({}), identityWorld());
      const stretch = mod.buildSpriteMaterialUboPayload(
        makeSpriteSnapshot({ slices: [0.25, 0.25, 0.25, 0.25], sliceMode: 0 }),
        identityWorld(),
      );
      expect(stretch.byteLength).toBe(80);
      const stretchF32 = new Float32Array(stretch);
      const baseF32 = new Float32Array(baseline);
      // first 48 B (12 floats) byte-stable across slices presence (D-7 isolation).
      expect(Array.from(stretchF32.slice(0, 12))).toEqual(Array.from(baseF32.slice(0, 12)));
      // slot 3 carries the slices verbatim (sliceMode=0).
      expect(Array.from(stretchF32.slice(12, 16))).toEqual([0.25, 0.25, 0.25, 0.25]);
    });

    it('(3) tile slices [.25,.25,.25,-.25] -> slot 3 carries sentinel (w negative)', () => {
      if (typeof mod.buildSpriteMaterialUboPayload !== 'function') {
        throw new Error('helper not exported yet (red phase)');
      }
      const tile = mod.buildSpriteMaterialUboPayload(
        makeSpriteSnapshot({ slices: [0.25, 0.25, 0.25, -0.25], sliceMode: 1 }),
        identityWorld(),
      );
      expect(tile.byteLength).toBe(80);
      const f32 = new Float32Array(tile);
      // first 48 B (12 floats) still byte-identical across slot 3 changes.
      const baseline = mod.buildSpriteMaterialUboPayload(makeSpriteSnapshot({}), identityWorld());
      const baseF32 = new Float32Array(baseline);
      expect(Array.from(f32.slice(0, 12))).toEqual(Array.from(baseF32.slice(0, 12)));
      // sentinel: slot 3 = [.25, .25, .25, -.25] (extract already encodes the
      // sign on tile mode; w11 record path writes verbatim from snapshot).
      expect(f32[12]).toBe(0.25);
      expect(f32[13]).toBe(0.25);
      expect(f32[14]).toBe(0.25);
      expect(f32[15]).toBe(-0.25);
    });
  });
}

// ─── from feat-20260609 M2: dispatch selector filtering ───
{
  // feat-20260609-pipeline-driven-pass-selector-shadowcaster-via-mat M2
  // T-005: dispatch entry selector filtering unit tests.
  //
  // AC-03: selector { LightMode: ['Forward'] } filters to only Forward entries.
  // AC-04: selector { LightMode: ['ShadowCaster'] } filters to only matching entity.
  // AC-18: multiple ShadowCaster passes per entity -> filtered count = N.
  //
  // Anchors: plan-strategy section 5.3 key tests; requirements AC-03/AC-04/AC-18.

  const filterDispatchBySelector = (
    recordModule as unknown as {
      filterDispatchBySelector?: (
        dispatch: readonly DispatchEntry[],
        selector: PassSelector,
      ) => readonly DispatchEntry[];
    }
  ).filterDispatchBySelector;

  function makeDispatchEntry(
    renderableIndex: number,
    passIndex: number,
    tags: Record<string, string>,
  ): DispatchEntry {
    return {
      entityIndex: renderableIndex,
      materialHandle: 1,
      renderableIndex,
      passIndex,
      queue: 2000,
      tags,
      renderState: undefined,
      defines: undefined,
      vertexEntry: undefined,
      fragmentEntry: undefined,
      materialShaderId: 'forgeax::default-unlit',
      paramSnapshot: undefined,
    };
  }

  describe('dispatch entry selector filtering (M2, T-005)', () => {
    it('AC-03: empty selector returns all dispatch entries unchanged', () => {
      if (typeof filterDispatchBySelector !== 'function') {
        throw new Error('filterDispatchBySelector not exported yet');
      }
      const dispatch: DispatchEntry[] = [
        makeDispatchEntry(0, 0, { LightMode: 'Forward' }),
        makeDispatchEntry(1, 0, { LightMode: 'ShadowCaster' }),
      ];
      const result = filterDispatchBySelector(dispatch, {});
      expect(result.length).toBe(2);
    });

    it('AC-03: selector { LightMode: [Forward] } returns only Forward entries', () => {
      if (typeof filterDispatchBySelector !== 'function') {
        throw new Error('filterDispatchBySelector not exported yet');
      }
      const dispatch: DispatchEntry[] = [
        makeDispatchEntry(0, 0, { LightMode: 'Forward' }),
        makeDispatchEntry(1, 0, { LightMode: 'ShadowCaster' }),
        makeDispatchEntry(2, 0, { LightMode: 'Forward' }),
      ];
      const result = filterDispatchBySelector(dispatch, { LightMode: ['Forward'] });
      expect(result.length).toBe(2);
      for (const e of result) {
        expect(e.tags.LightMode).toBe('Forward');
      }
    });

    it('AC-04: selector { LightMode: [ShadowCaster] } returns only ShadowCaster entries', () => {
      if (typeof filterDispatchBySelector !== 'function') {
        throw new Error('filterDispatchBySelector not exported yet');
      }
      const dispatch: DispatchEntry[] = [
        makeDispatchEntry(0, 0, { LightMode: 'Forward' }),
        makeDispatchEntry(1, 0, { LightMode: 'ShadowCaster' }),
        makeDispatchEntry(2, 0, { LightMode: 'Forward' }),
      ];
      const result = filterDispatchBySelector(dispatch, { LightMode: ['ShadowCaster'] });
      expect(result.length).toBe(1);
      expect(result[0]?.tags.LightMode).toBe('ShadowCaster');
      expect(result[0]?.renderableIndex).toBe(1);
    });

    it('AC-18: multiple ShadowCaster passes per entity -> filtered count equals N', () => {
      if (typeof filterDispatchBySelector !== 'function') {
        throw new Error('filterDispatchBySelector not exported yet');
      }
      // Entity at renderableIndex=0 has 3 ShadowCaster passes.
      const dispatch: DispatchEntry[] = [
        makeDispatchEntry(0, 0, { LightMode: 'ShadowCaster' }),
        makeDispatchEntry(0, 1, { LightMode: 'ShadowCaster' }),
        makeDispatchEntry(0, 2, { LightMode: 'ShadowCaster' }),
        makeDispatchEntry(1, 0, { LightMode: 'Forward' }),
      ];
      const result = filterDispatchBySelector(dispatch, { LightMode: ['ShadowCaster'] });
      expect(result.length).toBe(3);
      for (const e of result) {
        expect(e.tags.LightMode).toBe('ShadowCaster');
        expect(e.renderableIndex).toBe(0);
      }
      // Each pass has a distinct passIndex.
      expect(result[0]?.passIndex).toBe(0);
      expect(result[1]?.passIndex).toBe(1);
      expect(result[2]?.passIndex).toBe(2);
    });

    it('selector with non-matching key returns empty array', () => {
      if (typeof filterDispatchBySelector !== 'function') {
        throw new Error('filterDispatchBySelector not exported yet');
      }
      const dispatch: DispatchEntry[] = [makeDispatchEntry(0, 0, { LightMode: 'Forward' })];
      const result = filterDispatchBySelector(dispatch, { RenderType: ['Opaque'] });
      expect(result.length).toBe(0);
    });

    it('selector matching on multiple keys requires both to match', () => {
      if (typeof filterDispatchBySelector !== 'function') {
        throw new Error('filterDispatchBySelector not exported yet');
      }
      const dispatch: DispatchEntry[] = [
        makeDispatchEntry(0, 0, { LightMode: 'Forward', RenderQueue: 'Geometry' }),
        makeDispatchEntry(1, 0, { LightMode: 'Forward', RenderQueue: 'Transparent' }),
      ];
      const result = filterDispatchBySelector(dispatch, {
        LightMode: ['Forward'],
        RenderQueue: ['Geometry'],
      });
      expect(result.length).toBe(1);
      expect(result[0]?.renderableIndex).toBe(0);
    });

    it('entry with empty tags is filtered out by a non-empty selector', () => {
      if (typeof filterDispatchBySelector !== 'function') {
        throw new Error('filterDispatchBySelector not exported yet');
      }
      const dispatch: DispatchEntry[] = [
        makeDispatchEntry(0, 0, {}),
        makeDispatchEntry(1, 0, { LightMode: 'Forward' }),
      ];
      const result = filterDispatchBySelector(dispatch, { LightMode: ['Forward'] });
      expect(result.length).toBe(1);
      expect(result[0]?.renderableIndex).toBe(1);
    });
  });
}
