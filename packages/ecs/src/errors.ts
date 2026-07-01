// @forgeax/engine-ecs — typed error class collection.
//
// Typed error classes covering all boundary conditions. Each follows progressive
// disclosure format: one-line summary → context fields → hint fix suggestion.
// Each exposes a `.hint` readonly property for programmatic extraction.

// ────────────────────────────────────────────────────────────────────────────
// Existing errors (carried from @forgeax/engine-ecs)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when an attempt is made to encode an entity index that does not fit
 * in 24 bits (i.e. >= 2^24 = 16_777_216).
 *
 * `.code = 'entity-index-overflow'`
 * `.hint` — suggests reducing entity count or investigating leaks.
 */
export class EntityIndexOverflowError extends RangeError {
  override readonly name = 'EntityIndexOverflowError';
  readonly code = 'entity-index-overflow' as const;
  readonly hint: string;

  constructor(index: number) {
    const hint =
      'Entity index exceeds 24-bit max (16777215). Reduce simultaneous entity count or investigate entity leaks.';
    super(
      `Entity index ${index} exceeds 24-bit max (16777215).\n` +
        `  index: ${index}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
  }
}

/**
 * Thrown when `defineComponent` is given a field type that is not in the
 * supported scalar field type set.
 *
 * `.code = 'schema-unsupported-field'`
 * `.hint` — lists all supported scalar field types.
 */
export class SchemaUnsupportedFieldError extends Error {
  override readonly name = 'SchemaUnsupportedFieldError';
  readonly code = 'schema-unsupported-field' as const;
  readonly hint: string;

  constructor(fieldName: string, fieldType: string) {
    let hint = 'Supported types: f32 / f64 / i32 / u32 / i16 / u16 / i8 / u8 / bool / enum / ref.';
    // feat-20260614 M1 / M5: explicit migration hints for the two
    // retired schema-vocab keyword families. Both renames preserve brand
    // and storage layout (u32 column); only the keyword + dispatch arm
    // changed. AI users hitting either literal land directly on the new
    // keyword instead of grepping for the rename note (charter F1
    // single-entry indexability).
    if (fieldType.startsWith('handle<') && fieldType.endsWith('>')) {
      const tag = fieldType.slice(7, -1);
      hint = `'handle<${tag}>' was removed in feat-20260614 M5; use 'shared<${tag}>' instead. The brand and storage layout are unchanged; only the keyword + write-barrier dispatch (SharedRefStore retain/release) is new.`;
    } else if (fieldType.startsWith('ref<') && fieldType.endsWith('>')) {
      const tag = fieldType.slice(4, -1);
      hint = `'ref<${tag}>' was renamed in feat-20260614 M1; use 'unique<${tag}>' instead. The brand and storage layout are unchanged; the dispatch still routes through UniqueRefStore (single-holder direct release).`;
    }
    super(
      `Schema field "${fieldName}" has unsupported type "${fieldType}".\n` +
        `  field: ${fieldName}\n` +
        `  type: ${fieldType}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// New 6 errors for @forgeax/engine-ecs
// ────────────────────────────────────────────────────────────────────────────

/**
 * Thrown (or returned via the `Result` err branch — `r.ok === false`, `r.error`)
 * when get/set/addComponent/removeComponent is called on an entity that has
 * been despawned (stale handle).
 *
 * `.code = 'stale-entity'`
 * `.hint` — includes operation name, expected/actual generation, and component name.
 * Enhanced fields: `.component`, `.operation`, `.expectedGeneration`, `.actualGeneration`.
 */
export class StaleEntityError extends Error {
  override readonly name = 'StaleEntityError';
  readonly code = 'stale-entity' as const;
  readonly hint: string;

  /** Component name involved in the operation (undefined when the operation does not target a specific component). */
  readonly component: string | undefined;
  /** The component-level operation that triggered this error (e.g. 'get' / 'set' / 'add' / 'remove'). Entity-level operations like `despawn` are not surfaced here — see `EntityHandle` lifecycle errors. */
  readonly operation: string | undefined;
  /** The generation the caller expected (from the entity handle). */
  readonly expectedGeneration: number | undefined;
  /**
   * The actual generation found in the entity pool. `-1` is the sentinel
   * value for entities never allocated (slot was never occupied), as opposed
   * to allocated-then-despawned entities which carry a real (incremented)
   * generation number.
   */
  readonly actualGeneration: number | undefined;

  constructor(
    entityId: number,
    index: number,
    generation: number,
    enhanced?: {
      component?: string;
      operation: string;
      expectedGeneration: number;
      actualGeneration: number;
    },
  ) {
    const hint = enhanced
      ? `Entity was despawned. Operation "${enhanced.operation}" on entity ${entityId}` +
        (enhanced.component ? ` (component: ${enhanced.component})` : '') +
        ` expected generation ${enhanced.expectedGeneration}, found ${enhanced.actualGeneration}.` +
        ' Check entity lifecycle before access.'
      : 'Entity was despawned. Check entity lifecycle before access.';
    super(
      `Operation on stale entity handle.\n` +
        `  entity: ${entityId} (index=${index}, generation=${generation})\n` +
        (enhanced ? `  operation: ${enhanced.operation}\n` : '') +
        (enhanced?.component ? `  component: ${enhanced.component}\n` : '') +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.component = enhanced?.component;
    this.operation = enhanced?.operation;
    this.expectedGeneration = enhanced?.expectedGeneration;
    this.actualGeneration = enhanced?.actualGeneration;
  }
}

/**
 * Returned via the `Result` err branch (`r.ok === false`, `r.error`) when
 * addComponent tries to add a component that the entity already possesses.
 *
 * `.code = 'component-already-present'`
 * `.hint` — suggests using `set()` to update values instead.
 */
export class ComponentAlreadyPresentError extends Error {
  override readonly name = 'ComponentAlreadyPresentError';
  readonly code = 'component-already-present' as const;
  readonly hint: string;

  constructor(entityId: number, componentName: string) {
    const hint = 'Entity already has this component. Use set() to update values.';
    super(
      `Entity ${entityId} already has component "${componentName}".\n` +
        `  entity: ${entityId}\n` +
        `  component: ${componentName}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
  }
}

/**
 * Returned via the `Result` err branch (`r.ok === false`, `r.error`) when
 * removeComponent / set is called for a component the entity does not possess.
 *
 * `.code = 'component-not-present'`
 * `.hint` — suggests checking with query or inspect().
 */
export class ComponentNotPresentError extends Error {
  override readonly name = 'ComponentNotPresentError';
  readonly code = 'component-not-present' as const;
  readonly hint: string;

  constructor(entityId: number, componentName: string) {
    const hint = 'Entity does not have this component. Check with query or inspect().';
    super(
      `Entity ${entityId} does not have component "${componentName}".\n` +
        `  entity: ${entityId}\n` +
        `  component: ${componentName}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
  }
}

/**
 * Thrown when DAG Schedule detects a cyclic dependency among systems.
 *
 * `.code = 'cyclic-dependency'`
 * `.hint` — includes the cycle path and suggests removing one constraint.
 */
export class CyclicDependencyError extends Error {
  override readonly name = 'CyclicDependencyError';
  readonly code = 'cyclic-dependency' as const;
  readonly hint: string;

  constructor(cyclePath: string) {
    const hint = `Cycle path: ${cyclePath}. Remove one ordering constraint to break the cycle.`;
    super(`DAG Schedule has a cyclic dependency.\n  cycle: ${cyclePath}\n  hint: ${hint}`);
    this.hint = hint;
  }
}

/**
 * Closed-set ScheduleMutationError code union (M2 — plan-strategy D-3).
 *
 * Schedule add-only API (`removeSystem` / `replaceSystem`) returns
 * `Result<void, ScheduleMutationError>` carrying one of these codes. The
 * `@forgeax/engine-remote` layer (M3) bridges these strings to JSON-RPC
 * `RemoteErrorCode` 1:1 — keeping ECS free of console / wire dependencies.
 *
 * - `system-before-unknown` — name argument does not match any registered system.
 * - `system-name-conflict`  — reserved for the M3 inject path; surfaced from
 *   schedule when callers inject a name that already exists.
 * - `cyclic-injection`      — schedule build detected a cycle introduced by
 *   the mutation; carries the cycle path in `.detail.cycle`.
 */
export type ScheduleMutationErrorCode =
  | 'system-before-unknown'
  | 'system-name-conflict'
  | 'cyclic-injection';

export interface ScheduleMutationErrorDetail {
  readonly cycle?: readonly string[];
  readonly candidates?: readonly string[];
}

/**
 * Returned via `Result.err` from `world.removeSystem` / `world.replaceSystem`.
 *
 * `.code` is the closed-set string SSOT consumed by the M3 console bridge;
 * `.hint` carries an AI-friendly self-repair suggestion; `.detail` is the
 * discriminated payload (cycle path for `cyclic-injection`, candidate list
 * for `system-before-unknown`).
 */
export class ScheduleMutationError extends Error {
  override readonly name = 'ScheduleMutationError';
  readonly code: ScheduleMutationErrorCode;
  readonly hint: string;
  readonly detail: ScheduleMutationErrorDetail;

  constructor(
    code: ScheduleMutationErrorCode,
    message: string,
    hint: string,
    detail: ScheduleMutationErrorDetail = {},
  ) {
    super(`${message}\n  code: ${code}\n  hint: ${hint}`);
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }
}

/**
 * Thrown when getResource is called with a key that does not exist.
 *
 * `.code = 'resource-not-found'`
 * `.hint` — suggests using `world.insertResource()` first.
 */
export class ResourceNotFoundError extends Error {
  override readonly name = 'ResourceNotFoundError';
  readonly code = 'resource-not-found' as const;
  readonly hint: string;

  constructor(key: string) {
    const hint = `Resource "${key}" not found. Insert with world.insertResource() first.`;
    super(`Resource "${key}" not found.\n` + `  key: ${key}\n` + `  hint: ${hint}`);
    this.hint = hint;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// w5 — managed-* closed-union extension (M0).
//
// Four error classes covering the managed-* family:
//
//   managed-*               : UniqueRefStore + BufferPool runtime fail-fast.
//                             Returned via Result.err from M1 / M2 storage paths.
//
// `.code` uses lowercase-kebab literals consistent with `ScheduleMutationErrorCode`
// (the prior closed-set convention). The 9 legacy errors keep their
// SCREAMING_SNAKE_CASE codes — codes are append-only per the evolution contract.
// `EcsErrorCode` (declared at the foot of this file) merges all literal codes
// into one closed union; downstream `switch (err.code)` is exhaustive.
//
// Every detail object is a discriminated payload — narrowed per `.code` via
// `EcsErrorDetail` (also at foot of file).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Thrown / returned via `Result.err` when UniqueRefStore.alloc encounters a
 * slot whose refcount has already dropped to zero (sentinel for a released
 * slot reused without re-init).
 *
 * `.code = 'unique-ref-released'`
 * `.detail = { handle, target }`
 * `.hint` — recommends checking handle lifetime against owner despawn.
 */
export class UniqueRefReleasedError extends Error {
  override readonly name = 'UniqueRefReleasedError';
  readonly code = 'unique-ref-released' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly handle: number; readonly target: string };

  constructor(handle: number, target: string) {
    const hint = `Handle ${handle} (target ${target}) was released before this access. Re-acquire via the producing system or re-spawn the asset before reading.`;
    const expected = 'live (refcount >= 1) managed handle';
    super(
      `UniqueRefStore: handle is already released.\n` +
        `  code: unique-ref-released\n` +
        `  handle: ${handle}\n` +
        `  target: ${target}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { handle, target };
  }
}

/**
 * Thrown / returned via `Result.err` when UniqueRefStore.release is called on
 * a handle whose refcount is already zero (double-free).
 *
 * `.code = 'unique-ref-double-release'`
 * `.detail = { handle, target }`
 * `.hint` — recommends auditing the release-loop entry points (set / removeComponent / despawn).
 */
export class UniqueRefDoubleReleaseError extends Error {
  override readonly name = 'UniqueRefDoubleReleaseError';
  readonly code = 'unique-ref-double-release' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly handle: number; readonly target: string };

  constructor(handle: number, target: string) {
    const hint = `Handle ${handle} (target ${target}) was released twice. Only one of {despawn / removeComponent / set} should release a managed handle per lifecycle.`;
    const expected = 'first release of a managed handle (refcount transition 1 -> 0)';
    super(
      `UniqueRefStore: double release on handle.\n` +
        `  code: unique-ref-double-release\n` +
        `  handle: ${handle}\n` +
        `  target: ${target}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { handle, target };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260614-ecs-shared-component-and-unique-rename M3 — SharedRefStore
// closed-union extension (+2). Mirrors the UniqueRef* pair — `'shared-ref-released'`
// covers resolve-after-release / retain-after-release; `'shared-ref-double-release'`
// covers release-when-rc-already-zero. Both are Result.err returns (not throws);
// AI users branch on `.code` and read `.detail.handle` for the offending slot.
//
// Detail field shape mirrors UniqueRef* with one addition (`rc`) so AI users
// debugging a double-release see the exact rc transition that surfaced the
// failure (charter P3 progressive disclosure). Empty `target` handled the
// same way as UniqueRef* — runtime-erased phantom, surfaced as '<unknown>'.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Thrown / returned via `Result.err` when SharedRefStore.resolve / .retain is
 * called on a handle whose refcount has already dropped to zero (slot released).
 *
 * `.code = 'shared-ref-released'`
 * `.detail = { handle, target }`
 * `.hint` — recommends checking handle lifetime against owner / consumer release.
 */
export class SharedRefReleasedError extends Error {
  override readonly name = 'SharedRefReleasedError';
  readonly code = 'shared-ref-released' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly handle: number; readonly target: string };

  constructor(handle: number, target: string) {
    const hint = `Handle ${handle} (target ${target}) was released (refcount reached 0). Re-acquire via the producing system or re-spawn the asset before reading.`;
    const expected = 'live (refcount >= 1) shared handle';
    super(
      `SharedRefStore: handle is already released.\n` +
        `  code: shared-ref-released\n` +
        `  handle: ${handle}\n` +
        `  target: ${target}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { handle, target };
  }
}

/**
 * Thrown / returned via `Result.err` when SharedRefStore.release is called on
 * a handle whose refcount is already zero (double-release). Distinct from the
 * UniqueRef family because shared release is rc--, not direct slot drop —
 * AI users debug this by reading `.detail.rc` (always 0 here) alongside the
 * payload-presence signal.
 *
 * `.code = 'shared-ref-double-release'`
 * `.detail = { handle, target, rc }`
 * `.hint` — recommends auditing the producer / consumer release pairs.
 */
export class SharedRefDoubleReleaseError extends Error {
  override readonly name = 'SharedRefDoubleReleaseError';
  readonly code = 'shared-ref-double-release' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly handle: number; readonly target: string; readonly rc: number };

  constructor(handle: number, target: string, rc: number) {
    const hint = `Handle ${handle} (target ${target}) released with rc=${rc}. Each shared handle must have a matching alloc/retain for every release; audit the producer / consumer release pairs.`;
    const expected = 'rc >= 1 before release';
    super(
      `SharedRefStore: double release on handle.\n` +
        `  code: shared-ref-double-release\n` +
        `  handle: ${handle}\n` +
        `  target: ${target}\n` +
        `  rc: ${rc}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { handle, target, rc };
  }
}

/**
 * Returned via `Result.err` when a builtin-tier slot (`slot < BUILTIN_BASE`)
 * is passed to SharedRefStore.alloc / retain / release / resolve
 * (feat-20260614 M6 D-15). The SharedRefStore manages ONLY user-tier slots
 * (`>= BUILTIN_BASE`); builtin asset payloads are process-static and live in
 * `BuiltinAssetRegistry` (`@forgeax/engine-runtime`), never reference-counted.
 *
 * `.code = 'builtin-slot-not-owned'`
 * `.detail = { slot }`
 * `.hint` — points the caller at BuiltinAssetRegistry.resolve.
 */
export class BuiltinSlotNotOwnedError extends Error {
  override readonly name = 'BuiltinSlotNotOwnedError';
  readonly code = 'builtin-slot-not-owned' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly slot: number };

  constructor(slot: number) {
    const hint = `Slot ${slot} is a builtin-tier handle (< BUILTIN_BASE). The SharedRefStore manages only user-tier handles (>= BUILTIN_BASE). Resolve builtin payloads through BuiltinAssetRegistry.resolve (@forgeax/engine-runtime); they are process-static and never reference-counted.`;
    const expected = 'user-tier slot (>= BUILTIN_BASE)';
    super(
      `SharedRefStore: builtin slot is not owned by this store.\n` +
        `  code: builtin-slot-not-owned\n` +
        `  slot: ${slot}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { slot };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260623-asset-handle-generation M4 — stale error classes (+2).
//
// Two error classes covering gen-based staleness detection in SharedRefStore
// and UniqueRefStore. Distinguish from the existing `*-ref-released` codes
// (slot empty / never allocated) — `*-ref-stale` means the slot has been
// released AND re-allocated, so the caller's handle generation no longer
// matches the store's current generation. AI users pick different recovery
// strategies: released -> re-load the asset; stale -> re-acquire the handle
// from AssetRegistry (charter P3 explicit failure, two semantics two
// recovery paths).
//
// `.detail` carries { slot, expectedGeneration, actualGeneration } aligned
// with StaleEntityError field names (AC-11). Codes are add-only minor
// members of EcsErrorCode (AC-10) and detail shapes extend EcsErrorDetail
// discriminator.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returned via `Result.err` when SharedRefStore.resolve / .retain / .release
 * is called with a handle whose generation no longer matches the store's
 * current generation for that slot — the slot was released and re-allocated
 * to a different payload. Distinct from `'shared-ref-released'` (slot empty,
 * never re-allocated): stale means the slot IS live but belongs to a newer
 * allocation.
 *
 * `.code = 'shared-ref-stale'`
 * `.detail = { slot, expectedGeneration, actualGeneration }`
 * `.hint` — recommends re-acquiring the handle from AssetRegistry.
 */
export class SharedRefStaleError extends Error {
  override readonly name = 'SharedRefStaleError';
  readonly code = 'shared-ref-stale' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly slot: number;
    readonly expectedGeneration: number;
    readonly actualGeneration: number;
  };

  constructor(slot: number, expectedGeneration: number, actualGeneration: number) {
    const hint = `Handle for slot ${slot} is stale: expected generation ${expectedGeneration}, but the store has generation ${actualGeneration} (slot was released and re-allocated). Re-acquire the handle from AssetRegistry.`;
    const expected = `generation === ${actualGeneration} (current store generation)`;
    super(
      `SharedRefStore: stale handle.\n` +
        `  code: shared-ref-stale\n` +
        `  slot: ${slot}\n` +
        `  expectedGeneration: ${expectedGeneration}\n` +
        `  actualGeneration: ${actualGeneration}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { slot, expectedGeneration, actualGeneration };
  }
}

/**
 * Returned via `Result.err` when UniqueRefStore.resolve / .release is
 * called with a handle whose generation no longer matches the store's
 * current generation for that slot — the slot was released and re-allocated.
 * Distinct from `'unique-ref-released'` (slot empty). UniqueRefStore has
 * no retain method; the stale surface is resolve + release only.
 *
 * `.code = 'unique-ref-stale'`
 * `.detail = { slot, expectedGeneration, actualGeneration }`
 * `.hint` — recommends re-acquiring the handle from the producing system.
 */
export class UniqueRefStaleError extends Error {
  override readonly name = 'UniqueRefStaleError';
  readonly code = 'unique-ref-stale' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly slot: number;
    readonly expectedGeneration: number;
    readonly actualGeneration: number;
  };

  constructor(slot: number, expectedGeneration: number, actualGeneration: number) {
    const hint = `Handle for slot ${slot} is stale: expected generation ${expectedGeneration}, but the store has generation ${actualGeneration} (slot was released and re-allocated). Re-acquire the handle via the producing system or re-spawn the asset.`;
    const expected = `generation === ${actualGeneration} (current store generation)`;
    super(
      `UniqueRefStore: stale handle.\n` +
        `  code: unique-ref-stale\n` +
        `  slot: ${slot}\n` +
        `  expectedGeneration: ${expectedGeneration}\n` +
        `  actualGeneration: ${actualGeneration}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { slot, expectedGeneration, actualGeneration };
  }
}

/**
 * Thrown / returned via `Result.err` when BufferPool indexing reads or writes
 * an offset outside the slot's `[0, size)` byte range. Triggers are limited
 * to the `buffer:<N>` and managed-array-element-buffer paths; the
 * `'string'` schema vocab no longer routes through this code (collapsed onto
 * the managed-ref dispatch by feat-20260515-string-managed-collapse — JS
 * string capacity is bounded by the host runtime, not by BufferPool buckets).
 *
 * `.code = 'managed-buffer-out-of-bounds'`
 * `.detail = { index, size }`
 * `.hint` — points at the field's `'buffer'` / `buffer<N>` schema declaration.
 */
export class ManagedBufferOutOfBoundsError extends RangeError {
  override readonly name = 'ManagedBufferOutOfBoundsError';
  readonly code = 'managed-buffer-out-of-bounds' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly index: number; readonly size: number };

  constructor(index: number, size: number) {
    const hint = `Index ${index} is outside [0, ${size}). Check the field's 'buffer' / 'buffer<N>' declaration matches the access pattern.`;
    const expected = `index in [0, ${size})`;
    super(
      `BufferPool: index out of bounds.\n` +
        `  code: managed-buffer-out-of-bounds\n` +
        `  index: ${index}\n` +
        `  size: ${size}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { index, size };
  }
}

/**
 * Thrown / returned via `Result.err` when BufferPool resize is asked to shrink
 * a slot below its current allocated size — the pool only grows.
 *
 * `.code = 'managed-buffer-shrink-not-supported'`
 * `.detail = { requested, current }`
 * `.hint` — directs callers to allocate a fresh slot if a smaller buffer is needed.
 */
export class ManagedBufferShrinkNotSupportedError extends Error {
  override readonly name = 'ManagedBufferShrinkNotSupportedError';
  readonly code = 'managed-buffer-shrink-not-supported' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly requested: number; readonly current: number };

  constructor(requested: number, current: number) {
    const hint = `BufferPool only grows. Requested ${requested} bytes < current ${current}; allocate a fresh slot if a smaller buffer is required.`;
    const expected = `requested >= ${current}`;
    super(
      `BufferPool: shrink not supported.\n` +
        `  code: managed-buffer-shrink-not-supported\n` +
        `  requested: ${requested}\n` +
        `  current: ${current}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { requested, current };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260515-buffer-array-vocab-collapse w11 — closed-union evolution.
//
// 4 managed-array-* error classes deleted (replaced by the 4 collapsed-vocab
// codes below); ManagedArrayElementTypeNotAllowedError preserved (still
// surfaced from defineComponent's schema parser).
//
// 4 new error classes:
//   - FixedSizeMismatchError              ('fixed-size-mismatch')
//   - FixedArrayOverflowError             ('fixed-array-overflow')
//   - ArrayPopEmptyError                  ('array-pop-empty')
//   - InstanceTransformsStrideMismatchError ('instance-transforms-stride-mismatch')
//
// Naming-prefix orthogonality (plan-strategy §2.5):
//   fixed-     element-type or capacity contract violations on fixed shape
//   array-     operation failures (pop on empty) on the array vocab keyword
//   instance-  GPU-render component-specific stride contract (Instances.transforms)
//
// Net EcsErrorCode count: 23 -> 19 (delete 4) -> 23 (add 4). The
// `instance-transforms-stride-mismatch` member is the plan-strategy §2.4
// evolution surfaced from `packages/runtime/src/render-system-extract.ts`
// defensive entry (consumed by w15 in M3, but the error class lives here so
// the EcsErrorCode union closure is owned by ECS — RhiError is not extended
// per plan-strategy §2.4 decision).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returned via `Result.err` from `world.set` when a `buffer<N>` field is
 * written with a `Uint8Array` whose `byteLength` does not equal the
 * schema-declared fixed size `N`. AI users resize their payload to exactly
 * `N` bytes (zero-pad or truncate at the producer) before calling `world.set`.
 *
 * `.code = 'fixed-size-mismatch'`
 * `.detail = { expected, actual }`
 * `.hint` — points at the producer's payload sizing.
 */
export class FixedSizeMismatchError extends Error {
  override readonly name = 'FixedSizeMismatchError';
  readonly code = 'fixed-size-mismatch' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly expected: number; readonly actual: number };

  constructor(fieldName: string, expected: number, actual: number) {
    const hint = `buffer<${expected}> set with byteLength ${actual} (expected ${expected}); resize your Uint8Array to exactly ${expected} bytes before world.set`;
    const expectedStr = `byteLength === ${expected}`;
    super(
      `buffer<N>: fixed-size mismatch.\n` +
        `  code: fixed-size-mismatch\n` +
        `  field: ${fieldName}\n` +
        `  expected: ${expected}\n` +
        `  actual: ${actual}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { expected, actual };
  }
}

/**
 * Returned via `Result.err` from `world.push` when an `array<T, N>`
 * (fixed-capacity) field's count has reached the schema-declared `N` and a
 * push would overflow. Fixed-capacity arrays cannot grow; AI users switch to
 * `array<T>` (variable capacity) for runtime growth.
 *
 * `.code = 'fixed-array-overflow'`
 * `.detail = { capacity, attemptedCount }`
 * `.hint` — names the variable-capacity remediation path. Hint text is the
 * SSOT locked at plan-strategy §8.3 (w28); the `{T}` slot is substituted
 * with the schema-declared element type literal so AI users get an
 * actionable copy-paste form (e.g. `'use array<f32> for variable capacity'`).
 */
export class FixedArrayOverflowError extends RangeError {
  override readonly name = 'FixedArrayOverflowError';
  readonly code = 'fixed-array-overflow' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly capacity: number; readonly attemptedCount: number };

  constructor(
    fieldName: string,
    capacity: number,
    attemptedCount: number,
    elementType: string = 'T',
  ) {
    const hint = `array<${elementType}, ${capacity}> push at count == ${capacity} (capacity == N == ${capacity}); fixed-capacity arrays cannot grow; use array<${elementType}> for variable capacity`;
    const expectedStr = `attemptedCount < ${capacity}`;
    super(
      `array<T, N>: fixed capacity overflow.\n` +
        `  code: fixed-array-overflow\n` +
        `  field: ${fieldName}\n` +
        `  capacity: ${capacity}\n` +
        `  attemptedCount: ${attemptedCount}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { capacity, attemptedCount };
  }
}

/**
 * Returned via `Result.err` from `world.pop` when the variable-capacity
 * `array<T>` field's count is 0. AI users guard with
 * `world.get(e, C).unwrap().f.length > 0` (read-only TypedArray snapshot) or
 * `world.capacity(e, C, fieldName)` (max) before popping.
 *
 * `.code = 'array-pop-empty'`
 * `.detail = { count: 0 }`
 * `.hint` — names the read-side guard path.
 */
export class ArrayPopEmptyError extends Error {
  override readonly name = 'ArrayPopEmptyError';
  readonly code = 'array-pop-empty' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly count: 0 };

  constructor(fieldName: string) {
    const hint = `cannot pop from empty array; check world.get(e, C).unwrap().f.length > 0 before world.pop, or use world.capacity(e, C, ...) for max`;
    const expectedStr = 'count >= 1';
    super(
      `array<T>: pop on empty array.\n` +
        `  code: array-pop-empty\n` +
        `  field: ${fieldName}\n` +
        `  count: 0\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { count: 0 };
  }
}

/**
 * Surfaced via the Layer-3 ErrorHandler from
 * `packages/runtime/src/render-system-extract.ts` defensive entry when an
 * `Instances.transforms` array<f32> length violates the column-major mat4
 * stride contract (`length % 16 === 0`). Locates the failure adjacent to the
 * extract pipeline rather than at GPU upload (plan-strategy §2.4 D-P2 +
 * §8.3 hint SSOT).
 *
 * `.code = 'instance-transforms-stride-mismatch'`
 * `.detail = { actualLength, expectedStride: 16 }`
 * `.hint` — names the stride invariant + the call sites to audit.
 */
export class InstanceTransformsStrideMismatchError extends Error {
  override readonly name = 'InstanceTransformsStrideMismatchError';
  readonly code = 'instance-transforms-stride-mismatch' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly actualLength: number; readonly expectedStride: 16 };

  constructor(actualLength: number) {
    const hint = `Instances.transforms length ${actualLength} violates stride 16 (mat4); ensure transforms.length % 16 === 0 before render frame; verify world.set / world.push call sites`;
    const expectedStr = 'actualLength % 16 === 0';
    super(
      `Instances.transforms: stride mismatch.\n` +
        `  code: instance-transforms-stride-mismatch\n` +
        `  actualLength: ${actualLength}\n` +
        `  expectedStride: 16\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { actualLength, expectedStride: 16 };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260519-light-casters-point-spot-pbr w2 — closed-union evolution +1.
//
// Adds 1 new member 'spawn-light-invalid-bounds' to EcsErrorCode (23 -> 24).
// AGENTS.md section Error model evolution contract: minor (add member only).
// Triggered by PointLight / SpotLight spawn-time payload validation
// (plan-strategy D-S3 a). detail.field three-branch
// ('range' | 'innerOuter' | 'outerNinety') keeps the four bound-violation
// shapes under one error code so callers narrow first on `.code` then on
// `.detail.field` (charter P3 progressive disclosure).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returned via `Result.err` from `world.spawn` when a PointLight or SpotLight
 * payload field is out of the documented bound. Four bound violations share
 * one `.code` and discriminate via `.detail.field`:
 *
 * - `range` — PointLight / SpotLight `range < 0` or `Number.isNaN(range)`.
 *   Use `Number.POSITIVE_INFINITY` for an unlimited range or a non-negative
 *   meter value.
 * - `innerOuter` — SpotLight `outerConeDeg <= innerConeDeg`. Inner cone is
 *   the saturated bright region; outer cone is the falloff edge.
 * - `outerNinety` — SpotLight `outerConeDeg > 90`. KHR_lights_punctual upper
 *   bound. A spot light cone wider than 90 degrees becomes a point light;
 *   use PointLight instead.
 *
 * `.code = 'spawn-light-invalid-bounds'`
 * `.detail = { field: 'range' | 'innerOuter' | 'outerNinety'; got: number }`
 * `.hint` — names the offending field plus the valid replacement form.
 */
export class SpawnLightInvalidBoundsError extends Error {
  override readonly name = 'SpawnLightInvalidBoundsError';
  readonly code = 'spawn-light-invalid-bounds' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly field: 'range' | 'innerOuter' | 'outerNinety';
    readonly got: number;
  };

  constructor(componentName: string, field: 'range' | 'innerOuter' | 'outerNinety', got: number) {
    let hint: string;
    let expectedStr: string;
    switch (field) {
      case 'range':
        hint = `${componentName}.range = ${got} is invalid; use Number.POSITIVE_INFINITY for unlimited range, or a non-negative meter value`;
        expectedStr = 'range >= 0 or Number.POSITIVE_INFINITY';
        break;
      case 'innerOuter':
        hint = `${componentName}.outerConeDeg <= innerConeDeg (got ${got}); inner cone is the saturated bright region, outer cone is the falloff edge; outerConeDeg > innerConeDeg required`;
        expectedStr = 'outerConeDeg > innerConeDeg';
        break;
      case 'outerNinety':
        hint = `${componentName}.outerConeDeg = ${got} > 90; a spot light cone wider than 90 degrees becomes a point light; use PointLight instead`;
        expectedStr = 'outerConeDeg <= 90 (KHR_lights_punctual upper bound)';
        break;
    }
    super(
      `${componentName}: spawn payload bound violation.\n` +
        `  code: spawn-light-invalid-bounds\n` +
        `  component: ${componentName}\n` +
        `  field: ${field}\n` +
        `  got: ${got}\n` +
        `  expected: ${expectedStr}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { field, got };
  }
}

/**
 * Thrown by `defineComponent` when an `array<T>` / `array<T,N>` schema field
 * carries an element type outside the legal whitelist (scalars + entity).
 * Forms like `array<ref<X>>` / `array<handle<X>>` / `array<buffer:N>` /
 * `array<array<...>>` are rejected (AC-03 runtime fail-safe). The TS layer
 * blocks these forms at compile time; this error is the runtime backstop for
 * `as unknown as SchemaFieldType` casts.
 *
 * `.code = 'managed-array-element-type-not-allowed'`
 * `.detail = { fieldName, elementType, hint }`
 * `.hint` — lists the whitelist of legal element types.
 */
export class ManagedArrayElementTypeNotAllowedError extends Error {
  override readonly name = 'ManagedArrayElementTypeNotAllowedError';
  readonly code = 'managed-array-element-type-not-allowed' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly fieldName: string;
    readonly elementType: string;
    readonly hint: string;
  };

  constructor(fieldName: string, elementType: string) {
    const hint = `array<T> element type must be a scalar (f32/f64/i32/u32/i16/u16/i8/u8/bool/enum/ref) or entity. ref<X> / handle<X> / buffer:N / nested array<...> are forbidden on field "${fieldName}".`;
    const expected = 'element type in {scalar | entity}';
    super(
      `managed-array: element type not allowed.\n` +
        `  code: managed-array-element-type-not-allowed\n` +
        `  field: ${fieldName}\n` +
        `  elementType: ${elementType}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { fieldName, elementType, hint };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260520-directional-light-shadow-mapping M1 / w1 — closed-union
// evolution +1 (`'cardinality-exceeded'`). feat-20260520-2d-sprite-layer-mvp
// M-2 w13 — closed-union evolution +1 (`'resource-invalid-value'`). Both
// land as minor (add-member) per AGENTS.md §Error model evolution contract;
// the unified count after merge is 24 -> 26.
//
// `'cardinality-exceeded'` is triggered when ECS spawn / addComponent
// detects more than one entity carrying a cardinality=1 component such as
// PointLightShadow (plan-strategy D-3). `.detail` carries
// `{ componentName, count, max }` so AI users narrow on `.code` then read
// `.detail` for the offending component name + the bound violated
// (charter P3 progressive disclosure).
//
// `'resource-invalid-value'` sits in the spawn-* fail-fast kebab series
// alongside `'spawn-light-invalid-bounds'` (feat-20260519). Triggered by
// `setTransparentSortConfig(world, { mode, yzAlpha })` when
// `mode \u2208/ {0, 1, 2}` (plan-strategy D-4). Generalisable to any future
// world-level resource validator that fails on bound-mismatch payloads;
// `.detail` carries `receivedMode` for the sort-config use case and accepts
// an optional `receivedKey` slot for future resource validators sharing the
// code.
//
// AGENTS.md table sync is deferred to a follow-up w33 (AC-16) so the doc +
// code commits land together with the D-6 historical 23 -> 24 catch-up
// (feat-20260519 missed the table bump). Plan-decisions D-3 + D-4 + D-6
// reference this comment.
// ───────────────────────────────────────────────────────────────────────

/**
 * Thrown / returned via `Result.err` when an attempt is made to add or spawn
 * a second entity with a component declared cardinality = 1 on the World.
 * The canonical first consumer is `PointLightShadow` (at most 4 shadow-casting
 * point lights per scene, cardinality=4); other bounded components route through
 * the same code.
 *
 * `.code = 'cardinality-exceeded'`
 * `.detail = { componentName, count, max }`
 * `.hint` — names the offending component, the current count, and the bound.
 */
export class CardinalityExceededError extends Error {
  override readonly name = 'CardinalityExceededError';
  readonly code = 'cardinality-exceeded' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly componentName: string;
    readonly count: number;
    readonly max: number;
  };

  constructor(componentName: string, count: number, max: number) {
    const hint = `Component "${componentName}" is declared cardinality=${max}; current count ${count} exceeds the bound. Despawn the extra entity or merge the data into a single carrier.`;
    const expectedStr = `count <= ${max} for component "${componentName}"`;
    super(
      `Cardinality exceeded for component "${componentName}".\n` +
        `  code: cardinality-exceeded\n` +
        `  component: ${componentName}\n` +
        `  count: ${count}\n` +
        `  max: ${max}\n` +
        `  expected: ${expectedStr}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { componentName, count, max };
  }
}

/**
 * Returned via `Result.err` from resource-setter helpers (e.g.
 * `setTransparentSortConfig`) when a numeric payload field violates the
 * closed bound declared by the resource contract. The first consumer is
 * `TransparentSortConfig.mode \u2208 {0, 1, 2}` (plan-strategy D-4); future
 * resource validators with the same shape reuse this code by routing
 * through `.detail.receivedKey` to disambiguate which resource validator
 * surfaced the failure.
 *
 * Closed-set kebab code consistent with `spawn-light-invalid-bounds`
 * (feat-20260519 / w2); AI users consume via `switch (err.code)` exhaustive
 * narrows + `err.detail.receivedMode` (or `err.detail.receivedKey` /
 * `err.expected`) property access — never string-parse the message.
 *
 * `.code = 'resource-invalid-value'`
 * `.detail = { receivedMode: number; receivedKey?: string }`
 * `.hint` — direct copy-paste recovery (e.g. "0=layer-z, 1=layer-y,
 *   2=layer-yz" for the sort-config case).
 * `.expected` — the bound contract literal (e.g. "mode \u2208 {0, 1, 2}").
 *
 * @reuses RhiError structured shape — same `.code / .expected / .hint /
 *   .detail` quadruple AI users consume across rhi + ecs.
 */
export class ResourceInvalidValueError extends Error {
  override readonly name = 'ResourceInvalidValueError';
  readonly code = 'resource-invalid-value' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly receivedMode: number; readonly receivedKey?: string };

  constructor(
    expected: string,
    hint: string,
    detail: { readonly receivedMode: number; readonly receivedKey?: string },
  ) {
    const keyClause = detail.receivedKey === undefined ? '' : `  key: ${detail.receivedKey}\n`;
    super(
      `resource: invalid value.\n` +
        `  code: resource-invalid-value\n` +
        keyClause +
        `  receivedMode: ${detail.receivedMode}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = detail;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260521-sprite-atlas-animation M1 T-05 — closed-union evolution +1.
//
// Adds 1 new member 'sprite-animation-invalid' to EcsErrorCode (25 -> 26).
// AGENTS.md §Error model evolution contract: minor (add member only).
// Same-shape add-only mirror of SpawnLightInvalidBoundsError (feat-20260519
// w2 line 736-776) and ResourceInvalidValueError (feat-20260520 w13 line
// 862) — the kebab `'<noun>-invalid-...'` series keeps `switch (err.code)`
// exhaustive narrows visually consistent (charter P4 consistent abstraction;
// research F-7 candidate A).
//
// Triggered by `spriteAnimationTickSystem` (packages/runtime/src/systems/
// sprite-animation-tick.ts, landed in M4 T-23) when an entity's
// `SpriteAnimation` row violates one of two runtime invariants:
//
//   - field='regions-length' -> `regions.length !== frameCount * 4`
//   - field='frame-duration' -> `frameDuration <= 0`
//
// `.detail.field` two-branch (charter P3: AI users branch once on
// `err.code` and once on `err.detail.field` to reach the recovery hint
// without parsing the message). Plan-strategy section 2 D-1 binds the
// detail field shape; M4 T-19 / T-20 / T-21 cover the runtime fail-fast
// paths end-to-end.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returned via `Result.err` from `spriteAnimationTickSystem` (M4 T-23) when
 * an entity's `SpriteAnimation` row violates a runtime invariant.
 * Two invariants share one `.code` and discriminate via `.detail.field`:
 *
 * - `regions-length` — `SpriteAnimation.regions.length !== frameCount * 4`.
 *   `regions` packs `[uMin, vMin, uW, vH]` per frame so the length must be
 *   exactly `frameCount * 4`. Detail carries the offending `regionsLength`
 *   alongside the declared `frameCount` so the hint can spell the exact
 *   delta in callsite-friendly numbers.
 * - `frame-duration` — `SpriteAnimation.frameDuration <= 0` (covers both
 *   `frameDuration === 0` and `frameDuration < 0`; T-21 binds the negative
 *   case to the same arm so AI users handle both via a single
 *   `if (err.detail.field === 'frame-duration')` branch — charter P4
 *   consistent abstraction).
 *
 * `.code = 'sprite-animation-invalid'`
 * `.detail = { field: 'regions-length', regionsLength, frameCount } |
 *            { field: 'frame-duration', frameDuration }`
 *
 * Two top-level detail variants give each `.field` branch its own
 * required sub-field shape so AI users get strong narrowing inside
 * `switch (err.detail.field)` without optional sub-fields bleeding
 * across branches (mirrors `SpawnLightInvalidBoundsError`'s shared
 * `got: number` shape but adapted because regions-length /
 * frame-duration carry different sub-field counts).
 *
 * `.hint` — names the offending invariant plus the valid replacement form.
 */
export class SpriteAnimationInvalidError extends Error {
  override readonly name = 'SpriteAnimationInvalidError';
  readonly code = 'sprite-animation-invalid' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail:
    | {
        readonly field: 'regions-length';
        readonly regionsLength: number;
        readonly frameCount: number;
      }
    | {
        readonly field: 'frame-duration';
        readonly frameDuration: number;
      };

  constructor(
    detail:
      | { field: 'regions-length'; regionsLength: number; frameCount: number }
      | { field: 'frame-duration'; frameDuration: number },
  ) {
    let hint: string;
    let expectedStr: string;
    switch (detail.field) {
      case 'regions-length':
        expectedStr = 'SpriteAnimation.regions.length === frameCount * 4';
        hint = `SpriteAnimation.regions.length = ${detail.regionsLength} does not match frameCount * 4 = ${detail.frameCount * 4}; pack 4 floats [uMin, vMin, uW, vH] per frame (see <name>.atlas.meta.json sidecar 'regions' map)`;
        break;
      case 'frame-duration':
        expectedStr = 'SpriteAnimation.frameDuration > 0';
        hint = `SpriteAnimation.frameDuration = ${detail.frameDuration} is invalid; use a positive seconds-per-frame value (e.g. 0.1 = 10 fps)`;
        break;
    }
    super(
      `SpriteAnimation: invariant violated.\n` +
        `  code: sprite-animation-invalid\n` +
        `  field: ${detail.field}\n` +
        `  expected: ${expectedStr}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = detail;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260531-ecs-relationship-abstraction-bidirectional-sync M2 — closed-
// union evolution +4 (plan-strategy D-5). Adds 4 `relationship-*` kebab codes
// (27 -> 31, add-only minor per AGENTS.md Error model evolution contract):
//
//   - relationship-self-cycle                       (cycle / ancestor walk hit)
//   - relationship-mirror-component-not-registered  (defineComponent gate a)
//   - relationship-mirror-field-type-mismatch       (defineComponent gate b)
//   - relationship-detach-mismatch                  (removeChild parent arg mismatch)
//
// `relationship-exclusive-violation` is intentionally NOT a member: exclusive
// re-add is an automatic reparent (a success path, D-1 style), not an error.
// Every detail object is a discriminated payload narrowed via EcsErrorDetail.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returned via `Result.err` from `world.addChild` / `world.reparent` (M3) when
 * a hierarchy write would form a cycle — either the child is its own parent
 * (self-loop) or the proposed parent is already a descendant of the child
 * (ancestor-walk hit). The `.detail` carries both the offending child entity
 * and the ancestor entity that closed the cycle so AI users can locate the
 * loop without re-walking the graph.
 *
 * `.code = 'relationship-self-cycle'`
 * `.detail = { component, entity, ancestor }`
 * `.hint` — names the child + ancestor that would close the cycle.
 */
export class RelationshipSelfCycleError extends Error {
  override readonly name = 'RelationshipSelfCycleError';
  readonly code = 'relationship-self-cycle' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly component: string;
    readonly entity: number;
    readonly ancestor: number;
  };

  constructor(component: string, entity: number, ancestor: number) {
    const hint = `Linking entity ${entity} via "${component}" would close a cycle through ancestor ${ancestor}. Reparent to an entity that is not a descendant of ${entity}.`;
    const expected = 'acyclic parent chain';
    super(
      `relationship: cycle detected.\n` +
        `  code: relationship-self-cycle\n` +
        `  component: ${component}\n` +
        `  entity: ${entity}\n` +
        `  ancestor: ${ancestor}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { component, entity, ancestor };
  }
}

/**
 * Thrown by `defineComponent` (feat-20260602 M2) when a component declares a
 * `relationship.mirror` naming a component that has not yet been defined
 * (AC-09). AI users defineComponent the mirror before the holder (mirror-then-
 * holder order).
 *
 * The `.code` literal `relationship-mirror-component-not-registered` is kept
 * unchanged across the M2 migration (deliberate terminology trade-off:
 * external `.code` stability over wording precision); only the `.hint` text
 * drops the register/registered phrasing in favour of defineComponent ordering
 * guidance.
 *
 * `.code = 'relationship-mirror-component-not-registered'`
 * `.detail = { component, mirror }`
 * `.hint` — names the holder + the undefined mirror component.
 */
export class RelationshipMirrorComponentNotRegisteredError extends Error {
  override readonly name = 'RelationshipMirrorComponentNotRegisteredError';
  readonly code = 'relationship-mirror-component-not-registered' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly component: string; readonly mirror: string };

  constructor(component: string, mirror: string) {
    const hint = `Component "${component}" declares relationship.mirror = "${mirror}", but "${mirror}" has not been defined yet. defineComponent the mirror component before the holder (define them in mirror-then-holder order).`;
    const expected = `mirror component "${mirror}" registered`;
    super(
      `relationship: mirror component not registered.\n` +
        `  code: relationship-mirror-component-not-registered\n` +
        `  component: ${component}\n` +
        `  mirror: ${mirror}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { component, mirror };
  }
}

/**
 * Thrown by `defineComponent` (feat-20260602 M2) when the
 * `relationship.field` on the mirror component is missing or its schema type
 * is not the only legal back-reference storage shape `array<entity>`
 * (AC-11 b). AI users declare the mirror field as `'array<entity>'`.
 *
 * `.code = 'relationship-mirror-field-type-mismatch'`
 * `.detail = { component, mirror, field, actualType }`
 * `.hint` — names the holder + mirror field + the type observed.
 */
export class RelationshipMirrorFieldTypeMismatchError extends Error {
  override readonly name = 'RelationshipMirrorFieldTypeMismatchError';
  readonly code = 'relationship-mirror-field-type-mismatch' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly component: string;
    readonly mirror: string;
    readonly field: string;
    readonly actualType: string;
  };

  constructor(component: string, mirror: string, field: string, actualType: string) {
    const hint = `Component "${component}" mirror "${mirror}".${field} has type "${actualType}"; the reverse-list field must be declared as 'array<entity>'.`;
    const expected = "mirror field type === 'array<entity>'";
    super(
      `relationship: mirror field type mismatch.\n` +
        `  code: relationship-mirror-field-type-mismatch\n` +
        `  component: ${component}\n` +
        `  mirror: ${mirror}\n` +
        `  field: ${field}\n` +
        `  actualType: ${actualType}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { component, mirror, field, actualType };
  }
}

/**
 * Returned via `Result.err` from `world.removeChild` (M3) when the `parent`
 * argument does not match the child's current relationship parent (the child
 * lacks the relationship component, or it points at a different parent). The
 * `.detail` carries the expected (argument) parent + the actual current parent
 * so AI users can reconcile their model.
 *
 * `.code = 'relationship-detach-mismatch'`
 * `.detail = { component, child, expectedParent, actualParent }`
 *   `actualParent === ENTITY_NULL_RAW` (0) signals the child has no relationship.
 * `.hint` — names the child + the parent mismatch.
 */
export class RelationshipDetachMismatchError extends Error {
  override readonly name = 'RelationshipDetachMismatchError';
  readonly code = 'relationship-detach-mismatch' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly component: string;
    readonly child: number;
    readonly expectedParent: number;
    readonly actualParent: number;
  };

  constructor(component: string, child: number, expectedParent: number, actualParent: number) {
    const hint = `removeChild(${expectedParent}, ${child}) via "${component}": child's current parent is ${actualParent}, not ${expectedParent}. Detach from the actual parent or re-read the current relationship.`;
    const expected = `child's "${component}" parent === ${expectedParent}`;
    super(
      `relationship: detach parent mismatch.\n` +
        `  code: relationship-detach-mismatch\n` +
        `  component: ${component}\n` +
        `  child: ${child}\n` +
        `  expectedParent: ${expectedParent}\n` +
        `  actualParent: ${actualParent}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { component, child, expectedParent, actualParent };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260531-query-optional-components M1 — closed-union evolution +1.
//
// Adds 1 new member 'query-descriptor-with-optional-conflict' to EcsErrorCode
// (31 -> 32). AGENTS.md §Error model evolution contract: minor (add member
// only). Same-shape add-only mirror of ScheduleMutationError — the kebab
// `<noun>-<problem>` series keeps `switch (err.code)` exhaustive narrows
// visually consistent (charter P4).
//
// Triggered by `createQueryState` when a component token appears in both
// `with` and `optional` arrays — the two roles are contradictory (with =
// must be present for matching; optional = may be absent, data-only).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Thrown / returned via `Result.err` from `createQueryState` when the same
 * component token appears in both `with` and `optional` — the two roles are
 * contradictory. AI users remove the component from one of the two lists.
 *
 * `.code = 'query-descriptor-with-optional-conflict'`
 * `.detail = { tokenName }`
 * `.hint` — names the conflicting component + the resolution (remove from
 *   `with` or `optional`).
 */
export class QueryDescriptorOptionalConflictError extends Error {
  override readonly name = 'QueryDescriptorOptionalConflictError';
  readonly code = 'query-descriptor-with-optional-conflict' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly tokenName: string };

  constructor(tokenName: string) {
    const hint = `Component "${tokenName}" appears in both \`with\` and \`optional\`. These roles conflict: \`with\` requires the component for matching, while \`optional\` is data-only. Remove "${tokenName}" from one of the two lists.`;
    const expectedStr = 'disjoint with and optional component sets';
    super(
      `QueryDescriptor: with-optional conflict.\n` +
        `  code: query-descriptor-with-optional-conflict\n` +
        `  token: ${tokenName}\n` +
        `  expected: ${expectedStr}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { tokenName };
  }
}

/**
 * Returned via `Result.err` from `world.removeComponent` when the caller tries
 * to remove an essential (undeletable) component
 * (feat-20260602-archetype-stores-full-packed-entity M1 / w3, plan-strategy
 * D-3). The only essential component today is the id=0 `Entity` component: every
 * archetype carries it unconditionally as the row's own packed handle, so
 * removing it is structurally meaningless. The code name is deliberately
 * generic (`remove-essential-component`, not entity-specific) so a future second
 * essential component reuses it without a rename.
 *
 * `.code = 'remove-essential-component'`
 * `.detail = { componentName }`
 * `.hint` — names the essential component + states it cannot be removed.
 */
export class RemoveEssentialComponentError extends Error {
  override readonly name = 'RemoveEssentialComponentError';
  readonly code = 'remove-essential-component' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly componentName: string };

  constructor(componentName: string) {
    const hint = `Component "${componentName}" is essential (every entity carries it unconditionally) and cannot be removed. Despawn the entity instead if you want to retire it.`;
    const expected = 'non-essential component';
    super(
      `removeComponent: essential component cannot be removed.\n` +
        `  code: remove-essential-component\n` +
        `  component: ${componentName}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { componentName };
  }
}

/**
 * Returned via the `Result` err branch when `instantiate` encounters a
 * SceneAsset entity whose `components` map references a component name that was
 * never passed to `defineComponent`.
 *
 * `.code = 'component-not-defined'`
 * `.detail.name` — the offending component name.
 *
 * Promoting this to a class (rather than a bare object literal) keeps the
 * scene-instantiate failure surface inside the `EcsError` class union, so the
 * documented two-level narrow `cause instanceof EcsError` actually matches it
 * (docs/feedbacks/2026-06-03 §6.2 Tier 4.2). `expected` / `hint` accept
 * per-call overrides because the parent-passthrough (ChildOf) site needs a
 * distinct message from the generic entity-component site.
 */
export class ComponentNotDefinedError extends Error {
  override readonly name = 'ComponentNotDefinedError';
  readonly code = 'component-not-defined' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly name: string };

  constructor(componentName: string, opts?: { expected?: string; hint?: string }) {
    const expected = opts?.expected ?? `component '${componentName}' defined before instantiate`;
    const hint =
      opts?.hint ??
      `define the component via defineComponent('${componentName}', ...) before instantiating this SceneAsset`;
    super(
      `instantiate: component not defined.\n` +
        `  code: component-not-defined\n` +
        `  component: ${componentName}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { name: componentName };
  }
}

/**
 * Returned via `Result.err` from `world.spawn` / `world.addComponent` /
 * `world.instantiateScene` / `Commands.spawn` when the caller-supplied
 * data payload carries a key that is not declared in the target component's
 * schema. The pre-fix behaviour silently dropped unknown keys inside
 * `fillComponentDefaults` (which walked schema keys, never raw keys), so a
 * typo like `MeshRenderer { material: h }` (singular legacy field name; the
 * current schema has `materials: array<...>`) produced an empty-defaults row
 * + an invisible / mid-grey entity downstream. Surfacing the typo at the
 * spawn boundary collapses a class of "renders wrong, looks like a graphics
 * bug" reports into a single explicit error.
 *
 * `.code = 'spawn-data-unknown-field'`
 * `.detail = { component, field, knownFields }`
 * `.hint` — names the offending field and lists the schema's known fields.
 */
export class SpawnDataUnknownFieldError extends Error {
  override readonly name = 'SpawnDataUnknownFieldError';
  readonly code = 'spawn-data-unknown-field' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly component: string;
    readonly field: string;
    readonly knownFields: readonly string[];
  };

  constructor(componentName: string, fieldName: string, knownFields: readonly string[]) {
    const sortedKnown = [...knownFields].sort();
    const expected = `field name in {${sortedKnown.join(', ')}}`;
    const hint =
      `'${fieldName}' is not a schema field of '${componentName}'. ` +
      `Known fields: ${sortedKnown.join(', ')}. ` +
      `Check for a typo or a stale single-vs-plural rename (e.g. 'material' vs 'materials').`;
    super(
      `${componentName}: spawn data carries unknown field.\n` +
        `  code: spawn-data-unknown-field\n` +
        `  component: ${componentName}\n` +
        `  field: ${fieldName}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { component: componentName, field: fieldName, knownFields: sortedKnown };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M1 / w2 —
// closed-union evolution +3 for the SpriteInstances primitive + tilemap
// terrain static-batch path. AGENTS.md §Error model evolution contract: minor
// (add member only).
//
// All 3 codes are DECLARED here (M1) but FIRED at the render-system-extract
// queryRun callback (M3 w13) — plan-strategy D-6 "fail-fast at the render
// domain entry, not at ECS spawn-time (avoids reverse dep ECS -> AssetRegistry
// to look up MaterialAsset.shadingModel)". M1 carries class declarations only;
// the `_routeError` call sites land in M3.
//
// Three codes, three failure shapes:
//   - 'sprite-instances-count-mismatch' — transforms.length / 16 !==
//     regions.length / 4 (stride contract; cf. instance-transforms-stride-
//     mismatch which guards Instances stride 16).
//   - 'sprite-instances-requires-sprite-shader' — the entity's MaterialAsset's
//     first pass shader is not 'forgeax::sprite' (extract-time check; AI users
//     using SpriteInstances must pick a sprite-shaded material).
//   - 'sprite-instances-mutually-exclusive-with-instances' — the same entity
//     carries both Instances + SpriteInstances (the two primitives are peers;
//     SpriteInstances supersedes Instances when per-instance UV region is
//     needed).
//
// .hint follows charter P3: each contains the literal repair step AI users
// can paste back into spawn code (transforms/regions stride math; shading
// model field write; component removal).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Thrown / returned via Layer-3 error route when `SpriteInstances.transforms`
 * (stride 16 — column-major mat4 per instance) and `SpriteInstances.regions`
 * (stride 4 — per-instance UV vec4) instance counts disagree at render-system-
 * extract entry.
 *
 * `.code = 'sprite-instances-count-mismatch'`
 * `.detail = { transformsLength, regionsLength, expectedStride: { transforms: 16, regions: 4 } }`
 * `.hint` — instructs the AI user to enforce
 *   `transforms.length / 16 === regions.length / 4`.
 */
export class SpriteInstancesCountMismatchError extends Error {
  override readonly name = 'SpriteInstancesCountMismatchError';
  readonly code = 'sprite-instances-count-mismatch' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly code: 'sprite-instances-count-mismatch';
    readonly transformsLength: number;
    readonly regionsLength: number;
    readonly expectedStride: { readonly transforms: 16; readonly regions: 4 };
  };

  constructor(transformsLength: number, regionsLength: number) {
    const hint =
      'SpriteInstances.transforms (stride 16) and SpriteInstances.regions (stride 4) ' +
      'must describe the same instance count: ensure transforms.length / 16 === regions.length / 4 ' +
      'at the spawn / set site (resize both arrays together).';
    const expected = 'transforms.length / 16 === regions.length / 4';
    super(
      `SpriteInstances: per-instance count mismatch between transforms and regions.\n` +
        `  code: sprite-instances-count-mismatch\n` +
        `  transformsLength: ${transformsLength} (count = ${transformsLength / 16})\n` +
        `  regionsLength: ${regionsLength} (count = ${regionsLength / 4})\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = {
      code: 'sprite-instances-count-mismatch',
      transformsLength,
      regionsLength,
      expectedStride: { transforms: 16, regions: 4 },
    };
  }
}

/**
 * Thrown / returned via Layer-3 error route when an entity carrying
 * `SpriteInstances` references a MaterialAsset whose first pass shader is not
 * `'forgeax::sprite'`. Detected at render-system-extract entry (M3 w13).
 *
 * `.code = 'sprite-instances-requires-sprite-shader'`
 * `.detail = { entityId, observedMaterialShaderId }`
 * `.hint` — instructs the AI user to bind a MaterialAsset whose first pass
 *   `shader` is `'forgeax::sprite'` or `'forgeax::sprite-lit'`.
 *
 * feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t6:
 * sprite-lit walks the same per-instance UV region vertex path as sprite
 * (VsOut byte-identical, paramSchema mirror); both shader ids are accepted.
 */
export class SpriteInstancesRequiresSpriteShaderError extends Error {
  override readonly name = 'SpriteInstancesRequiresSpriteShaderError';
  readonly code = 'sprite-instances-requires-sprite-shader' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly code: 'sprite-instances-requires-sprite-shader';
    readonly entityId: number;
    readonly observedMaterialShaderId: string;
  };

  constructor(entityId: number, observedMaterialShaderId: string) {
    const hint =
      "bind a MaterialAsset whose first pass `shader` is 'forgeax::sprite' " +
      "or 'forgeax::sprite-lit' to this entity's MeshRenderer (SpriteInstances " +
      'requires a sprite-family shader so the per-instance UV region is consumed ' +
      'by the sprite vertex shader path).';
    const expected =
      "MaterialAsset.passes[0].shader === 'forgeax::sprite' || 'forgeax::sprite-lit'";
    super(
      `SpriteInstances: entity ${entityId} requires a sprite-shaded MaterialAsset.\n` +
        `  code: sprite-instances-requires-sprite-shader\n` +
        `  entityId: ${entityId}\n` +
        `  observedMaterialShaderId: ${observedMaterialShaderId}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = {
      code: 'sprite-instances-requires-sprite-shader',
      entityId,
      observedMaterialShaderId,
    };
  }
}

/**
 * Thrown / returned via Layer-3 error route when the same entity carries both
 * `Instances` (3D per-instance mat4) and `SpriteInstances` (2D per-instance
 * mat4 + UV region). The two primitives are peers — pick one. Detected at
 * render-system-extract entry (M3 w13).
 *
 * `.code = 'sprite-instances-mutually-exclusive-with-instances'`
 * `.detail = { entityId }`
 * `.hint` — instructs the AI user to remove one of the two components.
 */
export class SpriteInstancesMutuallyExclusiveWithInstancesError extends Error {
  override readonly name = 'SpriteInstancesMutuallyExclusiveWithInstancesError';
  readonly code = 'sprite-instances-mutually-exclusive-with-instances' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly code: 'sprite-instances-mutually-exclusive-with-instances';
    readonly entityId: number;
  };

  constructor(entityId: number) {
    const hint =
      'remove Instances or replace with SpriteInstances; SpriteInstances supersedes ' +
      'Instances when per-instance region is needed.';
    const expected = 'entity carries Instances XOR SpriteInstances (not both)';
    super(
      `SpriteInstances: entity ${entityId} carries both Instances and SpriteInstances.\n` +
        `  code: sprite-instances-mutually-exclusive-with-instances\n` +
        `  entityId: ${entityId}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = {
      code: 'sprite-instances-mutually-exclusive-with-instances',
      entityId,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// EcsErrorCode closed union (w5)
//
// Merges every `.code` literal across the EcsError family. Downstream
// `switch (err.code)` blocks become exhaustive; `assertNever(code)` catches
// any future code addition without a matching case at compile time.
//
// Order is grouped (legacy SCREAMING_SNAKE first, then closed-set kebab) but
// not load-bearing — TS unions are unordered.
// ────────────────────────────────────────────────────────────────────────────

/** Closed union of every `.code` literal carried by EcsError instances. */
export type EcsErrorCode =
  // Legacy SCREAMING_SNAKE codes (7, carried unchanged; the two
  // registration codes COMPONENT_ALREADY_REGISTERED / COMPONENT_NOT_REGISTERED
  // were dropped by feat-20260602 along with the per-World register concept).
  | 'entity-index-overflow'
  | 'schema-unsupported-field'
  | 'stale-entity'
  | 'component-already-present'
  | 'component-not-present'
  | 'cyclic-dependency'
  | 'resource-not-found'
  // ScheduleMutationError closed-set kebab codes (3).
  | ScheduleMutationErrorCode
  // w5 managed-* kebab codes (4).
  | 'unique-ref-released'
  | 'unique-ref-double-release'
  // feat-20260614-ecs-shared-component-and-unique-rename M3 — SharedRefStore
  // closed-union extension (+2). `'shared-ref-released'` covers resolve / retain
  // on rc=0; `'shared-ref-double-release'` covers release on rc=0.
  | 'shared-ref-released'
  | 'shared-ref-double-release'
  // feat-20260614-ecs-shared-component-and-unique-rename M6 D-15 (+1).
  // SharedRefStore manages ONLY user-tier slots (>= BUILTIN_BASE); a builtin
  // slot (< BUILTIN_BASE) passed to alloc/retain/release/resolve is a caller
  // error -> `'builtin-slot-not-owned'` (hint points at BuiltinAssetRegistry).
  | 'builtin-slot-not-owned'
  // feat-20260623-asset-handle-generation M4 — stale error codes (+2).
  // `'shared-ref-stale'` / `'unique-ref-stale'` cover gen mismatch on resolve /
  // retain / release after slot re-allocation. Add-only minor per AGENTS.md
  // Error model evolution contract; distinct from the existing `*-ref-released`
  // codes (slot empty vs slot re-allocated).
  | 'shared-ref-stale'
  | 'unique-ref-stale'
  | 'managed-buffer-out-of-bounds'
  | 'managed-buffer-shrink-not-supported'
  // managed-array-* kebab codes — surviving member from feat-20260514;
  // the other 4 (`managed-array-{index-out-of-bounds, pop-empty,
  // shrink-not-supported, stride-mismatch}`) were dropped by
  // feat-20260515-buffer-array-vocab-collapse w11 in favour of the 4 new
  // collapsed-vocab codes below. Kept here because `defineComponent`'s schema
  // parser still surfaces it for illegal `array<...>` element types.
  | 'managed-array-element-type-not-allowed'
  // feat-20260515-buffer-array-vocab-collapse w11 collapsed-vocab codes (4,
  // plan-strategy §2.4 + §2.5 four-prefix taxonomy).
  | 'fixed-size-mismatch'
  | 'fixed-array-overflow'
  | 'array-pop-empty'
  | 'instance-transforms-stride-mismatch'
  // feat-20260519-light-casters-point-spot-pbr w2 — PointLight / SpotLight
  // spawn-time payload bound violation (plan-strategy D-S3 a). 23 -> 24
  // minor evolution per AGENTS.md Error model evolution contract.
  | 'spawn-light-invalid-bounds'
  // feat-20260520-directional-light-shadow-mapping M1 / w1 — singleton
  // component cardinality violation (plan-strategy D-3). 24 -> 25 minor
  // evolution per AGENTS.md Error model evolution contract. Surfaced from
  // ECS spawn / addComponent when more than one entity carries a
  // cardinality=1 component (canonical first consumer:
  // PointLightShadow).
  | 'cardinality-exceeded'
  // feat-20260520-2d-sprite-layer-mvp M-2 w13 — resource-setter bound
  // validation (plan-strategy D-4). 25 -> 26 minor evolution; first
  // consumer is `setTransparentSortConfig` (mode ∈ {0, 1, 2}).
  | 'resource-invalid-value'
  // feat-20260521-sprite-atlas-animation M1 T-05 — spriteAnimationTickSystem
  // runtime invariant violation (plan-strategy D-1). 26 -> 27 minor evolution
  // per AGENTS.md §Error model evolution contract; same-shape mirror of
  // 'spawn-light-invalid-bounds' (feat-20260519 w2) and 'resource-invalid-
  // value' (feat-20260520 w13) — the `<noun>-invalid-...` kebab series keeps
  // switch (err.code) narrows visually consistent for AI users (charter P4).
  | 'sprite-animation-invalid'
  // feat-20260531-ecs-relationship-abstraction-bidirectional-sync M2 —
  // relationship bidirectional sync + defineComponent relationship validation +
  // addChild/reparent cycle detection + removeChild detach guard
  // (plan-strategy D-5). 27 -> 31 minor evolution per AGENTS.md Error model
  // evolution contract. `relationship-exclusive-violation` is NOT a member:
  // exclusive re-add is an automatic reparent (success path), not an error.
  | 'relationship-self-cycle'
  | 'relationship-mirror-component-not-registered'
  | 'relationship-mirror-field-type-mismatch'
  | 'relationship-detach-mismatch'
  // feat-20260531-query-optional-components M1 — createQueryState descriptor
  // self-consistency check when a component token appears in both `with` and
  // `optional`. 31 -> 32 minor evolution per AGENTS.md Error model evolution
  // contract.
  | 'query-descriptor-with-optional-conflict'
  // feat-20260602-drop-component-registration w16-a — scene instantiate
  // fail-fast when a SceneAsset entity names a component that was never defined
  // via defineComponent (the per-World register concept was dropped; a
  // component becomes globally usable the moment defineComponent runs). 30 ->
  // 31 minor evolution per AGENTS.md Error model evolution contract. Replaces
  // the deleted COMPONENT_NOT_REGISTERED code at the scene-instance producer
  // sites (research Finding 5 missed these 3 producers; human escalation-
  // response authorized this scope-amendment).
  | 'component-not-defined'
  // feat-20260602-archetype-stores-full-packed-entity M1 / w3 — removeComponent
  // rejection when the target is an essential (undeletable) component. The only
  // essential component is the id=0 `Entity` (plan-strategy D-3). Net +1 minor
  // evolution per AGENTS.md §Error model evolution contract.
  | 'remove-essential-component'
  // feat-20260608-scene-nesting-ecs-fication M1 / w9 — setSceneOverride
  // type-mismatch fail-fast (plan-strategy D-9). 30 -> 31 minor evolution per
  // AGENTS.md §Error model evolution contract. Surfaced from
  // `world.setSceneOverride(root, member, comp, field, value)` when `value`'s
  // runtime type does not match the per-component schema field type (the
  // override apply path never silently coerces — value writes are typed at the
  // ECS layer; requirements §Edge cases table last row, reviewer Issue 1).
  | 'scene-override-type-mismatch'
  // bug-20260615-spawn-data-unknown-field-fail-fast — spawn / addComponent /
  // SceneAsset.instantiate / Commands.spawn fail-fast when the caller-supplied
  // payload carries a key that is not declared in the component schema. Pre-
  // fix the unknown key was silently dropped by `fillComponentDefaults`
  // (which iterated only over schema keys), routing typos like
  // `MeshRenderer { material }` (singular legacy name) into the empty-default
  // path and producing invisible / mid-grey entities downstream. AI users
  // narrow on `.code` then read `.detail.field` for the offending key and
  // `.detail.knownFields` for the valid field whitelist.
  | 'spawn-data-unknown-field'
  // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M1 / w2 —
  // SpriteInstances primitive + tilemap terrain static-batch path. Three
  // codes declared together; fire path lands in M3 w13 at the
  // render-system-extract queryRun callback. Minor evolution +3 per
  // AGENTS.md §Error model evolution contract; plan-strategy D-6 keeps the
  // detection in the render domain (not the ECS spawn path) to avoid an
  // ECS -> AssetRegistry reverse dep for the shader-id lookup.
  | 'sprite-instances-count-mismatch'
  | 'sprite-instances-requires-sprite-shader'
  | 'sprite-instances-mutually-exclusive-with-instances';

/**
 * Discriminated `.detail` payload per `.code`.
 *
 * Narrowed via `switch (err.code)` against `EcsErrorCode`. Empty-detail entries
 * (legacy errors without `.detail`) are intentionally omitted from this map —
 * only the w5 family + `cyclic-injection` carry structured payloads today.
 */
export type EcsErrorDetail =
  | { readonly code: 'unique-ref-released'; readonly handle: number; readonly target: string }
  | {
      readonly code: 'unique-ref-double-release';
      readonly handle: number;
      readonly target: string;
    }
  // feat-20260614 M3 — SharedRefStore detail variants (+2).
  | { readonly code: 'shared-ref-released'; readonly handle: number; readonly target: string }
  | {
      readonly code: 'shared-ref-double-release';
      readonly handle: number;
      readonly target: string;
      readonly rc: number;
    }
  // feat-20260614 M6 D-15 — builtin-slot fail-fast detail variant (+1).
  | { readonly code: 'builtin-slot-not-owned'; readonly slot: number }
  // feat-20260623-asset-handle-generation M4 — stale error detail variants (+2).
  | {
      readonly code: 'shared-ref-stale';
      readonly slot: number;
      readonly expectedGeneration: number;
      readonly actualGeneration: number;
    }
  | {
      readonly code: 'unique-ref-stale';
      readonly slot: number;
      readonly expectedGeneration: number;
      readonly actualGeneration: number;
    }
  | { readonly code: 'managed-buffer-out-of-bounds'; readonly index: number; readonly size: number }
  | {
      readonly code: 'managed-buffer-shrink-not-supported';
      readonly requested: number;
      readonly current: number;
    }
  // feat-20260514 surviving managed-array-* discriminated detail variant (1).
  | {
      readonly code: 'managed-array-element-type-not-allowed';
      readonly fieldName: string;
      readonly elementType: string;
      readonly hint: string;
    }
  // feat-20260515-buffer-array-vocab-collapse w11 collapsed-vocab detail
  // variants (4). Per-code field names are SSOT-anchored at AC-07 + plan-
  // strategy §2.4 §detail-list (NOT renamed for "consistency" — name follows
  // semantics).
  | {
      readonly code: 'fixed-size-mismatch';
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly code: 'fixed-array-overflow';
      readonly capacity: number;
      readonly attemptedCount: number;
    }
  | {
      readonly code: 'array-pop-empty';
      readonly count: 0;
    }
  | {
      readonly code: 'instance-transforms-stride-mismatch';
      readonly actualLength: number;
      readonly expectedStride: 16;
    }
  // feat-20260519-light-casters-point-spot-pbr w2 — PointLight / SpotLight
  // spawn-time payload bound violation (plan-strategy D-S3 a). detail.field
  // three-branch ('range' | 'innerOuter' | 'outerNinety') keeps four bound
  // violations under one code; AI users narrow on `.detail.field` after the
  // outer `switch (err.code)` to pick the specific recovery hint.
  | {
      readonly code: 'spawn-light-invalid-bounds';
      readonly field: 'range' | 'innerOuter' | 'outerNinety';
      readonly got: number;
    }
  // feat-20260520-directional-light-shadow-mapping M1 / w1 — cardinality=1
  // component violation (plan-strategy D-3). detail carries the offending
  // component name + the observed count + the declared max so AI users can
  // narrow on `.code` then read `.detail.componentName` for the surface
  // identity of the violation.
  | {
      readonly code: 'cardinality-exceeded';
      readonly componentName: string;
      readonly count: number;
      readonly max: number;
    }
  // feat-20260520-2d-sprite-layer-mvp M-2 w13 — resource-setter bound
  // violation (plan-strategy D-4). receivedMode carries the rejected
  // payload number; receivedKey is optional so future resource
  // validators can share the same code while disambiguating which
  // resource produced the failure.
  | {
      readonly code: 'resource-invalid-value';
      readonly receivedMode: number;
      readonly receivedKey?: string;
    }
  // feat-20260521-sprite-atlas-animation M1 T-05 — sprite-animation tick
  // runtime invariant violation (plan-strategy D-1 + section 5 AC-09).
  // detail.field two-branch keeps the regions-length / frame-duration
  // invariants under one code; AI users narrow on `.detail.field` after
  // the outer `switch (err.code)` to pick the specific recovery hint
  // (charter P3 + P4). Two top-level variants give each `.field` branch
  // its own required sub-field shape so AI users get strong narrowing
  // inside `switch (err.detail.field)` without optional sub-fields
  // bleeding across branches.
  | {
      readonly code: 'sprite-animation-invalid';
      readonly field: 'regions-length';
      readonly regionsLength: number;
      readonly frameCount: number;
    }
  | {
      readonly code: 'sprite-animation-invalid';
      readonly field: 'frame-duration';
      readonly frameDuration: number;
    }
  // feat-20260531-ecs-relationship-abstraction-bidirectional-sync M2 — the 4
  // relationship-* discriminated detail variants (plan-strategy D-5). Each
  // carries the component name + the entities involved so AI users narrow on
  // `.code` then read `.detail` to locate the offending relationship surface.
  | {
      readonly code: 'relationship-self-cycle';
      readonly component: string;
      readonly entity: number;
      readonly ancestor: number;
    }
  | {
      readonly code: 'relationship-mirror-component-not-registered';
      readonly component: string;
      readonly mirror: string;
    }
  | {
      readonly code: 'relationship-mirror-field-type-mismatch';
      readonly component: string;
      readonly mirror: string;
      readonly field: string;
      readonly actualType: string;
    }
  | {
      readonly code: 'relationship-detach-mismatch';
      readonly component: string;
      readonly child: number;
      readonly expectedParent: number;
      readonly actualParent: number;
    }
  // feat-20260531-query-optional-components M1 — createQueryState descriptor
  // self-consistency (31 -> 32).
  | {
      readonly code: 'query-descriptor-with-optional-conflict';
      readonly tokenName: string;
    }
  // feat-20260602-drop-component-registration w16-a — scene instantiate
  // unknown-component fail-fast (30 -> 31). `.detail.name` carries the
  // component name that was never defined via defineComponent.
  | {
      readonly code: 'component-not-defined';
      readonly name: string;
    }
  // feat-20260602-archetype-stores-full-packed-entity M1 / w3 — removeComponent
  // essential-component rejection. `.detail.componentName` carries the essential
  // component name (the id=0 `Entity`).
  | {
      readonly code: 'remove-essential-component';
      readonly componentName: string;
    }
  // feat-20260608-scene-nesting-ecs-fication M1 / w9 — setSceneOverride
  // value-type rejection (plan-strategy D-9; requirements §Edge cases last
  // row + reviewer Issue 1). `.detail.comp` / `.detail.field` locate the
  // override target; `.detail.expectedType` carries the schema-declared
  // type literal (e.g. 'f32', 'bool', 'string'); `.detail.actualType`
  // carries the runtime `typeof value` (typed `unknown` because the
  // override write is not coerced — fail-fast surfaces the mismatch).
  | {
      readonly code: 'scene-override-type-mismatch';
      readonly comp: string;
      readonly field: string;
      readonly expectedType: string;
      readonly actualType: unknown;
    }
  // bug-20260615-spawn-data-unknown-field-fail-fast — spawn-data unknown-key
  // fail-fast. `.detail.component` names the schema's component, `.detail.field`
  // is the offending raw key, `.detail.knownFields` is the schema's full field
  // whitelist (sorted, used by AI users / hint formatters to surface "did you
  // mean" suggestions without round-tripping to the schema).
  | {
      readonly code: 'spawn-data-unknown-field';
      readonly component: string;
      readonly field: string;
      readonly knownFields: readonly string[];
    }
  // feat-20260625-sprite-instances-and-tilemap-terrain-static-batch M1 / w2 —
  // 3 discriminated detail variants for the SpriteInstances primitive
  // (declared in M1, fired at render-system-extract entry in M3).
  | {
      readonly code: 'sprite-instances-count-mismatch';
      readonly transformsLength: number;
      readonly regionsLength: number;
      readonly expectedStride: { readonly transforms: 16; readonly regions: 4 };
    }
  | {
      readonly code: 'sprite-instances-requires-sprite-shader';
      readonly entityId: number;
      readonly observedMaterialShaderId: string;
    }
  | {
      readonly code: 'sprite-instances-mutually-exclusive-with-instances';
      readonly entityId: number;
    };

// ────────────────────────────────────────────────────────────────────────────
// Layer-3 routing envelope (relocated from former managed-array-view.ts in
// feat-20260515-buffer-array-vocab-collapse w10; the value-shape view classes
// were deleted in favour of the direct TypedArray snapshot contract, but the
// shared error envelope remains the SSOT for `errorRouter` callbacks across
// the StringView + writeArrayField paths).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Layer-3 error envelope routed through `errorRouter` callbacks. Mirrors the
 * `EcsError` shape so AI users can branch on `.code`. `.detail` is intentionally
 * left as `unknown` here -- callers narrow it via the `EcsErrorDetail` discriminated
 * union when the envelope is forwarded to a structured error handler.
 */
export interface ManagedArrayErrorEnvelope {
  readonly code: EcsErrorCode;
  readonly hint: string;
  readonly expected: string;
  readonly detail: unknown;
}
