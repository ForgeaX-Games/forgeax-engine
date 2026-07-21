// @forgeax/engine-ecs — typed error class collection.
//
// Typed error classes covering all boundary conditions. Each follows progressive
// disclosure format: one-line summary → context fields → hint fix suggestion.
// Each exposes a `.hint` readonly property for programmatic extraction.

// ────────────────────────────────────────────────────────────────────────────
// Re-exports from split error sub-files (w3-b — package cohesion split)
// ────────────────────────────────────────────────────────────────────────────

export {
  ComponentNotDefinedError,
  QueryCombinationsEntityRequiredError,
  QueryDescriptorOptionalConflictError,
  RemoveEssentialComponentError,
  SpawnDataUnknownFieldError,
} from './errors/query-and-component-errors';

export {
  RelationshipDetachMismatchError,
  RelationshipMirrorComponentNotRegisteredError,
  RelationshipMirrorFieldTypeMismatchError,
  RelationshipSelfCycleError,
} from './errors/relationship-errors';
export {
  SharedFieldInvalidValueError,
  SpriteInstancesCountMismatchError,
  SpriteInstancesMutuallyExclusiveWithInstancesError,
  SpriteInstancesRequiresSpriteShaderError,
} from './errors/sprite-and-shared-errors';
export {
  CardinalityExceededError,
  ResourceInvalidValueError,
  SpawnLightInvalidBoundsError,
  SpriteAnimationInvalidError,
} from './errors/validation-errors';

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
 * `.detail` — `{ code: 'cyclic-dependency'; cycle: readonly string[] }` contains the
 *    structured cycle path for programmatic consumption.
 */
export class CyclicDependencyError extends Error {
  override readonly name = 'CyclicDependencyError';
  readonly code = 'cyclic-dependency' as const;
  readonly hint: string;
  /** Structured cycle path — programmatic consumers read this, not the message. */
  readonly detail: { readonly code: 'cyclic-dependency'; readonly cycle: readonly string[] };

  constructor(cycle: readonly string[]) {
    const cycleStr = cycle.join(' -> ');
    const hint = `Cycle path: ${cycleStr}. Remove one ordering constraint to break the cycle.`;
    super(`DAG Schedule has a cyclic dependency.\n  cycle: ${cycleStr}\n  hint: ${hint}`);
    this.hint = hint;
    this.detail = { code: 'cyclic-dependency' as const, cycle };
  }
}

/**
 * Returned via `Result.err` from `world.addSystems` / `world.configureSets`
 * when a SystemSet token fails identity validation against the global registry.
 *
 * The sole public invalid-token error type (D-2a). Covers all rejection
 * scenarios: plain-object cast, unregistered name, stale token after
 * overwrite, and cross-realm copies.
 *
 * `.code = 'system-set-not-registered'`
 * `.expected` — the name of the unregistered token.
 * `.hint` — suggests calling `getRegisteredSystemSets()` and re-importing the current token.
 * `.detail` — `{ code, name, registered }` where `registered` is a deterministic snapshot
 *    of the current registry keys.
 */
export class SystemSetNotRegisteredError extends Error {
  override readonly name = 'SystemSetNotRegisteredError';
  readonly code = 'system-set-not-registered' as const;
  /** The name carried by the rejected token. */
  readonly expected: string;
  readonly hint: string;
  /** Deterministic snapshot of the current registry for AI-user self-repair. */
  readonly detail: {
    readonly code: 'system-set-not-registered';
    readonly name: string;
    readonly registered: readonly string[];
  };

  constructor(name: string, registered: readonly string[]) {
    const hint =
      `SystemSet "${name}" is not in the current registry. ` +
      `Call getRegisteredSystemSets() to enumerate valid sets, then re-import or re-define the token.`;
    const message =
      `SystemSet "${name}" is not registered.\n` +
      `  expected: ${name}\n` +
      `  registered: [${registered.join(', ')}]\n` +
      `  hint: ${hint}`;
    super(message);
    this.expected = name;
    this.hint = hint;
    this.detail = { code: 'system-set-not-registered' as const, name, registered };
  }
}

/**
 * Factory for {@link SystemSetNotRegisteredError}. Consumed by
 * {@link validateSystemSetTokens} (w4) and the two mutation entry points.
 */
export function systemSetNotRegistered(
  name: string,
  registered: readonly string[],
): SystemSetNotRegisteredError {
  return new SystemSetNotRegisteredError(name, registered);
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

/**
 * Thrown when insertResource/removeResource is called on a World-owned
 * protected resource (Time or FixedTime).
 *
 * `.code = 'resource-protected'`
 * `.hint` — suggests using `world.update(delta)` or reading the resource.
 * `.expected` — the resource name that was rejected.
 */
export class ProtectedResourceError extends Error {
  override readonly name = 'ProtectedResourceError';
  readonly code = 'resource-protected' as const;
  readonly hint: string;
  readonly expected: string;

  constructor(resourceName: string, operation: 'insert' | 'remove') {
    const hint =
      operation === 'insert'
        ? `"${resourceName}" is a World-owned protected resource. It is advanced by world.update(delta); read it via world.getResource(${resourceName}).`
        : `"${resourceName}" is a World-owned protected resource. It is owned by the World scheduler and cannot be removed.`;
    const expected = `a user-owned resource key (not ${resourceName})`;
    super(
      `Protected resource "${resourceName}" cannot be ${operation}ed.\n` +
        `  code: resource-protected\n` +
        `  resource: ${resourceName}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
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
// EcsErrorCode closed union (w5)
//
// Merges every `.code` literal across the EcsError family. Downstream
// `switch (err.code)` blocks become exhaustive; `assertNever(code)` catches
// any future code addition without a matching case at compile time.
//
// Order is grouped (legacy SCREAMING_SNAKE first, then closed-set kebab) but
// not load-bearing — TS unions are unordered.
// ────────────────────────────────────────────────────────────────────────────

export class TimeDeltaInvalidError extends Error {
  override readonly name = 'TimeDeltaInvalidError';
  readonly code = 'time-delta-invalid' as const;
  readonly expected = 'a finite delta greater than or equal to 0';
  readonly hint = 'Call world.update(deltaSeconds) with a finite non-negative delta.';
  readonly detail: { readonly received: number };

  constructor(received: number) {
    super(
      `Invalid world.update delta: ${received}.\n  expected: a finite delta greater than or equal to 0\n  hint: Call world.update(deltaSeconds) with a finite non-negative delta.`,
    );
    this.detail = { received };
  }
}

export class TimeConfigInvalidError extends Error {
  override readonly name = 'TimeConfigInvalidError';
  readonly code = 'time-config-invalid' as const;
  readonly expected: string;
  readonly hint = 'Increase maxDeltaSeconds or decrease maxStepsPerUpdate or fixedDeltaSeconds.';
  readonly detail: {
    readonly fixedDeltaSeconds: number;
    readonly maxStepsPerUpdate: number;
    readonly maxDeltaSeconds: number;
  };

  constructor(detail: TimeConfigInvalidError['detail']) {
    const expected = 'maxDeltaSeconds >= (maxStepsPerUpdate + 1) * fixedDeltaSeconds';
    super(
      `Invalid World time policy.\n  expected: ${expected}\n  hint: Increase maxDeltaSeconds or decrease maxStepsPerUpdate or fixedDeltaSeconds.`,
    );
    this.expected = expected;
    this.detail = detail;
  }
}

export class ScheduleScopeMismatchError extends Error {
  override readonly name = 'ScheduleScopeMismatchError';
  readonly code = 'schedule-scope-mismatch' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly sourceSchedule: string;
    readonly targetSchedule: string;
    readonly reference?: string;
  };

  constructor(sourceSchedule: string, targetSchedule: string, reference?: string) {
    const expected = `a reference owned by ${sourceSchedule}`;
    const hint = `The referenced item belongs to ${targetSchedule}; register and order it in ${sourceSchedule}.`;
    super(`Schedule scope mismatch.\n  expected: ${expected}\n  hint: ${hint}`);
    this.expected = expected;
    this.hint = hint;
    this.detail = { sourceSchedule, targetSchedule, ...(reference ? { reference } : {}) };
  }
}

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
  // ECS time and schedule-scope errors (M2 w16, approved 43 -> 46 baseline; verify hotfix +1 → 47).
  | 'time-delta-invalid'
  | 'time-config-invalid'
  | 'schedule-scope-mismatch'
  | 'resource-protected'
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
  | 'sprite-instances-mutually-exclusive-with-instances'
  // solo bevy-examples round 20260713-194533 — queryCombinations requires the
  // Entity component in the query's `with` list (the entity handle is the unit
  // it yields per combination). Minor evolution +1 per AGENTS.md §Error model
  // evolution contract; fail-fast at the queryCombinations entry (mirrors
  // query-descriptor-with-optional-conflict's setup-time self-consistency shape).
  | 'query-combinations-entity-required'
  // feat-20260713-mount-override-component-add-and-shared-ref-round M2 / w9 —
  // P3 shared-field value gate. A `shared<T>` scalar or `array<shared<T>>`
  // element must be a resolved numeric Handle; a raw GUID string / `{ guid }` /
  // `{ kind }` object (the pre-resolution shape an AI user gets from a sidecar)
  // was silently coerced to the all-zero sentinel by the column packer
  // (`typed[i] = typeof val === 'number' ? val : 0`) / scalar write, so a
  // mis-bound reference read back as `0` / `[0,0,0,0]` and rendered blank with
  // no error. `validateComponentDataKeys` only checks key names, not value
  // types — this code closes the value-type gap at all three write entries
  // (spawn / addComponent / set). AI users resolve a GUID via
  // `loadByGuid + allocSharedRef` first; passing the raw GUID now fails fast.
  // Minor evolution +1 per AGENTS.md §Error model evolution contract.
  | 'shared-field-invalid-value'
  // feat-20260714-bevy-style-system-sets M1 / w3 — sole invalid-SystemSet
  // error code. Surfaced from world.addSystems / world.configureSets when a
  // token fails identity validation (brand bypass + registry identity check).
  // Minor evolution +1 per AGENTS.md §Error model evolution contract.
  | 'system-set-not-registered';

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
    }
  // solo bevy-examples round 20260713-194533 — queryCombinations called with a
  // state whose `with` list omits the Entity component. `.detail.withNames`
  // carries the descriptor's declared component names so the AI user sees what
  // was passed and adds `Entity` to it.
  | {
      readonly code: 'query-combinations-entity-required';
      readonly withNames: readonly string[];
    }
  // feat-20260713-mount-override-component-add-and-shared-ref-round M2 / w9 —
  // shared-field value gate. `.detail.component` / `.detail.field` locate the
  // shared reference field; `.detail.fieldType` is the schema-declared type
  // literal (`shared<T>` scalar or `array<shared<T>>`); `.detail.actualValue`
  // is the offending non-handle value (typed `unknown` — a raw GUID string /
  // `{ guid }` / `{ kind }` object is not coerced, the fail-fast surfaces it);
  // `.detail.index` is the array element index for the array form (undefined for
  // the scalar form). AI users read `.detail.field` + `.detail.fieldType` to see
  // which reference needs `loadByGuid + allocSharedRef` before binding.
  | {
      readonly code: 'shared-field-invalid-value';
      readonly component: string;
      readonly field: string;
      readonly fieldType: string;
      readonly actualValue: unknown;
      readonly index?: number;
    }
  // feat-20260714-bevy-style-system-sets M1 / w3 — invalid-SystemSet detail.
  // `.detail.name` is the rejected token name; `.detail.registered` is a
  // deterministic snapshot of the current registry keys.
  | {
      readonly code: 'system-set-not-registered';
      readonly name: string;
      readonly registered: readonly string[];
    }
  // feat-20260714-bevy-style-system-sets M2 / w12 — structured cyclic-dependency
  // detail. `.detail.cycle` is the ordered cycle path array; consumers read
  // this instead of parsing the message string.
  | {
      readonly code: 'cyclic-dependency';
      readonly cycle: readonly string[];
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
