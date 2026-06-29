// feat-20260608-scene-nesting-ecs-fication M2 / w18 (red phase) — nested /
// cross-boundary / deep / multi-mount cases.
//
// Test file location rationale: same as world-scene-instantiate.test.ts —
// uses SceneInstance / Transform tokens (defined in @forgeax/engine-runtime),
// so the test physically lives in runtime; the World methods themselves
// resolve to @forgeax/engine-ecs.
//
// AC anchors:
//   - AC-23 (double-nested A->B->C: query<SceneInstance>() returns >=3 roots)
//   - AC-24 (cross-boundary: outer entities[].ChildOf.parent points into a
//     mount sub-region)
//   - AC-25 (deep nesting >=5 layers does not stack-overflow)
//   - AC-26 (same prefab mounted multiple times: mappings disjoint, overrides
//     do not leak across mount instances)

import {
  createQueryState,
  defineComponent,
  Entity,
  err,
  ok,
  queryRun,
  World,
} from '@forgeax/engine-ecs';
import { ChildOf, SceneInstance } from '@forgeax/engine-runtime';
import type { Handle, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function registerSceneAsset(world: World, asset: SceneAsset): Handle<'SceneAsset', 'shared'> {
  return world.allocSharedRef('SceneAsset', asset);
}

describe('AC-23 double-nested A -> B -> C', () => {
  it('query<SceneInstance>() returns >=3 SceneInstance roots after instantiating A', () => {
    const world = new World();
    // Bottom asset C: 1 entity
    const assetC: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
    };
    const handleC = registerSceneAsset(world, assetC);
    // Middle asset B: 1 entity + 1 mount of C
    const assetB: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
      mounts: [
        {
          localId: 1 as never,
          source: 0,
          memberFirst: 2 as never,
          memberCount: 1,
        },
      ],
    };
    const handleB = registerSceneAsset(world, assetB);
    // Outer asset A: 1 entity + 1 mount of B
    const assetA: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
      mounts: [
        {
          localId: 1 as never,
          source: 0,
          memberFirst: 2 as never,
          memberCount: 3,
        },
      ],
    };
    const handleA = registerSceneAsset(world, assetA);

    // Wire SceneAsset resolver: each mount.source `0` resolves to the
    // applicable child handle. We use a thread-local trick — the
    // instantiateScene impl is expected to use a SceneAssetResolver wired
    // through engine.assets in production; for the unit test we set a
    // resolver directly by stuffing handles into a Map keyed by parent.
    // The test relies on World using the same registry the SceneAsset was
    // alloc'd into; mount.source -> child handle resolution is done by
    // looking up `parent.refs[source]` in the implementation. Since this
    // unit test creates raw POD assets in-memory without `refs`, the
    // implementation must accept an explicit resolver arm — see
    // _setSceneAssetResolver below.
    world._setSceneAssetResolver?.((sourceIdx, parentHandle) => {
      void sourceIdx;
      const parentManagedRaw = parentHandle as unknown as number;
      // Parent A handle u32 -> handle B; parent B handle u32 -> handle C.
      if (parentManagedRaw === (handleA as unknown as number)) return ok(handleB);
      if (parentManagedRaw === (handleB as unknown as number)) return ok(handleC);
      return err({ code: 'asset-not-found' });
    });

    const r = world.instantiateScene(handleA);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    let count = 0;
    const state = createQueryState({ with: [SceneInstance, Entity] });
    queryRun(state, world, (bundle) => {
      count += bundle.Entity.self.length;
    });
    expect(count).toBeGreaterThanOrEqual(3);
  });
});

describe('AC-25 deep nesting >=5 layers — no stack overflow', () => {
  it('5-layer chain instantiates successfully', () => {
    const world = new World();
    // Build chain L0 ... L5 where Lk mounts L(k+1).
    // R2/B-2: mount.memberCount must equal child.totalSlots; recompute
    // bottom-up. L5 has no mounts -> totalSlots=1; each k<5 has
    // 1 entity + 1 mount.localId + memberCount(=child.totalSlots) slots.
    const handles: Handle<'SceneAsset', 'shared'>[] = [];
    let childTotalSlots = 1; // L5: just one entity
    for (let k = 5; k >= 0; k -= 1) {
      const asset: SceneAsset = {
        kind: 'scene',
        entities: [{ localId: 0 as never, components: { Transform: {} } }],
        mounts:
          k < 5
            ? [
                {
                  localId: 1 as never,
                  source: 0,
                  memberFirst: 2 as never,
                  memberCount: childTotalSlots,
                },
              ]
            : [],
      };
      handles.unshift(registerSceneAsset(world, asset));
      // Update for the parent layer above.
      // totalSlots = 1 entity + 1 mount.localId + memberCount slots
      childTotalSlots = k < 5 ? 1 + 1 + childTotalSlots : 1;
    }
    world._setSceneAssetResolver?.((sourceIdx, parentHandle) => {
      void sourceIdx;
      const raw = parentHandle as unknown as number;
      for (let k = 0; k < handles.length - 1; k += 1) {
        if (raw === (handles[k] as unknown as number)) {
          const next = handles[k + 1];
          if (next === undefined) break;
          return ok(next);
        }
      }
      return err({ code: 'asset-not-found' });
    });
    const r = world.instantiateScene(handles[0] as Handle<'SceneAsset', 'shared'>);
    expect(r.ok).toBe(true);
  });
});

describe('AC-26 same prefab mounted multiple times — disjoint mappings', () => {
  it('two mounts of the same child each get their own member entities', () => {
    const world = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: { posX: 99 } } }],
    };
    const childHandle = registerSceneAsset(world, child);
    // Parent: 1 entity + 2 mounts of `child`
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as never, components: { Transform: {} } }],
      mounts: [
        { localId: 1 as never, source: 0, memberFirst: 3 as never, memberCount: 1 },
        { localId: 2 as never, source: 0, memberFirst: 4 as never, memberCount: 1 },
      ],
    };
    const parentHandle = registerSceneAsset(world, parent);
    world._setSceneAssetResolver?.((sourceIdx, parentH) => {
      void sourceIdx;
      void parentH;
      return ok(childHandle);
    });
    const r = world.instantiateScene(parentHandle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inst = world.get(r.value.root, SceneInstance);
    if (!inst.ok) throw new Error('get SceneInstance failed');
    // Two mount-time children at memberFirst=3 and memberFirst=4 should be
    // distinct entities.
    const m3 = inst.value.mapping[3];
    const m4 = inst.value.mapping[4];
    expect(m3).toBeDefined();
    expect(m4).toBeDefined();
    expect(m3).not.toBe(m4);
  });
});

describe('AC-24 outer entity ChildOf points into mount sub-region', () => {
  it('outer entity carries ChildOf with parent=mapping[memberFirst+k]', () => {
    const world = new World();
    const child: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as never, components: { Transform: {} } },
        { localId: 1 as never, components: { Transform: {} } },
      ],
    };
    const childHandle = registerSceneAsset(world, child);
    // Outer scene: entity[0] is independent root; entity[1] declares
    // ChildOf {parent: 3} — referencing the FIRST member of the mount at
    // localId=2 (memberFirst=3). The runtime must remap localId=3 to the
    // live spawned member entity.
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as never, components: { Transform: {} } },
        { localId: 1 as never, components: { Transform: {}, ChildOf: { parent: 3 } } },
      ],
      mounts: [{ localId: 2 as never, source: 0, memberFirst: 3 as never, memberCount: 2 }],
    };
    const parentHandle = registerSceneAsset(world, parent);
    world._setSceneAssetResolver?.(() => ok(childHandle));
    const r = world.instantiateScene(parentHandle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inst = world.get(r.value.root, SceneInstance);
    if (!inst.ok) throw new Error('get failed');
    const outerE = inst.value.mapping[1] as unknown as number;
    const memberE = inst.value.mapping[3] as unknown as number;
    const co = world.get(outerE as never, ChildOf);
    expect(co.ok).toBe(true);
    if (!co.ok) return;
    expect(co.value.parent as unknown as number).toBe(memberE);
  });
});

// Force-reference defineComponent so a future TS pruning pass keeps the
// import alive even if all explicit calls are inlined into a deeper helper.
void defineComponent;
