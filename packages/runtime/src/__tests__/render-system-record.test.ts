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
  ParamSchemaEntry,
  PassSelector,
} from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { Camera, MeshFilter, MeshRenderer, Transform } from '../components';
import { SpriteRegionOverride } from '../components/sprite-region-override';
import { createEngineMetrics } from '../engine-metrics';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '../materials';
import type { DispatchEntry } from '../render-system-extract';
import { extractFrame, type MaterialSnapshot } from '../render-system-extract';
import * as recordModule from '../render-system-record';
import { detectNineSliceScaleTooSmall } from '../render-system-record';
import { propagateTransforms } from '../systems/propagate-transforms';

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
    // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w11+w12: the
    // sprite paramSchema mirrors the WGSL UBO struct field set (4 vec4 +
    // baseColorTexture). Legacy user inputs (slices/sliceMode/flipX/flipY/
    // pivot) are still accepted by extract and folded into the UBO-aligned
    // paramSnapshot vec4 entries (D-8).
    sr.registerMaterialShader('forgeax::sprite', {
      source: 'fn main() {}',
      paramSchema: [
        { name: 'colorTint', type: 'vec4', default: [1.0, 1.0, 1.0, 1.0] },
        { name: 'region', type: 'vec4', default: [0.0, 0.0, 1.0, 1.0] },
        { name: 'pivotAndSize', type: 'vec4', default: [0.5, 0.5, 1.0, 1.0] },
        { name: 'slicesAndMode', type: 'vec4', default: [0.0, 0.0, 0.0, 0.0] },
        { name: 'baseColorTexture', type: 'texture2d' },
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
      const assets = new AssetRegistry(makeShaderRegistryWithSprite());
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
      // feat-20260625 M3 / w12: sprite filter is now materialShaderId, not
      // shadingModel; region lands on paramSnapshot.region (D-8 / AC-07).
      const sprite = frame.renderables.find(
        (r) => r.material.materialShaderId === 'forgeax::sprite',
      );
      expect(sprite).toBeDefined();
      expect(sprite?.material.paramSnapshot?.region).toEqual([0.1, 0.1, 0.8, 0.8]);
    });

    it('(2) entity with override uses the override region in the snapshot', () => {
      const world = new World();
      const assets = new AssetRegistry(makeShaderRegistryWithSprite());
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
      const sprite = frame.renderables.find(
        (r) => r.material.materialShaderId === 'forgeax::sprite',
      );
      expect(sprite).toBeDefined();
      // The override displaces the asset-side [0, 0, 1, 1] region with the
      // half-width [0, 0, 0.5, 1] override, so downstream consumers (record
      // stage UBO write, 9-slice anchor budget) see the override values via
      // paramSnapshot.region (post-w12).
      expect(sprite?.material.paramSnapshot?.region).toEqual([0, 0, 0.5, 1]);
    });

    it('(3) two entities sharing one material diverge on effective region (compose with 9-slice)', () => {
      const world = new World();
      const assets = new AssetRegistry(makeShaderRegistryWithSprite());
      const mesh = registerSpriteMesh(world);
      const matHandle = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
        kind: 'material',
        passes: [SPRITE_PASS],
        paramValues: {
          region: [0.0, 0.0, 1.0, 1.0],
          slicesAndMode: [0.25, 0.25, 0.25, 0.25],
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
      const sprites = frame.renderables.filter(
        (r) => r.material.materialShaderId === 'forgeax::sprite',
      );
      expect(sprites.length).toBe(2);
      const regions = sprites.map((s) => s.material.paramSnapshot?.region);
      // One renderable lands on the asset-side region; the other lands on the
      // override. Order is archetype-walk order (we check the set, not which is
      // which, so the test stays robust to archetype iteration order).
      expect(regions).toContainEqual([0, 0, 1, 1]);
      expect(regions).toContainEqual([0, 0, 0.5, 1]);
      // Slices ride through unchanged on both renderables -- slicesAndMode
      // stretch encoding (positive .w, plan-strategy D-3); effective region
      // governs UV sampling, not the slices unit.
      for (const s of sprites) {
        expect(s.material.paramSnapshot?.slicesAndMode).toEqual([0.25, 0.25, 0.25, 0.25]);
      }
    });
  });
}

// --- from render-system-record-sprite-ubo-bytes.test.ts ---
{
  // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w8 (TDD red).
  //
  // Sprite UBO bytes via the GENERIC paramSnapshot writer (M1 / w3
  // applyParamSnapshotToUbo). The sprite path consumes the same
  // derive(uboLayout).entries-driven overlay every other paramSchema-bound
  // material uses, so the 4 vec4 sprite layout (colorTint / region /
  // pivotAndSize / slicesAndMode) is produced by `applyParamSnapshotToUbo`
  // walking a sprite-shaped paramSchema -- not by the legacy
  // `buildSpriteMaterialUboPayload` POD helper.
  //
  // Plan anchors:
  //   - plan-strategy section 2 D-2 / D-6: generic std140 writer is the
  //     single UBO write path; sprite-specific builder is ablated in w13.
  //   - plan-strategy section 5.3 #1: 4-vec4 std140 layout byte correctness.
  //   - requirements AC-03: buildSpriteMaterialUboPayload export does not
  //     survive M3 (closed-loop reverse-grep gate).
  //
  // Red phase: the legacy helper still ships; we assert here that the new
  // production path (generic writer + sprite-shaped paramSnapshot) produces
  // the expected bytes AND that `buildSpriteMaterialUboPayload` is no longer
  // exported. Both flip green when w13 lands.

  const mod = recordModule as unknown as {
    applyParamSnapshotToUbo?: (
      payload: ArrayBuffer,
      paramSchema: readonly ParamSchemaEntry[] | undefined,
      paramSnapshot:
        | Readonly<Record<string, number | readonly number[] | string | undefined>>
        | undefined,
    ) => void;
    buildSpriteMaterialUboPayload?: unknown;
  };

  // Sprite UBO layout (matches sprite.wgsl post-w11 unit-quad struct: four
  // vec4 fields, total 64 B; the writer fills the leading 64 B of the
  // STANDARD_PBR_UBO_SIZE-sized payload buffer the runtime reuses).
  const SPRITE_UBO_SCHEMA: readonly ParamSchemaEntry[] = [
    { name: 'colorTint', type: 'vec4', default: [1, 1, 1, 1] },
    { name: 'region', type: 'vec4', default: [0, 0, 1, 1] },
    { name: 'pivotAndSize', type: 'vec4', default: [0.5, 0.5, 1, 1] },
    { name: 'slicesAndMode', type: 'vec4', default: [0, 0, 0, 0] },
  ];

  function makeSpriteSnapshot(opts: {
    colorTintAlpha?: number;
    region?: readonly [number, number, number, number];
    pivot?: readonly [number, number];
    slices?: readonly [number, number, number, number];
  }): {
    colorTint: readonly [number, number, number, number];
    region: readonly [number, number, number, number];
    pivotAndSize: readonly [number, number, number, number];
    slicesAndMode: readonly [number, number, number, number];
  } {
    const pivot = opts.pivot ?? [0.5, 0.5];
    return {
      colorTint: [1, 1, 1, opts.colorTintAlpha ?? 1] as const,
      region: opts.region ?? ([0, 0, 1, 1] as const),
      // Unit quad: pivotAndSize.zw=(1,1) is the placeholder slot the shader
      // no longer reads -- world scale flows entirely through worldFromLocal
      // (plan-strategy section 2 D-6).
      pivotAndSize: [pivot[0], pivot[1], 1, 1] as const,
      slicesAndMode: (opts.slices ?? ([0, 0, 0, 0] as const)) as readonly [
        number,
        number,
        number,
        number,
      ],
    };
  }

  describe('sprite Material UBO bytes via generic writer (M3 / w8)', () => {
    it('grep: buildSpriteMaterialUboPayload is no longer exported from render-system-record (AC-03)', () => {
      expect(mod.buildSpriteMaterialUboPayload).toBeUndefined();
    });

    it('(1) no slices -> 64 B leading bytes; slot 3 = [0,0,0,0]; slots 0..2 = identity defaults', () => {
      if (typeof mod.applyParamSnapshotToUbo !== 'function') {
        throw new Error('applyParamSnapshotToUbo not exported');
      }
      // 80 B buffer mirrors the per-entity slot stride the runtime allocates
      // (STANDARD_PBR_UBO_SIZE). The sprite writer only touches the leading
      // 64 B; trailing bytes stay zero on a fresh ArrayBuffer.
      const buf = new ArrayBuffer(80);
      const snap = makeSpriteSnapshot({});
      mod.applyParamSnapshotToUbo(buf, SPRITE_UBO_SCHEMA, snap);
      const f32 = new Float32Array(buf);
      // colorTint slot 0 - default identity (1,1,1,1).
      expect(Array.from(f32.slice(0, 4))).toEqual([1, 1, 1, 1]);
      // region slot 1 - identity (no flip applied at this layer).
      expect(Array.from(f32.slice(4, 8))).toEqual([0, 0, 1, 1]);
      // pivotAndSize slot 2 - pivot=(0.5,0.5); .zw=(1,1) dead-slot placeholder.
      expect(Array.from(f32.slice(8, 12))).toEqual([0.5, 0.5, 1, 1]);
      // slicesAndMode slot 3 - no slices, all zero.
      expect(Array.from(f32.slice(12, 16))).toEqual([0, 0, 0, 0]);
      // Trailing 16 B left untouched (overlay semantics, charter P4).
      expect(Array.from(f32.slice(16, 20))).toEqual([0, 0, 0, 0]);
    });

    it('(2) stretch slices [.25,.25,.25,.25] -> slot 3 verbatim; slots 0..2 byte-stable vs baseline', () => {
      if (typeof mod.applyParamSnapshotToUbo !== 'function') {
        throw new Error('applyParamSnapshotToUbo not exported');
      }
      const baseBuf = new ArrayBuffer(80);
      mod.applyParamSnapshotToUbo(baseBuf, SPRITE_UBO_SCHEMA, makeSpriteSnapshot({}));
      const stretchBuf = new ArrayBuffer(80);
      mod.applyParamSnapshotToUbo(
        stretchBuf,
        SPRITE_UBO_SCHEMA,
        makeSpriteSnapshot({ slices: [0.25, 0.25, 0.25, 0.25] }),
      );
      const baseF32 = new Float32Array(baseBuf);
      const stretchF32 = new Float32Array(stretchBuf);
      // First 48 B (slots 0..2, 12 floats) byte-stable across slices presence
      // (plan-strategy section D-7 isolation: 9-slice expressions live only in
      // slot 3).
      expect(Array.from(stretchF32.slice(0, 12))).toEqual(Array.from(baseF32.slice(0, 12)));
      // Slot 3 verbatim copy of slicesAndMode (sliceMode=0 stretch).
      expect(Array.from(stretchF32.slice(12, 16))).toEqual([0.25, 0.25, 0.25, 0.25]);
    });

    it('(3) tile slicesAndMode [.25,.25,.25,-.25] -> slot 3 carries sentinel (w negative)', () => {
      if (typeof mod.applyParamSnapshotToUbo !== 'function') {
        throw new Error('applyParamSnapshotToUbo not exported');
      }
      const buf = new ArrayBuffer(80);
      // Extract folds sliceMode=1 into a negative slicesAndMode.w (plan-
      // strategy D-3 sentinel); record writes the snapshot verbatim.
      mod.applyParamSnapshotToUbo(
        buf,
        SPRITE_UBO_SCHEMA,
        makeSpriteSnapshot({ slices: [0.25, 0.25, 0.25, -0.25] }),
      );
      const baseBuf = new ArrayBuffer(80);
      mod.applyParamSnapshotToUbo(baseBuf, SPRITE_UBO_SCHEMA, makeSpriteSnapshot({}));
      const f32 = new Float32Array(buf);
      const baseF32 = new Float32Array(baseBuf);
      // First 48 B still byte-identical to baseline across slot 3 changes.
      expect(Array.from(f32.slice(0, 12))).toEqual(Array.from(baseF32.slice(0, 12)));
      // Slot 3 carries the tile sentinel.
      expect(f32[12]).toBe(0.25);
      expect(f32[13]).toBe(0.25);
      expect(f32[14]).toBe(0.25);
      expect(f32[15]).toBe(-0.25);
    });

    it('flipped region [0.5,0,-0.5,1] -> slot 1 carries flip-folded coords verbatim (D-8)', () => {
      if (typeof mod.applyParamSnapshotToUbo !== 'function') {
        throw new Error('applyParamSnapshotToUbo not exported');
      }
      const buf = new ArrayBuffer(80);
      // Extract folds flipX into region (region.x += region.z; region.z = -region.z).
      // Starting from identity region [0,0,1,1], flipX yields [1,0,-1,1]; the
      // snapshot reaches the writer with the fold already applied.
      mod.applyParamSnapshotToUbo(
        buf,
        SPRITE_UBO_SCHEMA,
        makeSpriteSnapshot({ region: [1, 0, -1, 1] }),
      );
      const f32 = new Float32Array(buf);
      expect(Array.from(f32.slice(4, 8))).toEqual([1, 0, -1, 1]);
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
      layer: 0,
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

// --- from feat-20260625-refactor-sprite-as-transparent-mesh M1 / w1 ---
{
  // Generic std140 UBO writer driven by derive(paramSchema).uboLayout.entries.
  //
  // Plan anchors:
  //   - plan-strategy section 2 D-2: the inline overlay at render-system-
  //     record.ts:4334-4374 is generalised to read every uboLayout.entries
  //     std140 offset and write paramSnapshot[name] (numeric / numeric[])
  //     into the payload buffer. standard-pbr stays byte-identical to the
  //     pre-feat buildPbrMaterialUboPayload output (covered by the w2 suite
  //     appended below); sprite-shaped layouts (4 x vec4 stride 16) are
  //     honoured per offset/size declared by derive.
  //   - requirements AC-03 sets buildSpriteMaterialUboPayload ablation as
  //     the M3 deliverable; M1 only establishes that the generic writer can
  //     produce sprite-shaped bytes from paramSnapshot alone (no asset get,
  //     gate R-H from plan-strategy section 5.6 prevents reading internals).
  //
  // The suite reads render-system-record dynamically so it sits RED until
  // w3 lands. The expected helper is a pure function with the signature:
  //
  //   applyParamSnapshotToUbo(
  //     payload: ArrayBuffer,
  //     paramSchema: readonly ParamSchemaEntry[] | undefined,
  //     paramSnapshot: { readonly [name: string]: number | readonly number[] }
  //       | undefined,
  //   ): void
  //
  // The helper is internal (export-for-test) and walks
  // derive(paramSchema).uboLayout.entries to dispatch each field by its
  // std140 offset. Vec / color entries pull numeric arrays from the
  // snapshot; f32 / i32 / u32 entries pull scalars.

  const mod = recordModule as unknown as {
    applyParamSnapshotToUbo?: (
      payload: ArrayBuffer,
      paramSchema: readonly ParamSchemaEntry[] | undefined,
      paramSnapshot:
        | Readonly<Record<string, number | readonly number[] | string | undefined>>
        | undefined,
    ) => void;
  };

  // Sprite-shaped paramSchema: four vec4 entries at std140 offsets
  // 0 / 16 / 32 / 48; total = 64 bytes rounded to 16 (still 64).
  // This mirrors the post-ablation sprite.wgsl UBO layout (M3 / w11) but
  // the writer must already accept it in M1 so M3 only needs to wire it in.
  const SPRITE_SHAPED_SCHEMA: readonly ParamSchemaEntry[] = [
    { name: 'colorTint', type: 'vec4', default: [1, 1, 1, 1] },
    { name: 'region', type: 'vec4', default: [0, 0, 1, 1] },
    { name: 'pivotAndSize', type: 'vec4', default: [0.5, 0.5, 1, 1] },
    { name: 'slicesAndMode', type: 'vec4', default: [0, 0, 0, 0] },
  ];

  describe('applyParamSnapshotToUbo: sprite-shaped 4x vec4 std140 (M1 / w1)', () => {
    it('export: applyParamSnapshotToUbo helper is exported from render-system-record', () => {
      expect(typeof mod.applyParamSnapshotToUbo).toBe('function');
    });

    it('derive(uboLayout).entries produces four vec4 entries at offsets 0/16/32/48', () => {
      const { uboLayout } = derive(SPRITE_SHAPED_SCHEMA);
      expect(uboLayout.entries.length).toBe(4);
      expect(uboLayout.entries[0]).toMatchObject({
        name: 'colorTint',
        offset: 0,
        size: 16,
        type: 'vec4',
      });
      expect(uboLayout.entries[1]).toMatchObject({
        name: 'region',
        offset: 16,
        size: 16,
        type: 'vec4',
      });
      expect(uboLayout.entries[2]).toMatchObject({
        name: 'pivotAndSize',
        offset: 32,
        size: 16,
        type: 'vec4',
      });
      expect(uboLayout.entries[3]).toMatchObject({
        name: 'slicesAndMode',
        offset: 48,
        size: 16,
        type: 'vec4',
      });
      // std140 struct alignment rounds up to 16 -- 64 already aligns.
      expect(uboLayout.totalBytes).toBe(64);
    });

    it('writes each vec4 at its std140 offset (byte-exact, no f32-slot heuristic)', () => {
      if (typeof mod.applyParamSnapshotToUbo !== 'function') {
        throw new Error('helper not exported yet (red phase)');
      }
      const buf = new ArrayBuffer(64);
      // Values chosen to round-trip exactly in IEEE 754 f32 (powers of 2 /
      // sums thereof) so we can assert with toEqual; the non-exact-encoding
      // values (0.1 / 0.2 / 0.3) would lose the trailing bit on f32 storage
      // and force a toBeCloseTo, weakening the byte-level signal.
      const snapshot = {
        colorTint: [0.25, 0.5, 0.75, 1] as readonly number[],
        region: [0.125, 0.25, 0.5, 0.75] as readonly number[],
        pivotAndSize: [0.5, 0.5, 2, 4] as readonly number[],
        slicesAndMode: [0.125, 0.125, 0.125, -0.125] as readonly number[],
      };
      mod.applyParamSnapshotToUbo(buf, SPRITE_SHAPED_SCHEMA, snapshot);
      const f32 = new Float32Array(buf);
      // colorTint at offset 0
      expect(Array.from(f32.slice(0, 4))).toEqual([0.25, 0.5, 0.75, 1]);
      // region at offset 16 (f32 index 4)
      expect(Array.from(f32.slice(4, 8))).toEqual([0.125, 0.25, 0.5, 0.75]);
      // pivotAndSize at offset 32 (f32 index 8)
      expect(Array.from(f32.slice(8, 12))).toEqual([0.5, 0.5, 2, 4]);
      // slicesAndMode at offset 48 (f32 index 12) -- carries 9-slice tile
      // sentinel via negative w (verbatim from snapshot, charter P3 explicit
      // signal vs the legacy spriteFields.sliceMode side channel).
      expect(Array.from(f32.slice(12, 16))).toEqual([0.125, 0.125, 0.125, -0.125]);
    });

    it('missing snapshot fields leave existing bytes untouched (overlay semantics)', () => {
      if (typeof mod.applyParamSnapshotToUbo !== 'function') {
        throw new Error('helper not exported yet (red phase)');
      }
      const buf = new ArrayBuffer(64);
      const pre = new Float32Array(buf);
      // Seed the buffer with sentinel pre-values; the writer must only
      // touch offsets it has snapshot values for (charter P4 -- the writer
      // is an overlay, not a clear-and-fill stamp).
      pre[0] = 9;
      pre[1] = 9;
      pre[2] = 9;
      pre[3] = 9;
      pre[12] = 7;
      pre[13] = 7;
      pre[14] = 7;
      pre[15] = 7;
      const snapshot = {
        region: [0.125, 0.25, 0.5, 0.75] as readonly number[],
        pivotAndSize: [0.5, 0.5, 2, 4] as readonly number[],
      };
      mod.applyParamSnapshotToUbo(buf, SPRITE_SHAPED_SCHEMA, snapshot);
      const f32 = new Float32Array(buf);
      // colorTint (no snapshot value) preserved
      expect(Array.from(f32.slice(0, 4))).toEqual([9, 9, 9, 9]);
      // region written
      expect(Array.from(f32.slice(4, 8))).toEqual([0.125, 0.25, 0.5, 0.75]);
      // pivotAndSize written
      expect(Array.from(f32.slice(8, 12))).toEqual([0.5, 0.5, 2, 4]);
      // slicesAndMode (no snapshot value) preserved
      expect(Array.from(f32.slice(12, 16))).toEqual([7, 7, 7, 7]);
    });

    it('no-op when paramSchema or paramSnapshot is undefined', () => {
      if (typeof mod.applyParamSnapshotToUbo !== 'function') {
        throw new Error('helper not exported yet (red phase)');
      }
      const buf = new ArrayBuffer(64);
      const pre = new Float32Array(buf);
      for (let i = 0; i < 16; i++) pre[i] = i + 1;
      const snapshot = { colorTint: [0.5, 0.5, 0.5, 0.5] as readonly number[] };
      mod.applyParamSnapshotToUbo(buf, undefined, snapshot);
      // Schema undefined -> no writes.
      for (let i = 0; i < 16; i++) expect(pre[i]).toBe(i + 1);
      mod.applyParamSnapshotToUbo(buf, SPRITE_SHAPED_SCHEMA, undefined);
      // Snapshot undefined -> no writes.
      for (let i = 0; i < 16; i++) expect(pre[i]).toBe(i + 1);
    });
  });
}

// --- from feat-20260625-refactor-sprite-as-transparent-mesh M1 / w2 ---
{
  // standard-pbr regression: the generic writer over the engine-shipped
  // default-standard-pbr.wgsl.meta.json paramSchema (10 numeric entries
  // std140-packed into 80 B) must produce byte-identical output to
  // buildPbrMaterialUboPayload. This is the gate plan-strategy section 2
  // D-2 sets so the generic writer can replace the inline overlay without
  // perturbing PBR rendering. RED until w3 lands the helper.

  const mod = recordModule as unknown as {
    applyParamSnapshotToUbo?: (
      payload: ArrayBuffer,
      paramSchema: readonly ParamSchemaEntry[] | undefined,
      paramSnapshot:
        | Readonly<Record<string, number | readonly number[] | string | undefined>>
        | undefined,
    ) => void;
    buildPbrMaterialUboPayload?: (material: MaterialSnapshot) => ArrayBuffer;
  };

  // Mirror the engine-shipped default-standard-pbr.wgsl.meta.json schema
  // (the on-disk SSOT; inline here to keep the unit suite free of asset
  // loads).
  const STANDARD_PBR_SCHEMA: readonly ParamSchemaEntry[] = [
    { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
    { name: 'metallic', type: 'f32', default: 0 },
    { name: 'roughness', type: 'f32', default: 0.5 },
    { name: 'metallicChannel', type: 'f32', default: 2 },
    { name: 'roughnessChannel', type: 'f32', default: 1 },
    { name: 'aoChannel', type: 'f32', default: 0 },
    { name: 'extraChannel', type: 'f32', default: 0 },
    { name: 'emissive', type: 'vec3', default: [0, 0, 0] },
    { name: 'emissiveIntensity', type: 'f32', default: 0 },
    { name: 'occlusionStrength', type: 'f32', default: 1 },
  ];

  describe('applyParamSnapshotToUbo: standard-pbr byte-identical via derive (M1 / w2)', () => {
    it('derive(standard-pbr).uboLayout matches the 80 B layout the inline PBR writer uses', () => {
      const { uboLayout } = derive(STANDARD_PBR_SCHEMA);
      expect(uboLayout.totalBytes).toBe(80);
      const byName = new Map(uboLayout.entries.map((e) => [e.name, e]));
      expect(byName.get('baseColor')?.offset).toBe(0);
      expect(byName.get('metallic')?.offset).toBe(16);
      expect(byName.get('roughness')?.offset).toBe(20);
      expect(byName.get('metallicChannel')?.offset).toBe(24);
      expect(byName.get('roughnessChannel')?.offset).toBe(28);
      expect(byName.get('aoChannel')?.offset).toBe(32);
      expect(byName.get('extraChannel')?.offset).toBe(36);
      // vec3 aligns to 16: cursor at 40 rounds up to 48.
      expect(byName.get('emissive')?.offset).toBe(48);
      expect(byName.get('emissiveIntensity')?.offset).toBe(60);
      expect(byName.get('occlusionStrength')?.offset).toBe(64);
    });

    it('generic writer over standard-pbr snapshot equals buildPbrMaterialUboPayload bytes', () => {
      if (typeof mod.applyParamSnapshotToUbo !== 'function') {
        throw new Error('helper not exported yet (red phase)');
      }
      if (typeof mod.buildPbrMaterialUboPayload !== 'function') {
        throw new Error('buildPbrMaterialUboPayload missing -- baseline broken');
      }
      // Construct a snapshot equivalent to the explicit material fields the
      // legacy helper consumes (baseColor / metallic / roughness / emissive /
      // emissiveIntensity / occlusionStrength + the channelMap defaults the
      // helper hard-codes).
      const baseColor = [0.5, 0.6, 0.7, 1] as readonly number[];
      const metallic = 0.1;
      const roughness = 0.4;
      const emissive = [0, 0, 0] as readonly number[];
      const emissiveIntensity = 0;
      const occlusionStrength = 1;
      const material = {
        baseColor,
        metallic,
        roughness,
        shadingModel: undefined,
        materialShaderId: 'forgeax::default-standard-pbr',
        paramSnapshot: undefined,
        emissive,
        emissiveIntensity,
        occlusionStrength,
      } as unknown as MaterialSnapshot;
      const baseline = mod.buildPbrMaterialUboPayload(material);
      // Construct the generic-writer output: start from the same explicit
      // PBR baseline, then apply the generic overlay over a paramSnapshot
      // carrying the same values. The overlay must not perturb any byte
      // the explicit baseline already wrote (charter P4 -- one writer, one
      // byte layout).
      const candidate = mod.buildPbrMaterialUboPayload(material);
      const snapshot = {
        baseColor,
        metallic,
        roughness,
        metallicChannel: 2,
        roughnessChannel: 1,
        aoChannel: 0,
        extraChannel: 0,
        emissive,
        emissiveIntensity,
        occlusionStrength,
      };
      mod.applyParamSnapshotToUbo(candidate, STANDARD_PBR_SCHEMA, snapshot);
      expect(new Uint8Array(candidate)).toEqual(new Uint8Array(baseline));
    });

    it('honours f32 slot offsets independently (slot 1 width = 4 floats from metallic..extraChannel)', () => {
      if (typeof mod.applyParamSnapshotToUbo !== 'function') {
        throw new Error('helper not exported yet (red phase)');
      }
      const buf = new ArrayBuffer(80);
      // f32-exact values (powers of 2 / sums) so we can assert toEqual on
      // every slot; toBeCloseTo would let off-by-one-bit drifts hide.
      const snapshot = {
        baseColor: [0.125, 0.25, 0.5, 1] as readonly number[],
        metallic: 0.5,
        roughness: 0.25,
        metallicChannel: 2,
        roughnessChannel: 1,
        aoChannel: 0,
        extraChannel: 0,
        emissive: [0.5, 0.5, 0.5] as readonly number[],
        emissiveIntensity: 1.5,
        occlusionStrength: 0.75,
      };
      mod.applyParamSnapshotToUbo(buf, STANDARD_PBR_SCHEMA, snapshot);
      const f32 = new Float32Array(buf);
      // baseColor occupies slot 0 (offset 0).
      expect(Array.from(f32.slice(0, 4))).toEqual([0.125, 0.25, 0.5, 1]);
      // 4 f32 channels packed at offset 16..36 -- distinct slots, not folded
      // into one vec4 (regression against legacy "first two f32 only"
      // overlay at render-system-record.ts:4334-4374).
      expect(f32[4]).toBe(0.5);
      expect(f32[5]).toBe(0.25);
      expect(f32[6]).toBe(2);
      expect(f32[7]).toBe(1);
      expect(f32[8]).toBe(0);
      expect(f32[9]).toBe(0);
      // emissive vec3 at offset 48 (f32 index 12).
      expect(Array.from(f32.slice(12, 15))).toEqual([0.5, 0.5, 0.5]);
      expect(f32[15]).toBe(1.5);
      expect(f32[16]).toBe(0.75);
    });
  });
}

// --- from feat-20260625-refactor-sprite-as-transparent-mesh M2 / w4 ---
{
  // AC-05: a MaterialSnapshot carrying transparent:true on its source pass
  // (recorded as MaterialSnapshot.transparent === true) must drive the LDR
  // split-pass decision and the blend-state lookup INDEPENDENTLY of the
  // shader id. The shader here is a generic 'forgeax::unlit-test' stub -- if
  // splitLdrSprite or the blend-state helper still keys on
  // 'forgeax::sprite', this suite stays red.
  //
  // Plan anchors:
  //   - requirements AC-05 (transparent decoupled from sprite shader)
  //   - plan-strategy section 2 D-3 (MaterialSnapshot.transparent
  //     transparent passthrough; split reads snapshot, not pass)
  //   - plan-strategy section 5.4 falsification check (the inline comment
  //     below records the variant: flipping blend src=one/dst=zero turns
  //     premultiplied alpha into hard-edge composition and fails the dawn
  //     msaa-sprite-pixel-diff baseline -- documenting that the pixel
  //     diff smoke is sensitive to blend factor correctness).
  //
  // The `computeSplitLdrSprite` helper is added by w7. The dynamic-import
  // sentinel keeps this suite red until it lands.
  //
  // feat-20260626-sprite-transparent-collapse M2 / M4: the sibling
  // `resolveTransparentBlendState` helper has been removed — premultiplied-
  // alpha blend factors are now pinned to the exported
  // `SPRITE_PREMULTIPLIED_ALPHA_BLEND` constant (the SSOT for asset-side
  // `renderState.blend`); the tests that exercised the resolver are deleted
  // and the falsification check now lives on the dawn pixel-diff
  // baseline + the asset-side constant export check.

  type DispatchEntryLike = {
    readonly source: {
      readonly material: MaterialSnapshot;
      readonly materials: readonly MaterialSnapshot[];
    };
  };

  const mod = recordModule as unknown as {
    computeSplitLdrSprite?: (
      validatedOrdered: readonly (DispatchEntryLike | undefined)[],
      tonemapActive: boolean,
    ) => boolean;
  };

  function makeTransparentSnap(opts: {
    transparent?: boolean;
    materialShaderId?: string;
  }): MaterialSnapshot {
    return {
      baseColor: [1, 1, 1, 1] as const,
      metallic: 0,
      roughness: 1,
      shadingModel: undefined,
      materialShaderId: opts.materialShaderId ?? 'forgeax::unlit-test',
      paramSnapshot: {},
      ...(opts.transparent === true && { transparent: true }),
    } as unknown as MaterialSnapshot;
  }

  function makeValidatedEntry(material: MaterialSnapshot): DispatchEntryLike {
    return { source: { material, materials: [material] } };
  }

  describe('transparent decouples from sprite shader (M2 / w4, AC-05)', () => {
    it('export: computeSplitLdrSprite helper is exported from render-system-record', () => {
      expect(typeof mod.computeSplitLdrSprite).toBe('function');
    });

    it('non-sprite shader with transparent:true triggers LDR split', () => {
      if (typeof mod.computeSplitLdrSprite !== 'function') {
        throw new Error('computeSplitLdrSprite helper not exported yet (red phase)');
      }
      const transparentSnap = makeTransparentSnap({
        transparent: true,
        materialShaderId: 'forgeax::unlit-test',
      });
      const opaqueSnap = makeTransparentSnap({
        transparent: false,
        materialShaderId: 'forgeax::unlit-test',
      });
      // tonemapActive=false (LDR path) + a transparent entry in the
      // validated list -- the split decision must trip even though the
      // shader is not forgeax::sprite (AC-05 proves the decoupling).
      const split = mod.computeSplitLdrSprite(
        [makeValidatedEntry(opaqueSnap), makeValidatedEntry(transparentSnap)],
        false,
      );
      expect(split).toBe(true);
    });

    it('LDR split stays false on pure-opaque non-sprite list', () => {
      if (typeof mod.computeSplitLdrSprite !== 'function') {
        throw new Error('computeSplitLdrSprite helper not exported yet (red phase)');
      }
      const opaqueA = makeTransparentSnap({
        transparent: false,
        materialShaderId: 'forgeax::unlit-test',
      });
      const opaqueB = makeTransparentSnap({
        transparent: false,
        materialShaderId: 'forgeax::default-standard-pbr',
      });
      const split = mod.computeSplitLdrSprite(
        [makeValidatedEntry(opaqueA), makeValidatedEntry(opaqueB)],
        false,
      );
      expect(split).toBe(false);
    });

    it('HDR path (tonemapActive=true) suppresses split even with transparent entries', () => {
      if (typeof mod.computeSplitLdrSprite !== 'function') {
        throw new Error('computeSplitLdrSprite helper not exported yet (red phase)');
      }
      const transparentSnap = makeTransparentSnap({
        transparent: true,
        materialShaderId: 'forgeax::unlit-test',
      });
      const split = mod.computeSplitLdrSprite([makeValidatedEntry(transparentSnap)], true);
      expect(split).toBe(false);
    });

    it('M3 / w13: legacy sprite shadingModel without transparent:true does NOT trigger split (union arm deleted)', () => {
      if (typeof mod.computeSplitLdrSprite !== 'function') {
        throw new Error('computeSplitLdrSprite helper not exported yet (red phase)');
      }
      // feat-20260625-refactor-sprite-as-transparent-mesh M3 / w13 (D-3):
      // the M2 union (`transparent || shadingModel === 'sprite'`) is gone
      // — transparent is the single SSOT. A legacy snapshot still carrying
      // `shadingModel: 'sprite'` but no `transparent: true` declaration
      // MUST NOT trigger the LDR split (forces explicit transparent
      // attribution on the asset side; AC-04 / AC-05).
      const legacySpriteNoTransparent = {
        baseColor: [1, 1, 1, 1] as const,
        metallic: 0,
        roughness: 1,
        shadingModel: 'sprite',
        materialShaderId: 'forgeax::sprite',
        paramSnapshot: {},
      } as unknown as MaterialSnapshot;
      const splitWithoutTransparent = mod.computeSplitLdrSprite(
        [makeValidatedEntry(legacySpriteNoTransparent)],
        false,
      );
      expect(splitWithoutTransparent).toBe(false);

      // Same snapshot with `transparent: true` declared on the pass DOES
      // trigger the split (the only path that should).
      const spriteTransparent = {
        ...legacySpriteNoTransparent,
        transparent: true,
      } as unknown as MaterialSnapshot;
      const splitWithTransparent = mod.computeSplitLdrSprite(
        [makeValidatedEntry(spriteTransparent)],
        false,
      );
      expect(splitWithTransparent).toBe(true);
    });

    it('transparent:true resolves premultiplied-alpha blend state (src=one/dst=one-minus-src-alpha)', () => {
      // feat-20260626-sprite-transparent-collapse M2 / M4: the
      // `resolveTransparentBlendState` resolver is gone — premultiplied-alpha
      // factors are pinned to the exported `SPRITE_PREMULTIPLIED_ALPHA_BLEND`
      // constant (the asset-side SSOT for `renderState.blend`). This test
      // pins the constant's shape so a future maintainer flipping the color
      // blend to {src:'one', dst:'zero'} (opaque copy) still trips a unit
      // gate before the dawn msaa-sprite-pixel-diff smoke catches the
      // regression. AC-10 reaches the human arbiter through both paths.
      expect(SPRITE_PREMULTIPLIED_ALPHA_BLEND.color.srcFactor).toBe('one');
      expect(SPRITE_PREMULTIPLIED_ALPHA_BLEND.color.dstFactor).toBe('one-minus-src-alpha');
      expect(SPRITE_PREMULTIPLIED_ALPHA_BLEND.alpha.srcFactor).toBe('one');
      expect(SPRITE_PREMULTIPLIED_ALPHA_BLEND.alpha.dstFactor).toBe('one-minus-src-alpha');
    });
  });
}

// --- from feat-20260625-refactor-sprite-as-transparent-mesh M2 / w5 ---
{
  // AC-14: a transparent material whose target shader pipeline is not yet
  // cached must surface a structured RhiError (.code / .expected / .hint),
  // NOT silently fall back to the debug-pink placeholder. The generic
  // materialShaderId path is the only resolver -- post feat-20260625 M3 / w14
  // the dedicated sprite PSO fields are gone; sprite uses the same generic
  // getMaterialShaderPipeline path every transparent material consumes.
  //
  // The helper signature added by w7:
  //
  //   selectMaterialPipelineForRender({
  //     materialShaderId, isHdr, renderState, topology, indexFormat,
  //     variantSet, sampleCount,
  //     getMaterialShaderPipeline, // injected at call site (runtime.getMaterialShaderPipeline)
  //   }): Result<RenderPipeline, RhiError>
  //
  // Plan anchors:
  //   - requirements AC-14 (structured RhiError, no debug-pink fall-through)
  //   - plan-strategy section 8.3 (error info AI users consume via property
  //     access: .code / .expected / .hint; charter P3 explicit failure)
  //   - plan-strategy section 2 D-3 (transparent flows through the generic
  //     materialShaderId path; the resolver therefore never branches on
  //     'forgeax::sprite' to recover)

  type SelectArgs = {
    readonly materialShaderId: string;
    readonly isHdr: boolean;
    readonly renderState: {
      readonly blend?: {
        readonly color: { readonly srcFactor: string; readonly dstFactor: string };
        readonly alpha: { readonly srcFactor: string; readonly dstFactor: string };
      };
    };
    readonly topology: 'triangle-list' | 'triangle-strip';
    readonly indexFormat: 'uint16' | 'uint32';
    readonly variantSet: string;
    readonly sampleCount: number;
    readonly getMaterialShaderPipeline: (
      materialShaderId: string,
      isHdr: boolean,
    ) => unknown | null;
  };

  const mod = recordModule as unknown as {
    selectMaterialPipelineForRender?: (
      args: SelectArgs,
    ) =>
      | { readonly ok: true; readonly value: unknown }
      | { readonly ok: false; readonly error: { code: string; expected: string; hint: string } };
  };

  function makeSelectArgs(overrides: {
    materialShaderId?: string;
    getter?: SelectArgs['getMaterialShaderPipeline'];
  }): SelectArgs {
    const pipelineStub = { __pipeline: true };
    return {
      materialShaderId: overrides.materialShaderId ?? 'forgeax::unlit-test',
      isHdr: false,
      renderState: {
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
        },
      },
      topology: 'triangle-list',
      indexFormat: 'uint16',
      variantSet: '',
      sampleCount: 1,
      getMaterialShaderPipeline: overrides.getter ?? (() => pipelineStub),
    };
  }

  describe('selectMaterialPipelineForRender pipeline-miss surfaces RhiError (M2 / w5, AC-14)', () => {
    it('export: selectMaterialPipelineForRender helper is exported from render-system-record', () => {
      expect(typeof mod.selectMaterialPipelineForRender).toBe('function');
    });

    it('cache miss returns ok=false with structured RhiError (.code/.expected/.hint)', () => {
      if (typeof mod.selectMaterialPipelineForRender !== 'function') {
        throw new Error('selectMaterialPipelineForRender helper not exported yet (red phase)');
      }
      const result = mod.selectMaterialPipelineForRender(
        makeSelectArgs({
          materialShaderId: 'forgeax::unlit-test',
          getter: () => null, // simulate cache miss / async build pending
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable -- result.ok asserted false above');
      const err = result.error;
      // charter P3 -- AI users branch on .code (string union member from
      // RhiErrorCode) and consume .expected / .hint as property reads;
      // they do NOT parse the human-facing .message string.
      expect(typeof err.code).toBe('string');
      expect(err.code.length).toBeGreaterThan(0);
      expect(typeof err.expected).toBe('string');
      expect(err.expected.length).toBeGreaterThan(0);
      expect(typeof err.hint).toBe('string');
      expect(err.hint.length).toBeGreaterThan(0);
    });

    it('cache miss .hint references the missing materialShaderId (AI users locate the cache key)', () => {
      if (typeof mod.selectMaterialPipelineForRender !== 'function') {
        throw new Error('selectMaterialPipelineForRender helper not exported yet (red phase)');
      }
      const result = mod.selectMaterialPipelineForRender(
        makeSelectArgs({
          materialShaderId: 'forgeax::missing-shader-id',
          getter: () => null,
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable -- result.ok asserted false above');
      // The shader id must appear in .hint (or .expected) so AI users can
      // grep the registry / pipeline cache straight from the structured
      // error -- not from a human-prose substring of .message.
      const exposed = `${result.error.hint} ${result.error.expected}`;
      expect(exposed).toContain('forgeax::missing-shader-id');
    });

    it('cache hit returns ok=true with the pipeline (no error path on success)', () => {
      if (typeof mod.selectMaterialPipelineForRender !== 'function') {
        throw new Error('selectMaterialPipelineForRender helper not exported yet (red phase)');
      }
      const pipeline = { __pipeline: 'forgeax::unlit-test-pso' };
      const result = mod.selectMaterialPipelineForRender(
        makeSelectArgs({
          materialShaderId: 'forgeax::unlit-test',
          getter: () => pipeline,
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable -- result.ok asserted true above');
      expect(result.value).toBe(pipeline);
    });

    it('cache miss does NOT silently substitute a debug-pink fallback pipeline', () => {
      if (typeof mod.selectMaterialPipelineForRender !== 'function') {
        throw new Error('selectMaterialPipelineForRender helper not exported yet (red phase)');
      }
      // Probe: the only branch the getter ever returns is the one passed in.
      // A cache miss must surface ok=false, NOT a synthesized pipeline value
      // that hides the miss (charter P3 -- the pre-M6 silent fallback to
      // pipelineState.standardPipeline* was exactly this anti-pattern, see
      // render-system-record.ts:5188-5198 commentary).
      let getterCallCount = 0;
      const result = mod.selectMaterialPipelineForRender(
        makeSelectArgs({
          materialShaderId: 'forgeax::unlit-test',
          getter: () => {
            getterCallCount += 1;
            return null;
          },
        }),
      );
      expect(getterCallCount).toBeGreaterThanOrEqual(1);
      expect(result.ok).toBe(false);
    });
  });
}

// ─── bug-20260622-tilemap-ysort-transparent-sort-modes-followup M2 m2-1 ───
//
// AC-04 (error signal SSOT) + AC-05 (LAYER_Y footY ordering) + R-2
// (mode=DISTANCE without a cameraPos falls back to the original list).
// `sortTransparentDispatch` itself is render-system.ts-private (closure-
// scoped helper invoked once per draw); the public-surface contract sits on
// `transparentSortEntries` (same primary `layer ASC` + secondary mode-formula
// + identical fallback semantics). Asserting against the exported helper
// gives byte-exact coverage of the 4-mode dispatch SSOT without instantiating
// the full RenderSystem (which would need a real GPU device + canvas, far
// outside unit-test scope; plan-strategy R-2 mitigation).
// biome-ignore lint/complexity/noUselessLoneBlockStatements: mirrors the per-test-file block-scope idiom this consolidated test file already uses (lines 31/159/261/501/633 -- each ported slab from a pre-consolidation file lives in its own block so helper names cannot collide).
{
  // --- AC-04: setTransparentSortConfig mode=99 -> Result.err with 4 SSOT fields ---
  describe('AC-04 setTransparentSortConfig mode=99 returns Result.err (KV untouched)', () => {
    it('Result.err carries code/expected/hint/detail + KV resource is NOT inserted', async () => {
      const { setTransparentSortConfig, TRANSPARENT_SORT_CONFIG_KEY } = await import(
        '@forgeax/engine-runtime'
      );
      const world = new World();
      // Pre-check: resource MUST be absent before the rejected call.
      expect(world.hasResource(TRANSPARENT_SORT_CONFIG_KEY)).toBe(false);

      const r = setTransparentSortConfig(world, { mode: 99, yzAlpha: 1.0 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      // The 4 SSOT fields locked by plan-strategy D-4. The math symbol
      // U+2208 ("is element of") goes through the ASCII `∈` escape
      // so this source file stays English-only per AGENTS.md §Conventions
      // (mirrors EXPECTED_EXPECTED in systems.unit.test.ts).
      expect(r.error.code).toBe('resource-invalid-value');
      expect(r.error.expected).toBe('mode ∈ {0, 1, 2, 3}');
      expect(r.error.hint).toBe('0=layer-z, 1=layer-y, 2=layer-yz, 3=distance');
      expect((r.error.detail as { receivedMode: number }).receivedMode).toBe(99);
      // The KV resource MUST stay un-inserted after a rejected write
      // (charter P3 -- structured failure, never silently coerce).
      expect(world.hasResource(TRANSPARENT_SORT_CONFIG_KEY)).toBe(false);
    });
  });

  // --- AC-05: mode=LAYER_Y, 3 entities footY=10/20/30 same layer -> 30/20/10 ---
  describe('AC-05 LAYER_Y footY ordering (same layer, deeper foot draws later)', () => {
    it('footY=10/20/30 same layer -> output order footY=30/20/10 (back-to-front)', async () => {
      const { setTransparentSortConfig, TRANSPARENT_SORT_MODE_LAYER_Y } = await import(
        '@forgeax/engine-runtime'
      );
      const { transparentSortEntries } = await import('../systems/transparent-sort');
      const world = new World();
      setTransparentSortConfig(world, {
        mode: TRANSPARENT_SORT_MODE_LAYER_Y,
        yzAlpha: 1.0,
      }).unwrap();

      // footY = posY - pivotY * sizeY. Pin pivotY=0 + sizeY=1 so footY === posY
      // -- the 10/20/30 numbers land verbatim, no algebra to second-guess.
      // mode=1 sortValue = -footY; ASC over [-10, -20, -30] yields entries
      // ordered footY=30, 20, 10 (deepest foot draws last = back-to-front).
      const entries = [
        {
          entityIndex: 0,
          materialHandle: 0,
          layer: 0,
          posX: 0,
          posY: 10,
          posZ: 0,
          pivotY: 0,
          sizeY: 1,
        },
        {
          entityIndex: 1,
          materialHandle: 0,
          layer: 0,
          posX: 0,
          posY: 20,
          posZ: 0,
          pivotY: 0,
          sizeY: 1,
        },
        {
          entityIndex: 2,
          materialHandle: 0,
          layer: 0,
          posX: 0,
          posY: 30,
          posZ: 0,
          pivotY: 0,
          sizeY: 1,
        },
      ];
      const sorted = transparentSortEntries(entries, world);
      expect(sorted.map((e) => e.posY)).toEqual([30, 20, 10]);
    });
  });

  // --- R-2: mode=DISTANCE without a cameraPos returns entries unchanged ---
  // plan-strategy R-2 risk mitigation: sortTransparentDispatch mode=3 +
  // cameras[0] missing must keep the original dispatch list (PR #401
  // baseline). transparentSortEntries surfaces the same fallback through
  // the public helper -- the 2-arg call (no cameraPos) falls through to
  // the mode=0 posZ formula; with posZ pinned constant the sort becomes
  // a no-op preserving insertion order (charter P3 deterministic output).
  describe('R-2 mode=DISTANCE + cameraPos absent preserves insertion order', () => {
    it('transparentSortEntries(entries, world) with mode=3 + no cameraPos = insertion order', async () => {
      const { setTransparentSortConfig, TRANSPARENT_SORT_MODE_DISTANCE } = await import(
        '@forgeax/engine-runtime'
      );
      const { transparentSortEntries } = await import('../systems/transparent-sort');
      const world = new World();
      setTransparentSortConfig(world, {
        mode: TRANSPARENT_SORT_MODE_DISTANCE,
        yzAlpha: 1.0,
      }).unwrap();

      // posZ pinned identical so the fallback (posZ ASC) is a no-op; the
      // assertion guards both R-2 (no crash, no reorder) and "fallback is
      // deterministic" together.
      const entries = [
        {
          entityIndex: 7,
          materialHandle: 0,
          layer: 0,
          posX: 1,
          posY: 0,
          posZ: 0,
          pivotY: 0.5,
          sizeY: 1,
        },
        {
          entityIndex: 8,
          materialHandle: 0,
          layer: 0,
          posX: 2,
          posY: 0,
          posZ: 0,
          pivotY: 0.5,
          sizeY: 1,
        },
        {
          entityIndex: 9,
          materialHandle: 0,
          layer: 0,
          posX: 3,
          posY: 0,
          posZ: 0,
          pivotY: 0.5,
          sizeY: 1,
        },
      ];
      const sorted = transparentSortEntries(entries, world);
      expect(sorted.map((e) => e.entityIndex)).toEqual([7, 8, 9]);
    });
  });
}
