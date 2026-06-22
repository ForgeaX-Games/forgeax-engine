// feat-20260614-ecs-shared-component-and-unique-rename M3 — SharedRefStore
// red-green-refactor unit tests.
//
// Drives the SharedRefStore class directly (no World) per plan-strategy §5.3.
// The store mirrors UniqueRefStore in shape but adds reference counting +
// onLastRelease registration. Five public API surfaces:
//
//   alloc(tag, value)          -> Handle<T, 'shared'> (rc starts at 1)
//   resolve(handle)            -> Result<T, SharedRefReleasedError>
//   retain(handle)             -> Result<void, SharedRefReleasedError>
//   release(handle)            -> Result<void, SharedRefDoubleReleaseError>
//   onLastRelease(cb)          -> unsubscribe fn (fires once at rc=0)
//
// Tests are split across three describe blocks tracking the w6 / w7 / w8
// task boundary. The first two run as TDD red against the still-absent
// SharedRefStore class in w6 / w7; w9 implements the class to turn them
// green. w8 covers the World.allocSharedRef facade including AC-16 type
// inference inside an addSystem fn callback.
//
// M3 scope: store + facade + parser/TYPE_METADATA wiring. Spawn-retain /
// despawn-release of `'shared<T>'` schema fields is M4 work (w12 inserts the
// fieldType.startsWith('shared<') sub-dispatch in releaseManagedFieldOnRow);
// that integration is covered by the M4 test surface (w11), not here.

import type { Handle } from '@forgeax/engine-types';
import { BUILTIN_BASE, toShared, unwrapHandle } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { defineComponent } from '../component';
import {
  BuiltinSlotNotOwnedError,
  SharedRefDoubleReleaseError,
  SharedRefReleasedError,
} from '../errors';
import { SharedRefStore } from '../shared-ref-store';
import { World } from '../world';

// ─── w6: alloc + resolve ────────────────────────────────────────────────
describe('w6 SharedRefStore: alloc + resolve', () => {
  it('alloc returns a Handle<T, "shared"> branded value with rc=1', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('TestAsset', { id: 1 });

    expectTypeOf(handle).toEqualTypeOf<Handle<'TestAsset', 'shared'>>();
    expect(store.refcount(handle)).toBe(1);
    expect(store._liveCount()).toBe(1);
  });

  it('resolve returns the payload while rc > 0', () => {
    const store = new SharedRefStore();
    const payload = { mesh: 'cube' };
    const handle = store.alloc('MeshAsset', payload);

    const r = store.resolve(handle);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toBe(payload);
    }
  });

  it('resolve returns SharedRefReleasedError after rc drops to 0', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('MeshAsset', { id: 7 });

    const releaseResult = store.release(handle);
    expect(releaseResult.ok).toBe(true);

    const r = store.resolve(handle);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(SharedRefReleasedError);
      expect(r.error.code).toBe('shared-ref-released');
      if (r.error.code === 'shared-ref-released') {
        expect(typeof r.error.detail.handle).toBe('number');
      }
    }
  });

  it('release after rc=0 returns SharedRefDoubleReleaseError (no throw)', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('MeshAsset', { id: 9 });

    expect(store.release(handle).ok).toBe(true);
    const second = store.release(handle);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBeInstanceOf(SharedRefDoubleReleaseError);
      expect(second.error.code).toBe('shared-ref-double-release');
      if (second.error.code === 'shared-ref-double-release') {
        expect(typeof second.error.detail.handle).toBe('number');
      }
    }
  });
});

// ─── w29 (D-10): retain + release + per-handle onLastRelease deleter ─────
// M6 D-10: the global onLastRelease(globalCb) listener Set is deleted; the
// release signal is a per-handle deleter passed as the third alloc argument
// (mirrors UniqueRefStore.alloc). AC-21 (deleter fires once at rc=0) /
// AC-22 (no deleter -> no callback) / AC-23 (deleter inner alloc isolated).
describe('w29 SharedRefStore: retain + release + per-handle deleter', () => {
  it('AC-21: alloc(target, payload, cb) deleter fires once and only once at rc 1 -> 0', () => {
    const store = new SharedRefStore();
    const cb = vi.fn();

    const handle = store.alloc('Asset', { id: 1 }, cb);
    expect(store.refcount(handle)).toBe(1);

    expect(store.retain(handle).ok).toBe(true);
    expect(store.refcount(handle)).toBe(2);

    expect(store.release(handle).ok).toBe(true);
    expect(store.refcount(handle)).toBe(1);
    expect(cb).not.toHaveBeenCalled();

    expect(store.release(handle).ok).toBe(true);
    expect(store.refcount(handle)).toBe(0);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ id: 1 });
  });

  it('AC-21: deleter fires exactly once at rc 1 -> 0 (no second fire on double-release)', () => {
    const store = new SharedRefStore();
    const cb = vi.fn();

    const handle = store.alloc('Asset', { id: 2 }, cb);
    expect(store.release(handle).ok).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);

    // Second release is the error path -- it MUST NOT re-fire the deleter.
    const second = store.release(handle);
    expect(second.ok).toBe(false);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('AC-22: alloc without deleter (third arg undefined) -> no callback at rc=0', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('Asset', { id: 3 }, undefined);
    // Reaching rc=0 with no deleter is a clean drop; nothing to observe except
    // refcount 0 and a successful release Result.
    expect(store.release(handle).ok).toBe(true);
    expect(store.refcount(handle)).toBe(0);
  });

  it('AC-23: deleter that allocs a fresh handle observes the dropped slot (snapshot isolation)', () => {
    const store = new SharedRefStore();
    let observedDuringCb: number | undefined;
    let innerHandle: Handle<string, 'shared'> | undefined;
    const handle = store.alloc('Asset', { id: 4 }, () => {
      // Slot is dropped BEFORE the deleter fires (mirrors UniqueRefStore): the
      // released slot's refcount is already 0 when the cb runs.
      observedDuringCb = store.refcount(handle);
      innerHandle = store.alloc('Asset', { id: 5 });
    });

    expect(store.release(handle).ok).toBe(true);
    expect(observedDuringCb).toBe(0);
    // The inner alloc minted an independent live handle, undisturbed by the
    // surrounding release.
    expect(innerHandle).toBeDefined();
    if (innerHandle !== undefined) {
      expect(store.refcount(innerHandle)).toBe(1);
      expect(store.release(innerHandle).ok).toBe(true);
      expect(store.refcount(innerHandle)).toBe(0);
    }
  });

  it('alloc -> retain N -> release N+1 cycles through rc=0 cleanly', () => {
    const store = new SharedRefStore();
    const cb = vi.fn();

    const handle = store.alloc('Asset', { id: 4 }, cb);
    for (let i = 0; i < 5; i++) {
      expect(store.retain(handle).ok).toBe(true);
    }
    expect(store.refcount(handle)).toBe(6);

    for (let i = 0; i < 6; i++) {
      expect(store.release(handle).ok).toBe(true);
    }
    expect(store.refcount(handle)).toBe(0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('retain after release-to-zero is a SharedRefReleasedError (cannot resurrect)', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('Asset', { id: 5 });
    expect(store.release(handle).ok).toBe(true);

    const r = store.retain(handle);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(SharedRefReleasedError);
    }
  });
});

// ─── w8: World.allocSharedRef + AC-16 type inference inside addSystem fn ─
describe('w8 World.allocSharedRef: facade + AC-16 type inference', () => {
  it('World.allocSharedRef returns Handle<Tag, "shared"> (no `as` assertion)', () => {
    const world = new World();
    const handle = world.allocSharedRef('SkinAsset', { joints: 24 });

    expectTypeOf(handle).toEqualTypeOf<Handle<'SkinAsset', 'shared'>>();
    expect(world.sharedRefs.refcount(handle)).toBe(1);
  });

  it('explicit release of the alloc-grant takes rc to 0 and triggers the per-handle deleter', () => {
    const world = new World();
    const cb = vi.fn();

    const handle = world.allocSharedRef('Asset', { id: 99 }, cb);
    const r = world.sharedRefs.release(handle);
    expect(r.ok).toBe(true);
    expect(world.sharedRefs.refcount(handle)).toBe(0);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('AC-16 fourth application point: addSystem fn callback infers Handle<Target, "shared">', () => {
    // AC-16 application point #4: `addSystem({ fn })` callback consumer reads
    // a `'shared<T>'` schema field via world.get and the bundle field type
    // must narrow to `Handle<Target, 'shared'>` with no `as` assertion.
    // Validated inside a real system fn (not a *.test-d.ts file).
    //
    // This test exercises the type-inference end-to-end: schema vocab keyword
    // 'shared<MaterialAsset>' -> column u32 -> world.get unwrap -> field
    // value type. Runtime spawn-retain wiring is M4 (w12) work; here we only
    // exercise the type assertion, not the rc transition.
    const Material = defineComponent('SharedMaterialField', {
      asset: 'shared<MaterialAsset>',
    });
    const world = new World();
    const handle = world.allocSharedRef('MaterialAsset', { albedo: 0xffffff });

    const e = world.spawn({ component: Material, data: { asset: handle } }).unwrap();

    let observedType: 'matched' | 'unmatched' = 'unmatched';
    world.addSystem({
      name: 'shared-bundle-reader',
      queries: [{ with: [Material] }],
      fn: () => {
        const row = world.get(e, Material).unwrap();
        // The type assertion: row.asset MUST be Handle<'MaterialAsset', 'shared'>
        // (not Handle<'MaterialAsset', 'unique'>, not Uint32Array, not unknown).
        expectTypeOf(row.asset).toEqualTypeOf<Handle<'MaterialAsset', 'shared'>>();
        observedType = 'matched';
      },
    });

    world.update();
    expect(observedType).toBe('matched');
  });
});

// ─── w30 (AC-26): global listener API removed from the public surface ─────
// D-10 deletes the global onLastRelease(globalCb) broadcast method + the
// lastReleaseListeners Set. The release signal is the per-handle deleter
// (alloc third argument) only. Type-level assertion: SharedRefStore must not
// expose an `onLastRelease` instance method.
describe('w30 SharedRefStore: global listener API deleted (AC-26)', () => {
  it('SharedRefStore has no onLastRelease instance method', () => {
    const store = new SharedRefStore();
    expect((store as unknown as Record<string, unknown>).onLastRelease).toBeUndefined();
  });

  it('type-level: onLastRelease is not a key of SharedRefStore', () => {
    type StoreKeys = keyof SharedRefStore;
    expectTypeOf<'onLastRelease'>().not.toEqualTypeOf<StoreKeys>();
    // A positive control: alloc remains a key.
    expectTypeOf<'alloc'>().toMatchTypeOf<StoreKeys>();
  });
});

// ─── w50 (AC-32): builtin-slot fail-fast guard ───────────────────────────
// D-15: World.sharedRefs manages ONLY user-tier slots (>= BUILTIN_BASE).
// Passing a builtin slot (< BUILTIN_BASE) to alloc/retain/release/resolve is a
// caller error -> BuiltinSlotNotOwnedError with a hint pointing at
// BuiltinAssetRegistry. (toShared(1) is HANDLE_CUBE's slot.)
describe('w50 SharedRefStore: fail-fast on builtin slot < BUILTIN_BASE (AC-32)', () => {
  it('retain(builtin slot) returns BuiltinSlotNotOwnedError with a hint', () => {
    const store = new SharedRefStore();
    const r = store.retain(toShared<'MeshAsset'>(1));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(BuiltinSlotNotOwnedError);
      expect(r.error.code).toBe('builtin-slot-not-owned');
      if (r.error.code === 'builtin-slot-not-owned') {
        expect(r.error.hint.length).toBeGreaterThan(0);
        expect(r.error.detail.slot).toBe(1);
      }
    }
  });

  it('release(builtin slot) returns BuiltinSlotNotOwnedError', () => {
    const store = new SharedRefStore();
    const r = store.release(toShared<'MeshAsset'>(2));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(BuiltinSlotNotOwnedError);
  });

  it('resolve(builtin slot) returns BuiltinSlotNotOwnedError', () => {
    const store = new SharedRefStore();
    const r = store.resolve(toShared<'MeshAsset'>(3));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(BuiltinSlotNotOwnedError);
  });

  it('alloc mints user-tier slots (>= BUILTIN_BASE), never a builtin slot', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('MeshAsset', { kind: 'mesh' });
    expect(unwrapHandle(handle)).toBeGreaterThanOrEqual(BUILTIN_BASE);
  });
});
