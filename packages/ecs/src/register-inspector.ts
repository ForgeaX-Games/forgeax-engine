// register-inspector - Pure-function ECS inspector contributor (plan-tasks.json
// w4eb + plan-strategy §2.6 + AC-10).
//
// Top-level pure function `registerEcsInspector(reg, world)` registers four
// JSON-RPC methods (entities / components / systems / resources) onto a
// Registry interface from `@forgeax/engine-types`. Behaviour migrated
// verbatim from the byte-frozen literals in
// `@forgeax/engine-console/src/inspect-scripts.ts` so the inspect CLI 6
// target literal diff stays empty (AC-12).
//
// charter: proposition 1 (single registration entry per domain) +
// proposition 3 (Result<void, InspectorError>) + proposition 4 (explicit
// fail-fast on duplicate via 'console-startup-failed' — §2.5; never throw)
// + proposition 5 (consistent abstraction — Handler signature shared with
// the runtime / pack / gltf contributor families).
//
// Pipeline isolation (architecture-principles #4): this module imports
// only `@forgeax/engine-types` (interface SSOT) and the local ECS
// `World`; it never reaches into the `@forgeax/engine-console` runtime
// class. The Registry parameter is structurally typed so downstream tests
// may substitute a fake registry.

import type { Handler, RegisterMethodResult, Registry } from '@forgeax/engine-types';
import { ECS_MUTATING_METHODS } from './mutating-methods';
import type { World } from './world';

/**
 * Result alias for `registerEcsInspector`. Mirrors `RegisterMethodResult`
 * from `@forgeax/engine-types` — same `Result<void, InspectorError>` shape
 * as `Registry.registerMethod` and the in-process console runtime;
 * declared here only so the public function signature reads naturally.
 */
export type RegisterEcsInspectorResult = RegisterMethodResult;

/**
 * Register the four ECS inspection methods on a Registry instance.
 *
 * Methods registered (in order):
 * - `entities`   : returns `world.inspect()` archetype + entity count summary
 * - `components` : registered component name list with archetype/entity rollup
 * - `systems`    : system count + name list (registration order)
 * - `resources`  : resource key list
 *
 * Same-name duplicate fails fast on the first conflict and returns
 * `Result.err(InspectorError)` with `code: 'console-startup-failed'`. No
 * partial registration leaks: if `entities` succeeds but `components`
 * fails, callers should construct a fresh `new Registry()` to retry
 * (plan-strategy §3.3 error path 1).
 *
 * @example Host assembly (plan-strategy §3.3 success path)
 * ```ts
 * import { Registry, startConsoleServer } from '@forgeax/engine-console';
 * import { registerEcsInspector } from '@forgeax/engine-ecs';
 *
 * const reg = new Registry();
 * const r = registerEcsInspector(reg, world);
 * if (!r.ok) { console.error(r.error); process.exit(1); }
 * await startConsoleServer({ port: 5732, registry: reg });
 * ```
 *
 * @param reg   `Registry` instance from `@forgeax/engine-console` (or any
 *              implementation of the `Registry` interface in
 *              `@forgeax/engine-types`).
 * @param world `World` whose live state the four handlers expose. The
 *              handlers call `world.inspect()` lazily on each invocation,
 *              so the binding sees post-mutation state without re-register.
 */
export function registerEcsInspector(reg: Registry, world: World): RegisterEcsInspectorResult {
  const entitiesHandler: Handler = () => {
    const inspection = world.inspect();
    return {
      entityCount: inspection.entityCount,
      archetypeCount: inspection.archetypes.length,
      archetypes: inspection.archetypes.map((a) => ({
        key: a.key,
        componentNames: a.componentNames,
        entityCount: a.entityCount,
      })),
    };
  };
  const componentsHandler: Handler = () => {
    const inspection = world.inspect();
    const perComponent = new Map<
      string,
      { name: string; archetypeCount: number; entityCount: number }
    >();
    for (const name of inspection.activeComponents) {
      perComponent.set(name, { name, archetypeCount: 0, entityCount: 0 });
    }
    for (const a of inspection.archetypes) {
      for (const name of a.componentNames) {
        let entry = perComponent.get(name);
        if (entry === undefined) {
          entry = { name, archetypeCount: 0, entityCount: 0 };
          perComponent.set(name, entry);
        }
        entry.archetypeCount += 1;
        entry.entityCount += a.entityCount;
      }
    }
    return {
      componentCount: inspection.activeComponents.length,
      components: Array.from(perComponent.values()),
    };
  };
  const systemsHandler: Handler = () => {
    const inspection = world.inspect();
    return {
      systemCount: inspection.systemCount,
      systems: inspection.systems,
    };
  };
  const resourcesHandler: Handler = () => {
    const inspection = world.inspect();
    return {
      resourceCount: inspection.resourceKeys.length,
      resourceKeys: inspection.resourceKeys,
    };
  };

  const r1 = reg.registerMethod('entities', entitiesHandler);
  if (!r1.ok) return r1;
  const r2 = reg.registerMethod('components', componentsHandler);
  if (!r2.ok) return r2;
  const r3 = reg.registerMethod('systems', systemsHandler);
  if (!r3.ok) return r3;
  const r4 = reg.registerMethod('resources', resourcesHandler);
  if (!r4.ok) return r4;
  // Third step (feat-20260517 D-2 / w13): contribute the ECS write-method
  // SSOT to the merged sandbox blacklist. The merged set is consulted
  // wrap-time by `@forgeax/engine-console/src/sandbox.ts` so a `world.spawn`
  // call inside an inspector script body surfaces `inspector-write-denied`.
  const r5 = reg.registerMutatingMethods(ECS_MUTATING_METHODS);
  if (!r5.ok) return r5;
  return { ok: true, value: undefined };
}
