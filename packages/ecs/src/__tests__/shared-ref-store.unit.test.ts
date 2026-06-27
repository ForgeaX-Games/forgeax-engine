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
import {
  BUILTIN_BASE,
  handleGeneration,
  handleSlot,
  MAX_SLOT,
  pack,
  toShared,
  unwrapHandle,
} from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { defineComponent } from '../component';
import { BuiltinSlotNotOwnedError, SharedRefStaleError } from '../errors';
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

  it('resolve returns SharedRefStaleError after rc drops to 0 (gen incremented on release)', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('MeshAsset', { id: 7 });

    const releaseResult = store.release(handle);
    expect(releaseResult.ok).toBe(true);

    // After w10 gen increment on release, old handle gen=0 mismatches store
    // gen=1 — stale, not released. Gen comparison runs before payload lookup.
    const r = store.resolve(handle);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shared-ref-stale');
      if (r.error instanceof SharedRefStaleError) {
        expect(typeof r.error.detail.slot).toBe('number');
      }
    }
  });

  it('release after rc=0 returns SharedRefStaleError (gen mismatch after first release)', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('MeshAsset', { id: 9 });

    expect(store.release(handle).ok).toBe(true);
    // Second release: gen=0 vs store gen=1 — stale, not double-release.
    const second = store.release(handle);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('shared-ref-stale');
      // error.detail is a discriminated union; use error instance check
      if (second.error instanceof SharedRefStaleError) {
        expect(typeof second.error.detail.slot).toBe('number');
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

  it('retain after release-to-zero is a SharedRefStaleError (gen mismatch after w10)', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('Asset', { id: 5 });
    expect(store.release(handle).ok).toBe(true);

    const r = store.retain(handle);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shared-ref-stale');
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

// ─── w6 M3: gen welding alloc tests ─────────────────────────────────────
// feat-20260623-asset-handle-generation M3 — alloc embeds generation into
// the returned handle via codec.pack(slot, gen). First alloc gen=0 (AC-06);
// builtin invariant pack(slot,0)===slot holds (AC-05).
// M3 scope: gen welding only, no gen increment on release (that's M4).
// Reused slots always get gen=0 in M3 (release does NOT increment
// _generations[slot] yet).
describe('w6 M3 SharedRefStore: gen welding on alloc', () => {
  it('AC-06: first alloc gen=0 => pack(slot,0) === slot (handleSlot matches raw slot)', () => {
    const store = new SharedRefStore();
    const handle = store.alloc('TestAsset', { id: 1 });

    const raw = unwrapHandle(handle);
    const slot = handleSlot(handle);
    const gen = handleGeneration(handle);

    expect(gen).toBe(0);
    expect(raw).toBe(slot);
    // AC-06: slot is the raw value when gen=0
    expect(raw).toBeGreaterThanOrEqual(BUILTIN_BASE);
    expect(raw).toBeLessThanOrEqual(MAX_SLOT);
  });

  it('AC-05: builtin invariant — pack(slot,0) === slot for slot 1-5', () => {
    // Builtin handle constants (slot 1..5, gen=0) must encode to the same
    // u32 value as the raw slot — ensures AssetRegistry builtin Map keys,
    // GUID pre-registration, and entity bit patterns stay unchanged.
    for (let s = 1; s <= 5; s++) {
      expect(pack(s, 0)).toBe(s);
    }
  });

  it('alloc welds gen into handle — gen extractable via handleGeneration', () => {
    // After alloc gen welding, handleGeneration returns the gen embedded
    // during alloc. In M3, gen is always 0 because release does not yet
    // increment _generations (that's M4). But the code path — pack(slot,gen)
    // inside alloc -> toShared -> handleGeneration unpacks it — must work.
    const store = new SharedRefStore();
    const h = store.alloc('TestAsset', { id: 1 });
    expect(handleGeneration(h)).toBe(0);
    expect(handleSlot(h)).toBeGreaterThanOrEqual(BUILTIN_BASE);
    // pack(slot, gen) round-trips: unpackSlot(pack(s,0)) === s
    expect(pack(handleSlot(h), handleGeneration(h))).toBe(unwrapHandle(h));
  });

  it('resolve works correctly after gen-welded alloc (gen increments on release in M4)', () => {
    // Alloc + release + re-alloc: the second handle resolves to the
    // second payload. After M4, release increments gen so the reused
    // slot gets gen=1.
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(handleGeneration(h1)).toBe(0);

    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    // M4: release incremented gen, so re-alloc gets gen=1
    expect(handleGeneration(h2)).toBe(1);

    const r2 = store.resolve(h2);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value).toEqual({ mesh: 'sphere' });
    }
  });

  it('alloc with onLastRelease fires deleter after gen-welded release', () => {
    const cb = vi.fn();
    const store = new SharedRefStore();
    const h = store.alloc('Asset', { key: 1 }, cb);
    expect(store.release(h).ok).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ key: 1 });
  });

  it('M4: alloc after release reuses slot with gen 1 (gen increments on release)', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    void handleSlot(h1); // probe slot
    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    // M4: release incremented gen to 1, so re-alloc gets gen=1
    expect(handleGeneration(h2)).toBe(1);

    // h2 resolves to the new payload
    const r2 = store.resolve(h2);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toEqual({ mesh: 'sphere' });

    // h1 (gen=0) is stale now
    const r1 = store.resolve(h1);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.code).toBe('shared-ref-stale');
  });
});

// ─── w9 M4: stale detection unit tests (red phase) ─────────────────────
// feat-20260623-asset-handle-generation M4 — gen comparison on
// resolve/retain/release. RED phase: gen increment on release is NOT
// now via release (gen 0->1) + re-alloc (gen=1), making h1 (gen=0)
// stale. No manual _generations mutation needed.
describe('w9 M4 SharedRefStore: stale detection (resolve/retain/release + retire)', () => {
  it('AC-01: stale resolve returns error with code shared-ref-stale', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    // Release bumps gen from 0 to 1, then re-alloc gets gen=1.
    // h1 (gen=0) is now stale.
    expect(store.release(h1).ok).toBe(true);
    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });

    const r = store.resolve(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shared-ref-stale');
    }
    // h2 is the current handle and should always resolve
    const r2 = store.resolve(h2);
    expect(r2.ok).toBe(true);
  });

  it('AC-01: stale resolve never returns a payload (verify error branch has no value)', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);
    store.alloc('MeshAsset', { mesh: 'sphere' });

    const r = store.resolve(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The error must NOT carry a payload — stale resolve does
      // not return the new payload through any channel.
      // biome-ignore lint/suspicious/noExplicitAny: accessing value on Result union error branch to verify no payload leak
      expect((r as any).value).toBeUndefined();
    }
  });

  it('AC-02: stale retain returns error, rc unchanged', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);
    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });

    // h2 is alive with rc=1. Read rc before stale retain.
    const rcBefore = store.refcount(h2);
    expect(rcBefore).toBe(1);

    const r = store.retain(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shared-ref-stale');
    }

    const rcAfter = store.refcount(h2);
    // AC-02: rc MUST be unchanged after stale retain
    expect(rcAfter).toBe(rcBefore);
  });

  it('AC-03: stale release returns error, rc unchanged — read rc before and after', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    expect(handleGeneration(h2)).toBe(1);

    // h2 is alive with rc=1. Stale release with h1 (gen=0) must NOT
    // decrement h2's rc.
    const rcBefore = store.refcount(h2);
    expect(rcBefore).toBe(1);

    const r = store.release(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shared-ref-stale');
    }

    const rcAfter = store.refcount(h2);
    // AC-03 core: stale release MUST NOT touch the new holder's rc.
    expect(rcAfter).toBe(rcBefore);
  });

  it('AC-03: stale release when h2 rc>1 does not decrement', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);

    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    // build rc=3 for h2
    expect(store.retain(h2).ok).toBe(true);
    expect(store.retain(h2).ok).toBe(true);
    expect(store.refcount(h2)).toBe(3);

    const rcBefore = store.refcount(h2);
    const r = store.release(h1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('shared-ref-stale');
    }
    // Stale release must not affect h2's rc, even when rc>1
    expect(store.refcount(h2)).toBe(rcBefore);
  });

  it('AC-04: new handle after reuse resolves, retains, releases normally', () => {
    const store = new SharedRefStore();
    const h1 = store.alloc('MeshAsset', { mesh: 'cube' });
    expect(store.release(h1).ok).toBe(true);

    // New handle with gen=1 works normally
    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    expect(handleGeneration(h2)).toBe(1);

    // resolve
    const r = store.resolve(h2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ mesh: 'sphere' });
    }

    // retain
    expect(store.retain(h2).ok).toBe(true);
    expect(store.refcount(h2)).toBe(2);

    // release back to rc=1 (gen does NOT increment — rc>1)
    expect(store.release(h2).ok).toBe(true);
    expect(store.refcount(h2)).toBe(1);

    // final release to rc=0 (gen increments 1->2)
    expect(store.release(h2).ok).toBe(true);
    expect(store.refcount(h2)).toBe(0);

    // h1 still stale (gen=0 vs gen=2)
    const rStale = store.resolve(h1);
    expect(rStale.ok).toBe(false);
    if (!rStale.ok) {
      expect(rStale.error.code).toBe('shared-ref-stale');
    }
  });

  it('AC-07: retire-on-255 — gen pushed past MAX_GEN then slot not in freeSlots after release', () => {
    const store = new SharedRefStore();
    const h = store.alloc('MeshAsset', { mesh: 'cube' });
    const slot = handleSlot(h);

    // gen=255 is still a usable handle under the new gen > MAX_GEN predicate.
    // Bump _generations[slot] to 255 and push to freeSlots so the next alloc
    // reuses it with gen=255.
    // biome-ignore lint/suspicious/noExplicitAny: private mutation for retire edge boundary
    (store as any)._generations[slot] = 255;
    // biome-ignore lint/suspicious/noExplicitAny: push slot to free list so alloc reuses
    (store as any).freeSlots.push(slot);

    // Alloc reuses slot, reads gen=255 from _generations.
    const h2 = store.alloc('MeshAsset', { mesh: 'sphere' });
    expect(handleGeneration(h2)).toBe(255);
    // Verify gen=255 is a usable handle — resolve succeeds.
    const rResolve = store.resolve(h2);
    expect(rResolve.ok).toBe(true);

    // Release h2: gen matches (255==255), proceed, gen++ to 256 (>MAX_GEN), retired.
    expect(store.release(h2).ok).toBe(true);

    // Verify slot is NOT in freeSlots (retired)
    // biome-ignore lint/suspicious/noExplicitAny: private read
    const freeSlots: number[] = (store as any).freeSlots;
    expect(freeSlots.indexOf(slot)).toBe(-1);
  });
});
