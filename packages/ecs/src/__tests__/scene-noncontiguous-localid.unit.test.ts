// C-R1 (studio-issues #6): non-contiguous localId mapping sizing test.
//
// Pre-fix: mapping table sized to entity count (totalSlots = entityCount),
// so non-contiguous localIds with gaps (e.g. [0, 5] -> 2 entities, maxId=5)
// cause silent Uint32Array OOB on mapping[maxId] — entity spawns but is
// unreachable by localId.
//
// Post-fix: totalSlots = Math.max(entityCount, maxLocalId + 1).
//
// TDD red phase: this test is expected to FAIL until w25 lands.

/// <reference types="vitest" />

import type { Handle, LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { defineComponent, resolveComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import { World } from '../world';

const Transform = defineComponent('Transform', {
  posX: { type: 'f32' },
  posY: { type: 'f32' },
  posZ: { type: 'f32' },
});

defineComponent('SceneInstance', {
  source: { type: 'shared<SceneAsset>' },
  mapping: { type: 'array<entity>' },
  state: { type: 'unique<SceneInstanceState>' },
});

void Transform;

function localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}

function buildScene(nodes: readonly SceneEntity[]): SceneAsset {
  return { kind: 'scene', entities: nodes };
}

function registerSceneAsset(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  return world.allocSharedRef('SceneAsset', asset);
}

function readMapping(world: World, root: EntityHandle): Uint32Array {
  const token = resolveComponent('SceneInstance');
  if (token === undefined) throw new Error('SceneInstance not registered');
  return (world.get(root, token).unwrap() as unknown as { mapping: Uint32Array }).mapping;
}

describe('C-R1 non-contiguous localId mapping sizing', () => {
  it('AC-01: mapping sized to maxLocalId+1 when localIds have gaps (2 entities, id=0 and id=5)', () => {
    // Non-contiguous localIds: only 0 and 5, gap at 1-4.
    // maxLocalId=5, entity count=2.
    // Fix must produce totalSlots >= 6.
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
      { localId: localId(5), components: { Transform: { posX: 5, posY: 5, posZ: 5 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));

    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const root = r.value.root;
    const mapping = readMapping(world, root);

    const ENTITY_NULL_RAW = 0xffffffff;

    // mapping length must be >= maxLocalId+1 (6), not entity count (2).
    expect(mapping.length).toBeGreaterThanOrEqual(6);

    // localId=5 should map to a valid entity (not OOB / ENTITY_NULL_RAW).
    const entity5 = mapping[5];
    expect(entity5).not.toBe(ENTITY_NULL_RAW);

    // localId=0 should still map normally.
    const entity0 = mapping[0];
    expect(entity0).not.toBe(ENTITY_NULL_RAW);

    // Verify the two mapped entities are distinct.
    expect(entity0).not.toBe(entity5);

    // Verify entity positions match input via component read.
    const posToken = resolveComponent('Transform');
    if (posToken) {
      const pos0 = world.get(entity0 as unknown as EntityHandle, posToken).unwrap() as unknown as {
        posX: number;
      };
      expect(pos0.posX).toBe(0);
      const pos5 = world.get(entity5 as unknown as EntityHandle, posToken).unwrap() as unknown as {
        posX: number;
      };
      expect(pos5.posX).toBe(5);
    }
  });

  it('AC-01: mapping sized to entity count when localIds are dense (no gap)', () => {
    // Dense localIds 0/1/2 — no gap, entity count=3 = maxLocalId+1.
    // Fix must NOT over-allocate beyond needed.
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
      { localId: localId(1), components: { Transform: { posX: 1, posY: 1, posZ: 1 } } },
      { localId: localId(2), components: { Transform: { posX: 2, posY: 2, posZ: 2 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));

    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const root = r.value.root;
    const mapping = readMapping(world, root);

    // Dense case: mapping length = 3 (entity count) = maxLocalId+1.
    expect(mapping.length).toBe(3);

    // All three slots should contain valid entities (raw encoding can be 0
    // for first entity in a fresh world; ENTITY_NULL_RAW 0xffffffff is the
    // unspawned sentinel).
    const ENTITY_NULL_RAW = 0xffffffff;
    for (let i = 0; i < 3; i++) {
      const e = mapping[i];
      expect(e).not.toBe(ENTITY_NULL_RAW);
    }
  });

  it('AC-01: mapping for single entity with high localId (id=100)', () => {
    // Single entity with localId=100 — extreme gap.
    const nodes: SceneEntity[] = [
      { localId: localId(100), components: { Transform: { posX: 100, posY: 100, posZ: 100 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));

    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const root = r.value.root;
    const mapping = readMapping(world, root);

    const ENTITY_NULL_RAW = 0xffffffff;

    // mapping must be at least 101 long.
    expect(mapping.length).toBeGreaterThanOrEqual(101);

    // localId=100 must be a valid entity.
    const entity100 = mapping[100];
    expect(entity100).not.toBe(ENTITY_NULL_RAW);

    // Interstitial slots (0-99) should all be ENTITY_NULL_RAW.
    for (let i = 0; i < 100; i++) {
      expect(mapping[i]).toBe(ENTITY_NULL_RAW);
    }
  });
});
