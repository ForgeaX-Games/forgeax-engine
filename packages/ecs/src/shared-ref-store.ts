// @forgeax/engine-ecs - SharedRefStore.
//
// Reference-counted store for AssetRegistry-style shared handles. Schema vocab
// `shared<T>` fields derive `Handle<T, 'shared'>` whose lifecycle is tracked
// by retain/release on the holder side - allocators (typically the asset
// registry) call `alloc` once and let consumers retain/release as the asset
// flows through ECS components and external systems. When rc transitions
// 1 -> 0 the optional per-handle `onLastRelease` deleter fires (signal only -
// the deleter observes; it does not own the lifecycle, so e.g. the asset
// registry can drop GPU resources lazily).
//
// Companion to UniqueRefStore (1-holder-direct-release semantics). The two
// stores share storage shape and code patterns; only the lifecycle differs:
//
//   UniqueRefStore: alloc -> store; release -> drop. No retain.
//   SharedRefStore: alloc -> rc=1; retain -> rc++; release -> rc--; rc=0 -> drop.
//
// §contract - shared handles are tracked by refcount, not generation
//   The handle u32 is the slot index directly. Identical to UniqueRefStore
//   in this respect: there is no generation tag, and a stale handle whose
//   slot has been re-allocated silently resolves to the next payload. AI
//   users keep the rule "don't cache a handle past release" exactly as for
//   UniqueRefStore - the AssetRegistry mediates almost every shared handle
//   lifecycle so consumers rarely encounter the stale-slot case directly.
//
// §tier boundary (feat-20260614 M6 D-15)
//   This store manages ONLY user-tier slots (`slot >= BUILTIN_BASE`). Builtin
//   asset payloads (HANDLE_CUBE=1 .. HANDLE_NINESLICE_QUAD=5) are process-
//   static and live in `BuiltinAssetRegistry` (@forgeax/engine-runtime); they
//   are never reference-counted. `nextSlot` starts at `BUILTIN_BASE` so minted
//   handles never collide with builtin slots, and alloc/retain/release/resolve
//   fail-fast with `BuiltinSlotNotOwnedError` when handed a builtin slot.
//
// Storage shape:
//   - `payloads: Map<number, unknown>` - key = handle u32 = slot index.
//   - `refcounts: Map<number, number>` - key = handle u32; rc >= 1 while live;
//                                  removed (not set to 0) on final release
//                                  so resolve / retain can detect the
//                                  released state via `payloads.has(raw)`.
//   - `freeSlots: number[]`        - LIFO stack of recyclable slot indices.
//   - `releaseCallbacks: Map<number, cb?>` - per-slot onLastRelease deleter,
//                                  cleared before fire (mirrors UniqueRefStore).
//   - `nextSlot`                   - bump counter for the never-recycled tail
//                                  (starts at BUILTIN_BASE; user tier only).
//
// 24 bits = 16_777_215 simultaneous live shared handles - same ceiling as
// UniqueRefStore + Entity, so the three managed-handle resources fail-fast
// at the same bound.
//
// Release path (D-1 codes):
//   - resolve(h): err(SharedRefReleasedError)        if payload absent.
//   - retain(h):  err(SharedRefReleasedError)        if payload absent.
//   - release(h): err(SharedRefDoubleReleaseError, rc=0) on rc=0 input.
//   - any(builtin slot): err(BuiltinSlotNotOwnedError) (D-15).
//
// Identity invariant (mirrors UniqueRefStore): resolve(h) returns the SAME
// payload object on every call until the final release. Archetype migration
// preserves this trivially - the column carries the u32 handle, never the
// payload reference.

import type { Handle } from '@forgeax/engine-types';
import { BUILTIN_BASE, err, ok, type Result, toShared, unwrapHandle } from '@forgeax/engine-types';
import {
  BuiltinSlotNotOwnedError,
  SharedRefDoubleReleaseError,
  SharedRefReleasedError,
} from './errors';

/** Maximum representable shared slot index (2^24 - 1 = 16_777_215). */
const MAX_SLOT = (1 << 24) - 1;

/**
 * Reference-counted store for ECS-aware `Handle<T, 'shared'>` lifecycles.
 *
 * The producer (typically AssetRegistry) calls `alloc` once and owns the
 * "alloc-grant" rc=1; consumers (ECS schema fields, external systems) call
 * `retain` on each new holder and `release` when the holder drops. When rc
 * transitions 1 -> 0 the per-handle `onLastRelease` deleter (the third alloc
 * argument) fires once; the deleter observes the signal but does not
 * implicitly resurrect the slot (a fresh `alloc` returns a new handle).
 *
 * D-15: manages ONLY user-tier slots (`slot >= BUILTIN_BASE`). Builtin slots
 * (`< BUILTIN_BASE`) fail-fast with `BuiltinSlotNotOwnedError`.
 *
 * Public API:
 *   - alloc(target, payload, onLastRelease?) -> Handle<T, 'shared'> (rc=1)
 *   - resolve(handle)             -> Result<T, SharedRefReleasedError | BuiltinSlotNotOwnedError>
 *   - retain(handle)              -> Result<void, SharedRefReleasedError | BuiltinSlotNotOwnedError>
 *   - release(handle)             -> Result<void, SharedRefDoubleReleaseError | BuiltinSlotNotOwnedError>
 *   - refcount(handle)            -> number (0 == released; debug + tests)
 *   - _liveCount()                -> live slot count (debug + inspector)
 */
export class SharedRefStore {
  private readonly payloads = new Map<number, unknown>();
  private readonly refcounts = new Map<number, number>();
  private readonly freeSlots: number[] = [];
  private readonly releaseCallbacks = new Map<number, ((payload: unknown) => void) | undefined>();
  private nextSlot = BUILTIN_BASE;

  /**
   * Allocate a fresh shared handle for `payload`, branded against `target`.
   * Refcount starts at 1 (the alloc-grant). The optional `onLastRelease`
   * per-handle deleter (D-10, mirrors UniqueRefStore.alloc) fires once when
   * this handle's rc transitions 1 -> 0.
   *
   * Minted slots are user-tier (`>= BUILTIN_BASE`); builtin slots are never
   * produced here (D-15).
   */
  alloc<Target extends string, T = unknown>(
    target: Target,
    payload: T,
    onLastRelease?: (payload: T) => void,
  ): Handle<Target, 'shared'> {
    void target; // target is a phantom - tag flows only at the type level via Handle<Target,_>.
    const slot = this.freeSlots.pop() ?? this.nextSlot++;
    if (slot > MAX_SLOT) {
      throw new RangeError(
        `SharedRefStore: slot index ${slot} exceeds 24-bit max (${MAX_SLOT}). ` +
          'Reduce simultaneous shared handles or investigate handle leaks.',
      );
    }
    const raw = slot >>> 0;
    this.payloads.set(raw, payload);
    this.refcounts.set(raw, 1);
    if (onLastRelease !== undefined) {
      this.releaseCallbacks.set(raw, onLastRelease as (payload: unknown) => void);
    }
    return toShared(raw);
  }

  /**
   * Look up `payload` by handle. Returns `err(shared-ref-released)` when
   * the handle's slot has no live payload (rc reached 0, no re-alloc has
   * filled the slot); `err(builtin-slot-not-owned)` for a builtin slot.
   *
   * §contract - mirrors UniqueRefStore: a stale handle whose slot has been
   * re-allocated silently resolves to the new payload. Detection of stale-
   * by-reuse is intentionally absent; AI users rely on AssetRegistry +
   * ECS write-barrier discipline to keep handles alive.
   */
  resolve<Target extends string, T = unknown>(
    handle: Handle<Target, 'shared'>,
  ): Result<T, SharedRefReleasedError | BuiltinSlotNotOwnedError> {
    const raw = unwrapHandle(handle);
    if (raw < BUILTIN_BASE) return err(new BuiltinSlotNotOwnedError(raw));
    const payload = this.payloads.get(raw);
    if (payload === undefined) {
      return err(new SharedRefReleasedError(raw, '<unknown>'));
    }
    return ok(payload as T);
  }

  /**
   * Increment the refcount of a live shared handle. Returns
   * `err(shared-ref-released)` when the handle is not live - retain MUST
   * NOT resurrect a released slot (charter P3 explicit failure; would
   * defeat the rc=0 -> drop invariant); `err(builtin-slot-not-owned)` for a
   * builtin slot.
   */
  retain<Target extends string>(
    handle: Handle<Target, 'shared'>,
  ): Result<void, SharedRefReleasedError | BuiltinSlotNotOwnedError> {
    const raw = unwrapHandle(handle);
    if (raw < BUILTIN_BASE) return err(new BuiltinSlotNotOwnedError(raw));
    const rc = this.refcounts.get(raw);
    if (rc === undefined) {
      return err(new SharedRefReleasedError(raw, '<unknown>'));
    }
    this.refcounts.set(raw, rc + 1);
    return ok(undefined);
  }

  /**
   * Decrement the refcount. When rc transitions 1 -> 0, the slot is dropped:
   * payload + refcount entries removed, freelist gets the slot back, and the
   * per-handle `onLastRelease` deleter (if any) fires once. Order mirrors
   * UniqueRefStore.release: clean up ALL store state (including deleting the
   * callback entry) BEFORE invoking the deleter, so a deleter that re-allocs
   * gets a fresh slot and observes the post-drop refcount=0 for this handle.
   *
   * Returns `err(shared-ref-double-release, rc=0)` when the handle has
   * already reached rc=0 (or was never live); `err(builtin-slot-not-owned)`
   * for a builtin slot. AI users branch on `.code` and route the
   * second-release log to Layer 3 ErrorHandler without aborting the despawn
   * chain.
   */
  release<Target extends string>(
    handle: Handle<Target, 'shared'>,
  ): Result<void, SharedRefDoubleReleaseError | BuiltinSlotNotOwnedError> {
    const raw = unwrapHandle(handle);
    if (raw < BUILTIN_BASE) return err(new BuiltinSlotNotOwnedError(raw));
    const rc = this.refcounts.get(raw);
    if (rc === undefined) {
      return err(new SharedRefDoubleReleaseError(raw, '<unknown>', 0));
    }
    if (rc > 1) {
      this.refcounts.set(raw, rc - 1);
      return ok(undefined);
    }
    // rc === 1 -> drop. Order (mirrors UniqueRefStore §release): the payload
    // is captured on the stack so the deleter still observes the value; the
    // callback + refcount + payload entries are dropped and the slot pushed to
    // the freelist BEFORE the deleter fires. A re-entrant alloc inside the
    // deleter gets a stable freelist + cannot overwrite this slot's (already
    // deleted) callback. OOS-5: multi-callback ordering is not specified;
    // per-handle deleter makes it moot (at most one deleter per slot).
    const cb = this.releaseCallbacks.get(raw);
    this.releaseCallbacks.delete(raw);
    const payload = this.payloads.get(raw);
    this.refcounts.delete(raw);
    this.payloads.delete(raw);
    this.freeSlots.push(raw);
    if (cb !== undefined) {
      cb(payload);
    }
    return ok(undefined);
  }

  /**
   * Return the current refcount for `handle`. Returns 0 for a released
   * (or never-allocated) slot. Primarily a debug + tests entry point;
   * production code rarely reads rc directly (the rc=0 -> drop invariant
   * is the surface AI users consume via release / the per-handle deleter).
   */
  refcount<Target extends string>(handle: Handle<Target, 'shared'>): number {
    const raw = unwrapHandle(handle);
    return this.refcounts.get(raw) ?? 0;
  }

  /** @internal Diagnostic count of live slots. Exposed for tests + inspector. */
  _liveCount(): number {
    return this.payloads.size;
  }
}
