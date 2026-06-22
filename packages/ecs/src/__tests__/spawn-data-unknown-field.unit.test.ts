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
import { describe, expect, it } from 'vitest';
import { createCommandBuffer } from '../commands';
import { defineComponent } from '../component';
import { fillComponentDefaults, validateComponentDataKeys } from '../component-default-fallback';
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

  describe('SceneAsset.instantiate — Result.err on typo', () => {
    it('SceneEntity component payload with typo surfaces SpawnDataUnknownFieldError', () => {
      const T = defineComponent('TransformLike_scene', {
        posX: 'f32',
        posY: 'f32',
        posZ: 'f32',
      });
      defineComponent('SceneInstance', {
        source: 'shared<SceneAsset>',
        mapping: 'array<entity>',
        state: 'unique<SceneInstanceState>',
      });
      const lid = (n: number) => n as LocalEntityId;
      const nodes: SceneEntity[] = [
        // Typo: posXX instead of posX.
        { localId: lid(0), components: { TransformLike_scene: { posXX: 0, posY: 0, posZ: 0 } } },
      ];
      const world = new World();
      const handle = world.allocSharedRef('SceneAsset', {
        kind: 'scene',
        entities: nodes,
      } as SceneAsset);
      const r = world.instantiateScene(handle as Handle<'SceneAsset', 'shared'>);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('spawn-data-unknown-field');
      const detail = (r.error as unknown as { detail: { component: string; field: string } })
        .detail;
      expect(detail.component).toBe('TransformLike_scene');
      expect(detail.field).toBe('posXX');
      // Failed instantiate must not partially-spawn nodes (besides synthetic root accounting).
      // The typo node is rejected before any entity write commits.
      // Use T to silence "unused" warnings.
      void T;
    });
  });
});
