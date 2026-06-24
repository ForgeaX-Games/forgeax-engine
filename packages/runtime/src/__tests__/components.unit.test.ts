// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
//
// Source files (N=21):
//   - packages/runtime/src/__tests__/children.test.ts
//   - packages/runtime/src/__tests__/components.test.ts
//   - packages/runtime/src/__tests__/hierarchy-components.test.ts
//   - packages/runtime/src/__tests__/inspector-frustum-stats.test.ts
//   - packages/runtime/src/__tests__/layer-component.test.ts
//   - packages/runtime/src/__tests__/mesh-renderer-pickable.test.ts
//   - packages/runtime/src/__tests__/pick.test.ts
//   - packages/runtime/src/__tests__/register-inspector.test.ts
//   - packages/runtime/src/__tests__/relationship-migration-regression.test.ts
//   - packages/runtime/src/__tests__/scene-defaults.test.ts
//   - packages/runtime/src/__tests__/sort-key-component.test.ts
//   - packages/runtime/src/components/__tests__/animation-player.test.ts
//   - packages/runtime/src/components/__tests__/camera.test.ts
//   - packages/runtime/src/components/__tests__/layer.test.ts
//   - packages/runtime/src/components/__tests__/mesh-renderer.test.ts
//   - packages/runtime/src/components/__tests__/skybox-background.test.ts
//   - packages/runtime/src/components/__tests__/sort-key.test.ts
//   - packages/runtime/src/components/__tests__/sprite-components-schema.test.ts
//   - packages/runtime/src/components/__tests__/sprite-playback-mode.test.ts
//   - packages/runtime/src/components/__tests__/transform.test.ts
//   - packages/runtime/test/mesh-renderer-multi-material.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import {
  createQueryState,
  defineComponent,
  ENTITY_NULL_RAW,
  Entity,
  type EntityHandle,
  queryRun,
  World,
} from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  Handle,
  Handler,
  InspectorError as InspectorErrorShape,
  LocalEntityId,
  MaterialAsset,
  MeshAsset,
  RegisterMethodResult,
  RegisterRootResult,
  Registry,
  SceneAsset,
  SceneEntity,
} from '@forgeax/engine-types';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import {
  ANTIALIAS_NONE,
  AnimationPlayer,
  BLOOM_DISABLED,
  CAMERA_PROJECTION_ORTHOGRAPHIC,
  CAMERA_PROJECTION_PERSPECTIVE,
  Camera,
  ChildOf,
  Children,
  DirectionalLight,
  Layer,
  MeshFilter,
  MeshRenderer,
  orthographic,
  perspective,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  type SkyboxMode,
  SortKey,
  SPRITE_PLAYBACK_MODE_CLAMP,
  SPRITE_PLAYBACK_MODE_LOOP,
  SpriteAnimation,
  type SpritePlaybackMode,
  SpriteRegionOverride,
  skyboxModeFromF32,
  spritePlaybackModeFromU32,
  TONEMAP_NONE,
  TONEMAP_REINHARD_EXTENDED,
  Transform,
  tonemapFromF32,
} from '../components';
import { type PickHit, pick } from '../pick';
import { PickError } from '../pick-errors';
import { extractFrame } from '../render-system-extract';
import type { Renderer } from '../renderer';
import { propagateTransforms } from '../systems/propagate-transforms';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

{
  // --- from children.test.ts ---
  // w13 - Children component schema migration to `array<entity>` (M3).
  //
  // Locks AC-05 (requirements.md): the `entities: 'array<entity>'` field
  // resolves to a fresh `Uint32Array` snapshot at the get-site, and the
  // snapshot length reflects the live element count after
  // `world.push(parent, Children, 'entities', child)` /
  // `world.pop(parent, Children, 'entities')` mutation routes through the
  // M0/M1/M2 BufferPool slot + sidecar count column infrastructure.
  //
  // feat-20260515-buffer-array-vocab-collapse M3 / w17: rewritten for the
  // collapsed-vocab API surface -- the `VarArrayView<Entity>` wrapper was
  // retired (M2 / w10). AI users mutate via the three `world` commands and
  // read through the read-only `Uint32Array` snapshot; `snap.length` is the
  // live count, `snap[i]` is the packed Entity u32.
  //
  // Test path note: project convention places runtime tests under
  // `src/__tests__/` (TS rootDir = `./src`). The plan-tasks.json target path
  // `packages/runtime/src/components/__tests__/children.test.ts` lives outside
  // rootDir and would not be picked up by `tsc -b`. The test file therefore
  // lands under `src/__tests__/` to match the existing
  // `hierarchy-components.test.ts` convention.

  describe('w13 - Children { entities: array<entity> } schema (AC-05)', () => {
    it('Children.schema.entities is the array<entity> keyword (no legacy `count` field)', () => {
      expect(Children.name).toBe('Children');
      expect(Object.keys(Children.schema).length).toBe(1);
      expect((Children.schema as Record<string, unknown>).entities).toBe('array<entity>');
      expect((Children.schema as Record<string, unknown>).count).toBeUndefined();
    });

    it('world.get(e, Children).entities is a Uint32Array snapshot with length reflecting initial payload', () => {
      const world = new World();
      const a = world.spawn().unwrap();
      const b = world.spawn().unwrap();
      // Entity is a brand over number (Entity = number & { __entity }); the
      // Uint32Array constructor accepts the brand directly through structural
      // widening, no cast needed.
      const parent = world
        .spawn({
          component: Children,
          data: {
            entities: new Uint32Array([a, b]),
          },
        })
        .unwrap();
      const got = world.get(parent, Children).unwrap();
      // `entities` is a fresh Uint32Array snapshot (D-4 no-cache).
      expect(got.entities.length).toBe(2);
      expect(got.entities[0]).toBe(a);
      expect(got.entities[1]).toBe(b);
    });

    it('world.push(parent, Children, ...) writes a new element + length reflects push/pop', () => {
      const world = new World();
      const a = world.spawn().unwrap();
      const b = world.spawn().unwrap();
      const c = world.spawn().unwrap();
      const parent = world
        .spawn({
          component: Children,
          data: { entities: new Uint32Array([a]) },
        })
        .unwrap();
      expect(world.get(parent, Children).unwrap().entities.length).toBe(1);
      world.push(parent, Children, 'entities', b).unwrap();
      world.push(parent, Children, 'entities', c).unwrap();
      expect(world.get(parent, Children).unwrap().entities.length).toBe(3);
      // Re-materialise the snapshot (D-4 no-cache) and confirm the writes landed.
      const snap = world.get(parent, Children).unwrap().entities;
      expect(snap.length).toBe(3);
      expect(snap[0]).toBe(a);
      expect(snap[1]).toBe(b);
      expect(snap[2]).toBe(c);
      // pop reduces snapshot length by 1.
      const popped: EntityHandle = world.pop(parent, Children, 'entities').unwrap();
      expect(popped).toBe(c);
      expect(world.get(parent, Children).unwrap().entities.length).toBe(2);
    });
  });
}

{
  // --- from components.test.ts ---
  // w7 - 5 component schema runtime registration + multi-component spawn (TDD red).
  //
  // Locks plan-strategy 7.2 naming + requirements IN-1 schema field set:
  //   Transform: pos:[f32x3] + quat:[f32x4] + scale:[f32x3]   = 10 f32
  //   MeshFilter:         assetHandle:'shared<MeshAsset>' (u32)
  //   MeshRenderer:       material:'array<shared<MaterialAsset>>' (u32) + frustumCulled:'u8' (M3 / w8)
  //   Camera:             fov:f32 + aspect:f32 + near:f32 + far:f32   = 4 f32
  //   DirectionalLight: direction:[f32x3] + color:[f32x3] + intensity:f32 = 7 f32
  //
  // Storage shape: forgeax ECS columns store component fields as flat scalars
  // (`Float32Array` / `Uint32Array`). Vector / quaternion fields are decomposed
  // into per-axis scalars at the schema level (e.g. `posX` / `posY` / `posZ`).
  // The 5-component schema picks names that AI users see in `world.get(e, T).x`
  // and `data: {...}` shapes.
  //
  // charter mapping: proposition 1 (single import + LSP hover discoverability) +
  // proposition 3 (machine-readable schema > prose) + proposition 5 (consistent
  // abstraction: components are flat-scalar SoA columns, not nested objects).

  describe('w7 - 5 component schemas register through defineComponent', () => {
    it('Transform has 10 local f32 fields + world array<f32,16> (pos/quat/scale + world)', () => {
      expect(Transform.name).toBe('Transform');
      expect(Object.keys(Transform.schema).length).toBe(11);
      // pos:3 f32
      expect(Transform.schema.posX).toBe('f32');
      expect(Transform.schema.posY).toBe('f32');
      expect(Transform.schema.posZ).toBe('f32');
      // quat:4 f32 (xyzw quaternion)
      expect(Transform.schema.quatX).toBe('f32');
      expect(Transform.schema.quatY).toBe('f32');
      expect(Transform.schema.quatZ).toBe('f32');
      expect(Transform.schema.quatW).toBe('f32');
      // scale:3 f32
      expect(Transform.schema.scaleX).toBe('f32');
      expect(Transform.schema.scaleY).toBe('f32');
      expect(Transform.schema.scaleZ).toBe('f32');
      // world: resolved mat4 (column-major 16 floats)
      expect(Transform.schema.world).toBe('array<f32, 16>');
    });

    it('MeshFilter has 1 shared<MeshAsset> field (assetHandle; M5 / w14)', () => {
      expect(MeshFilter.name).toBe('MeshFilter');
      expect(Object.keys(MeshFilter.schema).length).toBe(1);
      expect(MeshFilter.schema.assetHandle).toBe('shared<MeshAsset>');
    });

    it('MeshRenderer has 3 fields (materials + frustumCulled + pickable; feat-20260608 M2 / w7 multi-material array)', () => {
      expect(MeshRenderer.name).toBe('MeshRenderer');
      expect(Object.keys(MeshRenderer.schema).length).toBe(3);
      const schemaRecord = MeshRenderer.schema as Record<string, string>;
      expect(schemaRecord.materials).toBe('array<shared<MaterialAsset>>');
      expect(schemaRecord.frustumCulled).toBe('u8');
      expect(schemaRecord.pickable).toBe('u8');
    });

    it('Camera has 22 fields (21 f32 + autoAspect bool: perspective quartet + projection + ortho quartet + tonemap trio + antialias + bloom quartet + clear-color quartet + autoAspect)', () => {
      expect(Camera.name).toBe('Camera');
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
      // feat-20260519-tonemap-reinhard-mvp / M1 / T-M1.2: AC-01 + D-1.
      expect(Camera.schema.tonemap).toBe('f32');
      expect(Camera.schema.exposure).toBe('f32');
      expect(Camera.schema.whitePoint).toBe('f32');
      expect(Camera.schema.antialias).toBe('f32');
      // feat-20260531-bloom-first-declarative-render-graph-pass / w2.
      expect(Camera.schema.bloom).toBe('f32');
      expect(Camera.schema.bloomThreshold).toBe('f32');
      expect(Camera.schema.bloomIntensity).toBe('f32');
      expect(Camera.schema.bloomBlurRadius).toBe('f32');
      // feat-20260608-create-app-param-surface-trim / M1: clear-color quartet.
      expect(Camera.schema.clearR).toBe('f32');
      expect(Camera.schema.clearG).toBe('f32');
      expect(Camera.schema.clearB).toBe('f32');
      expect(Camera.schema.clearA).toBe('f32');
      // feat-20260617-host-engine-contract-and-video-cutscene / M3: aspect-sync
      // opt-out flag (bool column tier, not f32).
      expect(Camera.schema.autoAspect).toBe('bool');
    });

    it('DirectionalLight has 17 fields: 7 light f32 + castShadow bool + 9 merged shadow f32', () => {
      // feat-20260621: DirectionalLightShadow merged into DirectionalLight via castShadow toggle.
      expect(DirectionalLight.name).toBe('DirectionalLight');
      expect(Object.keys(DirectionalLight.schema).length).toBe(17);
      // 7 light fields
      expect(DirectionalLight.schema.directionX).toBe('f32');
      expect(DirectionalLight.schema.directionY).toBe('f32');
      expect(DirectionalLight.schema.directionZ).toBe('f32');
      expect(DirectionalLight.schema.colorR).toBe('f32');
      expect(DirectionalLight.schema.colorG).toBe('f32');
      expect(DirectionalLight.schema.colorB).toBe('f32');
      expect(DirectionalLight.schema.intensity).toBe('f32');
      // shadow gate + 9 merged shadow fields
      expect(DirectionalLight.schema.castShadow).toBe('bool');
      expect(DirectionalLight.schema.mapSize).toBe('f32');
      expect(DirectionalLight.schema.cascadeCount).toBe('f32');
      expect(DirectionalLight.schema.splitLambda).toBe('f32');
      expect(DirectionalLight.schema.cascadeBlend).toBe('f32');
      expect(DirectionalLight.schema.depthBias).toBe('f32');
      expect(DirectionalLight.schema.normalBias).toBe('f32');
      expect(DirectionalLight.schema.nearPlane).toBe('f32');
      expect(DirectionalLight.schema.farPlane).toBe('f32');
      expect(DirectionalLight.schema.pcfKernelSize).toBe('f32');
    });

    it('all 5 components are frozen tokens with auto-incrementing .id', () => {
      expect(Object.isFrozen(Transform)).toBe(true);
      expect(Object.isFrozen(MeshFilter)).toBe(true);
      expect(Object.isFrozen(MeshRenderer)).toBe(true);
      expect(Object.isFrozen(Camera)).toBe(true);
      expect(Object.isFrozen(DirectionalLight)).toBe(true);
      for (const t of [Transform, MeshFilter, MeshRenderer, Camera, DirectionalLight]) {
        expect(typeof t.id).toBe('number');
        expect(t.id).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('w7 - world.spawn({ component, data }) accepts each of the 5 components', () => {
    it('spawn Transform succeeds and stores the 10 f32 values', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Transform,
          data: {
            posX: 1,
            posY: 2,
            posZ: 3,
            quatX: 0,
            quatY: 0,
            quatZ: 0,
            quatW: 1,
            scaleX: 1,
            scaleY: 1,
            scaleZ: 1,
          },
        })
        .unwrap();
      const r = world.get(e, Transform).unwrap();
      expect(r.posX).toBe(1);
      expect(r.quatW).toBe(1);
      expect(r.scaleZ).toBe(1);
    });

    it('spawn MeshFilter with HANDLE_CUBE-style u32 succeeds', () => {
      const world = new World();
      const e = world
        .spawn({
          component: MeshFilter,
          data: { assetHandle: 1 as Handle<'MeshAsset', 'shared'> },
        })
        .unwrap();
      const r = world.get(e, MeshFilter).unwrap();
      expect(r.assetHandle).toBe(1);
    });

    it('spawn MeshRenderer with a branded Handle<MaterialAsset> succeeds', () => {
      const world = new World();
      const e = world
        .spawn({
          component: MeshRenderer,
          data: {
            materials: [7 as Handle<'MaterialAsset', 'shared'>],
          },
        })
        .unwrap();
      const r = world.get(e, MeshRenderer).unwrap();
      expect(r.materials[0]).toBe(7);
    });

    it('spawn Camera with perspective parameters succeeds', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
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
        })
        .unwrap();
      const r = world.get(e, Camera).unwrap();
      expect(r.fov).toBeCloseTo(Math.PI / 4, 5);
      expect(r.far).toBe(100);
    });

    it('spawn DirectionalLight succeeds', () => {
      const world = new World();
      const e = world
        .spawn({
          component: DirectionalLight,
          data: {
            directionX: -0.5,
            directionY: -1,
            directionZ: -0.3,
            colorR: 1,
            colorG: 1,
            colorB: 1,
            intensity: 1,
          },
        })
        .unwrap();
      const r = world.get(e, DirectionalLight).unwrap();
      expect(r.intensity).toBe(1);
      expect(r.colorR).toBe(1);
    });

    it('multi-component spawn (Transform + MeshFilter + MeshRenderer + Camera) targets a single archetype', () => {
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
          { component: MeshFilter, data: { assetHandle: 1 as Handle<'MeshAsset', 'shared'> } },
          {
            component: MeshRenderer,
            data: {
              materials: [5 as Handle<'MaterialAsset', 'shared'>],
            },
          },
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
      expect(world.get(e, Transform).unwrap().posX).toBe(0);
      expect(world.get(e, MeshFilter).unwrap().assetHandle).toBe(1);
      expect(world.get(e, MeshRenderer).unwrap().materials[0]).toBe(5);
      expect(world.get(e, Camera).unwrap().far).toBe(100);
    });
  });

  describe('w7 - 5 component schemas remain unique tokens (no double registration / no name collision)', () => {
    it('5 components have 5 distinct .id values', () => {
      const ids = new Set([
        Transform.id,
        MeshFilter.id,
        MeshRenderer.id,
        Camera.id,
        DirectionalLight.id,
      ]);
      expect(ids.size).toBe(5);
    });

    it('user-defined component with the same name shape compiles independently', () => {
      // Using the same user-style schema to confirm the 5 engine tokens do not
      // collide with downstream user code at the registry level. The user token
      // is a fresh allocation; it does not interfere with the 5 engine tokens.
      const UserPos = defineComponent('UserPos', { x: { type: 'f32' } });
      expect(UserPos.id).not.toBe(Transform.id);
    });
  });
}

{
  // --- from hierarchy-components.test.ts ---
  // w5 - ChildOf / Children hierarchy component schema tests.
  //
  // Locks plan-strategy §D-P2 + requirements AC-12 schema field set:
  //   ChildOf:         { parent: 'entity' }
  //                    (M5 / w18 - migrated from raw 'ref' to schema-vocab
  //                    'entity' keyword; the parent column carries the encoded
  //                    Entity and the ECS does not bottom out dangling refs on
  //                    read - consumers check liveness themselves)
  //   Children:        { entities: 'array<entity>' } = variable-length
  //                    forward-list of child entity u32s (M3 / w13 of
  //                    feat-20260514-ecs-children-instances-managed-buffer-array
  //                    migrated from the legacy `count: 'u32'` advisory marker
  //                    to the real ECS-managed array storage path; AC-05).
  //                    The dedicated assertion lives in children.test.ts; this
  //                    file keeps an integration-shape spawn smoke for the
  //                    archetype-with-Children path.
  //
  // feat-20260601 M4: GlobalTransform is retired. The resolved world transform
  // is the `Transform.world` mat4 column; propagate + hierarchy compose coverage
  // lives in render-system-extract.test.ts (Transform.world parent x child).
  //
  // charter mapping: proposition 2 (Bevy ChildOf/Children industry analog) +
  // proposition 3 (machine-readable schema > prose: grep ChildOf.schema /
  // Children.schema recovers shape).

  describe('w5 - ChildOf / Children register through defineComponent', () => {
    it('ChildOf has 1 entity field (parent) (M5 / w18)', () => {
      expect(ChildOf.name).toBe('ChildOf');
      expect(Object.keys(ChildOf.schema).length).toBe(1);
      expect(ChildOf.schema.parent).toBe('entity');
    });

    it('Children has 1 array<entity> field (entities; M3 / w13 migration from legacy `count: u32`)', () => {
      expect(Children.name).toBe('Children');
      expect(Object.keys(Children.schema).length).toBe(1);
      expect((Children.schema as Record<string, unknown>).entities).toBe('array<entity>');
    });

    it('Transform carries the resolved world mat4 column (array<f32, 16>)', () => {
      // feat-20260601 M4: the world transform lives on Transform.world, not a
      // separate GlobalTransform component. The 10 local-TRS scalar columns plus
      // the `world: array<f32, 16>` resolved mat4 are the full shape.
      const tKeys = Object.keys(Transform.schema);
      expect(tKeys).toContain('world');
      expect(Transform.schema.world).toBe('array<f32, 16>');
      for (const k of [
        'posX',
        'posY',
        'posZ',
        'quatX',
        'quatY',
        'quatZ',
        'quatW',
        'scaleX',
        'scaleY',
        'scaleZ',
      ]) {
        expect(Transform.schema[k as keyof typeof Transform.schema]).toBe('f32');
      }
    });

    it('ChildOf / Children frozen tokens (schema immutable)', () => {
      expect(Object.isFrozen(ChildOf.schema)).toBe(true);
      expect(Object.isFrozen(Children.schema)).toBe(true);
    });

    it('spawn with ChildOf carries encoded Entity u32 through ref field round-trip', () => {
      const world = new World();
      const root = world
        .spawn({
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
        })
        .unwrap();
      const child = world
        .spawn(
          {
            component: Transform,
            data: {
              posX: 1,
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
          { component: ChildOf, data: { parent: root } },
        )
        .unwrap();
      const r = world.get(child, ChildOf);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.parent).toBe(root);
    });

    it('spawn with Transform + Children creates archetype with both components', () => {
      const world = new World();
      const root = world
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
          { component: Children, data: { entities: new Uint32Array([]) as never } },
        )
        .unwrap();
      const rt = world.get(root, Transform);
      expect(rt.ok).toBe(true);
      if (!rt.ok) return;
      expect(rt.value.quatW).toBe(1);
      expect(rt.value.scaleX).toBe(1);
      const rc = world.get(root, Children);
      expect(rc.ok).toBe(true);
      if (!rc.ok) return;
      // The variable-length entities snapshot starts empty for a fresh spawn
      // with a zero-length payload; the snapshot length equals the live count.
      // A dedicated push/pop suite lives in children.test.ts.
      expect(rc.value.entities.length).toBe(0);
    });

    // Silence unused-import lint if defineComponent elsewhere; keep the symbol
    // reference so the test file double-checks barrel wiring side-effects.
    it('defineComponent type is re-exported through @forgeax/engine-ecs', () => {
      expect(typeof defineComponent).toBe('function');
    });
  });
}

{
  // --- from inspector-frustum-stats.test.ts ---
  // inspector-frustum-stats.test.ts — frustum.stats inspector method test (feat-20260528-frustum-culling M5 / w15).
  //
  // TDD red phase: written before the `frustum.stats` inspector method is
  // registered in register-inspector.ts (w14). The test expects
  // `frustum.stats` to return `{ culled: number, total: number }` with both
  // fields being non-negative integers.
  //
  // charter P3: handler returns structured POD, no null/undefined sentinel;
  // P5: test calls through the same interface AI users call.

  class FakeRegistry implements Registry {
    readonly methodCalls: Array<{ method: string; handler: Handler }> = [];
    readonly rootCalls: Array<{ name: string }> = [];
    private readonly roots = new Set<string>();
    private readonly methods = new Set<string>();

    registerRoot(name: string, root: unknown): RegisterRootResult {
      this.rootCalls.push({ name });
      if (this.roots.has(name)) {
        return {
          ok: false,
          error: makeDuplicateError(`root "${name}" not yet registered`, name),
        };
      }
      this.roots.add(name);
      void root;
      return { ok: true, value: undefined };
    }

    registerMethod(method: string, handler: Handler): RegisterMethodResult {
      this.methodCalls.push({ method, handler });
      if (this.methods.has(method)) {
        return {
          ok: false,
          error: makeDuplicateError(`method "${method}" not yet registered`, method),
        };
      }
      this.methods.add(method);
      return { ok: true, value: undefined };
    }

    lookupRoot(name: string): unknown {
      return this.roots.has(name) ? {} : undefined;
    }

    lookupMethod(method: string): Handler | undefined {
      void method;
      return undefined;
    }

    registerMutatingMethods(): RegisterRootResult {
      return { ok: true, value: undefined };
    }

    lookupMutatingMethods(): ReadonlySet<string> {
      return EMPTY_MUTATING_METHODS;
    }
  }

  const EMPTY_MUTATING_METHODS: ReadonlySet<string> = new Set<string>();

  function makeDuplicateError(expected: string, name: string): InspectorErrorShape {
    return Object.assign(new Error('Console startup failed'), {
      code: 'console-startup-failed' as const,
      expected,
      hint: `duplicate on "${name}"`,
    });
  }

  function makeStubRenderer(overrides: Partial<Renderer> = {}): Renderer {
    return {
      backend: 'webgpu',
      frustumStats: { culled: 0, total: 0 },
      ...overrides,
    } as unknown as Renderer;
  }

  describe('frustum.stats inspector method', () => {
    it('is registered by registerRuntimeInspector when world is provided', async () => {
      const { registerRuntimeInspector } = await import('../register-inspector');
      const reg = new FakeRegistry();
      const engine = makeStubRenderer();
      // Pass undefined as world — frustum.stats does not require a World query;
      // it reads from engine.frustumStats directly.
      const result = registerRuntimeInspector(reg, engine);
      expect(result.ok).toBe(true);
      const methodNames = reg.methodCalls.map((c) => c.method);
      expect(methodNames).toContain('frustum.stats');
    });

    it('frustum.stats handler returns { culled, total }', async () => {
      const { registerRuntimeInspector } = await import('../register-inspector');
      const reg = new FakeRegistry();
      const engine = makeStubRenderer({ frustumStats: { culled: 3, total: 10 } });
      registerRuntimeInspector(reg, engine);
      const byName = new Map<string, Handler>(reg.methodCalls.map((c) => [c.method, c.handler]));
      const handler = byName.get('frustum.stats');
      expect(handler).toBeDefined();
      const result = handler?.(null) as { culled: number; total: number };
      expect(result).toBeDefined();
      expect(typeof result.culled).toBe('number');
      expect(typeof result.total).toBe('number');
      expect(result.culled).toBeGreaterThanOrEqual(0);
      expect(result.total).toBeGreaterThanOrEqual(0);
    });

    it('frustum.stats returns zeros when no frame has been drawn', async () => {
      const { registerRuntimeInspector } = await import('../register-inspector');
      const reg = new FakeRegistry();
      const engine = makeStubRenderer({ frustumStats: { culled: 0, total: 0 } });
      registerRuntimeInspector(reg, engine);
      const byName = new Map<string, Handler>(reg.methodCalls.map((c) => [c.method, c.handler]));
      const handler = byName.get('frustum.stats');
      const result = handler?.(null) as { culled: number; total: number };
      expect(result.culled).toBe(0);
      expect(result.total).toBe(0);
    });

    it('culled <= total always', async () => {
      const { registerRuntimeInspector } = await import('../register-inspector');
      const reg = new FakeRegistry();
      const engine = makeStubRenderer({ frustumStats: { culled: 5, total: 8 } });
      registerRuntimeInspector(reg, engine);
      const byName = new Map<string, Handler>(reg.methodCalls.map((c) => [c.method, c.handler]));
      const handler = byName.get('frustum.stats');
      const result = handler?.(null) as { culled: number; total: number };
      expect(result.culled).toBeLessThanOrEqual(result.total);
    });
  });
}

{
  // --- from layer-component.test.ts ---
  // w07 - Layer component schema spawn (TDD red).
  //
  // feat-20260520-2d-sprite-layer-mvp M-2 w07 / requirements AC-06 + AC-18 path (1).
  //
  // Coverage:
  //   - 4 explicit Layer values: {-100, 0, 100, 1000} (background / default /
  //     foreground / UI). i32 schema must preserve negative values via two's
  //     complement (no schema-layer mutate). plan-strategy §7 M-2 acceptance
  //     anchor AC-06.
  //   - 1 fallback case: entity spawned without Layer must round-trip via the
  //     existing 4-layer spawn fallback chain (feat-20260517-spawn-default-
  //     fallback) — value defaults to 0 (i32 scalar default), no fifth fallback
  //     layer introduced (AC-18 path (1)).
  //
  // charter mapping: F1 (single-import barrel discovery) + P3 (explicit defaults
  // — i32 zero default surfaces as a read-back value, not undefined) +
  // P4 (consistent abstraction — Layer is a generic ECS render component, not a
  // 2D-only special; 3D entities may also carry Layer).
  //
  // TDD red: imports Layer from the runtime barrel; w11 implements the
  // component file + barrel re-export to turn this green.

  describe('w07 - Layer = defineComponent("Layer", { value: "i32" })', () => {
    it('has schema { value: "i32" } (1 i32 field)', () => {
      expect(Layer.name).toBe('Layer');
      expect(Object.keys(Layer.schema).length).toBe(1);
      expect(Layer.schema.value).toBe('i32');
    });

    it("spawn Layer { value: -100 } (background) round-trips with two's complement", () => {
      const world = new World();
      const e = world.spawn({ component: Layer, data: { value: -100 } }).unwrap();
      const r = world.get(e, Layer).unwrap();
      expect(r.value).toBe(-100);
    });

    it('spawn Layer { value: 0 } (default / game layer) round-trips', () => {
      const world = new World();
      const e = world.spawn({ component: Layer, data: { value: 0 } }).unwrap();
      const r = world.get(e, Layer).unwrap();
      expect(r.value).toBe(0);
    });

    it('spawn Layer { value: 100 } (foreground) round-trips', () => {
      const world = new World();
      const e = world.spawn({ component: Layer, data: { value: 100 } }).unwrap();
      const r = world.get(e, Layer).unwrap();
      expect(r.value).toBe(100);
    });

    it('spawn Layer { value: 1000 } (UI) round-trips', () => {
      const world = new World();
      const e = world.spawn({ component: Layer, data: { value: 1000 } }).unwrap();
      const r = world.get(e, Layer).unwrap();
      expect(r.value).toBe(1000);
    });

    it('spawn payload omitting value falls through 4-layer chain to schema default 0 (AC-18 path 1)', () => {
      // Entity spawned without Layer payload — the existing 4-layer spawn
      // fallback chain (feat-20260517-spawn-default-fallback) fills i32
      // scalar default 0. No fifth fallback layer is introduced for this
      // feat (AC-18 path 1). The call below uses an empty `data: {}` payload
      // (no value field). The spawn must succeed (Result.ok) and the
      // round-tripped value must be exactly 0.
      const world = new World();
      const spawnResult = world.spawn({ component: Layer, data: {} });
      expect(spawnResult.ok).toBe(true);
      const e = spawnResult.unwrap();
      const r = world.get(e, Layer).unwrap();
      expect(r.value).toBe(0);
    });
  });
}

{
  // --- from mesh-renderer-pickable.test.ts ---
  // feat-20260529-picking-raycasting-screen-to-entity M3 / w10 — MeshRenderer.pickable u8 tests.
  //
  // Verifies: MeshRenderer carries a `pickable: 'u8'` schema field defaulting to 1; a bare
  // `world.spawn({ component: MeshRenderer, data: {} })` reads pickable === 1; `world.set`
  // round-trips 0 and 1; pickable and frustumCulled are independent orthogonal columns
  // (mutating one never reads / clobbers the other).
  //
  // Anchors: requirements AC-09 (pickable default 1, pickable=0 exits picking, orthogonal to
  // frustumCulled); research Finding 7 (frustumCulled:'u8' + default:1 verbatim template);
  // plan-strategy 5.6 don't-break (add-only).
  //
  // TDD red: pickable does not exist on the MeshRenderer schema yet when this file is first
  // committed, so the spawn-default + set round-trip + schema assertions fail. Green after w11.

  const asMat = (n: number) => n as Handle<'MaterialAsset', 'shared'>;

  describe('w10 — MeshRenderer.pickable u8 schema (AC-09)', () => {
    it('MeshRenderer.schema declares pickable as u8', () => {
      expect((MeshRenderer.schema as Record<string, string>).pickable).toBe('u8');
    });

    it('MeshRenderer.schema still declares frustumCulled as u8 (orthogonal column)', () => {
      expect((MeshRenderer.schema as Record<string, string>).frustumCulled).toBe('u8');
    });

    it('bare spawn reads pickable default 1', () => {
      const world = new World();
      const e = world.spawn({ component: MeshRenderer, data: {} }).unwrap();
      const r = world.get(e, MeshRenderer).unwrap() as { pickable: number };
      expect(r.pickable).toBe(1);
    });

    it('set(pickable: 0) then read 0', () => {
      const world = new World();
      const e = world.spawn({ component: MeshRenderer, data: {} }).unwrap();
      world.set(e, MeshRenderer, { pickable: 0 }).unwrap();
      const r = world.get(e, MeshRenderer).unwrap() as { pickable: number };
      expect(r.pickable).toBe(0);
    });

    it('set(pickable: 0) then set(pickable: 1) round-trips back to 1', () => {
      const world = new World();
      const e = world.spawn({ component: MeshRenderer, data: {} }).unwrap();
      world.set(e, MeshRenderer, { pickable: 0 }).unwrap();
      world.set(e, MeshRenderer, { pickable: 1 }).unwrap();
      const r = world.get(e, MeshRenderer).unwrap() as { pickable: number };
      expect(r.pickable).toBe(1);
    });
  });

  describe('w10 — pickable and frustumCulled are independent orthogonal columns (AC-09)', () => {
    it('mutating frustumCulled does not change pickable', () => {
      const world = new World();
      const e = world.spawn({ component: MeshRenderer, data: {} }).unwrap();
      world.set(e, MeshRenderer, { frustumCulled: 0 }).unwrap();
      const r = world.get(e, MeshRenderer).unwrap() as {
        pickable: number;
        frustumCulled: number;
      };
      expect(r.frustumCulled).toBe(0);
      expect(r.pickable).toBe(1);
    });

    it('mutating pickable does not change frustumCulled', () => {
      const world = new World();
      const e = world.spawn({ component: MeshRenderer, data: {} }).unwrap();
      world.set(e, MeshRenderer, { pickable: 0 }).unwrap();
      const r = world.get(e, MeshRenderer).unwrap() as {
        pickable: number;
        frustumCulled: number;
      };
      expect(r.pickable).toBe(0);
      expect(r.frustumCulled).toBe(1);
    });

    it('material handle is preserved alongside pickable mutation', () => {
      const world = new World();
      const e = world.spawn({ component: MeshRenderer, data: { materials: [asMat(7)] } }).unwrap();
      world.set(e, MeshRenderer, { pickable: 0 }).unwrap();
      const r = world.get(e, MeshRenderer).unwrap() as unknown as {
        materials: Uint32Array;
        pickable: number;
      };
      expect(r.materials[0]).toBe(7);
      expect(r.pickable).toBe(0);
    });
  });
}

{
  // --- from pick.test.ts ---
  // pick.test.ts — feat-20260529-picking-raycasting-screen-to-entity M3 / w12 (TDD red).
  //
  // Integration tests for the screen-to-entity `pick` free function:
  //   pick(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight)
  //     -> PickHit | undefined
  //
  // The deterministic scene is built with a bare `new World()` + a real
  // `AssetRegistry` (the `assets` param introduced by the 2026-05-29 replan: the
  // ray-AABB test needs `MeshAsset.aabb`, which lives ONLY in the AssetRegistry,
  // never on a world column). A full `createRenderer` is intentionally NOT used —
  // it requires a live WebGPU device unavailable in the `pnpm test:unit` project,
  // and `pick` only consumes an `AssetRegistry`, not the renderer. The registry
  // instance IS `renderer.assets` at the demo call site (w16), so the surface
  // under test is identical.
  //
  // Coverage (all pick acceptance criteria):
  //   (AC-06) nearest hit wins — two boxes along the ray, the closer one returns
  //   (AC-07) miss -> undefined (blank coordinate, no box on the ray)
  //   (AC-08) PickHit field shape {entity, point, distance} is exact + correct
  //   (AC-09) pickable=0 entity is skipped (and a pickable sibling still hits)
  //   (AC-10) orthographic camera picks via the parallel-ray path
  //   (AC-11) cameraEntity with no Camera -> PickError (structured, not undefined)
  //   (clamp) out-of-range / negative screen coords clamp to the viewport edge;
  //           NaN/Inf screen coords are sanitized (no NaN ray, no throw)
  //
  // Type-narrowing (AC-05 / AC-08) is asserted in a tsc-only block at the bottom:
  //   `const hit = pick(...)` needs no `as` cast, `hit.entity` is accessible after
  //   the `if (hit)` guard, and `hit.face` / `hit.uv` are compile errors.
  //
  // Anchors: requirements AC-05..AC-11; plan-strategy D-3 (GlobalTransform fallback
  // to Transform — the flat scene exercises the Transform path) + D-6 (PickHit
  // co-located in pick.ts) + 5.3 (all pick branches must-test); plan-tasks.json w12.
  //
  // TDD red: pick.ts does not exist yet when this file is first committed, so the
  // `../pick` import will not resolve. Green after w13.

  // feat-20260601 w12/w13: pick reads the resolved `Transform.world` mat4 written
  // by propagateTransforms (no GlobalTransform/Transform fallback). Every scene
  // runs propagate before pick so the world column is fresh; `runPick` folds the
  // propagate + pick pair so the test bodies stay focused on the pick contract.
  function runPick(
    world: World,
    camera: EntityHandle,
    x: number,
    y: number,
    w: number,
    h: number,
  ): PickHit | undefined {
    propagateTransforms(world);
    return pick(world, camera, x, y, w, h);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  function translateTransform(
    x: number,
    y: number,
    z: number,
  ): {
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
  } {
    return {
      posX: x,
      posY: y,
      posZ: z,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    };
  }

  /**
   * Register a mesh whose computed AABB spans [-0.5, 0.5]^3.
   *
   * The registry computes the AABB from `attributes.position` (an explicit `aabb` is
   * overwritten by `withMeshAabb`), so the position attribute carries the 8 cube corners.
   * `vertices` must be a multiple of the 12-float interleaved stride; a single 3-vertex
   * triangle (36 floats) satisfies the gate while the position attribute drives the AABB.
   */
  function registerBox(world: World, assets: AssetRegistry): Handle<'MeshAsset', 'shared'> {
    const vertices = new Float32Array([
      0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0,
      1, 0, 0, 0, 0,
    ]);
    // 8 cube corners spanning [-0.5, 0.5] on every axis -> computeAABB = [-0.5,-0.5,-0.5, 0.5,0.5,0.5]
    const positions = new Float32Array([
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5,
      -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ]);
    // catalog computes the local-space AABB (withMeshAabb); mint the augmented
    // payload on the world so resolveAssetHandle (used by pick) reads .aabb.
    const result = assets.catalog<MeshAsset>(AssetGuid.format(AssetGuid.random()), {
      kind: 'mesh',
      vertices,
      indices: new Uint16Array([0, 1, 2]),
      attributes: { position: positions },
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: vertices.length,
          topology: 'triangle-list',
        },
      ],
    });
    if (!result.ok) throw new Error('mesh catalog failed');
    return world.allocSharedRef('MeshAsset', result.value);
  }

  function registerMaterial(
    world: World,
    assets: AssetRegistry,
  ): Handle<'MaterialAsset', 'shared'> {
    const result = assets.catalog<MaterialAsset>(AssetGuid.format(AssetGuid.random()), {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::default-unlit',
          tags: { LightMode: 'Forward' },
          queue: 2000,
        },
      ],
      paramValues: { baseColor: [1, 1, 1] },
    });
    if (!result.ok) throw new Error('material catalog failed');
    return world.allocSharedRef('MaterialAsset', result.value);
  }

  interface Scene {
    world: World;
    assets: AssetRegistry;
    mesh: Handle<'MeshAsset', 'shared'>;
    material: Handle<'MaterialAsset', 'shared'>;
  }

  function makeScene(): Scene {
    const world = new World();
    const assets = new AssetRegistry(makeMockShaderRegistry());
    const mesh = registerBox(world, assets);
    const material = registerMaterial(world, assets);
    return { world, assets, mesh, material };
  }

  /** Spawn a perspective camera at (x,y,z) looking down -Z (identity rotation). */
  function spawnPerspectiveCamera(world: World, z: number): EntityHandle {
    return world
      .spawn(
        { component: Transform, data: translateTransform(0, 0, z) },
        {
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 1,
            near: 0.1,
            far: 100,
            projection: CAMERA_PROJECTION_PERSPECTIVE,
            left: -1,
            right: 1,
            bottom: -1,
            top: 1,
          },
        },
      )
      .unwrap();
  }

  /** Spawn an orthographic camera at (x,y,z) looking down -Z. */
  function spawnOrthographicCamera(world: World, z: number): EntityHandle {
    return world
      .spawn(
        { component: Transform, data: translateTransform(0, 0, z) },
        {
          component: Camera,
          data: {
            fov: 0,
            aspect: 1,
            near: 0.1,
            far: 100,
            projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
            left: -5,
            right: 5,
            bottom: -5,
            top: 5,
          },
        },
      )
      .unwrap();
  }

  /** Spawn a pickable box entity at (x,y,z). */
  function spawnBox(scene: Scene, x: number, y: number, z: number, pickable = 1): EntityHandle {
    return scene.world
      .spawn(
        { component: Transform, data: translateTransform(x, y, z) },
        { component: MeshFilter, data: { assetHandle: scene.mesh } },
        { component: MeshRenderer, data: { materials: [scene.material], pickable } },
      )
      .unwrap();
  }

  const VP = 600; // square viewport so screen-centre maps to the -Z axis ray

  // ── tests ────────────────────────────────────────────────────────────────

  describe('w12 — pick nearest hit (AC-06)', () => {
    it('returns the closer of two boxes along the ray', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const near = spawnBox(scene, 0, 0, 0); // closer to camera at z=5
      spawnBox(scene, 0, 0, -10); // farther along -Z

      const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
      expect(hit).toBeDefined();
      expect(hit?.entity).toBe(near);
    });

    it('returns the only box on the ray when a single candidate exists', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const box = spawnBox(scene, 0, 0, 0);

      const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
      expect(hit?.entity).toBe(box);
    });
  });

  describe('w12 — pick miss (AC-07)', () => {
    it('returns undefined when the ray hits nothing', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      // box pushed far off the -Z centre axis; the centre ray misses it
      spawnBox(scene, 50, 0, 0);

      const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
      expect(hit).toBeUndefined();
    });

    it('returns undefined when the world has no pickable meshes', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);

      const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
      expect(hit).toBeUndefined();
    });
  });

  describe('w12 — PickHit field shape (AC-08)', () => {
    it('carries entity + point (Vec3) + distance with correct values', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      const box = spawnBox(scene, 0, 0, 0);

      const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
      expect(hit).toBeDefined();
      if (!hit) throw new Error('expected hit');

      expect(hit.entity).toBe(box);
      // The ray origin is the unprojected NEAR-plane point (z = 5 - near = 4.9), not the
      // camera centre; the box front (+Z) face is at z=0.5, so the entry distance along the
      // ray is 4.9 - 0.5 = 4.4 (distance is measured from the near plane, charter D-NDC).
      expect(hit.distance).toBeGreaterThan(0);
      expect(hit.distance).toBeCloseTo(4.4, 1);
      // point = origin + dir * distance; for the centre ray it lands on the +Z face
      expect(hit.point.length).toBe(3);
      expect(hit.point[2]).toBeCloseTo(0.5, 1);
      expect(hit.point[0]).toBeCloseTo(0, 1);
      expect(hit.point[1]).toBeCloseTo(0, 1);
    });
  });

  describe('w12 — pickable filter (AC-09)', () => {
    it('skips a pickable=0 entity', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      spawnBox(scene, 0, 0, 0, 0); // pickable disabled

      const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
      expect(hit).toBeUndefined();
    });

    it('a pickable sibling still hits when a closer pickable=0 box is skipped', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      spawnBox(scene, 0, 0, 0, 0); // closer but not pickable -> skipped
      const farPickable = spawnBox(scene, 0, 0, -10, 1); // farther but pickable -> selected

      const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
      expect(hit?.entity).toBe(farPickable);
    });
  });

  describe('w12 — orthographic camera (AC-10)', () => {
    it('picks the box under the screen coordinate via the parallel ray path', () => {
      const scene = makeScene();
      const camera = spawnOrthographicCamera(scene.world, 5);
      const box = spawnBox(scene, 0, 0, 0);

      const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
      expect(hit?.entity).toBe(box);
    });

    it('orthographic ray translation: off-centre screen coordinate misses a centred box', () => {
      const scene = makeScene();
      const camera = spawnOrthographicCamera(scene.world, 5);
      spawnBox(scene, 0, 0, 0); // box at world origin, ortho span [-5,5]

      // top-left corner maps to world (-5, +5): far outside the unit box at origin
      const hit = runPick(scene.world, camera, 0, 0, VP, VP);
      expect(hit).toBeUndefined();
    });
  });

  describe('w12 — camera-missing precondition (AC-11)', () => {
    it('throws a structured PickError when cameraEntity has no Camera', () => {
      const scene = makeScene();
      // entity with a Transform but NO Camera component
      const notACamera = scene.world
        .spawn({ component: Transform, data: translateTransform(0, 0, 5) })
        .unwrap();
      spawnBox(scene, 0, 0, 0);

      expect(() => runPick(scene.world, notACamera, VP / 2, VP / 2, VP, VP)).toThrow(PickError);
    });

    it('the PickError carries .code / .expected / .hint / .detail', () => {
      const scene = makeScene();
      const notACamera = scene.world
        .spawn({ component: Transform, data: translateTransform(0, 0, 5) })
        .unwrap();

      try {
        runPick(scene.world, notACamera, VP / 2, VP / 2, VP, VP);
        throw new Error('expected PickError');
      } catch (e) {
        expect(e).toBeInstanceOf(PickError);
        const err = e as PickError;
        expect(err.code).toBe('camera-component-missing');
        expect(err.expected.length).toBeGreaterThan(0);
        expect(err.hint).toContain('world.set');
        expect(err.detail.cameraEntity).toBe(notACamera as unknown as number);
      }
    });
  });

  describe('w12 — coordinate clamp + sanitization (AC-11 boundary)', () => {
    it('clamps a negative / out-of-range coordinate to the viewport edge without throwing', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      spawnBox(scene, 0, 0, 0);

      // off-screen coordinates: must not throw and must not produce a NaN-driven hit
      expect(() => runPick(scene.world, camera, -100, -100, VP, VP)).not.toThrow();
      expect(() => runPick(scene.world, camera, VP + 999, VP + 999, VP, VP)).not.toThrow();
    });

    it('sanitizes NaN / Infinity screen coordinates (no throw, defined result)', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);
      spawnBox(scene, 0, 0, 0);

      expect(() => runPick(scene.world, camera, Number.NaN, 0, VP, VP)).not.toThrow();
      expect(() => runPick(scene.world, camera, Number.POSITIVE_INFINITY, 0, VP, VP)).not.toThrow();
    });
  });

  // ── tsc-only type-narrowing assertions (AC-05 / AC-08) ─────────────────────
  // These functions are never invoked at runtime; their sole purpose is to make
  // `pnpm run typecheck` (tsc -b) fail if the PickHit surface drifts.

  describe('w12 — type narrowing (AC-05 / AC-08, tsc)', () => {
    // The runtime body was a no-op probe wrapping `@ts-expect-error` calls; the
    // closure itself is what makes `pnpm run typecheck` fail if PickHit drifts.
    // Hoisting the closure to module scope keeps the typecheck signal without a
    // placeholder runtime assertion (feat-20260608-ci-time-cut).
    const _pickHitTypeProbe = (world: World, cam: EntityHandle): void => {
      // no `as` cast: pick is correctly typed as PickHit | undefined
      const hit = pick(world, cam, 0, 0, VP, VP);
      if (hit) {
        const e: EntityHandle = hit.entity;
        const d: number = hit.distance;
        const p: ArrayLike<number> = hit.point;
        void e;
        void d;
        void p;
        // @ts-expect-error — PickHit has no `face` field (AC-08)
        void hit.face;
        // @ts-expect-error — PickHit has no `uv` field (AC-08)
        void hit.uv;
      }
      // PickHit assignability sanity (no cast required)
      const explicit: PickHit | undefined = pick(world, cam, 1, 1, VP, VP);
      void explicit;
    };
    void _pickHitTypeProbe;

    it.todo(
      'PickHit narrows without a cast and rejects absent fields (typecheck-only via _pickHitTypeProbe)',
    );
  });

  describe('w12 — pick reads Transform.world for hierarchical entities (AC-05)', () => {
    it('picks a child box at its resolved world position (parent x child), not its local position', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);

      // Parent translates +X by 2; child local sits at the origin. The child's
      // world position is therefore (2,0,0) -- off the centre -Z ray. A pick
      // reading the LOCAL transform (origin) would (wrongly) hit; a pick reading
      // Transform.world (x=2) correctly misses the centre ray.
      const parent = scene.world
        .spawn({ component: Transform, data: translateTransform(2, 0, 0) })
        .unwrap();
      scene.world
        .spawn(
          { component: Transform, data: translateTransform(0, 0, 0) },
          { component: ChildOf, data: { parent } },
          { component: MeshFilter, data: { assetHandle: scene.mesh } },
          { component: MeshRenderer, data: { materials: [scene.material], pickable: 1 } },
        )
        .unwrap();

      // Centre ray (down -Z) misses the world-shifted child.
      expect(runPick(scene.world, camera, VP / 2, VP / 2, VP, VP)).toBeUndefined();
    });

    it('picks a child box whose world position lands back on the ray', () => {
      const scene = makeScene();
      const camera = spawnPerspectiveCamera(scene.world, 5);

      // Parent at -X 2, child local +X 2 -> child world (0,0,0) -> on the centre ray.
      const parent = scene.world
        .spawn({ component: Transform, data: translateTransform(-2, 0, 0) })
        .unwrap();
      const child = scene.world
        .spawn(
          { component: Transform, data: translateTransform(2, 0, 0) },
          { component: ChildOf, data: { parent } },
          { component: MeshFilter, data: { assetHandle: scene.mesh } },
          { component: MeshRenderer, data: { materials: [scene.material], pickable: 1 } },
        )
        .unwrap();

      const hit = runPick(scene.world, camera, VP / 2, VP / 2, VP, VP);
      expect(hit?.entity).toBe(child);
    });
  });
}

{
  // --- from register-inspector.test.ts ---
  // register-inspector.test - registerRuntimeInspector pure-function contract
  // (plan-tasks.json w4rt + plan-strategy §2.6 + AC-10 import-side-effect freeze).
  //
  // Coverage matrix (plan-tasks.json w4rt acceptanceCheck):
  //
  //   (a) Pure-function / zero-side-effect: importing '@forgeax/engine-runtime'
  //       does NOT call reg.registerRoot or reg.registerMethod (charter P3 +
  //       AC-10).
  //   (b) Happy path: registerRuntimeInspector(reg, engine) registers
  //       `renderer.info` (runtime-specific introspection method exposing
  //       at the CLI without owning a Renderer reference).
  //   (c) Fail-fast: a second registerRuntimeInspector(reg, engine) call on
  //       the same Registry instance returns Result.err with
  //       code='console-startup-failed' (plan-strategy §2.5).
  //
  // Red phase: written before packages/runtime/src/register-inspector.ts
  // exists (w4rb). vitest run will fail until w4rb lands. TDD red-green-refactor
  // per plan-strategy §5.1.
  //
  // charter: proposition 3 (Result<void, InspectorError>) + proposition 4
  // (explicit failure via closed union; reuses 'console-startup-failed' per
  // §2.11 wire-protocol freeze) + proposition 5 (Handler signature mirrors
  // the ecs / pack / gltf contributor families).

  // Local Registry stand-in: implements the `@forgeax/engine-types`
  // `Registry` interface without depending on `@forgeax/engine-console`
  // (the contributor function operates against the interface SSOT alone).
  class FakeRegistry implements Registry {
    readonly rootCalls: Array<{ name: string }> = [];
    readonly methodCalls: Array<{ method: string; handler: Handler }> = [];
    private readonly roots = new Set<string>();
    private readonly methods = new Set<string>();

    registerRoot(name: string, root: unknown): RegisterRootResult {
      this.rootCalls.push({ name });
      if (this.roots.has(name)) {
        return {
          ok: false,
          error: makeDuplicateError(`root "${name}" not yet registered`, name),
        };
      }
      this.roots.add(name);
      void root;
      return { ok: true, value: undefined };
    }

    registerMethod(method: string, handler: Handler): RegisterMethodResult {
      this.methodCalls.push({ method, handler });
      if (this.methods.has(method)) {
        return {
          ok: false,
          error: makeDuplicateError(`method "${method}" not yet registered`, method),
        };
      }
      this.methods.add(method);
      return { ok: true, value: undefined };
    }

    lookupRoot(name: string): unknown {
      return this.roots.has(name) ? {} : undefined;
    }

    lookupMethod(method: string): Handler | undefined {
      void method;
      return undefined;
    }
    // feat-20260517 D-5 stub — runtime register-inspector tests do not
    // exercise the mutating-methods accumulator (ECS plugin scope); empty
    // set keeps the interface contract satisfied at tsc level.
    registerMutatingMethods(): RegisterRootResult {
      return { ok: true, value: undefined };
    }
    lookupMutatingMethods(): ReadonlySet<string> {
      return EMPTY_MUTATING_METHODS;
    }
  }

  const EMPTY_MUTATING_METHODS: ReadonlySet<string> = new Set<string>();

  function makeDuplicateError(expected: string, name: string): InspectorErrorShape {
    return Object.assign(new Error('Console startup failed'), {
      code: 'console-startup-failed' as const,
      expected,
      hint: `call registerRuntimeInspector at most once per Registry instance (duplicate on "${name}")`,
    });
  }

  // Minimal Renderer stub for unit tests — only the fields the contributor
  // reads need to be populated (charter P5: structural typing over inheritance).
  function makeStubRenderer(): Renderer {
    return {
      backend: 'webgpu',
      frustumStats: { culled: 0, total: 0 },
    } as unknown as Renderer;
  }

  describe('registerRuntimeInspector — purity (AC-10)', () => {
    it('importing @forgeax/engine-runtime does not call registerRoot / registerMethod', async () => {
      const reg = new FakeRegistry();
      const mod = await import('../index');
      expect(reg.rootCalls).toHaveLength(0);
      expect(reg.methodCalls).toHaveLength(0);
      expect(typeof mod.registerRuntimeInspector).toBe('function');
    });
  });

  describe('registerRuntimeInspector — happy path', () => {
    it('registers renderer.info and frustum.stats methods', async () => {
      const { registerRuntimeInspector } = await import('../index');
      const reg = new FakeRegistry();
      const engine = makeStubRenderer();
      const result = registerRuntimeInspector(reg, engine);
      expect(result.ok).toBe(true);
      const methodNames = reg.methodCalls.map((c) => c.method);
      expect(methodNames).toContain('renderer.info');
      expect(methodNames).toContain('frustum.stats');
    });

    it('handler returns backend', async () => {
      const { registerRuntimeInspector } = await import('../index');
      const reg = new FakeRegistry();
      const engine = makeStubRenderer();
      registerRuntimeInspector(reg, engine);
      const byName = new Map<string, Handler>(reg.methodCalls.map((c) => [c.method, c.handler]));
      const info = byName.get('renderer.info')?.(null) as {
        backend: string;
      };
      expect(info.backend).toBe('webgpu');
    });

    it('renderer.info response does NOT contain rhiAvailable (feat-20260525-rhi-delete-webgl2-stub)', async () => {
      const { registerRuntimeInspector } = await import('../index');
      const reg = new FakeRegistry();
      const engine = makeStubRenderer();
      registerRuntimeInspector(reg, engine);
      const byName = new Map<string, Handler>(reg.methodCalls.map((c) => [c.method, c.handler]));
      const info = byName.get('renderer.info')?.(null) as Record<string, unknown>;
      expect(info).not.toHaveProperty('rhiAvailable');
    });
  });

  describe('registerRuntimeInspector — fail-fast on duplicate (R-REG-CONFLICT)', () => {
    it('returns Result.err with console-startup-failed on second call', async () => {
      const { registerRuntimeInspector } = await import('../index');
      const reg = new FakeRegistry();
      const engine = makeStubRenderer();
      const first = registerRuntimeInspector(reg, engine);
      expect(first.ok).toBe(true);
      const second = registerRuntimeInspector(reg, engine);
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error('unreachable');
      expect(second.error.code).toBe('console-startup-failed');
      expect(second.error.expected).toContain('renderer.info');
    });
  });
}

{
  // --- from relationship-migration-regression.test.ts ---
  // relationship-migration-regression.test.ts -- unit project (t21, M4).
  // Zero-regression + auto-sync verification for the ChildOf/Children
  // relationship migration (t20).
  //
  // Two orthogonal guarantees after ChildOf gained its `relationship` block:
  //   AC-25 reader path unchanged -- propagateTransforms still walks ChildOf.parent
  //     upward and composes child.Transform.world = parent.world x
  //     compose(child local). The migration must NOT alter this output.
  //   AC-25 mirror auto-maintained -- spawning / removing / reparenting ChildOf
  //     now auto-updates the parent's Children.entities list (the OOS-10 manual-
  //     sync contract is retired). This is the new behaviour the migration adds.
  //
  // CPU-only (no GPU access): propagateTransforms is pure matrix math and the
  // bidirectional sync is pure ECS bookkeeping, so this runs in the unit layer
  // alongside the pixel-readback propagate coverage in the dawn layer (AC-04).

  function transformData(posX: number, posY: number, posZ: number) {
    return {
      posX,
      posY,
      posZ,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      scaleX: 1,
      scaleY: 1,
      scaleZ: 1,
    };
  }

  describe('relationship-migration-regression (t21 / AC-25 / AC-26)', () => {
    it('ChildOf declares the Children relationship mirror block', () => {
      expect(ChildOf.relationship).toEqual({
        mirror: 'Children',
        field: 'entities',
        exclusive: true,
        linkedSpawn: true,
      });
    });

    it('propagateTransforms reader path unchanged: child composes parent x local translation', () => {
      const world = new World();
      const parent = world.spawn({ component: Transform, data: transformData(10, 0, 0) }).unwrap();
      const child = world
        .spawn(
          { component: Transform, data: transformData(1, 2, 3) },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();

      const r = propagateTransforms(world);
      expect(r.ok).toBe(true);

      // feat-20260601: the resolved world transform lives on Transform.world
      // (a 16-float column-major mat4); the translation column is m[12,13,14].
      const t = world.get(child, Transform);
      expect(t.ok).toBe(true);
      if (!t.ok) return;
      const w = t.value.world;
      // parent translates +10 X, child local +1/+2/+3 -> world 11/2/3.
      expect(w[12]).toBeCloseTo(11, 5);
      expect(w[13]).toBeCloseTo(2, 5);
      expect(w[14]).toBeCloseTo(3, 5);
    });

    it('spawning ChildOf auto-appends the child to parent.Children.entities (OOS-10 retired)', () => {
      const world = new World();
      // Mirror must be registered before the holder is used (M2 contract:
      // the relationship hook resolves Children by name from the registry).
      const parent = world.spawn({ component: Transform, data: transformData(0, 0, 0) }).unwrap();
      const a = world
        .spawn(
          { component: Transform, data: transformData(0, 0, 0) },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();
      const b = world
        .spawn(
          { component: Transform, data: transformData(0, 0, 0) },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();

      const snap = world.get(parent, Children);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      expect(Array.from(snap.value.entities)).toEqual([a, b]);
    });

    it('removing ChildOf prunes the child from parent.Children.entities', () => {
      const world = new World();
      const parent = world.spawn({ component: Transform, data: transformData(0, 0, 0) }).unwrap();
      const a = world
        .spawn(
          { component: Transform, data: transformData(0, 0, 0) },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();
      const b = world
        .spawn(
          { component: Transform, data: transformData(0, 0, 0) },
          { component: ChildOf, data: { parent } },
        )
        .unwrap();

      world.removeComponent(a, ChildOf).unwrap();

      const snap = world.get(parent, Children);
      expect(snap.ok).toBe(true);
      if (!snap.ok) return;
      expect(Array.from(snap.value.entities)).toEqual([b]);
    });

    it('reparent (exclusive re-add) moves the child between parent Children lists', () => {
      const world = new World();
      const oldParent = world
        .spawn({ component: Transform, data: transformData(0, 0, 0) })
        .unwrap();
      const newParent = world
        .spawn({ component: Transform, data: transformData(0, 0, 0) })
        .unwrap();
      const child = world
        .spawn(
          { component: Transform, data: transformData(0, 0, 0) },
          { component: ChildOf, data: { parent: oldParent } },
        )
        .unwrap();

      // Atomic detach-then-attach reparent via the M3 Commands surface.
      world.reparent(child, newParent, ChildOf, { parent: newParent }).unwrap();

      const oldSnap = world.get(oldParent, Children);
      const newSnap = world.get(newParent, Children);
      expect(oldSnap.ok && newSnap.ok).toBe(true);
      if (!oldSnap.ok || !newSnap.ok) return;
      expect(Array.from(oldSnap.value.entities)).toEqual([]);
      expect(Array.from(newSnap.value.entities)).toEqual([child]);

      // Reader path: ChildOf.parent now points at newParent.
      const co = world.get(child, ChildOf);
      expect(co.ok).toBe(true);
      if (!co.ok) return;
      expect(co.value.parent).toBe(newParent);
    });
  });

  // feat-20260602 M2 / w7: relationship-mirror validation moved into
  // `defineComponent` (define-time fail-fast). The runtime ChildOf holder
  // declares `mirror: 'Children'`, so the component barrel must export Children
  // (the mirror) before ChildOf (the holder) -- otherwise `defineComponent`
  // throws RelationshipMirrorComponentNotRegisteredError while the package is
  // being evaluated. This block is the load-bearing guard for that barrel
  // ordering: a clean dynamic import proves the module-evaluation order
  // satisfies the mirror-before-holder define-time contract.
  describe('relationship-migration-regression (feat-20260602 M2 / w7 barrel order)', () => {
    it('imports @forgeax/engine-runtime without throwing on module evaluation', async () => {
      const mod = await import('@forgeax/engine-runtime');
      expect(mod.Children).toBeDefined();
      expect(mod.ChildOf).toBeDefined();
    });

    it('runtime ChildOf resolves its Children mirror as array<entity>', async () => {
      const { ChildOf, Children } = await import('@forgeax/engine-runtime');
      expect(ChildOf.relationship?.mirror).toBe('Children');
      expect((Children.schema as Record<string, string>).entities).toBe('array<entity>');
    });
  });
}

{
  // --- from scene-defaults.test.ts ---
  // scene-defaults.test - default-value 4-layer fallback (w20 TDD red).
  //
  // Coverage map (anchored to requirements §AC-07 / §AC-11 / §AC-12 +
  // §default-value mechanism + plan-strategy §D-P3 / §D-P4):
  //
  //   (a) AC-07 layer 1 explicit Scene value:
  //       SceneEntity.components.Transform.posX = 1.5 -> instantiate -> posX === 1.5.
  //       Explicit Scene value beats every layer 2/3 default (no setOverride
  //       written, so overrides() stays empty).
  //
  //   (b) AC-11 layer 2 component-level defaults (D-P3 add-only minor):
  //       defineComponent('Transform', { posY: { type: 'f32', default: 7.0 } });
  //       SceneEntity does NOT write posY -> instantiate -> posY === 7.0.
  //
  //   (c) AC-12 layer 3 TS type defaults + NULL_ENTITY sentinel:
  //       Three layers all silent on posZ -> posZ === 0 (TS f32 default).
  //       'entity' typed field with no source value -> NULL_ENTITY sentinel
  //       (raw u32 = 0xffffffff per ENTITY_NULL_RAW SSOT). Layer 3 silent --
  //       MUST NOT throw 'scene-default-missing'; charter tension explicitly
  //       captured in requirements + plan-strategy.
  //
  //   (d) layer-boundary discipline:
  //       Known schema field name + missing value -> walks layer 1 -> 2 -> 3
  //       chain (this test file).
  //       Unknown field name (typo 'pozX') -> ajv fail-fast rejects upstream
  //       at pack-schema validate, never reaching instantiate -- that path is
  //       owned by AC-08 in packages/pack scene-schema tests (M1 / w4 covers
  //       it). The boundary is "known name + missing value = silent fallback;
  //       unknown name = fail-fast" -- this file asserts the silent half so
  //       the contract is bidirectionally pinned.
  //
  // w22 (ImplementerAgent M4) lands the impl in
  // packages/ecs/src/scene-instance-container.ts; this file is the red phase.

  // M3 ECS-fication: scene-instance container API replaced; tests use
  // world.instantiateScene + registerSceneAsset (allocUniqueRef + toShared)
  // and read mapping via the SceneInstance component on the synthetic root.
  // SceneInstance schema must be locally registered so resolveComponent finds
  // it during instantiateScene (matches the runtime schema definition).
  defineComponent('SceneInstance', {
    source: { type: 'shared<SceneAsset>' },
    mapping: { type: 'array<entity>' },
    state: { type: 'unique<SceneInstanceState>' },
  });

  function localId(n: number): LocalEntityId {
    return n as LocalEntityId;
  }

  function buildScene(nodes: readonly SceneEntity[]): SceneAsset {
    return { kind: 'scene', entities: nodes };
  }

  function registerSceneAsset(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
    return world.allocSharedRef('SceneAsset', asset);
  }

  function firstNodeEntity(world: World, root: EntityHandle): EntityHandle {
    // entityToLocalId.keys() iterates in topo-sort spawn order; first key is
    // localId 0's live Entity. Robust against the mapping[0]===0 encoding
    // (gen=0+idx=0 produces raw u32 0, which is a valid Entity not "empty").
    const stateRes = world.getSceneInstanceState(root);
    if (!stateRes.ok) throw new Error('SceneInstance state lookup failed');
    const it = stateRes.value.entityToLocalId.keys();
    const first = it.next();
    if (first.done) throw new Error('entityToLocalId empty');
    return first.value;
  }

  describe('default-value 4-layer fallback (w20 / AC-07 + AC-11 + AC-12)', () => {
    it('AC-07 layer 1: explicit Scene value beats every default', () => {
      const Transform = defineComponent('Transform', {
        posX: { type: 'f32', default: 99 },
        posY: { type: 'f32', default: 99 },
        posZ: { type: 'f32', default: 99 },
      });
      const world = new World();

      const nodes: SceneEntity[] = [
        {
          localId: localId(0),
          components: { Transform: { posX: 1.5 } },
        },
      ];
      const handle = registerSceneAsset(world, buildScene(nodes));
      const r = world.instantiateScene(handle);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const e = firstNodeEntity(world, r.value.root);
      const t = world.get(e, Transform).unwrap();
      expect(t.posX).toBe(1.5);
      // overrides stay empty - no setSceneOverride was called. M3 reads them
      // from the SceneInstanceState payload via getSceneInstanceState.
      const stateRes = world.getSceneInstanceState(r.value.root);
      expect(stateRes.ok).toBe(true);
      if (!stateRes.ok) return;
      expect(stateRes.value.overrides.size).toBe(0);
    });

    it('AC-11 layer 2: component-level defaults fill missing fields (D-P3)', () => {
      const Transform = defineComponent('Transform', {
        posX: 'f32',
        posY: { type: 'f32', default: 7.0 },
        posZ: 'f32',
      });
      const world = new World();

      // Node writes posX explicitly; posY + posZ omitted -> layer 2 gives
      // posY=7.0; posZ falls through to layer 3 (asserted in next test).
      const nodes: SceneEntity[] = [
        {
          localId: localId(0),
          components: { Transform: { posX: 1 } },
        },
      ];
      const handle = registerSceneAsset(world, buildScene(nodes));
      const r = world.instantiateScene(handle);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const e = firstNodeEntity(world, r.value.root);
      const t = world.get(e, Transform).unwrap();
      expect(t.posY).toBe(7.0);
    });

    it('AC-12 layer 3: TS type defaults silently fill three-layer-empty fields', () => {
      const Transform = defineComponent('Transform', {
        posX: 'f32',
        posY: 'f32',
        posZ: 'f32',
        flag: 'bool',
        kind: 'u32',
      });
      const world = new World();

      // No defaults at the component level; node writes posX only. Three-layer
      // chain leaves posY / posZ / flag / kind empty -> layer 3 fills with TS
      // type defaults. AC-12 mandates this path is SILENT (no error code).
      const nodes: SceneEntity[] = [
        {
          localId: localId(0),
          components: { Transform: { posX: 0 } },
        },
      ];
      const handle = registerSceneAsset(world, buildScene(nodes));
      const r = world.instantiateScene(handle);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const e = firstNodeEntity(world, r.value.root);
      const t = world.get(e, Transform).unwrap();
      expect(t.posY).toBe(0); // f32 -> 0
      expect(t.posZ).toBe(0); // f32 -> 0
      expect(t.flag).toBe(false); // bool -> false (read back as 0/1)
      expect(t.kind).toBe(0); // u32 -> 0
    });

    it('AC-12 layer 3: entity-typed field falls back to NULL_ENTITY sentinel', () => {
      const TargetSlot = defineComponent('TargetSlot', { target: 'entity' });
      const world = new World();

      // Node declares TargetSlot with NO target value -> three layers silent
      // -> layer 3 must store ENTITY_NULL_RAW (0xffffffff) sentinel in the u32
      // column. On read, readRow decodes ENTITY_NULL_RAW back to JS null (the
      // null-sentinel mapping is a storage-level convention, not a liveness check).
      // Both shapes are pinned here so a regression in either direction trips
      // this test:
      //   - storage layer: ENTITY_NULL_RAW is the sentinel SSOT
      //   - read layer:    null is what the AI user observes after world.get
      const nodes: SceneEntity[] = [
        {
          localId: localId(0),
          components: { TargetSlot: {} },
        },
      ];
      const handle = registerSceneAsset(world, buildScene(nodes));
      const r = world.instantiateScene(handle);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const e = firstNodeEntity(world, r.value.root);
      const slot = world.get(e, TargetSlot).unwrap();
      // Read-side: ENTITY_NULL_RAW storage maps back to null; layer 3 silent
      // path must NOT emit any error code.
      expect(slot.target).toBe(null);
      // SSOT pin: verify ENTITY_NULL_RAW is the agreed sentinel (so the
      // contract between layer 3 and the storage column stays bidirectional).
      expect(ENTITY_NULL_RAW).toBe(0xffffffff);
    });

    it('layer chain order: layer 1 > layer 2 > layer 3 priority discipline', () => {
      // Compose all three layers in one node so the priority chain is
      // observable in a single instantiate roundtrip:
      //   posX: layer 1 wins (explicit Scene value)
      //   posY: layer 2 wins (component default)
      //   posZ: layer 3 wins (silent TS default)
      const Transform = defineComponent('Transform', {
        posX: { type: 'f32', default: 99 },
        posY: { type: 'f32', default: 7.0 },
        posZ: 'f32',
      });
      const world = new World();

      const nodes: SceneEntity[] = [
        {
          localId: localId(0),
          components: { Transform: { posX: 1.5 } },
        },
      ];
      const handle = registerSceneAsset(world, buildScene(nodes));
      const r = world.instantiateScene(handle);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const e = firstNodeEntity(world, r.value.root);
      const t = world.get(e, Transform).unwrap();
      expect(t.posX).toBe(1.5); // layer 1 wins (explicit beats default 99)
      expect(t.posY).toBe(7.0); // layer 2 wins (component default beats type 0)
      expect(t.posZ).toBe(0); // layer 3 wins (TS f32 default)
    });

    it('layer 3 silent path: no error code surface on three-layer-empty schema field', () => {
      // Charter tension declared in requirements §default-value mechanism +
      // plan-strategy §3.3 §error-model: layer 3 MUST be silent. This test
      // pins the negative -- the Result must be ok and no error-shaped value
      // surfaces to the caller.
      defineComponent('Transform', {
        posX: 'f32',
        posY: 'f32',
        posZ: 'f32',
      });
      const world = new World();

      const nodes: SceneEntity[] = [{ localId: localId(0), components: { Transform: {} } }];
      const handle = registerSceneAsset(world, buildScene(nodes));
      const r = world.instantiateScene(handle);
      expect(r.ok).toBe(true);
      // No 'scene-default-missing' / similar code surfaces. Asserted at the
      // Result envelope -- if w22 ever introduces such a code in the silent
      // path this assertion flips red.
    });
  });
}

{
  // --- from sort-key-component.test.ts ---
  // w08 - SortKey component schema spawn (TDD red).
  //
  // feat-20260520-2d-sprite-layer-mvp M-2 w08 / requirements AC-07 + AC-19 (4).
  //
  // Coverage:
  //   - SortKey { value: 1.5 } round-trips with f32 precision.
  //   - spawn without SortKey reads back default 0.0 (f32 scalar default
  //     via the 4-layer fallback chain — feat-20260517-spawn-default-fallback).
  //   - Layer { value: 100 } + SortKey { value: -2.0 } co-exist on one entity
  //     (multi-component spawn targets a single archetype).
  //
  // The downstream "SortKey overrides TransparentSortConfig mode formula"
  // behaviour is verified by w16 inside `transparent-sort.test.ts` — this
  // task only validates that SortKey is a registerable scalar f32 component
  // with the expected read-back path. charter mapping: F1 + P3 + P4 (Layer +
  // SortKey are generic ECS renderer components, not 2D-only specials).
  //
  // TDD red: w12 implements the component file + barrel re-export to turn
  // this green.

  describe('w08 - SortKey = defineComponent("SortKey", { value: "f32" })', () => {
    it('has schema { value: "f32" } (1 f32 field)', () => {
      expect(SortKey.name).toBe('SortKey');
      expect(Object.keys(SortKey.schema).length).toBe(1);
      expect(SortKey.schema.value).toBe('f32');
    });

    it('spawn SortKey { value: 1.5 } round-trips within f32 precision', () => {
      const world = new World();
      const e = world.spawn({ component: SortKey, data: { value: 1.5 } }).unwrap();
      const r = world.get(e, SortKey).unwrap();
      expect(r.value).toBeCloseTo(1.5, 5);
    });

    it('spawn payload omitting value falls through 4-layer chain to f32 default 0', () => {
      const world = new World();
      const spawnResult = world.spawn({ component: SortKey, data: {} });
      expect(spawnResult.ok).toBe(true);
      const e = spawnResult.unwrap();
      const r = world.get(e, SortKey).unwrap();
      expect(r.value).toBe(0);
    });

    it('Layer + SortKey co-exist on a single entity (multi-component spawn)', () => {
      const world = new World();
      const e = world
        .spawn(
          { component: Layer, data: { value: 100 } },
          { component: SortKey, data: { value: -2.0 } },
        )
        .unwrap();
      const layerRead = world.get(e, Layer).unwrap();
      const sortKeyRead = world.get(e, SortKey).unwrap();
      expect(layerRead.value).toBe(100);
      expect(sortKeyRead.value).toBeCloseTo(-2.0, 5);
    });
  });
}

{
  // --- from animation-player.test.ts ---
  // feat-20260615-animation-player-crossfade-simple-transition M1 / w1 —
  // AnimationPlayer SoA schema lock test (TDD red).
  //
  // Old 5-field schema { clip, time, speed, paused, looping } replaced
  // by 6-field SoA inline arrays:
  //   clips:   'array<shared<AnimationClip>, 4>'   (default all-zero Uint32Array(4))
  //   times:   'array<f32, 4>'                      (default all-zero Float32Array(4))
  //   weights: 'array<f32, 4>'                      (default all-zero Float32Array(4))
  //   speeds:  'array<f32, 4>'                      (layer-2 default [1,1,1,1] — every slot plays at 1x)
  //   paused:  'bool'                                (default false)
  //   looping: 'bool'                                (default true)
  //
  // Anchors: requirements AC-01 (6 field names) + AC-02 (type-level error
  // on old shape) + IS-1 (SoA inline arrays); plan-strategy D-6 (speeds
  // default 0, not 1); plan-tasks.json w1.

  describe('AnimationPlayer — SoA 6-field schema lock (M1 / w1 red)', () => {
    it('AnimationPlayer is a registered component with name "AnimationPlayer" and 6 SoA schema fields', () => {
      expect(AnimationPlayer.name).toBe('AnimationPlayer');
      const schema = AnimationPlayer.schema as Record<string, unknown>;
      expect(Object.keys(schema).length).toBe(6);
      expect(schema).toEqual({
        clips: 'array<shared<AnimationClip>, 4>',
        times: 'array<f32, 4>',
        weights: 'array<f32, 4>',
        speeds: 'array<f32, 4>',
        paused: 'bool',
        looping: 'bool',
      });
    });

    it('AnimationPlayer.schema.clips is array<shared<AnimationClip>, 4> (SoA keyword)', () => {
      expect((AnimationPlayer.schema as Record<string, unknown>).clips).toBe(
        'array<shared<AnimationClip>, 4>',
      );
    });

    it('AnimationPlayer.schema.times is array<f32, 4>', () => {
      expect((AnimationPlayer.schema as Record<string, unknown>).times).toBe('array<f32, 4>');
    });

    it('AnimationPlayer.schema.weights is array<f32, 4>', () => {
      expect((AnimationPlayer.schema as Record<string, unknown>).weights).toBe('array<f32, 4>');
    });

    it('AnimationPlayer.schema.speeds is array<f32, 4>', () => {
      expect((AnimationPlayer.schema as Record<string, unknown>).speeds).toBe('array<f32, 4>');
    });

    it('AnimationPlayer.schema.paused is bool', () => {
      expect((AnimationPlayer.schema as Record<string, unknown>).paused).toBe('bool');
    });

    it('AnimationPlayer.schema.looping is bool', () => {
      expect((AnimationPlayer.schema as Record<string, unknown>).looping).toBe('bool');
    });

    it('old field clip is absent from schema (AC-02 type-level error)', () => {
      expect(AnimationPlayer.schema).not.toHaveProperty('clip');
    });

    it('old field time is absent from schema (AC-02 type-level error)', () => {
      expect(AnimationPlayer.schema).not.toHaveProperty('time');
    });

    it('old field speed is absent from schema (AC-02 type-level error)', () => {
      expect(AnimationPlayer.schema).not.toHaveProperty('speed');
    });

    it('AnimationPlayer spawn yields SoA default values: clips/times/weights all-zero, speeds=[1,1,1,1], paused=false, looping=true (tweak-20260616 retired plan D-6)', () => {
      const world = new World();
      const e = world
        .spawn({
          component: AnimationPlayer,
          data: {},
        })
        .unwrap();
      const ap = world.get(e, AnimationPlayer).unwrap() as unknown as {
        clips: Uint32Array;
        times: Float32Array;
        weights: Float32Array;
        speeds: Float32Array;
        paused: boolean;
        looping: boolean;
      };
      expect(ap.clips).toBeInstanceOf(Uint32Array);
      expect(ap.clips.length).toBe(4);
      expect(ap.clips[0]).toBe(0);
      expect(ap.clips[1]).toBe(0);
      expect(ap.clips[2]).toBe(0);
      expect(ap.clips[3]).toBe(0);
      expect(ap.times).toBeInstanceOf(Float32Array);
      expect(ap.times.length).toBe(4);
      expect(ap.times[0]).toBe(0);
      expect(ap.times[1]).toBe(0);
      expect(ap.times[2]).toBe(0);
      expect(ap.times[3]).toBe(0);
      expect(ap.weights).toBeInstanceOf(Float32Array);
      expect(ap.weights.length).toBe(4);
      expect(ap.weights[0]).toBe(0);
      expect(ap.weights[1]).toBe(0);
      expect(ap.weights[2]).toBe(0);
      expect(ap.weights[3]).toBe(0);
      expect(ap.speeds).toBeInstanceOf(Float32Array);
      expect(ap.speeds.length).toBe(4);
      // tweak-20260616: speeds layer-2 default is [1,1,1,1] — every slot plays
      // at 1x when its clip is set (was all-zero, plan D-6 retired).
      expect(ap.speeds[0]).toBe(1);
      expect(ap.speeds[1]).toBe(1);
      expect(ap.speeds[2]).toBe(1);
      expect(ap.speeds[3]).toBe(1);
      expect(ap.paused).toBe(false);
      expect(ap.looping).toBe(true);
    });

    it('AnimationPlayer spawn with explicit SoA data overrides defaults', () => {
      const world = new World();
      const e = world
        .spawn({
          component: AnimationPlayer,
          data: {
            clips: [
              toShared<'AnimationClip'>(7),
              toShared<'AnimationClip'>(3),
              0 as Handle<'AnimationClip', 'shared'>,
              0 as Handle<'AnimationClip', 'shared'>,
            ],
            times: new Float32Array([0, 1.5, 0, 0]),
            weights: new Float32Array([0.7, 0.3, 0, 0]),
            speeds: new Float32Array([1, 0.5, 0, 0]),
            paused: true,
            looping: false,
          },
        })
        .unwrap();
      const ap = world.get(e, AnimationPlayer).unwrap() as unknown as {
        clips: Uint32Array;
        times: Float32Array;
        weights: Float32Array;
        speeds: Float32Array;
        paused: boolean;
        looping: boolean;
      };
      expect(ap.clips[0]).toBe(toShared<'AnimationClip'>(7));
      expect(ap.clips[1]).toBe(toShared<'AnimationClip'>(3));
      expect(ap.clips[2]).toBe(0);
      expect(ap.clips[3]).toBe(0);
      expect(ap.times[0]).toBe(0);
      expect(ap.times[1]).toBeCloseTo(1.5, 5);
      expect(ap.weights[0]).toBeCloseTo(0.7, 5);
      expect(ap.weights[1]).toBeCloseTo(0.3, 5);
      expect(ap.speeds[0]).toBeCloseTo(1, 5);
      expect(ap.speeds[1]).toBeCloseTo(0.5, 5);
      expect(ap.paused).toBe(true);
      expect(ap.looping).toBe(false);
    });

    it('AnimationPlayer set(times) updates the times array column', () => {
      const world = new World();
      const e = world
        .spawn({
          component: AnimationPlayer,
          data: {},
        })
        .unwrap();
      world.set(e, AnimationPlayer, { times: new Float32Array([2.0, 0, 0, 0]) });
      const ap = world.get(e, AnimationPlayer).unwrap() as unknown as { times: Float32Array };
      expect(ap.times[0]).toBeCloseTo(2.0, 5);
    });
  });
}

{
  // --- from camera.test.ts ---
  // feat-20260602-ecs-component-type-field-reflection-metadata-base / M5 / w14.
  //
  // Camera SSOT invariant guards (AC-07). Two concerns:
  //
  //   (a) Full 21-field snapshot tests for perspective() / orthographic() factory
  //       functions — every field value is asserted to match the pre-migration
  //       reference. These guards ensure the w13 SSOT refactoring (deleting
  //       CameraDataPod, deriving factory base from Camera token defaults) does
  //       not change any field-level behavior.
  //
  //   (b) Camera.fields reflection guard: 17 f32 fields, each with type:'f32'.
  //       After w13 deletes CameraDataPod, the factory return type is also verified
  //       to be derivable from the Camera token (no standalone interface).
  //
  // Anchors: requirements AC-07 (camera SSOT guard), plan-strategy D-A4
  // (keep factories, delete CameraDataPod), plan-tasks.json w14/w13.

  // ────────────────────────────────────────────────────────────────────────────
  // w14-a: 21-field value snapshot (AC-07 invariant guard for w13 SSOT
  //        refactoring — every field value must stay byte-identical)
  // ────────────────────────────────────────────────────────────────────────────

  describe('camera factory 22-field snapshot (w14 AC-07 invariant)', () => {
    it('perspective({ fov: Math.PI/3, aspect: 16/9 }) — all 22 fields match reference', () => {
      const pod = perspective({ fov: Math.PI / 3, aspect: 16 / 9 });
      // Perspective quartet — caller-supplied
      expect(pod.fov).toBeCloseTo(Math.PI / 3, 6);
      expect(pod.aspect).toBeCloseTo(16 / 9, 6);
      expect(pod.near).toBeCloseTo(0.1, 6);
      expect(pod.far).toBe(100);
      // Projection discriminator
      expect(pod.projection).toBe(CAMERA_PROJECTION_PERSPECTIVE);
      // Ortho quartet defaults
      expect(pod.left).toBe(-1);
      expect(pod.right).toBe(1);
      expect(pod.bottom).toBe(-1);
      expect(pod.top).toBe(1);
      // Tonemap trio defaults
      expect(pod.tonemap).toBe(TONEMAP_NONE);
      expect(pod.exposure).toBeCloseTo(1.0, 6);
      expect(pod.whitePoint).toBeCloseTo(4.0, 6);
      // Post-processing defaults
      expect(pod.antialias).toBe(ANTIALIAS_NONE);
      expect(pod.bloom).toBe(BLOOM_DISABLED);
      expect(pod.bloomThreshold).toBeCloseTo(1.0, 6);
      expect(pod.bloomIntensity).toBeCloseTo(1.0, 6);
      expect(pod.bloomBlurRadius).toBeCloseTo(4.0, 6);
      // Clear-color quartet defaults (feat-20260608 / D-1 / D-8)
      expect(pod.clearR).toBe(0);
      expect(pod.clearG).toBe(0);
      expect(pod.clearB).toBe(0);
      expect(pod.clearA).toBe(1);
      // aspect-sync opt-out default (feat-20260617 / M3)
      expect(pod.autoAspect).toBe(true);
    });

    it('perspective({ fov: 45, aspect: 4/3, near: 0.01, far: 1000 }) — explicit overrides, rest defaults', () => {
      const pod = perspective({ fov: 45, aspect: 4 / 3, near: 0.01, far: 1000 });
      expect(pod.fov).toBe(45);
      expect(pod.aspect).toBeCloseTo(4 / 3, 6);
      expect(pod.near).toBeCloseTo(0.01, 6);
      expect(pod.far).toBe(1000);
      expect(pod.projection).toBe(CAMERA_PROJECTION_PERSPECTIVE);
      expect(pod.left).toBe(-1);
      expect(pod.right).toBe(1);
      expect(pod.bottom).toBe(-1);
      expect(pod.top).toBe(1);
      expect(pod.tonemap).toBe(TONEMAP_NONE);
      expect(pod.exposure).toBeCloseTo(1.0, 6);
      expect(pod.whitePoint).toBeCloseTo(4.0, 6);
      expect(pod.antialias).toBe(ANTIALIAS_NONE);
      expect(pod.bloom).toBe(BLOOM_DISABLED);
      expect(pod.bloomThreshold).toBeCloseTo(1.0, 6);
      expect(pod.bloomIntensity).toBeCloseTo(1.0, 6);
      expect(pod.bloomBlurRadius).toBeCloseTo(4.0, 6);
    });

    it('orthographic({ left: -10, right: 10, bottom: -10, top: 10 }) — all 22 fields match reference', () => {
      const pod = orthographic({ left: -10, right: 10, bottom: -10, top: 10 });
      // Ortho bounds — caller-supplied
      expect(pod.left).toBe(-10);
      expect(pod.right).toBe(10);
      expect(pod.bottom).toBe(-10);
      expect(pod.top).toBe(10);
      expect(pod.near).toBeCloseTo(0.1, 6);
      expect(pod.far).toBe(100);
      // Perspective fields sentinel
      expect(pod.fov).toBe(0);
      expect(pod.aspect).toBe(1);
      expect(pod.projection).toBe(CAMERA_PROJECTION_ORTHOGRAPHIC);
      // Tonemap trio defaults
      expect(pod.tonemap).toBe(TONEMAP_NONE);
      expect(pod.exposure).toBeCloseTo(1.0, 6);
      expect(pod.whitePoint).toBeCloseTo(4.0, 6);
      // Post-processing defaults
      expect(pod.antialias).toBe(ANTIALIAS_NONE);
      expect(pod.bloom).toBe(BLOOM_DISABLED);
      expect(pod.bloomThreshold).toBeCloseTo(1.0, 6);
      expect(pod.bloomIntensity).toBeCloseTo(1.0, 6);
      expect(pod.bloomBlurRadius).toBeCloseTo(4.0, 6);
      // Clear-color quartet defaults (feat-20260608 / D-1 / D-8)
      expect(pod.clearR).toBe(0);
      expect(pod.clearG).toBe(0);
      expect(pod.clearB).toBe(0);
      expect(pod.clearA).toBe(1);
      // aspect-sync opt-out default (feat-20260617 / M3): the sidecar only
      // touches perspective cameras, but the column default is shared.
      expect(pod.autoAspect).toBe(true);
    });

    it('orthographic({ ..., near: -1, far: 1 }) — explicit near/far overrides', () => {
      const pod = orthographic({ left: 0, right: 800, bottom: 600, top: 0, near: -1, far: 1 });
      expect(pod.left).toBe(0);
      expect(pod.right).toBe(800);
      expect(pod.bottom).toBe(600);
      expect(pod.top).toBe(0);
      expect(pod.near).toBe(-1);
      expect(pod.far).toBe(1);
      expect(pod.projection).toBe(CAMERA_PROJECTION_ORTHOGRAPHIC);
      expect(pod.fov).toBe(0);
      expect(pod.aspect).toBe(1);
      expect(pod.tonemap).toBe(TONEMAP_NONE);
    });

    it('perspective + orthographic 22-field counts (22 Camera columns)', () => {
      const p = perspective({ fov: 60, aspect: 4 / 3 });
      const o = orthographic({ left: -1, right: 1, bottom: -1, top: 1 });
      // Both return exactly 22 fields (17 pre-clear + 4 clear-color quartet +
      // autoAspect bool column, feat-20260617 / M3).
      expect(Object.keys(p).length).toBe(22);
      expect(Object.keys(o).length).toBe(22);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // w14-b: Camera.fields reflection guard (AC-07 SSOT — 17 f32 fields)
  // ────────────────────────────────────────────────────────────────────────────

  describe('Camera.fields reflection (w14 AC-07 SSOT)', () => {
    it('Camera.fields has exactly 22 keys matching the Camera column set', () => {
      const keys = Object.keys(Camera.fields).sort();
      expect(keys).toEqual([
        'antialias',
        'aspect',
        'autoAspect',
        'bloom',
        'bloomBlurRadius',
        'bloomIntensity',
        'bloomThreshold',
        'bottom',
        'clearA',
        'clearB',
        'clearG',
        'clearR',
        'exposure',
        'far',
        'fov',
        'left',
        'near',
        'projection',
        'right',
        'tonemap',
        'top',
        'whitePoint',
      ]);
    });

    it("every Camera.fields entry has type === 'f32' except autoAspect (bool)", () => {
      for (const key of Object.keys(Camera.fields) as Array<keyof typeof Camera.fields>) {
        const expected = key === 'autoAspect' ? 'bool' : 'f32';
        expect(Camera.fields[key].type).toBe(expected);
      }
    });

    it('Camera.fields is frozen', () => {
      expect(Object.isFrozen(Camera.fields)).toBe(true);
    });

    it("Camera.fields defaults match factory reference values (confirmed by w14-a's snapshot)", () => {
      // The per-field defaults stored in Camera.fields after M3 migration
      // should align with what perspective() / orthographic() use as
      // their base values.  Note: fov / aspect / near / far have no default
      // (perspective quartet is explicit-only per OOS-5).
      const d = Camera.fields;
      expect(d.projection.default).toBe(0);
      expect(d.left.default).toBe(-1);
      expect(d.right.default).toBe(1);
      expect(d.bottom.default).toBe(-1);
      expect(d.top.default).toBe(1);
      expect(d.tonemap.default).toBe(0);
      expect(d.exposure.default).toBeCloseTo(1.0, 6);
      expect(d.whitePoint.default).toBeCloseTo(4.0, 6);
      expect(d.antialias.default).toBe(0);
      expect(d.bloom.default).toBe(0);
      expect(d.bloomThreshold.default).toBeCloseTo(1.0, 6);
      expect(d.bloomIntensity.default).toBeCloseTo(1.0, 6);
      expect(d.bloomBlurRadius.default).toBeCloseTo(4.0, 6);
      // Clear-color quartet defaults (feat-20260608 / D-1 / D-8: opaque black)
      expect(d.clearR.default).toBe(0);
      expect(d.clearG.default).toBe(0);
      expect(d.clearB.default).toBe(0);
      expect(d.clearA.default).toBe(1);
      // aspect-sync opt-out default (feat-20260617 / M3).
      expect(d.autoAspect.default).toBe(true);
      // Perspective quartet defaults intentionally absent (OOS-5).
      expect(d.fov.default).toBeUndefined();
      expect(d.aspect.default).toBeUndefined();
      expect(d.near.default).toBeUndefined();
      expect(d.far.default).toBeUndefined();
    });
  });

  describe('Camera.defaults — frozen token defaults map (AC-07 + feat-20260528-fxaa-post-processing + feat-20260531-bloom + feat-20260608-clear-color)', () => {
    it('Camera.defaults equals { projection: 0, left: -1, right: 1, bottom: -1, top: 1, tonemap: 0, exposure: 1.0, whitePoint: 4.0, antialias: 0, bloom: 0, bloomThreshold: 1.0, bloomIntensity: 1.0, bloomBlurRadius: 4.0, clearR: 0, clearG: 0, clearB: 0, clearA: 1 }', () => {
      expect(Camera.defaults).toEqual({
        projection: 0,
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
        tonemap: 0,
        exposure: 1.0,
        whitePoint: 4.0,
        antialias: 0,
        bloom: 0,
        bloomThreshold: 1.0,
        bloomIntensity: 1.0,
        bloomBlurRadius: 4.0,
        clearR: 0,
        clearG: 0,
        clearB: 0,
        clearA: 1,
        autoAspect: true,
      });
    });

    it('Camera.defaults is deep-frozen (Object.isFrozen returns true)', () => {
      expect(Camera.defaults).toBeDefined();
      // Object.isFrozen is true for any frozen object; defineComponent
      // freezes the per-component defaults map at registration time.
      expect(Object.isFrozen(Camera.defaults)).toBe(true);
    });

    it('Camera.defaults does NOT carry fov / aspect / near / far (perspective quartet stays explicit per OOS-5)', () => {
      const d = Camera.defaults as Readonly<Record<string, unknown>> | undefined;
      expect(d).toBeDefined();
      if (d === undefined) return;
      expect('fov' in d).toBe(false);
      expect('aspect' in d).toBe(false);
      expect('near' in d).toBe(false);
      expect('far' in d).toBe(false);
    });
  });

  describe('Camera 4-field perspective spawn — token defaults fill ortho quartet (AC-07 runtime)', () => {
    it('world.spawn({ component: Camera, data: { fov, aspect, near, far } }) yields projection === 0 + ortho defaults', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 16 / 9,
            near: 0.1,
            far: 100,
          },
        })
        .unwrap();
      const row = world.get(e, Camera).unwrap();

      // Layer-1: explicit values pass through (f32 round on 16 / 9).
      expect(row.fov).toBeCloseTo(Math.PI / 4, 6);
      expect(row.aspect).toBeCloseTo(16 / 9, 6);
      expect(row.near).toBeCloseTo(0.1, 6);
      expect(row.far).toBe(100);

      // Layer-2 (token defaults): projection + 4 ortho fields + 3 tonemap fields.
      expect(row.projection).toBe(CAMERA_PROJECTION_PERSPECTIVE);
      expect(row.left).toBe(-1);
      expect(row.right).toBe(1);
      expect(row.bottom).toBe(-1);
      expect(row.top).toBe(1);
      expect(row.tonemap).toBe(TONEMAP_NONE);
      expect(row.exposure).toBeCloseTo(1.0, 6);
      expect(row.whitePoint).toBeCloseTo(4.0, 6);
    });

    it('explicit ortho override path: caller passes projection + 4 ortho fields, defaults yield', () => {
      // Token defaults must NOT clobber explicit caller input -- this is
      // the layer-1 wins clause from research section F1.
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
          data: {
            fov: 0,
            aspect: 1,
            near: 0.1,
            far: 100,
            projection: 1,
            left: -10,
            right: 10,
            bottom: -10,
            top: 10,
          },
        })
        .unwrap();
      const row = world.get(e, Camera).unwrap();
      expect(row.projection).toBe(1);
      expect(row.left).toBe(-10);
      expect(row.right).toBe(10);
      expect(row.bottom).toBe(-10);
      expect(row.top).toBe(10);
    });
  });

  // feat-20260519-tonemap-reinhard-mvp / M1 / T-M1.1 + T-M1.2.
  //
  // Camera tonemap field surface (AC-01 + AC-04 + AC-05 + AC-06). Three
  // schema columns (tonemap / exposure / whitePoint) plus a string-literal
  // closed union map (TONEMAP_NONE / TONEMAP_REINHARD_EXTENDED +
  // tonemapFromF32) following the same shape as projection +
  // cameraProjectionFromF32. Defaults: { tonemap: 0, exposure: 1.0,
  // whitePoint: 4.0 } belong to the layer-2 token defaults map (D-1 + D-7
  // in plan-strategy section 2.3). Spawn-time numeric range fail-fast is
  // out of scope per O1 (plan-decisions L-O1) — shader floor max(Y, 1e-5)
  // guards exposure / whitePoint == 0 from NaN.
  describe('Camera tonemap mapping (AC-01)', () => {
    it('TONEMAP_NONE === 0 + TONEMAP_REINHARD_EXTENDED === 1 (numeric encoding)', () => {
      expect(TONEMAP_NONE).toBe(0);
      expect(TONEMAP_REINHARD_EXTENDED).toBe(1);
    });

    it('tonemapFromF32(0) === "none" + tonemapFromF32(1) === "reinhard-extended"', () => {
      expect(tonemapFromF32(0)).toBe('none');
      expect(tonemapFromF32(1)).toBe('reinhard-extended');
    });

    it('tonemapFromF32 maps all 7 modes correctly', () => {
      expect(tonemapFromF32(2)).toBe('linear');
      expect(tonemapFromF32(3)).toBe('cineon');
      expect(tonemapFromF32(4)).toBe('aces-filmic');
      expect(tonemapFromF32(5)).toBe('agx');
      expect(tonemapFromF32(6)).toBe('neutral');
    });

    it('tonemapFromF32 falls back to "none" for out-of-range numeric (defensive)', () => {
      expect(tonemapFromF32(-1)).toBe('none');
      expect(tonemapFromF32(7)).toBe('none');
      expect(tonemapFromF32(NaN)).toBe('none');
    });
  });

  describe('Camera 7-field perspective + opt-in tonemap spawn (AC-01 runtime)', () => {
    it('spawn with tonemap "reinhard-extended" path keeps numeric encoding 1', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 16 / 9,
            near: 0.1,
            far: 100,
            tonemap: TONEMAP_REINHARD_EXTENDED,
            exposure: 1.0,
            whitePoint: 4.0,
          },
        })
        .unwrap();
      const row = world.get(e, Camera).unwrap();
      expect(row.tonemap).toBe(TONEMAP_REINHARD_EXTENDED);
      expect(row.exposure).toBeCloseTo(1.0, 6);
      expect(row.whitePoint).toBeCloseTo(4.0, 6);
      // Layer-2: ortho quartet still defaulted.
      expect(row.left).toBe(-1);
      expect(row.right).toBe(1);
    });

    it('explicit non-default exposure + whitePoint pass through layer-1 wins', () => {
      const world = new World();
      const e = world
        .spawn({
          component: Camera,
          data: {
            fov: Math.PI / 4,
            aspect: 16 / 9,
            near: 0.1,
            far: 100,
            tonemap: TONEMAP_REINHARD_EXTENDED,
            exposure: 2.5,
            whitePoint: 8.0,
          },
        })
        .unwrap();
      const row = world.get(e, Camera).unwrap();
      expect(row.exposure).toBeCloseTo(2.5, 6);
      expect(row.whitePoint).toBeCloseTo(8.0, 6);
    });
  });

  // M2 / w9: Camera.perspective / Camera.orthographic static factory tests
  // (feat-20260525-boilerplate-reduction-pod-defaults-factories)
  //
  // Covers AC-05 + AC-06 (perspective + orthographic returns with defaults).
  // Plan-strategy section 5.2 unit-test requirement + section 5.3 testing points.
  describe('perspective factory', () => {
    it('perspective({ fov: 60, aspect: 4/3 }) returns POD with projection=0, near=0.1, far=100', () => {
      const pod = perspective({ fov: 60, aspect: 4 / 3 });
      expect(pod.fov).toBe(60);
      expect(pod.aspect).toBeCloseTo(4 / 3, 6);
      expect(pod.near).toBeCloseTo(0.1, 6);
      expect(pod.far).toBe(100);
      expect(pod.projection).toBe(CAMERA_PROJECTION_PERSPECTIVE);
      expect(pod.left).toBe(-1);
      expect(pod.right).toBe(1);
      expect(pod.bottom).toBe(-1);
      expect(pod.top).toBe(1);
      expect(pod.tonemap).toBe(TONEMAP_NONE);
      expect(pod.exposure).toBeCloseTo(1.0, 6);
      expect(pod.whitePoint).toBeCloseTo(4.0, 6);
    });

    it('perspective({ fov: 45, aspect: 16/9, near: 0.01, far: 1000 }) returns explicit overrides', () => {
      const pod = perspective({ fov: 45, aspect: 16 / 9, near: 0.01, far: 1000 });
      expect(pod.fov).toBe(45);
      expect(pod.aspect).toBeCloseTo(16 / 9, 6);
      expect(pod.near).toBeCloseTo(0.01, 6);
      expect(pod.far).toBe(1000);
      expect(pod.projection).toBe(CAMERA_PROJECTION_PERSPECTIVE);
      // Ortho quartet + tonemap get defaults.
      expect(pod.left).toBe(-1);
      expect(pod.right).toBe(1);
      expect(pod.tonemap).toBe(TONEMAP_NONE);
      expect(pod.exposure).toBeCloseTo(1.0, 6);
    });

    it('perspective return value has all 22 Camera fields', () => {
      const pod = perspective({ fov: 60, aspect: 4 / 3 });
      const keys = Object.keys(pod).sort();
      expect(keys).toEqual([
        'antialias',
        'aspect',
        'autoAspect',
        'bloom',
        'bloomBlurRadius',
        'bloomIntensity',
        'bloomThreshold',
        'bottom',
        'clearA',
        'clearB',
        'clearG',
        'clearR',
        'exposure',
        'far',
        'fov',
        'left',
        'near',
        'projection',
        'right',
        'tonemap',
        'top',
        'whitePoint',
      ]);
    });
  });

  describe('orthographic factory', () => {
    it('orthographic({ left: -10, right: 10, bottom: -10, top: 10 }) returns POD with projection=1, near=0.1, far=100', () => {
      const pod = orthographic({ left: -10, right: 10, bottom: -10, top: 10 });
      expect(pod.projection).toBe(CAMERA_PROJECTION_ORTHOGRAPHIC);
      expect(pod.left).toBe(-10);
      expect(pod.right).toBe(10);
      expect(pod.bottom).toBe(-10);
      expect(pod.top).toBe(10);
      expect(pod.near).toBeCloseTo(0.1, 6);
      expect(pod.far).toBe(100);
      // Perspective fields get sensible defaults (fov=0, aspect=1 for ortho).
      expect(pod.fov).toBe(0);
      expect(pod.aspect).toBe(1);
      expect(pod.tonemap).toBe(TONEMAP_NONE);
      expect(pod.exposure).toBeCloseTo(1.0, 6);
      expect(pod.whitePoint).toBeCloseTo(4.0, 6);
    });

    it('orthographic({ left: 0, right: 800, bottom: 600, top: 0, near: -1, far: 1 }) returns explicit overrides', () => {
      const pod = orthographic({
        left: 0,
        right: 800,
        bottom: 600,
        top: 0,
        near: -1,
        far: 1,
      });
      expect(pod.left).toBe(0);
      expect(pod.right).toBe(800);
      expect(pod.bottom).toBe(600);
      expect(pod.top).toBe(0);
      expect(pod.near).toBe(-1);
      expect(pod.far).toBe(1);
      expect(pod.projection).toBe(CAMERA_PROJECTION_ORTHOGRAPHIC);
    });
  });
}

{
  // --- from layer.test.ts ---
  // feat-20260525-boilerplate-reduction-pod-defaults-factories / M1 / w3b.
  //
  // Layer defaults fill regression barrier (AC-04 sweep table #14).
  // Three concerns:
  //
  //   (a) `Layer.defaults` is a frozen map asserting `{ value: 0 }`
  //       (default game layer, charter P1 progressive disclosure).
  //
  //   (b) `world.spawn({ component: Layer, data: {} })` yields `value === 0`
  //       (the default game layer convention).
  //
  //   (c) `world.spawn` with an explicit `value: 100` preserves the explicit
  //       value -- layer-2 defaults do NOT overwrite layer-1 explicit input.
  //
  // Anchors: requirements AC-04 (sweep table #14 Layer defaults-added);
  // plan-strategy section 2 sweep pre-judgment table.

  describe('Layer.defaults -- frozen map assertion (AC-04 #14)', () => {
    it('Layer.defaults equals { value: 0 }', () => {
      expect(Layer.defaults).toEqual({ value: 0 });
    });

    it('Layer.defaults is deep-frozen (Object.isFrozen returns true)', () => {
      expect(Layer.defaults).toBeDefined();
      expect(Object.isFrozen(Layer.defaults as object)).toBe(true);
    });
  });

  describe('Layer spawn with data: {} -- default game layer (AC-04)', () => {
    it('spawn Layer with data: {} yields value === 0', () => {
      const world = new World();
      const e = world.spawn({ component: Layer, data: {} }).unwrap();
      const row = world.get(e, Layer).unwrap();

      expect(row.value).toBe(0);
    });
  });

  describe('Layer spawn with explicit value -- layer-1 wins (AC-04)', () => {
    it('spawn Layer with explicit value: 100 preserves the explicit value', () => {
      const world = new World();
      const e = world.spawn({ component: Layer, data: { value: 100 } }).unwrap();
      const row = world.get(e, Layer).unwrap();

      expect(row.value).toBe(100);
    });
  });
}

{
  // --- from mesh-renderer.test.ts ---
  // feat-20260608-mesh-multi-section-primitive-multi-material-slot M2 / w8.
  //
  // MeshRenderer schema migration barrier: material field removed, materials
  // array added.
  //
  //   (a) `MeshRenderer.defaults` is a frozen map asserting
  //       `{ materials: [], frustumCulled: 1, pickable: 1 }` (empty array
  //       routes to D-Q7 case B default material path).
  //
  //   (b) `world.spawn({ component: MeshRenderer, data: {} })` produces a row
  //       with `materials === []` (the D-Q7 case B path, mid-grey default).
  //
  //   (c) `world.spawn` with an explicit materials array round-trips: write
  //       and read-back the materials array.
  //
  //   (d) `world.spawn` with the old `material` field (singular) is a TS
  //       compile-time error (verified via test-d.ts).

  describe('MeshRenderer.defaults — frozen map assertion (w8)', () => {
    it('MeshRenderer.defaults equals { materials: [], frustumCulled: 1, pickable: 1 }', () => {
      expect(MeshRenderer.defaults).toEqual({ materials: [], frustumCulled: 1, pickable: 1 });
    });

    it('MeshRenderer.defaults is deep-frozen (Object.isFrozen returns true)', () => {
      expect(MeshRenderer.defaults).toBeDefined();
      expect(Object.isFrozen(MeshRenderer.defaults as object)).toBe(true);
    });
  });

  describe('MeshRenderer spawn with data: {} — D-Q7 case B path (w8)', () => {
    it('spawn MeshRenderer with data: {} produces materials column === empty Uint32Array', () => {
      const world = new World();
      const e = world.spawn({ component: MeshRenderer, data: {} }).unwrap();
      const row = world.get(e, MeshRenderer).unwrap();

      // materials column defaults to empty array for D-Q7 case B;
      // runtime type is Uint32Array (handles stored as u32).
      expect(row.materials).toBeInstanceOf(Uint32Array);
      expect((row.materials as unknown as Uint32Array).length).toBe(0);
    });
  });

  describe('MeshRenderer spawn with explicit materials array — round-trip (w8)', () => {
    it('spawn with explicit materials array preserves the handle values as Uint32Array', () => {
      const world = new World();

      const matHandle = world.allocSharedRef('MaterialAsset', {
        kind: 'material',
        shadingModel: 'unlit',
        baseColor: [1, 0, 0, 1],
      } as never);

      expect(matHandle).toBeGreaterThan(0);

      const e = world.spawn({ component: MeshRenderer, data: { materials: [matHandle] } }).unwrap();
      const row = world.get(e, MeshRenderer).unwrap();

      // Runtime: Uint32Array with the handle value
      expect(row.materials).toBeInstanceOf(Uint32Array);
      expect((row.materials as unknown as Uint32Array)[0]).toBe(matHandle);
    });

    it('spawn with multiple materials round-trips Uint32Array', () => {
      const world = new World();

      const m0 = world.allocSharedRef('MaterialAsset', {
        kind: 'material',
        shadingModel: 'unlit',
        baseColor: [1, 0, 0, 1],
      } as never);
      const m1 = world.allocSharedRef('MaterialAsset', {
        kind: 'material',
        shadingModel: 'unlit',
        baseColor: [0, 1, 0, 1],
      } as never);

      const e = world.spawn({ component: MeshRenderer, data: { materials: [m0, m1] } }).unwrap();
      const row = world.get(e, MeshRenderer).unwrap();

      expect(row.materials).toBeInstanceOf(Uint32Array);
      expect((row.materials as unknown as Uint32Array).length).toBe(2);
      expect((row.materials as unknown as Uint32Array)[0]).toBe(m0);
      expect((row.materials as unknown as Uint32Array)[1]).toBe(m1);
    });
  });
}

{
  // --- from skybox-background.test.ts ---
  // feat-20260531-skybox-env-background / M1 / w2.
  //
  // SkyboxBackground component unit tests (TDD red phase -- the component
  // source file does not exist yet; this test will turn green after w1
  // creates skybox-background.ts, barrel, and top-level re-export).
  //
  // Covers:
  //   (a) Spawning an entity with SkyboxBackground can be queried via
  //       createQueryState + queryRun (AC-01).
  //   (b) skyboxModeFromF32(0) returns 'cubemap' with TS narrow type
  //       (no `as` cast, AC-01).
  //   (c) SKYBOX_MODE_CUBEMAP === 0 invariant (non-zero sentinel guard,
  //       AC-01).
  //   (d) defaults: { mode: SKYBOX_MODE_CUBEMAP } takes effect -- spawn
  //       without `mode` yields mode === 0 (AC-01).
  //   (e) The mapper function uses exhaustive switch (no `default` branch,
  //       AC-02).
  //
  // Anchors: requirements AC-01 / AC-02; plan-strategy D-5 (f32 enum
  // column + mapper); research Finding 6 (camera.ts:51,105,145,221-237
  // cameraProjectionFromF32 pattern); plan-tasks.json w2 acceptanceCheck.

  describe('SkyboxBackground — component schema (AC-01)', () => {
    it('SKYBOX_MODE_CUBEMAP equals 0 (non-zero guard)', () => {
      expect(SKYBOX_MODE_CUBEMAP).toBe(0);
    });

    it('SkyboxBackground is a defineComponent token', () => {
      expect(SkyboxBackground).toBeDefined();
      expect(typeof SkyboxBackground.name).toBe('string');
    });

    it('defaults: { mode: SKYBOX_MODE_CUBEMAP } yields mode===0 on spawn without mode', () => {
      const world = new World();
      const e = world
        .spawn({
          component: SkyboxBackground,
          data: {
            cubemap: 42 as unknown as never, // Handle<CubeTextureAsset> stored as u32
          },
        })
        .unwrap();
      const row = world.get(e, SkyboxBackground).unwrap();
      expect(row.mode).toBe(SKYBOX_MODE_CUBEMAP);
    });

    it('entity with SkyboxBackground is hit by a single-component query', () => {
      const world = new World();
      world.spawn({
        component: SkyboxBackground,
        data: {
          cubemap: 7 as unknown as never,
          mode: SKYBOX_MODE_CUBEMAP,
        },
      });

      const state = createQueryState({ with: [SkyboxBackground, Entity] });
      const hits: Array<{ entityCount: number }> = [];
      queryRun(state, world, (bundle) => {
        hits.push({ entityCount: bundle.Entity.self.length });
      });

      expect(hits.length).toBeGreaterThanOrEqual(1);
      const total = hits.reduce((sum, b) => sum + b.entityCount, 0);
      expect(total).toBe(1);
    });

    it('world.get returns the cubemap handle (u32-stored)', () => {
      const world = new World();
      const handle = 99;
      const e = world
        .spawn({
          component: SkyboxBackground,
          data: { cubemap: handle as unknown as never, mode: 0 },
        })
        .unwrap();
      const row = world.get(e, SkyboxBackground).unwrap();
      expect(row.cubemap).toBe(handle);
    });
  });

  describe('skyboxModeFromF32 — mapper (AC-01 / AC-02)', () => {
    it('skyboxModeFromF32(0) returns "cubemap" (string literal, not widened to string)', () => {
      const result = skyboxModeFromF32(0);
      expect(result).toBe('cubemap');
      // TS narrow: type is literal 'cubemap', not widened `string`.
      expectTypeOf(result).toEqualTypeOf<'cubemap'>();
    });

    it('skyboxModeFromF32(unknown) also returns "cubemap" (only mode exists)', () => {
      // Currently only one mode exists; any value maps to 'cubemap'.
      const result = skyboxModeFromF32(99);
      expect(result).toBe('cubemap');
      expectTypeOf(result).toEqualTypeOf<'cubemap'>();
    });

    it('switch on SkyboxMode is exhaustive (no `as` cast in test)', () => {
      // This demonstrates that the consumer-side switch on SkyboxMode is
      // exhaustive -- when a future mode is added, TS will catch the missing
      // branch at compile time.
      const mode: SkyboxMode = skyboxModeFromF32(0);
      let hit = false;
      switch (mode) {
        case 'cubemap':
          hit = true;
          break;
        // No `default` branch -- TS enforces exhaustiveness when new
        // members are added to SkyboxMode.
      }
      expect(hit).toBe(true);
    });
  });
}

{
  // --- from sort-key.test.ts ---
  // feat-20260525-boilerplate-reduction-pod-defaults-factories / M1 / w3c.
  //
  // SortKey defaults fill regression barrier (AC-04 sweep table #15).
  // Three concerns:
  //
  //   (a) `SortKey.defaults` is a frozen map asserting `{ value: 0 }`
  //       (value 0 means 'no override, use mode formula' per transparent-sort
  //       algorithm semantics, charter P1 progressive disclosure).
  //
  //   (b) `world.spawn({ component: SortKey, data: {} })` yields `value === 0`
  //       (the 'no override' sentinel).
  //
  //   (c) `world.spawn` with an explicit `value: -100` preserves the explicit
  //       value -- layer-2 defaults do NOT overwrite layer-1 explicit input.
  //
  // Anchors: requirements AC-04 (sweep table #15 SortKey defaults-added);
  // plan-strategy section 2 sweep pre-judgment table.

  describe('SortKey.defaults -- frozen map assertion (AC-04 #15)', () => {
    it('SortKey.defaults equals { value: 0 }', () => {
      expect(SortKey.defaults).toEqual({ value: 0 });
    });

    it('SortKey.defaults is deep-frozen (Object.isFrozen returns true)', () => {
      expect(SortKey.defaults).toBeDefined();
      expect(Object.isFrozen(SortKey.defaults as object)).toBe(true);
    });
  });

  describe('SortKey spawn with data: {} -- no-override sentinel (AC-04)', () => {
    it('spawn SortKey with data: {} yields value === 0', () => {
      const world = new World();
      const e = world.spawn({ component: SortKey, data: {} }).unwrap();
      const row = world.get(e, SortKey).unwrap();

      expect(row.value).toBe(0);
    });
  });

  describe('SortKey spawn with explicit value -- layer-1 wins (AC-04)', () => {
    it('spawn SortKey with explicit value: -100 preserves the explicit value', () => {
      const world = new World();
      const e = world.spawn({ component: SortKey, data: { value: -100 } }).unwrap();
      const row = world.get(e, SortKey).unwrap();

      expect(row.value).toBe(-100);
    });
  });
}

{
  // --- from sprite-components-schema.test.ts ---
  // feat-20260521-sprite-atlas-animation / M2 / T-10.
  //
  // TDD red phase: this runtime suite exercises `world.spawn` + `world.get`
  // round-trips for the two new sprite-only ECS components — both of which
  // land in T-11 (SpriteRegionOverride) + T-12 (SpriteAnimation). Before
  // those impl tasks land the imports `../sprite-region-override` /
  // `../sprite-animation` fail to resolve and the suite stays red. After
  // T-11 + T-12 the imports resolve, `defineComponent` accepts the schema
  // keywords (no `SchemaUnsupportedFieldError` / `ManagedArrayElementType-
  // NotAllowedError`), and the spawn / get assertions turn green.
  //
  // Why a runtime test on top of the T-08 / T-09 type-d coverage?
  // Plan-strategy section 4 risk R-SCHEMA-1 + R-SCHEMA-2 explicitly cite the
  // ECS schema whitelist (`SchemaFieldType`) as the structural failure mode:
  // the type-d files prove the literals look right at TS edge, but the
  // runtime `defineComponent` call still has to walk the schema and accept
  // `'array<f32, 4>'` (fixed-length) + `'array<f32>'` (variable) + the
  // scalar `'u32'` / `'f32'` quartet without throwing. T-10 is the
  // behavioural witness for those two risks.
  //
  // Default-value coverage (component-default-fallback layer-3, AC-02 +
  // requirements section 2.3 defaults column):
  //   - `currentFrame: 'u32'`   -> 0   (scalar layer-3 fallback)
  //   - `accumDt: 'f32'`        -> 0   (scalar layer-3 fallback)
  //   - `playbackMode: 'u32'`   -> 0   (= SPRITE_PLAYBACK_MODE_LOOP, the
  //                                     default playbackMode per AC-02 +
  //                                     requirements section 2.3 footnote
  //                                     "default 'loop'")
  // The spawn payload thus only needs to carry frameCount / frameDuration /
  // regions for an entity to be observable; AI users get a meaningful
  // 4-step minimal walk-cycle by passing one Float32Array of length
  // frameCount * 4.
  //
  // Anchors: plan-tasks.json T-10 (acceptanceCheck: T-11 + T-12 land then
  // region round-trip + 6-field default-value + length round-trip + no
  // SchemaUnsupportedFieldError); plan-strategy section 4 R-SCHEMA-1 + R-
  // SCHEMA-2 reaction; research F-5; requirements section AC-01 + AC-02 +
  // section 2.3 (defaults column) + section 2.4; charter F1 + P3.

  describe('SpriteRegionOverride — defineComponent does not throw (R-SCHEMA-2)', () => {
    it("name + schema lock match the M2 D-6 contract (region: 'array<f32, 4>')", () => {
      expect(SpriteRegionOverride.name).toBe('SpriteRegionOverride');
      expect(Object.keys(SpriteRegionOverride.schema).length).toBe(1);
      expect((SpriteRegionOverride.schema as Record<string, unknown>).region).toBe('array<f32, 4>');
    });
  });

  describe('SpriteRegionOverride — spawn + get round-trip (AC-01 + AC-03 producer)', () => {
    it('region [0.5, 0, 0.5, 1] round-trips byte-for-byte', () => {
      const world = new World();
      const region = new Float32Array([0.5, 0, 0.5, 1]);
      const e = world.spawn({ component: SpriteRegionOverride, data: { region } }).unwrap();
      const snap = world.get(e, SpriteRegionOverride).unwrap();
      expect(snap.region).toBeInstanceOf(Float32Array);
      expect(snap.region.length).toBe(4);
      expect(snap.region[0]).toBeCloseTo(0.5, 6);
      expect(snap.region[1]).toBeCloseTo(0, 6);
      expect(snap.region[2]).toBeCloseTo(0.5, 6);
      expect(snap.region[3]).toBeCloseTo(1, 6);
    });

    it('region overwrite via world.set updates the snapshot', () => {
      const world = new World();
      const e = world
        .spawn({
          component: SpriteRegionOverride,
          data: { region: new Float32Array([0, 0, 1, 1]) },
        })
        .unwrap();

      world
        .set(e, SpriteRegionOverride, { region: new Float32Array([0.25, 0.25, 0.5, 0.5]) })
        .unwrap();

      const snap = world.get(e, SpriteRegionOverride).unwrap();
      expect(snap.region.length).toBe(4);
      expect(snap.region[0]).toBeCloseTo(0.25, 6);
      expect(snap.region[2]).toBeCloseTo(0.5, 6);
    });
  });

  describe('SpriteAnimation — defineComponent does not throw (R-SCHEMA-1)', () => {
    it('name + schema lock match the M2 D-5 + D-6 contract (6 fields)', () => {
      expect(SpriteAnimation.name).toBe('SpriteAnimation');

      const schema = SpriteAnimation.schema as Record<string, unknown>;
      expect(Object.keys(schema).length).toBe(6);
      expect(schema.frameCount).toBe('u32');
      expect(schema.frameDuration).toBe('f32');
      expect(schema.currentFrame).toBe('u32');
      expect(schema.accumDt).toBe('f32');
      expect(schema.regions).toBe('array<f32>');
      expect(schema.playbackMode).toBe('u32');
    });
  });

  describe('SpriteAnimation — spawn + get round-trip (AC-02 + section 2.3)', () => {
    it('4-frame walk cycle round-trips through ECS columns', () => {
      const world = new World();
      const frameCount = 4;
      const regions = new Float32Array(frameCount * 4);
      for (let i = 0; i < frameCount; i++) {
        regions[i * 4 + 0] = i * 0.25;
        regions[i * 4 + 1] = 0;
        regions[i * 4 + 2] = 0.25;
        regions[i * 4 + 3] = 1;
      }
      const e = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount,
            frameDuration: 0.1,
            currentFrame: 0,
            accumDt: 0,
            regions,
            playbackMode: SPRITE_PLAYBACK_MODE_LOOP,
          },
        })
        .unwrap();
      const snap = world.get(e, SpriteAnimation).unwrap();
      expect(snap.frameCount).toBe(frameCount);
      expect(snap.frameDuration).toBeCloseTo(0.1, 6);
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
      expect(snap.regions).toBeInstanceOf(Float32Array);
      expect(snap.regions.length).toBe(frameCount * 4);
      expect(snap.regions[2 * 4 + 0]).toBeCloseTo(0.5, 6);
      expect(snap.playbackMode).toBe(SPRITE_PLAYBACK_MODE_LOOP);
    });

    it('clamp playback mode encodes as numeric 1 in the column', () => {
      const world = new World();
      const e = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 3,
            frameDuration: 0.1,
            regions: new Float32Array(3 * 4),
            playbackMode: SPRITE_PLAYBACK_MODE_CLAMP,
          },
        })
        .unwrap();
      const snap = world.get(e, SpriteAnimation).unwrap();
      expect(snap.playbackMode).toBe(1);
      expect(snap.playbackMode).toBe(SPRITE_PLAYBACK_MODE_CLAMP);
    });

    it('layer-3 defaults fill currentFrame=0 / accumDt=0 / playbackMode=0 when omitted', () => {
      const world = new World();
      const e = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 2,
            frameDuration: 0.05,
            regions: new Float32Array([0, 0, 0.5, 1, 0.5, 0, 0.5, 1]),
          },
        })
        .unwrap();
      const snap = world.get(e, SpriteAnimation).unwrap();
      expect(snap.currentFrame).toBe(0);
      expect(snap.accumDt).toBeCloseTo(0, 6);
      expect(snap.playbackMode).toBe(SPRITE_PLAYBACK_MODE_LOOP);
      expect(snap.regions.length).toBe(2 * 4);
    });

    it('variable regions length round-trip — frameCount * 4 invariant is data not schema', () => {
      // Schema does not constrain regions.length; the M4 sprite-animation-tick
      // system enforces `regions.length === frameCount * 4` at first
      // observation (D-1 fail-fast path). This test only locks the bytes
      // round-trip — feeding 12 floats with frameCount === 3 returns 12 floats.
      const world = new World();
      const regions = new Float32Array([0, 0, 0.33, 1, 0.33, 0, 0.33, 1, 0.66, 0, 0.34, 1]);
      const e = world
        .spawn({
          component: SpriteAnimation,
          data: {
            frameCount: 3,
            frameDuration: 0.2,
            regions,
          },
        })
        .unwrap();
      const snap = world.get(e, SpriteAnimation).unwrap();
      expect(snap.regions.length).toBe(12);
      expect(snap.regions[4]).toBeCloseTo(0.33, 6);
    });
  });
}

{
  // --- from sprite-playback-mode.test.ts ---
  // feat-20260521-sprite-atlas-animation / M1 / T-06.
  //
  // TDD red phase: packages/runtime/src/components/sprite-playback-mode.ts
  // does not yet exist — these constant + mapper assertions stay red until
  // T-07 lands the SSOT (plan-strategy section 2 D-5 / requirements
  // section AC-02 + section 2.3).
  //
  // The shape mirrors `packages/runtime/src/components/camera.ts:72-90`
  // Tonemap block (TONEMAP_NONE = 0 / TONEMAP_REINHARD_EXTENDED = 1 +
  // `type Tonemap = 'none' | 'reinhard-extended'` + `tonemapFromF32`)
  // because ECS schema whitelist SchemaFieldType does not accept string-
  // literal unions for `playbackMode` (research F-2 + F-5). The mapper
  // pattern lets the ECS column stay `'u32'` while AI users still consume
  // `'loop' | 'clamp'` literal-union narrowing in TS land.
  //
  // Anchors: plan-strategy section 2 D-5 + section 3.1 PR block SPM (sprite-
  //          playback-mode) + section 4 risk R-SCHEMA-1 reaction; research
  //          F-2 + F-5; requirements section AC-02 + section 2.3 playbackMode
  //          row; charter P4 consistent abstraction (same shape as M1
  //          tonemap-encoding so AI users keep one mental model).

  describe('sprite-playback-mode SSOT — constants', () => {
    it('SPRITE_PLAYBACK_MODE_LOOP === 0 (u32 column encoding)', () => {
      expect(SPRITE_PLAYBACK_MODE_LOOP).toBe(0);
    });

    it('SPRITE_PLAYBACK_MODE_CLAMP === 1 (u32 column encoding)', () => {
      expect(SPRITE_PLAYBACK_MODE_CLAMP).toBe(1);
    });

    it('constants are typed as numeric literals (not widened to number)', () => {
      expectTypeOf(SPRITE_PLAYBACK_MODE_LOOP).toEqualTypeOf<0>();
      expectTypeOf(SPRITE_PLAYBACK_MODE_CLAMP).toEqualTypeOf<1>();
    });
  });

  describe('sprite-playback-mode SSOT — SpritePlaybackMode type', () => {
    it("SpritePlaybackMode is exactly 'loop' | 'clamp'", () => {
      expectTypeOf<SpritePlaybackMode>().toEqualTypeOf<'loop' | 'clamp'>();
    });

    it("'loop' is assignable to SpritePlaybackMode", () => {
      const mode: SpritePlaybackMode = 'loop';
      expect(mode).toBe('loop');
    });

    it("'clamp' is assignable to SpritePlaybackMode", () => {
      const mode: SpritePlaybackMode = 'clamp';
      expect(mode).toBe('clamp');
    });
  });

  describe('spritePlaybackModeFromU32 — u32 to string-literal translator', () => {
    it('spritePlaybackModeFromU32(0) === "loop"', () => {
      expect(spritePlaybackModeFromU32(0)).toBe('loop');
    });

    it('spritePlaybackModeFromU32(1) === "clamp"', () => {
      expect(spritePlaybackModeFromU32(1)).toBe('clamp');
    });

    it('out-of-range numerics fall back to "loop" (charter P4 no silent exception)', () => {
      // Mirror cameraProjectionFromF32 / tonemapFromF32: defensive default
      // for uninitialised / stale numeric values. The schema layer already
      // guarantees the column carries a u32, but AI users may pass through a
      // hand-set numeric that escapes the [0, 1] range.
      expect(spritePlaybackModeFromU32(2)).toBe('loop');
      expect(spritePlaybackModeFromU32(-1)).toBe('loop');
      expect(spritePlaybackModeFromU32(NaN)).toBe('loop');
    });

    it('return type narrows to SpritePlaybackMode (string-literal union)', () => {
      expectTypeOf(spritePlaybackModeFromU32(0)).toEqualTypeOf<SpritePlaybackMode>();
    });

    it('round-trip: SPRITE_PLAYBACK_MODE_LOOP -> "loop" / SPRITE_PLAYBACK_MODE_CLAMP -> "clamp"', () => {
      expect(spritePlaybackModeFromU32(SPRITE_PLAYBACK_MODE_LOOP)).toBe('loop');
      expect(spritePlaybackModeFromU32(SPRITE_PLAYBACK_MODE_CLAMP)).toBe('clamp');
    });
  });
}

{
  // --- from transform.test.ts ---
  // feat-20260525-boilerplate-reduction-pod-defaults-factories / M1 / w1.
  //
  // Transform defaults fill regression barrier (AC-02 + AC-03). Three
  // concerns:
  //
  //   (a) `world.spawn({ component: Transform, data: {} })` returns identity
  //       transform (pos/quat/scale all identity values), verifying that the
  //       layer-2 defaults map fills every schema field.
  //
  //   (b) `world.spawn({ component: Transform, data: { posZ: 2 } })` returns
  //       posZ=2 with remaining fields at identity defaults, verifying that
  //       layer-1 explicit values take priority over layer-2 defaults.
  //
  //   (c) `world.set` partial patch on Transform does not affect unfilled
  //       columns, verifying the column-wise set semantics.
  //
  // Anchors: requirements AC-02 / AC-03; plan-strategy section 5.1 TDD
  // red-green-refactor + section 5.2 unit test requirements.

  describe('Transform defaults fill — identity spawn (AC-02)', () => {
    it('world.spawn({ component: Transform, data: {} }) returns identity transform', () => {
      const world = new World();
      const e = world.spawn({ component: Transform, data: {} }).unwrap();
      const row = world.get(e, Transform).unwrap();

      expect(row.posX).toBe(0);
      expect(row.posY).toBe(0);
      expect(row.posZ).toBe(0);
      expect(row.quatX).toBe(0);
      expect(row.quatY).toBe(0);
      expect(row.quatZ).toBe(0);
      expect(row.quatW).toBe(1);
      expect(row.scaleX).toBe(1);
      expect(row.scaleY).toBe(1);
      expect(row.scaleZ).toBe(1);
    });
  });

  describe('Transform partial override — layer-1 wins over layer-2 defaults (AC-03)', () => {
    it('world.spawn with only posZ=2 yields identity on all other fields', () => {
      const world = new World();
      const e = world.spawn({ component: Transform, data: { posZ: 2 } }).unwrap();
      const row = world.get(e, Transform).unwrap();

      expect(row.posX).toBe(0);
      expect(row.posY).toBe(0);
      expect(row.posZ).toBe(2);
      expect(row.quatX).toBe(0);
      expect(row.quatY).toBe(0);
      expect(row.quatZ).toBe(0);
      expect(row.quatW).toBe(1);
      expect(row.scaleX).toBe(1);
      expect(row.scaleY).toBe(1);
      expect(row.scaleZ).toBe(1);
    });
  });

  describe('Transform new schema — local 10 f32 cols + world array<f32,16> (AC-01)', () => {
    it('spawn data:{} yields identity local TRS + identity world mat4 (16 contiguous f32)', () => {
      const world = new World();
      const e = world.spawn({ component: Transform, data: {} }).unwrap();
      const row = world.get(e, Transform).unwrap();

      // local 10 f32 scalar columns at identity.
      expect(row.posX).toBe(0);
      expect(row.posY).toBe(0);
      expect(row.posZ).toBe(0);
      expect(row.quatX).toBe(0);
      expect(row.quatY).toBe(0);
      expect(row.quatZ).toBe(0);
      expect(row.quatW).toBe(1);
      expect(row.scaleX).toBe(1);
      expect(row.scaleY).toBe(1);
      expect(row.scaleZ).toBe(1);

      // world array<f32,16> resolves to a Float32Array view of 16 contiguous
      // floats. Default fill is the identity mat4 (column-major).
      const w = row.world as Float32Array;
      expect(w).toBeInstanceOf(Float32Array);
      expect(w.length).toBe(16);
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      for (let i = 0; i < 16; i++) {
        expect(w[i]).toBeCloseTo(identity[i] as number, 5);
      }
    });
  });

  describe('Transform world.set — partial patch does not affect unfilled columns', () => {
    it('world.set partial patch on Transform leaves unreferenced columns unchanged', () => {
      const world = new World();
      const e = world
        .spawn({ component: Transform, data: { posX: 5, posY: 3, posZ: 10 } })
        .unwrap();

      // Partial set: only change posX.
      world.set(e, Transform, { posX: 25 }).unwrap();

      const after = world.get(e, Transform).unwrap();
      expect(after.posX).toBe(25);
      // Unaffected columns remain unchanged.
      expect(after.posY).toBe(3);
      expect(after.posZ).toBe(10);
      // Identity defaults still in place for unset columns.
      expect(after.quatX).toBe(0);
      expect(after.quatY).toBe(0);
      expect(after.quatZ).toBe(0);
      expect(after.quatW).toBe(1);
      expect(after.scaleX).toBe(1);
      expect(after.scaleY).toBe(1);
      expect(after.scaleZ).toBe(1);
    });
  });
}

{
  // --- from mesh-renderer-multi-material.test.ts ---
  // mesh-renderer-multi-material.test.ts — unit tests for render-system-extract
  // count-mismatch validation (feat-20260608-mesh-multi-section-primitive-multi-material-slot
  // M2 / w12).
  //
  // Anchors: requirements AC-05 (a); plan-strategy §2 D-3 (read-side interception);
  // plan-strategy §5.3 key test points "AC-03/AC-05 three triggers".

  describe('render-system-extract count-mismatch (w12, AC-05 a)', () => {
    it('single mesh single material: extract succeeds', () => {
      const world = new World();
      const assets = new AssetRegistry(
        // biome-ignore lint/suspicious/noExplicitAny: mock ShaderRegistry
        { lookupMaterialShader: () => ({ ok: false }) } as any,
      );

      const matHandle = world.allocSharedRef('MaterialAsset', {
        kind: 'material',
        shadingModel: 'unlit',
        baseColor: [1, 0, 0, 1],
      } as never);

      const meshHandle = world.allocSharedRef('MeshAsset', {
        kind: 'mesh',
        vertices: new Float32Array(4 * 12),
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        attributes: { position: new Float32Array(4 * 3) },
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 6,
            vertexCount: 4,
            topology: 'triangle-list' as const,
          },
        ],
      } as never);

      world.spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
      );

      // Extract should not crash; count matches (1 submesh, 1 material).
      // The renderable may be empty (material resolves to 0 passes with mock
      // ShaderRegistry) but the key assertion: no crash and count-mismatch
      // error is NOT triggered.
      const frame = extractFrame(world, assets);
      expect(frame.renderables).toBeDefined();
    });

    it('materials: [] with submeshes: [1] routes through D-Q7 case B mid-grey default (preserves legacy single-mesh-no-material path)', () => {
      const world = new World();

      const assets = new AssetRegistry(
        // biome-ignore lint/suspicious/noExplicitAny: mock ShaderRegistry
        { lookupMaterialShader: () => ({ ok: false }) } as any,
      );

      const meshHandle = world.allocSharedRef('MeshAsset', {
        kind: 'mesh',
        vertices: new Float32Array(4 * 12),
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        attributes: { position: new Float32Array(4 * 3) },
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 6,
            vertexCount: 4,
            topology: 'triangle-list' as const,
          },
        ],
      } as never);

      world.spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [] } },
      );

      // materials.length=0 routes through D-Q7 case B (defaultMaterialSnapshot
      // mid-grey unlit) without triggering mesh-renderer-material-count-mismatch
      // -- count-mismatch only applies to non-empty materials whose length
      // disagrees with submeshes.length. Backward-compat preserved for legacy
      // `data: {}` spawn shape (charter P5 consistent abstraction).
      const frame = extractFrame(world, assets);
      expect(frame.renderables.length).toBe(1);
    });

    it('materials: [m, m] with submeshes: [1] (non-empty length mismatch) -> count-mismatch fail-fast, 0 renderables', () => {
      const world = new World();

      const assets = new AssetRegistry(
        // biome-ignore lint/suspicious/noExplicitAny: mock ShaderRegistry
        { lookupMaterialShader: () => ({ ok: false }) } as any,
      );

      const matHandle = world.allocSharedRef('MaterialAsset', {
        kind: 'material',
        shadingModel: 'unlit',
        baseColor: [1, 0, 0, 1],
      } as never);

      const meshHandle = world.allocSharedRef('MeshAsset', {
        kind: 'mesh',
        vertices: new Float32Array(4 * 12),
        indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
        attributes: { position: new Float32Array(4 * 3) },
        submeshes: [
          {
            indexOffset: 0,
            indexCount: 6,
            vertexCount: 4,
            topology: 'triangle-list' as const,
          },
        ],
      } as never);

      world.spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: meshHandle } },
        { component: MeshRenderer, data: { materials: [matHandle, matHandle] } },
      );

      const frame = extractFrame(world, assets);
      expect(frame.renderables.length).toBe(0);
    });
  });
}
