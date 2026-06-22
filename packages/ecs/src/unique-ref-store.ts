// @forgeax/engine-ecs - UniqueRefStore.
//
// Per-slot singleton store for ECS-managed asset handles. Schema vocab
// `ref<T>` fields derive `Handle<T, 'unique'>` whose lifecycle is owned by
// the ECS - World hooks `despawn` / `removeComponent` / `set` into
// `UniqueRefStore.release` so dropping a holder entity reliably releases the
// referenced asset slot. AssetRegistry handles (`handle<T>` schema vocab) take
// the orthogonal `'shared'` mode and never enter this store.
//
// §contract — managed handles are operational, not persistent
//   Spec: docs/specs/2026-06-14-ecs-managed-lifecycle-ssot-design.md §3.3.
//   The handle u32 is the slot index directly (24-bit, capped at MAX_SLOT
//   which equals ENTITY_MAX_INDEX). There is NO generation tag: caching a
//   managed handle across despawn / removeComponent / world.set overwrite
//   is undefined behavior at the spec level — a stale handle silently
//   resolves to the next payload installed in the same slot, and the store
//   never reports a "stale-slot" error. Detection lives at the type system
//   (Handle<T, 'unique'>) + ECS lifecycle hooks, not at runtime.
//
//   AC-06 (unique-ref-double-release) is detected by payload-presence
//   (`payloads.has(raw)`), not by generation mismatch — a re-alloc into the
//   same slot makes the prior raw look "live" again, which is the silent-
//   resolve behavior the spec mandates.
//
// Storage shape:
//   - `payloads: Map<number, unknown>` - key = handle u32 = slot index.
//                                    Strong reference; deleted on release.
//                                    Type-erased (the store never inspects
//                                    payload fields); `Handle<T, 'unique'>`
//                                    carries `T` at the type level and the
//                                    single read site (World.get's ref path)
//                                    narrows `unknown -> T` at the boundary.
//   - `freeSlots: number[]`        - LIFO stack of recyclable slot indices.
//   - `releaseCallbacks: Map<...>` - per-slot onRelease cb cleared before fire.
//   - `nextSlot`                   - bump counter for the never-recycled tail.
//
// 24 bits = 16_777_215 simultaneous live managed handles - the same ceiling
// as Entity, so an ECS that hit the entity ceiling cannot grow past the
// managed-ref ceiling either. Ceiling-exhaust handling is a future concern;
// the store deliberately panics on overflow to fail fast rather than
// silently wrap.
//
// Release path (D-1 codes):
//   - resolve(h):  err(UniqueRefReleasedError)        if payload absent.
//   - release(h):  err(UniqueRefDoubleReleaseError)   on second release.
//
// Object.is identity invariant (AC-04 prelude):
//   resolve(h) returns the SAME payload object on every call until release
//   - the store does not clone, wrap, or proxy the payload. M4 carry-over
//   reuses this invariant: archetype migrate moves the row index, not the
//   payload reference, so wrapper identity survives migration.

import type { Handle } from '@forgeax/engine-types';
import { err, ok, type Result, toUnique, unwrapHandle } from '@forgeax/engine-types';
import { UniqueRefDoubleReleaseError, UniqueRefReleasedError } from './errors';

/** Maximum representable managed slot index (2^24 - 1 = 16_777_215). */
const MAX_SLOT = (1 << 24) - 1;

/**
 * Per-slot singleton store for ECS-managed `Handle<T, 'unique'>` lifecycles.
 * World hooks the three release paths (despawn, removeComponent, set) into
 * `release(handle)`; `resolve(handle)` is the read path AI users reach
 * indirectly through `world.get(e, C)` for `ref<T>` schema fields.
 *
 * §contract — managed handles are operational, not persistent (spec §3.3,
 * docs/specs/2026-06-14-ecs-managed-lifecycle-ssot-design.md): handle u32
 * directly equals slot index; no generation tag; stale handles silently
 * resolve to the next payload. README §"Managed handles are operational,
 * not persistent" is the canonical AI-user-facing statement.
 *
 * Identity invariant (AC-04 prelude): the payload returned by `resolve` is
 * the same object reference on every call until `release`. Carry-over (M4)
 * relies on this - archetype migrate moves the row index, not the payload.
 *
 * Storage is type-erased (`unknown`): the store routes lifecycle without ever
 * inspecting payload fields. Per-call payload typing flows through method
 * generics: `alloc<T>` accepts a `T` payload + matching `onRelease(T)`, and
 * `resolve<T>` returns `Result<T, ...>`. Both narrow at the call boundary
 * (the single read site is World.get's ref path); making the class generic
 * on `T` was decoration with no internal use, so the parameter was dropped
 * (architecture-principles.md §1 SSOT).
 */
export class UniqueRefStore {
  private readonly payloads = new Map<number, unknown>();
  private readonly freeSlots: number[] = [];
  private readonly releaseCallbacks = new Map<number, ((payload: unknown) => void) | undefined>();
  private nextSlot = 1;

  /**
   * Allocate a fresh managed handle for `payload`, branded against `target`.
   *
   * Slot 0 is reserved as the "null/unset" sentinel - schema-vocab `ref<T>`
   * fields default to this sentinel before the first write, and World's
   * release loop uses it to short-circuit (`shouldRelease(0) === false`).
   *
   * @returns a `Handle<T, 'unique'>` u32. The branded number is safe to
   *   widen to `number` for GPU upload (charter consistent abstraction).
   */
  alloc<Target extends string, T = unknown>(
    target: Target,
    payload: T,
    onRelease?: (payload: T) => void,
  ): Handle<Target, 'unique'> {
    void target; // target is a phantom - tag flows only at the type level via Handle<Target,_>.
    const slot = this.freeSlots.pop() ?? this.nextSlot++;
    if (slot > MAX_SLOT) {
      throw new RangeError(
        `UniqueRefStore: slot index ${slot} exceeds 24-bit max (${MAX_SLOT}). ` +
          'Reduce simultaneous managed handles or investigate handle leaks.',
      );
    }
    const raw = slot >>> 0;
    this.payloads.set(raw, payload);
    if (onRelease !== undefined) {
      this.releaseCallbacks.set(raw, onRelease as (payload: unknown) => void);
    }
    return toUnique(raw);
  }

  /**
   * Look up `payload` by handle. Returns `err(unique-ref-released)` when
   * the handle's slot has no live payload (release happened in between, and
   * no re-alloc has filled the slot). Resolves the same payload object on
   * every call - identity-stable until release.
   *
   * §contract: a stale handle whose slot has been re-allocated silently
   * resolves to the new payload (spec §3.3). Detection of stale-by-reuse
   * is intentionally absent from the runtime surface — see README
   * §"Managed handles are operational, not persistent".
   *
   * `T` flows from the caller's `Handle<T, 'unique'>` type; the store erases
   * payload types at the storage layer and the call boundary re-narrows.
   */
  resolve<Target extends string, T = unknown>(
    handle: Handle<Target, 'unique'>,
  ): Result<T, UniqueRefReleasedError> {
    const raw = unwrapHandle(handle);
    const payload = this.payloads.get(raw);
    if (payload === undefined) {
      // Slot 0 (sentinel) and any handle whose payload was already removed
      // both surface as released. The phantom Target is unavailable at
      // runtime - the error carries '<unknown>' to keep the structured
      // shape consistent.
      return err(new UniqueRefReleasedError(raw, '<unknown>'));
    }
    return ok(payload as T);
  }

  /**
   * Release `handle` - drop the payload and push the slot onto the free list.
   * Releasing the same handle twice surfaces `unique-ref-double-release`
   * (D-1) so World's release loop can route the second release to Layer 3
   * ErrorHandler without aborting the despawn chain. Detection is by
   * payload-presence, not generation (§contract — managed handles are
   * operational, not persistent).
   *
   * Releasing the slot-0 sentinel is a no-op - World's release loop calls
   * `shouldRelease` first to filter sentinels.
   */
  release<Target extends string>(
    handle: Handle<Target, 'unique'>,
  ): Result<void, UniqueRefDoubleReleaseError> {
    const raw = unwrapHandle(handle);
    const payload = this.payloads.get(raw);
    if (payload === undefined) {
      return err(new UniqueRefDoubleReleaseError(raw, '<unknown>'));
    }
    // Order (feat-20260614 M1 D-1): clean up ALL store state BEFORE invoking
    // onRelease. The payload is captured on the stack above so cb still
    // observes the value (D-5 RAII-equivalent semantics preserved); both
    // releaseCallbacks and payloads entries are dropped first, then the
    // freelist push happens, and only then is cb invoked. A throwing cb
    // leaves the store fully consistent: a second release sees
    // `payloads.has(raw) === false` and returns UniqueRefDoubleReleaseError
    // without re-firing the callback (AC-01, AC-02, AC-06). try/finally is
    // explicitly NOT used (D-1 alternative (a) rejected — would swallow the
    // first-release throw and violate spec section 3.1).
    const cb = this.releaseCallbacks.get(raw);
    this.releaseCallbacks.delete(raw);
    this.payloads.delete(raw);
    const slot = raw;
    this.freeSlots.push(slot);
    if (cb !== undefined) {
      cb(payload);
    }
    return ok(undefined);
  }

  /**
   * `true` if `handle` references a live slot - used by World's release loop
   * to decide whether to call `release` (skips sentinel + already-released).
   *
   * The release loop differentiates "expected sentinel" (no error) from
   * "leaked already-released handle" (`unique-ref-double-release`) at the
   * caller layer; this helper handles only the no-op short-circuit.
   */
  isLive<Target extends string>(handle: Handle<Target, 'unique'>): boolean {
    const raw = unwrapHandle(handle);
    if (raw === 0) return false;
    return this.payloads.has(raw);
  }

  /** @internal Diagnostic count of live slots. Exposed for tests + inspector. */
  _liveCount(): number {
    return this.payloads.size;
  }
}
