// @forgeax/engine-ecs — DAG Schedule: Kahn topological sort + cycle detection.
//
// addSystem registers a system + marks dirty. First update() triggers buildSchedule().
// Same in-degree systems ordered by addSystem call order (stable tie-breaker, D-05).

import { err, ok, type Result } from '@forgeax/engine-types';
import { type CommandBuffer, createCommandBuffer, flushCommands } from './commands';
import type { Component } from './component';
import {
  CyclicDependencyError,
  ScheduleMutationError,
  type SystemSetNotRegisteredError,
  systemSetNotRegistered,
} from './errors';
import type { ColumnBundle, NestedColumnBundle, QueryDescriptor, QueryState } from './query';
import { createQueryState, queryRun } from './query';
// type-only import: erases at build time, carries no runtime edge (same
// criterion as scripts/check-ecs-no-runtime-import.mjs). `world.ts` already
// value-imports `schedule.ts`; this back-reference is type-space only so no
// runtime cycle forms (plan-strategy D-1).
import type { ScheduleToken } from './schedule-token';
import type { World } from './world';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Severity + ErrorHandler (Layer 3 — AP-8)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Seven-level severity enum for error classification (AP-8 Layer 3).
 * Default is `Panic` (KD-2: fail-fast by default).
 * Ordered: Ignore < Trace < Debug < Info < Warning < Error < Panic.
 */
export const Severity = {
  Ignore: 0,
  Trace: 1,
  Debug: 2,
  Info: 3,
  Warning: 4,
  Error: 5,
  Panic: 6,
} as const;

export type SeverityLevel = (typeof Severity)[keyof typeof Severity];

/**
 * Error context passed to the ErrorHandler along with the error.
 */
export interface ErrorContext {
  /** Severity level of the error (default: Panic). */
  readonly severity: SeverityLevel;
  /** Name of the system that produced the error. */
  readonly systemName: string;
}

/**
 * ErrorHandler function signature. Called when a system returns a Result err
 * branch (`r.ok === false`) or ParamValidation returns 'invalid'.
 */
export type ErrorHandler = (error: unknown, context: ErrorContext) => void;

/**
 * Default error handler: dispatches by severity level.
 * Panic → throw, Error → console.error, Warning → console.warn,
 * Info → console.info, Debug/Trace → console.debug, Ignore → silent.
 */
export function matchSeverity(error: unknown, context: ErrorContext): void {
  switch (context.severity) {
    case Severity.Panic:
      throw error;
    case Severity.Error:
      console.error(`[${context.systemName}]`, error);
      break;
    case Severity.Warning:
      console.warn(`[${context.systemName}]`, error);
      break;
    case Severity.Info:
      // biome-ignore lint/suspicious/noConsole: matchSeverity routes errors to console by design
      console.info(`[${context.systemName}]`, error);
      break;
    case Severity.Debug:
    case Severity.Trace:
      // biome-ignore lint/suspicious/noConsole: matchSeverity routes errors to console by design
      console.debug(`[${context.systemName}]`, error);
      break;
    case Severity.Ignore:
      // Silent — do nothing
      break;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ParamValidation (Layer 2 — AP-8)
// ────────────────────────────────────────────────────────────────────────────

/**
 * ParamValidation three-state result for system parameter validation (AP-8 Layer 2).
 *
 * - `ok`: all params valid, system body executes.
 * - `skipped`: expected absence (e.g. query no match), body NOT executed, schedule continues.
 * - `invalid`: unexpected absence (e.g. Resource missing), body NOT executed, error collected.
 */
export type ParamValidation =
  | { readonly tag: 'ok' }
  | { readonly tag: 'skipped'; readonly reason: string }
  | { readonly tag: 'invalid'; readonly error: Error };

/**
 * System descriptor passed to `world.addSystem` — `fn` recovers per-query
 * bundle shapes mapped over `Qs`, no `as` casts required.
 *
 * `Qs` is the tuple of query descriptors; defaults to
 * `readonly QueryDescriptor[]` so non-generic call sites stay zero-modification
 * (KD-5). The `fn` first parameter is mapped over `Qs` so each
 * `queryResults[i]` recovers its own `NestedColumnBundle<Qs[i]['with']>` shape
 * (S-5, KD-2). `NoInfer<Qs[K]['with']>` blocks the callback body from feeding
 * back into `Qs` inference.
 *
 * @example
 * ```ts
 * // Single-query system — bundle fields recover per-component schema.
 * import { defineComponent, World } from '@forgeax/engine-ecs';
 *
 * const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
 * const Velocity = defineComponent('Velocity', { dx: 'f32', dy: 'f32' });
 *
 * const world = new World();
 * world.addSystem(Update, {
 *   name: 'movement',
 *   queries: [{ with: [Position, Velocity] }],
 *   fn: (_world, queryResults, _commands) => {
 *     for (const bundles of queryResults[0]) {
 *       // bundles.Position.x: Float32Array — directly usable, no `as` cast.
 *       const xs = bundles.Position.x;
 *       const dxs = bundles.Velocity.dx;
 *       for (let i = 0; i < bundles.Entity.self.length; i++) {
 *         // strict `noUncheckedIndexedAccess`: TypedArray index returns number | undefined
 *         xs[i] = (xs[i] ?? 0) + (dxs[i] ?? 0);
 *       }
 *     }
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Multi-query system — each queryResults[i] keeps its own bundle shape.
 * const Health = defineComponent('Health', { hp: 'f32' });
 * world.addSystem(Update, {
 *   name: 'multi',
 *   queries: [{ with: [Position] }, { with: [Health] }],
 *   fn: (_world, queryResults) => {
 *     // queryResults[0]: NestedColumnBundle<readonly [typeof Position]>[]
 *     // queryResults[1]: NestedColumnBundle<readonly [typeof Health]>[]
 *     for (const b of queryResults[0]) void b.Position.x;
 *     for (const b of queryResults[1]) void b.Health.hp;
 *   },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Commands-only system — `queries: []` is a legal form; fn receives `[]`.
 * world.addSystem(Update, {
 *   name: 'spawner',
 *   queries: [],
 *   fn: (_world, _queryResults, commands) => {
 *     commands.spawn({ component: Position, data: { x: 0, y: 0 } });
 *   },
 * });
 * ```
 */
export interface SystemDescriptor<
  Qs extends ReadonlyArray<QueryDescriptor> = ReadonlyArray<QueryDescriptor>,
> {
  /** Unique system name (used for before/after references). */
  readonly name: string;
  /** Query descriptors this system reads. */
  readonly queries: Qs;
  /**
   * System function — receives the World, resolved query results, and commands.
   *
   * @param world The owning World — read resources (`world.getResource(KEY)`),
   * resolve components by name, etc. without closure capture.
   * @param queryResults Mapped over `Qs`: `queryResults[i][j]` is a
   * `NestedColumnBundle<Qs[i]['with']>` with per-component TypedArray fields.
   * Direct access (`bundles.Position.x`) compiles without `as` casts.
   * @param commands Deferred-mutation buffer (flushed after the system).
   */
  readonly fn: (
    world: World,
    queryResults: {
      [K in keyof Qs]: Qs[K] extends QueryDescriptor<infer Cs extends ReadonlyArray<Component>>
        ? NestedColumnBundle<NoInfer<Cs>>[]
        : ColumnBundle[];
    },
    commands: CommandBuffer,
  ) => void | unknown;
  /** Run this system after named systems or the FixedUpdate anchor. */
  readonly after?: ReadonlyArray<string | ScheduleToken>;
  /** Run this system before named systems or the FixedUpdate anchor. */
  readonly before?: ReadonlyArray<string | ScheduleToken>;
  /** Required resource keys. Missing resource triggers 'invalid' validation (Layer 2). */
  readonly resources?: ReadonlyArray<string>;
  /**
   * Run condition. Evaluated each frame after ParamValidation passes (tag
   * 'ok') and before queryRun. Returning `false` skips the system silently —
   * no query runs, no fn call, no state added (plan-strategy D-8). Omitting it
   * (undefined) always runs the system.
   */
  readonly runIf?: (world: World) => boolean;
}

/**
 * A registered system token returned by {@link defineSystem}. Structurally the
 * frozen {@link SystemDescriptor} itself (plan-strategy D-6 — "define ==
 * register"). `world.addSystem(handle)` consumes it directly; the generic `Qs`
 * flows through so the `fn` first-query bundle shapes survive (S-5).
 */
export type SystemHandle<
  Qs extends ReadonlyArray<QueryDescriptor> = ReadonlyArray<QueryDescriptor>,
> = SystemDescriptor<Qs>;

/** Internal system record with registration index. */
interface SystemRecord {
  descriptor: SystemDescriptor;
  /** Registration order index (for tie-breaking). */
  registrationIndex: number;
  /** Cached QueryStates, one per query descriptor. Lazily initialized on first runSchedule. */
  queryStates: QueryState[] | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Schedule
// ────────────────────────────────────────────────────────────────────────────

/**
 * Per-set record in the Schedule. Created lazily on first addSystems /
 * configureSets call for a given set name.
 */
export interface SetRecord {
  /** Member system names (insertion-ordered, Set preserves add order). */
  readonly members: Set<string>;
  /** Names of sets that this set must run before. */
  readonly before: Set<string>;
  /** Names of sets that this set must run after. */
  readonly after: Set<string>;
  /** Snapshot of runIf from the defining token. */
  readonly runIf: ((world: import('./world').World) => boolean) | undefined;
  /** Snapshot of chained from the defining token. */
  readonly chained: boolean;
}

/** The Schedule manages system registration, DAG sorting, and execution. */
export interface Schedule {
  /** Owning token for scope-aware diagnostics. */
  readonly token: ScheduleToken;
  /** All registered systems by name. */
  systems: Map<string, SystemRecord>;
  /** Set records keyed by set name. Created lazily. */
  sets: Map<string, SetRecord>;
  /** Next registration index. */
  nextIndex: number;
  /** Whether the sorted order is stale. */
  dirty: boolean;
  /** Sorted system names after buildSchedule(). */
  sortedOrder: string[];
  /** Direct predecessor names derived while the DAG is built. */
  predecessors: Map<string, Set<string>>;
}

/** Create a fresh Schedule. */
export function createSchedule(token: ScheduleToken): Schedule {
  return {
    token,
    systems: new Map(),
    sets: new Map(),
    nextIndex: 0,
    dirty: true,
    sortedOrder: [],
    predecessors: new Map(),
  };
}

/**
 * Register a system. Marks schedule as dirty.
 * Query states are lazily initialized on first runSchedule (needs World for O-3 per-World ID).
 *
 * `const Qs` locks the `queries` tuple at the call site so `fn`'s first
 * parameter recovers per-query bundle shapes without `as const` annotations
 * (S-5, KD-2). `SystemRecord` itself is intentionally non-generic — the
 * heterogeneous `Qs` cannot be expressed inside the systems Map (KD-3).
 */
export function addSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
  schedule: Schedule,
  descriptor: SystemDescriptor<Qs>,
): void {
  const record: SystemRecord = {
    descriptor: descriptor as SystemDescriptor,
    registrationIndex: schedule.nextIndex++,
    queryStates: null, // Deferred: created in runSchedule when World is available
  };
  schedule.systems.set(descriptor.name, record);
  schedule.dirty = true;
}

// ────────────────────────────────────────────────────────────────────────────
// Global system registry (defineSystem — "define == register", plan-strategy D-6)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Global registry of all defined systems, keyed by system name.
 *
 * `defineSystem` writes here; `getRegisteredSystems` returns a read-only view.
 * Mirrors the `STATE_REGISTRY` pattern in `@forgeax/engine-state`.
 */
const SYSTEM_REGISTRY = new Map<string, SystemHandle>();

/**
 * Define a system at module level. Returns a frozen {@link SystemHandle} token
 * (the descriptor itself) and records it in the global registry under its name.
 *
 * `world.addSystem(handle)` consumes the token directly — no by-name overload
 * (OOS-8). Duplicate names silently overwrite (SYSTEM_REGISTRY.set, no guard),
 * matching `defineComponent` (OOS-3).
 *
 * `const Qs` locks the `queries` tuple so `fn`'s query-results parameter
 * recovers per-query bundle shapes without `as const` (S-5).
 *
 * @example
 * ```ts
 * const Move = defineSystem({
 *   name: 'movement',
 *   queries: [{ with: [Position, Velocity] }],
 *   fn: (_world, queryResults) => { ... },
 * });
 * world.addSystem(Move);
 * ```
 */
export function defineSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
  descriptor: SystemDescriptor<Qs>,
): SystemHandle<Qs> {
  const handle = Object.freeze(descriptor) as SystemHandle<Qs>;
  SYSTEM_REGISTRY.set(handle.name, handle as SystemHandle);
  return handle;
}

/**
 * Read-only snapshot of all systems defined via {@link defineSystem}, keyed by
 * name. The aux enumeration path is type-erased (`SystemHandle<any>` values) —
 * the heterogeneous `Qs` cannot be expressed inside one Map (KD-3).
 */
export function getRegisteredSystems(): ReadonlyMap<string, SystemHandle> {
  return SYSTEM_REGISTRY;
}

// ────────────────────────────────────────────────────────────────────────────
// SystemSet — nominal token + global registry (D-2c step 1, w2)
// ────────────────────────────────────────────────────────────────────────────

/** Brand symbol for {@link SystemSet}. Declared (not runtime-initialised) so
 * the token interface carries nominal identity without a runtime allocation.
 * Mirrors the `FORGEAX_STATE_BRAND` pattern in `@forgeax/engine-state`. */
declare const FORGEAX_SYSTEM_SET_BRAND: unique symbol;

/**
 * Opaque branded type for system-set tokens.
 *
 * Use {@link defineSystemSet} to create a token; never construct manually.
 * The {@link __forgeaxSystemSet} brand prevents plain-object assignment and
 * enables TypeScript narrowing at the two mutation entry points.
 */
export interface SystemSet {
  /** Brand — prevents structural compatibility with plain objects. */
  readonly __forgeaxSystemSet: typeof FORGEAX_SYSTEM_SET_BRAND;
  /** The user-supplied set name. */
  readonly name: string;
  /** Optional per-frame run condition. Consumed by M3 condition gate. */
  readonly runIf?: (world: import('./world').World) => boolean;
  /** Whether this set forms a sequential chain (M2). */
  readonly chained?: boolean;
}

/**
 * Global registry of all defined system sets, keyed by set name.
 *
 * `defineSystemSet` writes here; `getRegisteredSystemSets` returns a read-only
 * view. Mirrors the `SYSTEM_REGISTRY` / `STATE_REGISTRY` pattern.
 */
const SYSTEM_SET_REGISTRY = new Map<string, SystemSet>();

/**
 * Define a system set at module level. Returns a frozen branded token and
 * records it in the global registry under its name.
 *
 * Duplicate names silently overwrite (SYSTEM_SET_REGISTRY.set, no guard),
 * matching `defineSystem` / `defineComponent` (AGENTS.md §Component naming
 * "silent overwrite" convention). The old token becomes stale — identity
 * checks (`SYSTEM_SET_REGISTRY.get(name) === oldToken`) will reject it.
 *
 * @example
 * ```ts
 * const GameplaySet = defineSystemSet({ name: 'gameplay', runIf: (w) => !w.getResource<boolean>('paused') });
 * const OrderedSet = defineSystemSet({ name: 'ordered', chained: true });
 * ```
 */
export function defineSystemSet(opts: {
  readonly name: string;
  readonly runIf?: (world: import('./world').World) => boolean;
  readonly chained?: boolean;
}): SystemSet {
  const token: Record<string, unknown> = {
    __forgeaxSystemSet: undefined as unknown as typeof FORGEAX_SYSTEM_SET_BRAND,
    name: opts.name,
  };
  if (opts.runIf !== undefined) {
    token.runIf = opts.runIf;
  }
  if (opts.chained !== undefined) {
    token.chained = opts.chained;
  }
  const frozen = Object.freeze(token) as unknown as SystemSet;
  SYSTEM_SET_REGISTRY.set(opts.name, frozen);
  return frozen;
}

/**
 * Read-only snapshot of all system sets defined via {@link defineSystemSet},
 * keyed by name. Returns the live map — callers should not mutate the
 * returned reference.
 */
export function getRegisteredSystemSets(): ReadonlyMap<string, SystemSet> {
  return SYSTEM_SET_REGISTRY;
}

/**
 * Validate every token in `tokens` against the global registry via identity
 * check (`SYSTEM_SET_REGISTRY.get(token.name) === token`). Returns `ok(undefined)`
 * only when all tokens pass; the first failure produces a
 * `SystemSetNotRegisteredError` with the rejected token name and a
 * deterministic snapshot of current registry keys.
 *
 * Does not write any Schedule state — callers consume the `Result` and proceed
 * only on `ok`.
 */
export function validateSystemSetTokens(
  tokens: readonly SystemSet[],
): Result<void, SystemSetNotRegisteredError> {
  for (const token of tokens) {
    const current = SYSTEM_SET_REGISTRY.get(token.name);
    if (current !== token) {
      return err(systemSetNotRegistered(token.name, Array.from(SYSTEM_SET_REGISTRY.keys())));
    }
  }
  return ok(undefined);
}

/**
 * Remove a registered system by name (M2 — plan-strategy D-3).
 *
 * Drops the entry from `schedule.systems` and marks the schedule dirty so the
 * next `runSchedule` rebuilds the sorted order via Kahn topo. Cycle detection
 * already happens inside `buildSchedule`, so a removal that breaks an unrelated
 * `before/after` reference simply skips the unknown name (existing behaviour).
 *
 * Failure: name not registered → `Result.err(ScheduleMutationError)` with
 * `.code = 'system-before-unknown'` and `.detail.candidates` carrying the
 * registered names for AI-friendly typo recovery.
 */
export function removeSystem(
  schedule: Schedule,
  name: string,
): Result<void, ScheduleMutationError> {
  if (!schedule.systems.has(name)) {
    return err(
      new ScheduleMutationError(
        'system-before-unknown',
        `Cannot removeSystem: no system registered as "${name}".`,
        'Call world.inspect().systems to discover registered names.',
        { candidates: [...schedule.systems.keys()] },
      ),
    );
  }
  schedule.systems.delete(name);
  // Prune set membership: remove this system name from every set's members (D-1).
  for (const [, setRecord] of schedule.sets) {
    setRecord.members.delete(name);
  }
  schedule.dirty = true;
  return ok(undefined);
}

/**
 * Replace a registered system in-place (M2 — plan-strategy D-3 atomic semantics).
 *
 * Overwrites the `descriptor` field of the existing `SystemRecord` while
 * keeping `registrationIndex` and the `Map` slot identical, so all `before /
 * after` edges that reference this name remain bound to the same slot. Marks
 * the schedule dirty: the next `runSchedule` re-sorts.
 *
 * Failure: name not registered → `Result.err(ScheduleMutationError)` with
 * `.code = 'system-before-unknown'`.
 */
export function replaceSystem<const Qs extends ReadonlyArray<QueryDescriptor>>(
  schedule: Schedule,
  name: string,
  descriptor: SystemDescriptor<Qs>,
): Result<void, ScheduleMutationError> {
  const record = schedule.systems.get(name);
  if (!record) {
    return err(
      new ScheduleMutationError(
        'system-before-unknown',
        `Cannot replaceSystem: no system registered as "${name}".`,
        'Call world.inspect().systems to discover registered names; or addSystem(descriptor) to register a new system.',
        { candidates: [...schedule.systems.keys()] },
      ),
    );
  }
  record.descriptor = descriptor as SystemDescriptor;
  // Reset cached query states — descriptor.queries may have changed shape.
  record.queryStates = null;
  schedule.dirty = true;
  return ok(undefined);
}

/**
 * Batch-register systems to a set. Validates the set token before writing.
 *
 * - First call for a system name: registers via the existing `addSystem` path.
 * - Subsequent calls: only adds the system name to the set's members (dedup).
 * - `runIf` / `chained` are snapshotted from the token into the SetRecord on
 *   first encounter.
 *
 * Returns `Result.err` with `SystemSetNotRegisteredError` if the set token
 * fails identity validation.
 */
export function addSystems<const Qs extends ReadonlyArray<QueryDescriptor>>(
  schedule: Schedule,
  set: SystemSet,
  systems: ReadonlyArray<SystemDescriptor<Qs>>,
): Result<void, SystemSetNotRegisteredError> {
  const validated = validateSystemSetTokens([set]);
  if (!validated.ok) {
    return err(validated.error);
  }

  const setName = set.name;
  let record = schedule.sets.get(setName);
  if (!record) {
    record = {
      members: new Set(),
      before: new Set(),
      after: new Set(),
      runIf: set.runIf,
      chained: set.chained ?? false,
    };
    schedule.sets.set(setName, record);
  }

  for (const system of systems) {
    const name = system.name;
    // Dedup: only register the system once in schedule.systems.
    if (!schedule.systems.has(name)) {
      addSystem(schedule, system);
    }
    // Always add membership — multi-belong is supported.
    record.members.add(name);
  }

  schedule.dirty = true;
  return ok(undefined);
}

/**
 * Record set-level ordering constraints (M1 record layer only — no edge
 * expansion until M2's buildSchedule).
 *
 * Validates all input tokens (main set + before/after members) before
 * writing. On success, writes the before/after relationships into the
 * per-set record and marks the schedule dirty. On failure, writes nothing
 * (no partial record, no edges, no dirty).
 *
 * Returns `Result.err` with `SystemSetNotRegisteredError` if any token
 * fails identity validation.
 */
export function configureSets(
  schedule: Schedule,
  set: SystemSet,
  before?: readonly SystemSet[],
  after?: readonly SystemSet[],
): Result<void, SystemSetNotRegisteredError> {
  // Collect all tokens to validate.
  const allTokens: SystemSet[] = [set];
  if (before) {
    for (const b of before) allTokens.push(b);
  }
  if (after) {
    for (const a of after) allTokens.push(a);
  }

  const validated = validateSystemSetTokens(allTokens);
  if (!validated.ok) {
    return err(validated.error);
  }

  // Ensure a record exists for the main set.
  const setName = set.name;
  let record = schedule.sets.get(setName);
  if (!record) {
    record = {
      members: new Set(),
      before: new Set(),
      after: new Set(),
      runIf: set.runIf,
      chained: set.chained ?? false,
    };
    schedule.sets.set(setName, record);
  }

  // Record before/after edges (M1 only stores; M2 expands).
  if (before) {
    for (const b of before) {
      record.before.add(b.name);
      let targetRecord = schedule.sets.get(b.name);
      if (!targetRecord) {
        targetRecord = {
          members: new Set(),
          before: new Set(),
          after: new Set(),
          runIf: b.runIf,
          chained: b.chained ?? false,
        };
        schedule.sets.set(b.name, targetRecord);
      }
      targetRecord.after.add(setName);
    }
  }
  if (after) {
    for (const a of after) {
      record.after.add(a.name);
      let targetRecord = schedule.sets.get(a.name);
      if (!targetRecord) {
        targetRecord = {
          members: new Set(),
          before: new Set(),
          after: new Set(),
          runIf: a.runIf,
          chained: a.chained ?? false,
        };
        schedule.sets.set(a.name, targetRecord);
      }
      targetRecord.before.add(setName);
    }
  }

  schedule.dirty = true;
  return ok(undefined);
}

/**
 * Build the sorted execution order via Kahn's topological sort.
 * Throws CyclicDependencyError if a cycle is detected.
 *
 * @returns sorted system names
 */
export function buildSchedule(schedule: Schedule): string[] {
  const systems = schedule.systems;
  const names = [...systems.keys()];
  if (schedule.token.name === 'Update') names.push('FixedUpdate');
  const nameSet = new Set(names);

  // Build adjacency list + in-degree map.
  const adj = new Map<string, string[]>(); // adj[a] = [b] means a → b (a must run before b)
  const inDegree = new Map<string, number>();
  const predecessors = new Map<string, Set<string>>();

  for (const name of names) {
    adj.set(name, []);
    inDegree.set(name, 0);
    predecessors.set(name, new Set());
  }

  const addEdge = (source: string, target: string): void => {
    adj.get(source)?.push(target);
    predecessors.get(target)?.add(source);
    inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
  };
  const orderReferenceName = (reference: string | ScheduleToken): string =>
    typeof reference === 'string' ? reference : reference.name;

  for (const [name, record] of systems) {
    const desc = record.descriptor;

    // "after" constraints: for each dep in after, dep → name (dep runs before name)
    if (desc.after) {
      for (const reference of desc.after) {
        const dep = orderReferenceName(reference);
        if (!nameSet.has(dep)) continue; // scope validation handles cross-schedule references
        addEdge(dep, name);
      }
    }

    // "before" constraints: for each target in before, name → target (name runs before target)
    if (desc.before) {
      for (const reference of desc.before) {
        const target = orderReferenceName(reference);
        if (!nameSet.has(target)) continue; // scope validation handles cross-schedule references
        addEdge(name, target);
      }
    }
  }

  // ── Set-level edge expansion (M2) ──
  // Expand set before/after edges and chain edges into system-level edges.
  // This runs between the adjacency-list construction and Kahn's sort so the
  // existing cycle detection and stable tie-breaking apply unchanged.
  for (const [, setRecord] of schedule.sets) {
    // 1. Expand setA-before-setB edges: each member of setA must run before each member of setB
    for (const beforeName of setRecord.before) {
      const targetRecord = schedule.sets.get(beforeName);
      if (!targetRecord) continue; // skip unknown sets
      for (const srcMember of setRecord.members) {
        if (!nameSet.has(srcMember)) continue; // skip unknown systems
        for (const tgtMember of targetRecord.members) {
          if (!nameSet.has(tgtMember)) continue;
          // srcMember → tgtMember (srcMember runs before tgtMember)
          addEdge(srcMember, tgtMember);
        }
      }
    }

    // 2. Expand setA-after-setB edges: each member of setB must run before each member of setA
    for (const afterName of setRecord.after) {
      const targetRecord = schedule.sets.get(afterName);
      if (!targetRecord) continue;
      for (const tgtMember of targetRecord.members) {
        if (!nameSet.has(tgtMember)) continue;
        for (const srcMember of setRecord.members) {
          if (!nameSet.has(srcMember)) continue;
          // tgtMember → srcMember (tgtMember runs before srcMember)
          addEdge(tgtMember, srcMember);
        }
      }
    }

    // 3. Chain expansion: each consecutive pair of members in insertion order
    if (setRecord.chained) {
      const members = [...setRecord.members];
      for (let i = 0; i < members.length - 1; i++) {
        const m1 = members[i];
        const m2 = members[i + 1];
        if (!m1 || !m2 || !nameSet.has(m1) || !nameSet.has(m2)) continue;
        // m1 → m2 (m1 runs before m2)
        addEdge(m1, m2);
      }
    }
  }

  // Kahn's algorithm with registration-order tie-breaker.
  // Use a queue sorted by registrationIndex for deterministic ordering.
  const queue: string[] = [];
  for (const name of names) {
    if (inDegree.get(name) === 0) {
      queue.push(name);
    }
  }
  // Sort initial queue by registration index. The fixed anchor is intrinsic and
  // receives a deterministic slot after user systems with the same indegree.
  queue.sort(
    (a, b) =>
      (systems.get(a)?.registrationIndex ?? Number.MAX_SAFE_INTEGER) -
      (systems.get(b)?.registrationIndex ?? Number.MAX_SAFE_INTEGER),
  );

  const sorted: string[] = [];
  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: while(queue.length > 0) guarantees shift() returns a value
    const current = queue.shift()!;
    sorted.push(current);

    const neighbors = adj.get(current) ?? [];
    // Collect newly freed neighbors, then sort by registration index
    const freed: string[] = [];
    for (const neighbor of neighbors) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        freed.push(neighbor);
      }
    }
    freed.sort(
      (a, b) =>
        (systems.get(a)?.registrationIndex ?? Number.MAX_SAFE_INTEGER) -
        (systems.get(b)?.registrationIndex ?? Number.MAX_SAFE_INTEGER),
    );
    queue.push(...freed);
  }

  // Cycle detection: if we didn't process all nodes, there's a cycle.
  if (sorted.length < names.length) {
    // Find nodes still with in-degree > 0 (part of cycle).
    const remaining = names.filter((n) => !sorted.includes(n));
    const cyclePath = findCyclePath(remaining, adj);
    throw new CyclicDependencyError(cyclePath);
  }

  schedule.sortedOrder = sorted;
  schedule.predecessors = predecessors;
  schedule.dirty = false;
  return sorted;
}

/**
 * Find a cycle path among the remaining (unprocessed) nodes.
 * Returns the cycle as a readonly array of node names.
 */
function findCyclePath(remaining: string[], adj: Map<string, string[]>): readonly string[] {
  const remainSet = new Set(remaining);
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): readonly string[] | null {
    if (visited.has(node)) {
      // Found cycle: extract cycle from path
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart);
      cycle.push(node);
      return cycle;
    }
    visited.add(node);
    path.push(node);

    for (const neighbor of adj.get(node) ?? []) {
      if (!remainSet.has(neighbor)) continue;
      const result = dfs(neighbor);
      if (result) return result;
    }

    path.pop();
    return null;
  }

  for (const start of remaining) {
    visited.clear();
    path.length = 0;
    const result = dfs(start);
    if (result) return result;
  }

  /* istanbul ignore next -- fallback: DFS always finds cycle in remaining nodes */
  return remaining;
}

/** Interface for resource existence check (injected from World). */
export interface ResourceChecker {
  hasResource(key: string): boolean;
}

/**
 * Execute all systems in sorted order. Rebuilds schedule if dirty.
 * Each system receives its query results and a command buffer.
 * The world parameter provides the archetype graph, component ID resolution,
 * and resource checks.
 *
 * Layer 2 (ParamValidation): query empty → skip, resource missing → invalid.
 * Layer 3 (ErrorHandler): system fn returning a Result err branch → error handler.
 */
export function runSchedule(
  schedule: Schedule,
  world: World,
  errorHandler?: ErrorHandler,
  selectedNames?: readonly string[],
  commandsBySystem = new Map<string, ReturnType<typeof createCommandBuffer>>(),
  finalDrain = true,
): void {
  if (schedule.dirty) {
    buildSchedule(schedule);
  }
  const selected = selectedNames ? new Set(selectedNames) : undefined;

  // Build reverse map: system name → set names it belongs to (D-5).
  // Rebuilt each frame so removeSystem / replaceSystem membership changes
  // take effect on the next frame.
  const systemToSets = new Map<string, string[]>();
  for (const [setName, setRecord] of schedule.sets) {
    for (const memberName of setRecord.members) {
      if (schedule.systems.has(memberName)) {
        let list = systemToSets.get(memberName);
        if (!list) {
          list = [];
          systemToSets.set(memberName, list);
        }
        list.push(setName);
      }
    }
  }

  // Per-frame set runIf cache (D-5). Discarded at frame end — no cross-frame state.
  const setRunIfCache = new Map<string, boolean>();

  for (const name of schedule.sortedOrder) {
    if (selected && !selected.has(name)) continue;
    const record = schedule.systems.get(name);
    /* istanbul ignore next -- defensive: sortedOrder comes from systems Map keys */
    if (!record) continue;

    // Apply only buffers that have an explicit graph edge into this system.
    for (const predecessor of schedule.predecessors.get(name) ?? []) {
      const producerCommands = commandsBySystem.get(predecessor);
      if (producerCommands) flushCommands(producerCommands, world);
    }

    // Lazily initialize query states on first run (O-3: needs World for ID resolution).
    if (record.queryStates === null) {
      record.queryStates = record.descriptor.queries.map((q) => createQueryState(q));
    }

    // ── Layer 2: ParamValidation ──
    const validation = validateSystemParams(record, world);
    /* istanbul ignore next -- skipped path reserved for future Populated/Single query types */
    if (validation.tag === 'skipped') {
      // Expected absence — skip system body silently, continue to next system
      continue;
    }
    if (validation.tag === 'invalid') {
      // Unexpected absence — collect error via ErrorHandler
      if (errorHandler) {
        errorHandler(validation.error, {
          severity: Severity.Panic,
          systemName: name,
        });
      }
      continue;
    }

    // ── Set-level runIf AND gate (D-5) — evaluated after ParamValidation 'ok',
    // before system-level runIf. Each set's runIf is lazily cached per frame. ──
    const setNames = systemToSets.get(name);
    let allSetConditionsPass = true;
    if (setNames) {
      for (const setName of setNames) {
        const setRecord = schedule.sets.get(setName);
        if (setRecord?.runIf) {
          let cached = setRunIfCache.get(setName);
          if (cached === undefined) {
            cached = setRecord.runIf(world);
            setRunIfCache.set(setName, cached);
          }
          if (!cached) {
            allSetConditionsPass = false;
            break;
          }
        }
      }
    }
    if (!allSetConditionsPass) {
      continue; // skip system: no system runIf, no queryRun, no fn
    }

    // ── Run condition (runIf) — evaluated after ParamValidation 'ok', before
    // queryRun. false → skip silently (no query, no fn, no state) (D-8). ──
    if (record.descriptor.runIf && !record.descriptor.runIf(world)) {
      continue;
    }

    // Run each query and collect results
    const queryResults: ColumnBundle[][] = [];
    for (const qs of record.queryStates) {
      const bundles: ColumnBundle[] = [];
      queryRun(qs, world, (bundle) => bundles.push(bundle));
      queryResults.push(bundles);
    }

    // ── Layer 3: system execution + Result collection ──
    // trusted-cast: F-R2 single-direction; runtime correctness guaranteed by buildColumnBundle
    const commands = createCommandBuffer(world);
    commandsBySystem.set(name, commands);
    const returnValue = record.descriptor.fn(
      world,
      queryResults as Parameters<typeof record.descriptor.fn>[1],
      commands,
    );

    // If system fn returns a Result with err, invoke ErrorHandler
    if (returnValue && typeof returnValue === 'object' && 'ok' in (returnValue as object)) {
      const result = returnValue as { ok: boolean; error?: unknown };
      if (result.ok === false && result.error !== undefined) {
        if (errorHandler) {
          errorHandler(result.error, {
            severity: Severity.Panic,
            systemName: name,
          });
        }
      }
    }
    // void return → treated as ok, ErrorHandler not called
  }

  if (finalDrain) {
    // A schedule boundary drains every remaining buffer, including commands
    // enqueued by lifecycle hooks while another command is being applied.
    for (const commands of commandsBySystem.values()) {
      flushCommands(commands, world);
    }
  }
}

/**
 * Validate system parameters before execution (Layer 2).
 * - Query empty match → ok (Bevy: Query is always Ok; skip is for Populated/Single — not yet in forgeax).
 * - All required resources must exist; otherwise → invalid.
 *
 * Note: "query empty → skipped" path is available via the ParamValidation type
 * but not auto-triggered for plain queries. Future extensions (Populated, Single)
 * will use the skipped path.
 */
function validateSystemParams(record: SystemRecord, world: ResourceChecker): ParamValidation {
  // Check required resources
  if (record.descriptor.resources) {
    for (const key of record.descriptor.resources) {
      if (!world.hasResource(key)) {
        return {
          tag: 'invalid',
          error: new Error(
            `Required resource "${key}" not found for system "${record.descriptor.name}".`,
          ),
        };
      }
    }
  }

  return { tag: 'ok' };
}
