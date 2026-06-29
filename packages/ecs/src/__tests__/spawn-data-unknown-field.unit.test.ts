// bug-20260615-spawn-data-unknown-field-fail-fast — fail-fast guard on
// caller-supplied keys that are NOT declared in the component schema.
//
// Pre-fix: `fillComponentDefaults` walked schema keys and never inspected
// raw keys, so a typo like `MeshRenderer { material }` (singular legacy
// name; current schema declares `materials` array) was silently dropped
// and the entity rendered as the empty-defaults / mid-grey fallback.
//
// Post-fix: spawn / addComponent / SceneAsset.instantiate / Commands.spawn
// all surface a `SpawnDataUnknownFieldError` (.code 'spawn-data-unknown-field')
// at the boundary, with `.detail.field` and `.detail.knownFields` carrying
// the offending key + the schema's full whitelist.

import type { Handle, LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createCommandBuffer } from '../commands';
import { defineComponent, resolveComponent } from '../component';
import { fillComponentDefaults, validateComponentDataKeys } from '../component-default-fallback';
import type { EntityHandle } from '../entity-handle';
import { World } from '../world';

describe('bug-20260615 — spawn-data unknown-field fail-fast', () => {
  describe('validateComponentDataKeys (helper)', () => {
    it('returns null for raw containing only schema keys', () => {
      const C = defineComponent('C_ok', { x: 'f32', y: 'f32' });
      expect(validateComponentDataKeys(C, { x: 1 })).toBeNull();
      expect(validateComponentDataKeys(C, { x: 1, y: 2 })).toBeNull();
      expect(validateComponentDataKeys(C, {})).toBeNull();
      expect(validateComponentDataKeys(C, undefined)).toBeNull();
    });

    it('returns SpawnDataUnknownFieldError for an unknown raw key', () => {
      const C = defineComponent('C_bad', { x: 'f32', y: 'f32' });
      const e = validateComponentDataKeys(C, { z: 7 });
      expect(e).not.toBeNull();
      expect(e?.code).toBe('spawn-data-unknown-field');
      expect(e?.detail).toEqual({
        component: 'C_bad',
        field: 'z',
        knownFields: ['x', 'y'],
      });
      expect(e?.message).toContain('spawn-data-unknown-field');
      expect(e?.hint).toContain('typo');
    });

    it('reports first offending key (deterministic)', () => {
      const C = defineComponent('C_first', { a: 'f32', b: 'f32' });
      // Object key order = insertion order. The first key 'q' is reported.
      const e = validateComponentDataKeys(C, { q: 1, r: 2 });
      expect(e?.detail.field).toBe('q');
    });

    it('does NOT mutate raw or schema', () => {
      const C = defineComponent('C_pure', { x: 'f32' });
      const raw = { x: 1, bad: 2 };
      validateComponentDataKeys(C, raw);
      expect(raw).toEqual({ x: 1, bad: 2 });
    });
  });

  describe('world.spawn — Result.err on typo', () => {
    it('singular vs plural typo (the canonical reproducer)', () => {
      // Mimics MeshRenderer rename trap: schema has `materials`, caller
      // uses singular `material` (old name).
      const MeshRendererLike = defineComponent('MeshRendererLike', {
        materials: 'array<u32>',
        frustumCulled: 'u8',
      });
      const world = new World();
      const r = world.spawn({ component: MeshRendererLike, data: { material: 99 } as never });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('spawn-data-unknown-field');
      const detail = (r.error as unknown as { detail: { component: string; field: string } })
        .detail;
      expect(detail.component).toBe('MeshRendererLike');
      expect(detail.field).toBe('material');
    });

    it('aborts cleanly without partial state (no entity allocated)', () => {
      const C = defineComponent('C_noLeak', { x: 'f32' });
      const world = new World();
      const before = world.inspect().entityCount;
      const r = world.spawn({ component: C, data: { typo: 1 } as never });
      expect(r.ok).toBe(false);
      // Failed spawn must not allocate an entity.
      expect(world.inspect().entityCount).toBe(before);
    });

    it('valid spawn data still works (regression guard)', () => {
      const C = defineComponent('C_ok2', { x: 'f32', y: 'f32' });
      const world = new World();
      const r = world.spawn({ component: C, data: { x: 1, y: 2 } });
      expect(r.ok).toBe(true);
    });

    it('fillComponentDefaults remains unchanged (still drops unknown keys silently when called directly — pure helper)', () => {
      // The fill helper itself is intentionally NOT validating. Validation
      // lives at the spawn boundary; the fill helper stays pure.
      const C = defineComponent('C_fillpure', { x: 'f32' });
      const out = fillComponentDefaults(C, { x: 1, ignored: 99 } as never);
      expect(out.x).toBe(1);
      expect('ignored' in out).toBe(false);
    });
  });

  describe('world.addComponent — Result.err on typo', () => {
    it('typo aborts before archetype migration', () => {
      const Pos = defineComponent('Pos_addBad', { x: 'f32' });
      const Vel = defineComponent('Vel_addBad', { dx: 'f32' });
      const world = new World();
      const e = world.spawn({ component: Pos, data: { x: 1 } });
      expect(e.ok).toBe(true);
      if (!e.ok) return;
      const r = world.addComponent(e.value, { component: Vel, data: { dxx: 5 } as never });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('spawn-data-unknown-field');
      // Entity should NOT have gained Vel — migration aborted before mutation.
      const get = world.get(e.value, Vel);
      expect(get.ok).toBe(false);
      if (!get.ok) expect(get.error.code).toBe('component-not-present');
    });
  });

  describe('Commands.spawn / Commands.addComponent — throws synchronously', () => {
    it('Commands.spawn throws on unknown raw key (queue-time fail-fast)', () => {
      const C = defineComponent('C_cmdSpawn', { x: 'f32' });
      const world = new World();
      const cmds = createCommandBuffer(world);
      expect(() => cmds.spawn({ component: C, data: { typo: 1 } as never })).toThrow(
        /spawn-data-unknown-field/,
      );
    });

    it('Commands.addComponent throws on unknown raw key', () => {
      const C = defineComponent('C_cmdAdd', { x: 'f32' });
      const world = new World();
      const cmds = createCommandBuffer(world);
      const e = world.spawn({ component: C, data: { x: 1 } });
      if (!e.ok) throw new Error('spawn failed unexpectedly');
      // Can't addComponent the same component (already-present), so use a sibling.
      const D = defineComponent('D_cmdAdd', { y: 'f32' });
      expect(() => cmds.addComponent(e.value, { component: D, data: { yy: 1 } as never })).toThrow(
        /spawn-data-unknown-field/,
      );
    });
  });

  // C-R2 (feat-20260622-s5 M6): SceneAsset.instantiate unknown-field is NOT a
  // fatal abort. Unlike world.spawn / addComponent (explicit API calls where a
  // typo is a programming error and stays fail-fast), scene data is loader-fed
  // and may carry a stale / typo / deprecated field. Blank-aborting the whole
  // scene over one bad field is hostile (#478 lesson: the prod-silent strip
  // re-introduced an invisible-entity class). The new contract: instantiate
  // SUCCEEDS, skips the unknown key (no write, no input mutation), and surfaces
  // a structured diagnostic on the success value so it is observable in
  // production (NOT NODE_ENV-gated).
  describe('SceneAsset.instantiate — C-R2 structured diagnostic (production-observable)', () => {
    const lid = (n: number) => n as LocalEntityId;

    function registerSceneInstance(): void {
      defineComponent('SceneInstance', {
        source: 'shared<SceneAsset>',
        mapping: 'array<entity>',
        state: 'unique<SceneInstanceState>',
      });
    }

    it('unknown-field scene -> Result.ok + diagnostics[] carrying component/field/localId', () => {
      defineComponent('CameraLike_w29', { orthoSize: 'f32' });
      registerSceneInstance();
      const nodes: SceneEntity[] = [
        // Typo: orthoHalfExtent is not a schema field (schema has orthoSize).
        { localId: lid(0), components: { CameraLike_w29: { orthoHalfExtent: 5 } } },
      ];
      const world = new World();
      const handle = world.allocSharedRef('SceneAsset', {
        kind: 'scene',
        entities: nodes,
      } as SceneAsset);
      const r = world.instantiateScene(handle as Handle<'SceneAsset', 'shared'>);
      // (a) does NOT blank the scene — instantiate succeeds.
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // (b) structured diagnostic entry, consumed by property access (no string parse).
      expect(r.value.diagnostics).toHaveLength(1);
      const d = r.value.diagnostics[0];
      expect(d).toBeDefined();
      if (d === undefined) return;
      expect(d.component).toBe('CameraLike_w29');
      expect(d.field).toBe('orthoHalfExtent');
      expect(d.localId).toBe(0);
      // value.root is the synthetic scene root EntityHandle.
      expect(typeof r.value.root).toBe('number');
    });

    it('production observability is NOT NODE_ENV-gated (same signal in NODE_ENV=production)', () => {
      defineComponent('CameraLike_w29prod', { orthoSize: 'f32' });
      registerSceneInstance();
      const prior = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const nodes: SceneEntity[] = [
          { localId: lid(0), components: { CameraLike_w29prod: { orthoHalfExtent: 7 } } },
        ];
        const world = new World();
        const handle = world.allocSharedRef('SceneAsset', {
          kind: 'scene',
          entities: nodes,
        } as SceneAsset);
        const r = world.instantiateScene(handle as Handle<'SceneAsset', 'shared'>);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        // Production must still observe the structured diagnostic (no silent drop).
        expect(r.value.diagnostics).toHaveLength(1);
        expect(r.value.diagnostics[0]?.field).toBe('orthoHalfExtent');
      } finally {
        if (prior === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prior;
      }
    });
  });

  // C-R2 (w30): the diagnostic path must NOT mutate the input SceneAsset. #478
  // re-landed a `delete rawObj[k]` that scribbled on the shared cached scene
  // object, so a second instantiate of the SAME handle no longer saw the field
  // -> non-idempotent + corrupted source. The remap copies into a fresh object
  // and skips unknown keys; the source is never touched. Two instantiate calls
  // must produce identical diagnostics (architecture-principles #6 idempotency).
  describe('SceneAsset.instantiate — C-R2 does not mutate input + idempotent', () => {
    const lid = (n: number) => n as LocalEntityId;

    function registerSceneInstance(): void {
      defineComponent('SceneInstance', {
        source: 'shared<SceneAsset>',
        mapping: 'array<entity>',
        state: 'unique<SceneInstanceState>',
      });
    }

    it('double instantiate -> input unknown-field still present + diagnostics consistent', () => {
      defineComponent('CameraLike_w30', { orthoSize: 'f32' });
      registerSceneInstance();
      const badComponent = { orthoHalfExtent: 5 };
      const nodes: SceneEntity[] = [
        { localId: lid(0), components: { CameraLike_w30: badComponent } },
      ];
      const asset = { kind: 'scene', entities: nodes } as SceneAsset;
      const world = new World();
      const handle = world.allocSharedRef('SceneAsset', asset);

      const r1 = world.instantiateScene(handle as Handle<'SceneAsset', 'shared'>);
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      // (a) input object NOT mutated — unknown-field still on the source after
      // the first instantiate (not deleted).
      expect('orthoHalfExtent' in badComponent).toBe(true);
      expect(badComponent.orthoHalfExtent).toBe(5);
      // (c) the first entity still spawned (synthetic root + one node entity).
      expect(world.inspect().entityCount).toBe(2);

      const r2 = world.instantiateScene(handle as Handle<'SceneAsset', 'shared'>);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      // (b) two diagnostics outputs identical (idempotent) — by structural value.
      expect(r2.value.diagnostics).toEqual(r1.value.diagnostics);
      expect(r2.value.diagnostics[0]?.field).toBe('orthoHalfExtent');
      // input STILL intact after the second instantiate.
      expect('orthoHalfExtent' in badComponent).toBe(true);
    });
  });

  // C-R2 (w31): one deprecated / typo field on ONE component must not abort the
  // whole scene. All entities (including the one carrying the unknown field)
  // spawn; the component's KNOWN fields are written correctly; the diagnostic
  // names only the offending field. This is the anti-blank guarantee (C-AC-04).
  describe('SceneAsset.instantiate — C-R2 does not blank a multi-entity scene', () => {
    const lid = (n: number) => n as LocalEntityId;

    it('3-entity scene with one unknown-field -> all spawn, known fields written, 1 diagnostic', () => {
      const Tr = defineComponent('TransformLike_w31', {
        posX: 'f32',
        posY: 'f32',
        posZ: 'f32',
      });
      defineComponent('SceneInstance', {
        source: 'shared<SceneAsset>',
        mapping: 'array<entity>',
        state: 'unique<SceneInstanceState>',
      });
      const nodes: SceneEntity[] = [
        { localId: lid(0), components: { TransformLike_w31: { posX: 1, posY: 2, posZ: 3 } } },
        // localId 1 carries an unknown field `posXX` alongside known posY.
        { localId: lid(1), components: { TransformLike_w31: { posXX: 9, posY: 20, posZ: 30 } } },
        { localId: lid(2), components: { TransformLike_w31: { posX: 4, posY: 5, posZ: 6 } } },
      ];
      const world = new World();
      const handle = world.allocSharedRef('SceneAsset', {
        kind: 'scene',
        entities: nodes,
      } as SceneAsset);
      const r = world.instantiateScene(handle as Handle<'SceneAsset', 'shared'>);
      // (a) Result.ok — scene not blanked.
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // (b) all 3 node entities + 1 synthetic root = 4 spawned (none lost).
      expect(world.inspect().entityCount).toBe(4);
      // (d) exactly one diagnostic, for the typo'd component+field+localId.
      expect(r.value.diagnostics).toHaveLength(1);
      expect(r.value.diagnostics[0]).toEqual({
        component: 'TransformLike_w31',
        field: 'posXX',
        localId: 1,
      });
      // (c) known fields written correctly. mapping[1] holds the typo entity;
      // its known posY/posZ wrote through; the skipped posXX leaves posX at
      // the layer-2 default (0).
      const sceneInstanceToken = resolveComponent('SceneInstance');
      if (sceneInstanceToken === undefined) throw new Error('SceneInstance not registered');
      const mapping = (
        world.get(r.value.root, sceneInstanceToken).unwrap() as unknown as {
          mapping: Uint32Array;
        }
      ).mapping;
      const member1 = mapping[1] as unknown as EntityHandle;
      const got = world.get(member1, Tr);
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.value.posY).toBe(20);
      expect(got.value.posZ).toBe(30);
      expect(got.value.posX).toBe(0); // skipped unknown key -> default, not 9
      // A fully-known sibling wrote all three fields.
      const member0 = mapping[0] as unknown as EntityHandle;
      const got0 = world.get(member0, Tr);
      expect(got0.ok).toBe(true);
      if (!got0.ok) return;
      expect(got0.value.posX).toBe(1);
    });
  });

  // C-R2 (w33): scenes nest via mounts. A child sub-scene's unknown-field
  // diagnostics must bubble up the recursion chain
  // (_instantiateSceneRec -> _instantiateSceneAsset -> _buildSceneEntityComponentDatas)
  // into the TOP-LEVEL instantiateScene result, never dropped at the boundary.
  // Plus: a fully-known scene yields an empty array (no false positives), and
  // every diagnostic field is consumed by property access (no string parse /
  // no `any`).
  describe('SceneAsset.instantiate — C-R2 recursive aggregation + exhaustion', () => {
    const lid = (n: number) => n as LocalEntityId;

    function registerSceneInstance(): void {
      defineComponent('SceneInstance', {
        source: 'shared<SceneAsset>',
        mapping: 'array<entity>',
        state: 'unique<SceneInstanceState>',
      });
    }

    it('parent + mounted child each with unknown-field -> diagnostics has BOTH', () => {
      defineComponent('CamLike_w33nest', { orthoSize: 'f32' });
      // Mounts wire ChildOf; the synthetic root carries Transform. Both must be
      // registered before instantiating a SceneAsset that has mounts.
      defineComponent('ChildOf', { parent: 'entity' });
      defineComponent('Transform', { posX: 'f32', posY: 'f32', posZ: 'f32' });
      registerSceneInstance();
      const world = new World();

      // Child sub-scene: one entity carrying an unknown field `childTypo`.
      const childAsset: SceneAsset = {
        kind: 'scene',
        entities: [{ localId: lid(0), components: { CamLike_w33nest: { childTypo: 1 } } }],
      };
      const childHandle = world.allocSharedRef('SceneAsset', childAsset);

      // Outer scene: one entity with its own unknown field `parentTypo`, plus
      // a mount of the child sub-scene (memberFirst=1 window of size 1).
      const outerAsset: SceneAsset = {
        kind: 'scene',
        entities: [{ localId: lid(0), components: { CamLike_w33nest: { parentTypo: 2 } } }],
        mounts: [{ localId: lid(1), source: 0, memberFirst: lid(2), memberCount: 1 }],
      };
      const outerHandle = world.allocSharedRef('SceneAsset', outerAsset);
      world._setSceneAssetResolver(() => ok(childHandle));

      const r = world.instantiateScene(outerHandle);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // BOTH the parent-level and the recursively-mounted child diagnostics
      // bubbled into the single top-level diagnostics[] (recursive aggregation).
      const fields = r.value.diagnostics.map((d) => d.field).sort();
      expect(fields).toEqual(['childTypo', 'parentTypo']);
      expect(r.value.diagnostics).toHaveLength(2);
    });

    it('all-known scene -> diagnostics is an empty array (no false positives)', () => {
      defineComponent('CamLike_w33ok', { orthoSize: 'f32' });
      registerSceneInstance();
      const world = new World();
      const asset: SceneAsset = {
        kind: 'scene',
        entities: [{ localId: lid(0), components: { CamLike_w33ok: { orthoSize: 5 } } }],
      };
      const handle = world.allocSharedRef('SceneAsset', asset);
      const r = world.instantiateScene(handle as Handle<'SceneAsset', 'shared'>);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.diagnostics).toEqual([]);
    });

    it('diagnostic fields are consumed by property access (compile-time, no any)', () => {
      defineComponent('CamLike_w33prop', { orthoSize: 'f32' });
      registerSceneInstance();
      const world = new World();
      const asset: SceneAsset = {
        kind: 'scene',
        entities: [{ localId: lid(0), components: { CamLike_w33prop: { wrongName: 1 } } }],
      };
      const handle = world.allocSharedRef('SceneAsset', asset);
      const r = world.instantiateScene(handle as Handle<'SceneAsset', 'shared'>);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.diagnostics[0];
      expect(d).toBeDefined();
      if (d === undefined) return;
      // Each field reached by typed property access — `component`/`field` are
      // `string`, `localId` is `number`. No cast, no JSON / string parse.
      const component: string = d.component;
      const field: string = d.field;
      const localId: number = d.localId;
      expect(component).toBe('CamLike_w33prop');
      expect(field).toBe('wrongName');
      expect(localId).toBe(0);
    });
  });
});
