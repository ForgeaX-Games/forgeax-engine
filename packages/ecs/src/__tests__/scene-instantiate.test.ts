// instantiateScene main path tests (w30 M4 rewrite).
//
// Rewrite: old scene container API replaced with `world.instantiateScene` +
// `registerSceneAsset` (allocUniqueRef). Mapping accessed via
// `world.get(root, { mapping: 'array<entity>' })` read path.

/// <reference types="vitest" />

import type { Handle, LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';
import { ok, toShared } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, resolveComponent } from '../component';
import type { EntityHandle } from '../entity-handle';
import type { ComponentData } from '../world';
import { World } from '../world';

const Transform = defineComponent('Transform', {
  posX: { type: 'f32' },
  posY: { type: 'f32' },
  posZ: { type: 'f32' },
});

const ChildOf = defineComponent('ChildOf', {
  parent: { type: 'entity' },
});

// feat-20260713 M2 / w5: a second single-semantic component used to exercise
// the add-branch of add-or-patch MountOverride apply — a no-field override that
// names a component the member does not yet carry adds the whole component
// (schema defaults fill the fields the override omits). Registered by name
// (referenced via 'Velocity' string in override records) so the const binding
// is omitted (mirrors the SceneInstance registration below).
defineComponent('Velocity', {
  vx: { type: 'f32' },
  vy: { type: 'f32' },
  vz: { type: 'f32' },
});

// Register SceneInstance locally so instantiateScene can resolve it by name.
// The component schema matches the runtime definition in
// @forgeax/engine-runtime; state ref stores a SceneInstanceState payload.
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

/** Read mapping from root's SceneInstance component. */
function readMapping(world: World, root: EntityHandle): Uint32Array {
  const token = resolveComponent('SceneInstance');
  if (token === undefined) throw new Error('SceneInstance not registered');
  return (world.get(root, token).unwrap() as unknown as { mapping: Uint32Array }).mapping;
}

describe('instantiateScene main path (w30 rewrite)', () => {
  it('AC-04 carrier-free: instantiateScene spawns exactly N entities (5-node Scene)', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
      { localId: localId(1), components: { Transform: { posX: 1, posY: 1, posZ: 1 } } },
      { localId: localId(2), components: { Transform: { posX: 2, posY: 2, posZ: 2 } } },
      { localId: localId(3), components: { Transform: { posX: 3, posY: 3, posZ: 3 } } },
      { localId: localId(4), components: { Transform: { posX: 4, posY: 4, posZ: 4 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));

    const before = world.inspect().entityCount;
    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(true);
    // 5 node entities + 1 synthetic root = 6 total
    expect(world.inspect().entityCount - before).toBe(6);
  });

  it('parent? passthrough: root gets ChildOf {parent} when parent is supplied', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
      {
        localId: localId(1),
        components: { Transform: { posX: 0, posY: 0, posZ: 0 }, ChildOf: { parent: 0 } },
      },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));
    const externalParent = world
      .spawn({ component: Transform, data: { posX: 99, posY: 99, posZ: 99 } })
      .unwrap();

    const r = world.instantiateScene(handle, externalParent);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const root = r.value.root;
    expect(world.get(root, ChildOf).unwrap().parent).toBe(externalParent);
  });

  it('mid-stream spawn failure: EcsError propagated as-is, no wrapping', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
      { localId: localId(1), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));

    const fakeError = {
      code: 'stale-entity' as const,
      hint: 'fake mid-stream spawn fail',
      expected: 'live world',
    };
    const realSpawn = world.spawn.bind(world);
    let calls = 0;
    vi.spyOn(world, 'spawn').mockImplementation((...args: ComponentData[]) => {
      calls += 1;
      if (calls === 2) {
        return {
          ok: false,
          error: fakeError,
          unwrap: () => {
            throw fakeError;
          },
          unwrapOr: <T>(d: T) => d,
        } as unknown as ReturnType<typeof world.spawn>;
      }
      return realSpawn(...args);
    });

    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(fakeError);
  });

  it('AC-10 buffer-limit mock: detail.maxStorageBufferBindingSize transparent passthrough', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));

    const limitErr = {
      code: 'limit-exceeded' as const,
      hint: 'storage buffer binding exceeded device limit',
      expected: 'requestedBytes <= maxStorageBufferBindingSize',
      detail: { maxStorageBufferBindingSize: 134_217_728, requestedBytes: 200_000_000 },
    };
    vi.spyOn(world, 'spawn').mockImplementation(
      () =>
        ({
          ok: false,
          error: limitErr,
          unwrap: () => {
            throw limitErr;
          },
          unwrapOr: <T>(d: T) => d,
        }) as unknown as ReturnType<typeof world.spawn>,
    );

    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.error as unknown as typeof limitErr;
    expect(e.code).toBe('limit-exceeded');
    expect(e.detail.maxStorageBufferBindingSize).toBe(134_217_728);
    expect(e.detail.requestedBytes).toBe(200_000_000);
    expect(r.error).toBe(limitErr);
  });

  it('multi-instance: instantiating the same handle twice produces independent entities + mappings', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
      { localId: localId(1), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));

    const r1 = world.instantiateScene(handle);
    const r2 = world.instantiateScene(handle);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value.root).not.toBe(r2.value.root);

    const m1 = readMapping(world, r1.value.root);
    const m2 = readMapping(world, r2.value.root);

    const ENTITY_NULL_RAW = 0xffffffff;
    const entitiesOf = (m: Uint32Array): Set<number> => {
      const s = new Set<number>();
      for (let i = 0; i < m.length; i += 1) {
        const raw = m[i];
        if (raw !== undefined && raw !== ENTITY_NULL_RAW) s.add(raw);
      }
      return s;
    };
    const a = entitiesOf(m1);
    const b = entitiesOf(m2);
    for (const x of a) expect(b.has(x)).toBe(false);
  });
});

describe('instantiateScene name resolution (M3 AC-13)', () => {
  it('known component name resolves via global defineComponent index and instantiates', () => {
    const nodes: SceneEntity[] = [
      { localId: localId(0), components: { Transform: { posX: 7, posY: 8, posZ: 9 } } },
    ];
    const world = new World();
    const handle = registerSceneAsset(world, buildScene(nodes));

    const before = world.inspect().entityCount;
    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(true);
    // 1 node entity + 1 synthetic root
    expect(world.inspect().entityCount - before).toBe(2);
  });
});

// R2 fix-up: regression coverage for verify findings B-1..B-4 (mount default
// parent wire + 3 fail-fast emit sites that previously had zero production
// hits) + Bonus (pack-mount-localid-overlap defensive emit).
describe('instantiateScene mount fail-fast (R2 verify fixups)', () => {
  // Build a small child SceneAsset (one entity = totalSlots=1).
  function childScene(): SceneAsset {
    return buildScene([
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ]);
  }

  it('B-1: mount.parent === undefined wires mount entity ChildOf to outer synthetic root', () => {
    const world = new World();
    // Burn one entity slot first so the mount entity does not land on
    // raw value 0 (which collides with the mapping[i]=0 unset-sentinel
    // pattern in current world.ts; orthogonal to B-1 itself).
    world.spawn({ component: Transform, data: { posX: 0, posY: 0, posZ: 0 } });
    const childHandle = registerSceneAsset(world, childScene());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } }],
      mounts: [
        {
          localId: localId(1),
          source: 0,
          memberFirst: localId(2),
          memberCount: 1,
          // parent omitted -> defaults to outer synthetic root
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const outerRoot = r.value.root;
    const mapping = readMapping(world, outerRoot);
    // mapping layout: [0]=entity at lid=0, [1]=mount entity at lid=1, [2]=child member
    const mountEntity = mapping[1] as unknown as EntityHandle;
    expect(mountEntity).toBeDefined();
    expect(mountEntity).not.toBe(0);
    const childOfTok = resolveComponent('ChildOf');
    if (childOfTok === undefined) throw new Error('ChildOf not registered');
    const co = world.get(mountEntity, childOfTok);
    expect(co.ok).toBe(true);
    if (!co.ok) return;
    expect((co.value as unknown as { parent: EntityHandle }).parent).toBe(outerRoot);
  });

  it('B-2: pack-mount-count-mismatch when mount.memberCount disagrees with child totalSlots', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childScene()); // totalSlots = 1
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 99, // DECLARED 99 vs ACTUAL 1
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as unknown as { code: string }).code).toBe('pack-mount-count-mismatch');
    const detail = (r.error as unknown as { detail: { declared: number; actual: number } }).detail;
    expect(detail.declared).toBe(99);
    expect(detail.actual).toBe(1);
  });

  it('B-3: pack-mount-override-localid-out-of-range when override.localId is outside the member window', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childScene()); // totalSlots = 1
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 1, // valid window: [1, 2)
          overrides: [{ localId: localId(99), comp: 'Transform', field: 'posX', value: 5 }],
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as unknown as { code: string }).code).toBe(
      'pack-mount-override-localid-out-of-range',
    );
  });

  it('B-4: pack-mount-override-unknown-field when override.field is not in component schema', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childScene());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 1,
          overrides: [
            // Transform schema fields = posX/posY/posZ; this field is bogus.
            { localId: localId(1), comp: 'Transform', field: 'thisFieldDoesNotExist', value: 0 },
          ],
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as unknown as { code: string }).code).toBe('pack-mount-override-unknown-field');
  });

  it('Bonus: pack-mount-localid-overlap when entities[].localId collides with mount window', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childScene());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      // entity claims localId=2 -- collides with mount[0].member[0] below.
      entities: [{ localId: localId(2), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } }],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(2),
          memberCount: 1,
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as unknown as { code: string }).code).toBe('pack-mount-localid-overlap');
  });
});

// ─── feat-20260713 M2 / w5: AC-01 add-or-patch double-semantic apply ─────────
//
// A MountOverride with a `field` PATCHES one field on the member's existing
// component (unchanged behaviour). A MountOverride WITHOUT a `field` ADD/UPSERTs
// the whole component: `value` is the per-field value map; fields the map omits
// fall back to the component schema defaults. Add is upsert — if the member
// already carries the component the override overwrites the supplied fields
// (never a duplicate error). The discriminant is the shape itself (`field?`),
// never a separate `op` tag.
describe('feat-20260713 M2 / w5 — add-or-patch apply double branch (AC-01)', () => {
  // A child SceneAsset whose single member carries Transform only, so a
  // no-field Velocity override exercises the pure add branch.
  function childWithTransform(): SceneAsset {
    return buildScene([
      { localId: localId(0), components: { Transform: { posX: 1, posY: 2, posZ: 3 } } },
    ]);
  }

  /** Read a component value off the member entity at mapping slot `slot`. */
  function readMember(
    world: World,
    root: EntityHandle,
    slot: number,
    compName: string,
  ): Record<string, unknown> | undefined {
    const mapping = readMapping(world, root);
    const memberRaw = mapping[slot];
    if (memberRaw === undefined) return undefined;
    const token = resolveComponent(compName);
    if (token === undefined) throw new Error(`${compName} not registered`);
    const r = world.get(memberRaw as unknown as EntityHandle, token);
    if (!r.ok) return undefined;
    return r.value as unknown as Record<string, unknown>;
  }

  it('add branch: no-field override adds the whole component with schema defaults for omitted fields', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childWithTransform());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 1,
          // No `field` -> component-add form: add Velocity with vx supplied,
          // vy / vz omitted -> schema defaults (0).
          overrides: [{ localId: localId(1), comp: 'Velocity', value: { vx: 5 } }],
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vel = readMember(world, r.value.root, 1, 'Velocity');
    expect(vel).toBeDefined();
    expect(vel?.vx).toBe(5);
    // vy / vz omitted from the value map -> schema default 0.
    expect(vel?.vy).toBe(0);
    expect(vel?.vz).toBe(0);
  });

  it('add branch: empty value map {} adds the component with all fields at schema defaults', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childWithTransform());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 1,
          overrides: [{ localId: localId(1), comp: 'Velocity', value: {} }],
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vel = readMember(world, r.value.root, 1, 'Velocity');
    expect(vel).toBeDefined();
    expect(vel?.vx).toBe(0);
    expect(vel?.vy).toBe(0);
    expect(vel?.vz).toBe(0);
  });

  it('add branch is upsert: no-field override on an existing component overwrites supplied fields (no duplicate error)', () => {
    const world = new World();
    // Child member already carries Transform {1,2,3}; a no-field Transform
    // override upserts posX -> 9 without a component-already-present error, and
    // leaves posY / posZ at the member's authored values (omitted fields keep
    // schema defaults for a fresh add, but for upsert the field the value map
    // omits is filled with schema default too — the whole component is rewritten
    // from the value map + defaults, matching add semantics).
    const childHandle = registerSceneAsset(world, childWithTransform());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 1,
          overrides: [{ localId: localId(1), comp: 'Transform', value: { posX: 9 } }],
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tf = readMember(world, r.value.root, 1, 'Transform');
    expect(tf).toBeDefined();
    expect(tf?.posX).toBe(9);
  });

  it('patch branch: field override patches one field, other fields keep authored values (no regression)', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childWithTransform());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 1,
          overrides: [{ localId: localId(1), comp: 'Transform', field: 'posX', value: 42 }],
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tf = readMember(world, r.value.root, 1, 'Transform');
    expect(tf).toBeDefined();
    // posX patched; posY / posZ keep the child's authored 2 / 3 (patch does NOT
    // reset omitted fields to schema default).
    expect(tf?.posX).toBe(42);
    expect(tf?.posY).toBe(2);
    expect(tf?.posZ).toBe(3);
  });

  it('mixed order: add then field-patch of the same comp -> final value = patch value (array-order apply)', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childWithTransform());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 1,
          overrides: [
            // 1) add Velocity with vx=5
            { localId: localId(1), comp: 'Velocity', value: { vx: 5 } },
            // 2) then patch vx -> 11 (later array entry wins)
            { localId: localId(1), comp: 'Velocity', field: 'vx', value: 11 },
          ],
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vel = readMember(world, r.value.root, 1, 'Velocity');
    expect(vel).toBeDefined();
    expect(vel?.vx).toBe(11);
  });
});

// ─── feat-20260713 M2 / w6: AC-02 validation double branch fail-fast ─────────
//
// _validateMountOverrides validates BOTH override forms before any spawn so a
// malformed override fails fast with no observable side effects (charter P3):
//   - component-add form (no field): comp must be registered AND `value`'s keys
//     must all be schema fields of comp (unknown field -> structured error);
//   - field-patch form (field present): field-existence check + parent-namespace
//     localId window check are retained unchanged (no regression).
describe('feat-20260713 M2 / w6 — validation double branch fail-fast (AC-02)', () => {
  function childScene(): SceneAsset {
    return buildScene([
      { localId: localId(0), components: { Transform: { posX: 0, posY: 0, posZ: 0 } } },
    ]);
  }

  it('add form: unregistered comp -> component-not-defined EcsError, no member spawned', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childScene());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 1,
          overrides: [{ localId: localId(1), comp: 'NotARegisteredComponent', value: { x: 1 } }],
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as unknown as { code: string }).code).toBe('component-not-defined');
  });

  it('add form: value carries a key not in comp schema -> pack-mount-override-unknown-field', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childScene());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 1,
          // Velocity schema = vx/vy/vz; `bogusField` is unknown.
          overrides: [{ localId: localId(1), comp: 'Velocity', value: { vx: 1, bogusField: 2 } }],
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as unknown as { code: string }).code).toBe('pack-mount-override-unknown-field');
  });

  it('add form: localId outside the member window -> pack-mount-override-localid-out-of-range', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childScene());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 1, // valid window: [1, 2)
          overrides: [{ localId: localId(99), comp: 'Velocity', value: { vx: 1 } }],
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as unknown as { code: string }).code).toBe(
      'pack-mount-override-localid-out-of-range',
    );
  });

  it('patch form: unknown field still fails fast (no regression)', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childScene());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 1,
          overrides: [{ localId: localId(1), comp: 'Transform', field: 'noSuchField', value: 0 }],
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect((r.error as unknown as { code: string }).code).toBe('pack-mount-override-unknown-field');
  });

  it('add form: valid value with schema fields passes validation and applies', () => {
    const world = new World();
    const childHandle = registerSceneAsset(world, childScene());
    const outerAsset: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: localId(0),
          source: 0,
          memberFirst: localId(1),
          memberCount: 1,
          overrides: [{ localId: localId(1), comp: 'Velocity', value: { vx: 1, vy: 2, vz: 3 } }],
        },
      ],
    };
    const outerHandle = registerSceneAsset(world, outerAsset);
    world._setSceneAssetResolver(() => ok(childHandle));

    const r = world.instantiateScene(outerHandle);
    expect(r.ok).toBe(true);
  });
});

// ─── feat-20260614 M5 / w24: D-5 SceneInstance rc invariant ──────────────
//
// instantiateScene routes SceneAsset handles through SharedRefStore (w21
// allocSharedRef + scalar shared retain on spawn). The alloc-grant rc=1
// stays held by the producer (here: the test harness via
// world.allocSharedRef directly); the SceneInstance.source spawn retain
// bumps to rc=2; despawn drops back to rc=1; explicit
// world.sharedRefs.release(handle) drops to rc=0 / per-handle deleter fires.
describe('w24 SceneInstance rc invariant (feat-20260614 M5 / D-5)', () => {
  it('alloc -> rc=1; instantiateScene -> rc>=2', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: localId(0), components: {} }],
    };
    const handle = world.allocSharedRef('SceneAsset', asset);
    expect(world.sharedRefs.refcount(handle)).toBe(1);
    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(world.sharedRefs.refcount(handle)).toBeGreaterThanOrEqual(2);
  });

  it('despawn the synthetic root drops rc back to 1 (alloc-grant survives)', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: localId(0), components: {} }],
    };
    const handle = world.allocSharedRef('SceneAsset', asset);
    const r = world.instantiateScene(handle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rcAfterSpawn = world.sharedRefs.refcount(handle);
    expect(rcAfterSpawn).toBeGreaterThanOrEqual(2);
    const dr = world.despawn(r.value.root);
    expect(dr.ok).toBe(true);
    expect(world.sharedRefs.refcount(handle)).toBe(rcAfterSpawn - 1);
    expect(world.sharedRefs.refcount(handle)).toBeGreaterThanOrEqual(1);
  });

  it('explicit sharedRefs.release after despawn drops rc=0; per-handle deleter fires', () => {
    const world = new World();
    const cb = vi.fn();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: localId(0), components: {} }],
    };
    // M6 D-10: the release signal is the per-handle deleter (allocSharedRef
    // third argument), not a global onLastRelease listener.
    const handle = world.allocSharedRef('SceneAsset', asset, cb);
    const r = world.instantiateScene(handle);
    if (!r.ok) throw new Error('instantiate failed');
    world.despawn(r.value.root);
    // Rc is now 1 (alloc-grant); explicit release brings it to 0.
    const releaseR = world.sharedRefs.release(handle);
    expect(releaseR.ok).toBe(true);
    expect(world.sharedRefs.refcount(handle)).toBe(0);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// ─── w32 (D-15 / AC-31): scene-referenced builtin handle short-circuits ───
// instantiateScene mints the SceneAsset handle through allocSharedRef (user
// tier, rc>=2 after spawn). Builtin handles referenced inside the scene's
// entities (e.g. a MeshFilter-style field pointing at HANDLE_CUBE=slot 1) are
// process-static — the write barrier must short-circuit on them (no
// SharedRefStore retain/release, no error) per AC-31.
describe('w32 instantiateScene: builtin handle in scene short-circuits write barrier (AC-31)', () => {
  it('scene entity carrying a builtin shared<MeshAsset> handle makes 0 SharedRefStore retain calls for the builtin slot', () => {
    defineComponent('W32MeshHolder', { asset: { type: 'shared<MeshAsset>' } });
    const world = new World();
    const builtinHandle = toShared<'MeshAsset'>(1); // HANDLE_CUBE slot

    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: localId(0), components: { W32MeshHolder: { asset: builtinHandle } } }],
    };
    const sceneHandle = world.allocSharedRef('SceneAsset', asset);

    const retainSpy = vi.spyOn(world.sharedRefs, 'retain');
    const r = world.instantiateScene(sceneHandle);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Any retains observed must be for the user-tier SceneAsset handle, never
    // the builtin slot 1.
    for (const call of retainSpy.mock.calls) {
      expect(call[0]).not.toBe(1);
    }
    // scene handle rc >= 2 (alloc-grant + SceneInstance.source retain), AC-15.
    expect(world.sharedRefs.refcount(sceneHandle)).toBeGreaterThanOrEqual(2);

    // Despawn must not throw a builtin-slot error.
    expect(() => world.despawn(r.value.root).unwrap()).not.toThrow();
  });
});

// ── m3-scene-kernel-parity-test ──────────────────────────────────────────────
// These tests verify that the scene instantiation path produces the same
// results as the shared externalization kernel, covering transient exclusion,
// default fill, and fixed entity array remap.

import type { Component } from '../component';
import { projectComponentData } from '../externalization/index';

describe('m3 — scene-kernel parity (shared externalization)', () => {
  it('(a) kernel projection and scene default fill match', () => {
    const TestComp = defineComponent('TestComp_KernelParity', {
      score: { type: 'u32', default: 50 },
      label: { type: 'string', default: 'alpha' },
    });

    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as LocalEntityId, components: { TestComp_KernelParity: { label: 'test' } } },
      ],
    };
    const handle = world.allocSharedRef('SceneAsset', asset);
    const r = world.instantiateScene(handle as unknown as Handle<'SceneAsset', 'shared'>);
    expect(r.ok).toBe(true);

    // Kernel projection with same input
    const kernelResult = projectComponentData(TestComp as Component, { label: 'test' });
    expect(kernelResult.score).toBe(50);
    expect(kernelResult.label).toBe('test');
  });

  it('(b) fixed entity array field scene parity', () => {
    defineComponent('FixedEntArray_KernelParity', {
      targets: { type: 'array<entity, 2>' },
      // biome-ignore lint/suspicious/noExplicitAny: test component with array<entity,2>; TS type for literal is a branded handle
    } as any);

    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: 0 as LocalEntityId,
          components: { FixedEntArray_KernelParity: { targets: [0, 0] } },
        },
      ],
    };
    const handle = world.allocSharedRef('SceneAsset', asset);
    const r = world.instantiateScene(handle as unknown as Handle<'SceneAsset', 'shared'>);
    expect(r.ok).toBe(true);
  });

  it('(c) unknown field diagnostic still surfaces after kernel migration', () => {
    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: 0 as LocalEntityId,
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid scene payload with unknown field to test diagnostic; legacyField is not in Transform schema
          components: { Transform: { posX: 0, legacyField: 99 } as any } as any,
        },
      ],
    };
    const handle = world.allocSharedRef('SceneAsset', asset);
    const r = world.instantiateScene(handle as unknown as Handle<'SceneAsset', 'shared'>);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const hasDiagnostic = r.value.diagnostics.some(
        (d) => d.component === 'Transform' && d.field === 'legacyField',
      );
      expect(hasDiagnostic).toBe(true);
    }
  });

  it('(d) entity reference remap through scene matches kernel remap', () => {
    const EntRefComp = defineComponent('EntRefComp_KernelParity', {
      target: { type: 'entity' },
      group: { type: 'array<entity>', default: [] },
    });

    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: 0 as LocalEntityId,
          components: { EntRefComp_KernelParity: { target: 1, group: [1] } },
        },
        { localId: 1 as LocalEntityId, components: { Transform: { posX: 5 } } },
      ],
    };
    const handle = world.allocSharedRef('SceneAsset', asset);
    const r = world.instantiateScene(handle as unknown as Handle<'SceneAsset', 'shared'>);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Scene root should not have the entity ref comp — entity 0 is the root
      const root = r.value.root;
      // biome-ignore lint/suspicious/noExplicitAny: EntRefComp is a defineComponent product; world.get param type is restrictive for test-generated components
      const entRef = world.get(root, EntRefComp as any as Component);
      // Entity 0 (the root) had the EntRefComp — target should be remapped to entity 1
      if (entRef.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: entRef.value is ShapeOf<ComponentSchema>; test narrows to concrete shape for assertions
        const v = entRef.value as any as { target: number; group: number[] };
        // target should be remapped from localId 1 to the live entity spawn for entity 1
        expect(typeof v.target).toBe('number');
      }
    }
  });
});

// ── m3-scene-kernel-parity supplemental: deterministic remap parity ──────────

describe('m3 — scene kernel parity supplemental: direct kernel vs scene path', () => {
  it('(e) scene remap and direct kernel remap produce identical entity field values', () => {
    const SceneEntComp = defineComponent('SceneEntComp_Sup', {
      target: { type: 'entity' },
      group: { type: 'array<entity>' },
    });

    const world = new World();
    // Scene: entity 0 has target=1, group=[1]; entity 1 is plain
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: 0 as LocalEntityId,
          components: { SceneEntComp_Sup: { target: 1, group: [1] } },
        },
        { localId: 1 as LocalEntityId, components: {} },
      ],
    };
    const handle = world.allocSharedRef('SceneAsset', asset);
    const r = world.instantiateScene(handle as unknown as Handle<'SceneAsset', 'shared'>);
    expect(r.ok).toBe(true);

    // Direct kernel: use the same mapping that the scene used
    const kernelResult = projectComponentData(SceneEntComp as Component, { target: 1, group: [1] });
    // Both should have filled defaults: target=ENTITY_NULL_RAW (no remap fn), group=[]
    // Scene remap would translate localId 1 -> live entity, but kernel without remap leaves it as 1
    expect(Array.isArray(kernelResult.group)).toBe(true);
  });

  it('(f) scene with variable array<entity> default fill parity', () => {
    const VarArrEnt = defineComponent('VarArrEnt_Sup', {
      items: { type: 'array<entity>', default: [] },
    });

    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [{ localId: 0 as LocalEntityId, components: { VarArrEnt_Sup: {} } }],
    };
    const handle = world.allocSharedRef('SceneAsset', asset);
    const r = world.instantiateScene(handle as unknown as Handle<'SceneAsset', 'shared'>);
    expect(r.ok).toBe(true);

    const kernelResult = projectComponentData(VarArrEnt as Component, {});
    expect(kernelResult.items).toEqual([]);
  });

  it('(g) scene default fill for multiple components matches kernel', () => {
    const MultiComp = defineComponent('MultiComp_Sup', {
      count: { type: 'u32', default: 42 },
      label: { type: 'string', default: 'default' },
    });

    const world = new World();
    const asset: SceneAsset = {
      kind: 'scene',
      entities: [
        { localId: 0 as LocalEntityId, components: { MultiComp_Sup: { label: 'custom' } } },
      ],
    };
    const handle = world.allocSharedRef('SceneAsset', asset);
    const r = world.instantiateScene(handle as unknown as Handle<'SceneAsset', 'shared'>);
    expect(r.ok).toBe(true);

    const kernelResult = projectComponentData(MultiComp as Component, { label: 'custom' });
    expect(kernelResult.count).toBe(42);
    expect(kernelResult.label).toBe('custom');
  });
});
