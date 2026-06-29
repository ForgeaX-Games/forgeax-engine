// @forgeax/engine-console/src/sandbox - alpha-mode read-only Proxy
// (feat-20260516 dependency-inversion + feat-20260517 D-2 Registry-driven
// mutating-method blacklist).
//
// Why alpha mode (vs naive object-level apply trap):
//   `worldProxy.spawn(arg)` resolves per ECMA-262 as:
//     ref = [[Get]](worldProxy, propertyName)
//     Call(ref, worldProxy, [arg])
//   The function `ref` is `World.prototype.spawn` itself - *not* a Proxy.
//   An object-level apply trap NEVER fires here (research g4 source ECMA-262
//   + MDN). We therefore install the apply trap on the *function* returned
//   from the get-trap when its name lives in the merged mutating-method set
//   (generic JS containers + every ECS-domain set contributed via
//   `Registry.registerMutatingMethods`). The next [[Call]] in the evaluation
//   rule then triggers the apply trap and throws.
//
// Mutating-method vocabulary:
//   - `MUTATION_BLACKLIST` (this file) - generic JS container surface only
//     (Array/Map/Set writers + the cross-surface 'set' / 'clear' / 'delete'
//     accessors). 9 names total; vocabulary is deliberately ECS-free so
//     console keeps zero conceptual coupling to renderer-side packages
//     (charter P5 + AC-01 4-deny-list).
//   - ECS-domain mutating methods are contributed at host-assembly time via
//     `registerEcsInspector(reg, world)` calling
//     `reg.registerMutatingMethods(ECS_MUTATING_METHODS)`; the SSOT for the
//     ECS list lives in `@forgeax/engine-ecs/src/mutating-methods.ts`. The
//     wrap-time call to `reg.lookupMutatingMethods()` (research F6: V8
//     hash-Set O(1) hit, no per-method-call cost) merges every contributor's
//     frozen Set into a single closure-cached reference.
//
// charter: proposition 4 (explicit failure - every mutation routes through
// the closed InspectorError union) + proposition 5 (consistent abstraction -
// `wrapReadOnly` works uniformly across plain objects / Array / Map /
// TypedArray / class instances / domain-supplied surfaces).

import { InspectorError } from './errors';

/**
 * Generic JS-container mutation method names intercepted by the alpha-mode
 * get-trap regardless of which Registry is wired. The set is intentionally
 * ECS-free; ECS-domain mutating method names enter the trap at wrap-time
 * via `Registry.lookupMutatingMethods()` (feat-20260517 D-2).
 *
 * 9 entries: 7 Array.prototype writers (push/pop/shift/unshift/splice/sort/
 * reverse) + the 'set' Map.prototype writer + the cross-surface 'clear' and
 * 'delete' (Map / Set / cross-domain). The cross-surface names also cover
 * the ECS World container's `clear` / `delete` semantics by string match,
 * which is intentional (charter P5 - one vocabulary across containers).
 *
 * The set is *not* `Object.freeze`d at runtime because freezing has
 * measurable cost on Set lookups and the compile-time `ReadonlySet<string>`
 * already guards source-level mutation attempts.
 */
export const MUTATION_BLACKLIST: ReadonlySet<string> = new Set<string>([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'set',
  'clear',
  'delete',
]);

/**
 * Minimal Registry shape the sandbox depends on - matches the
 * `lookupMutatingMethods(): ReadonlySet<string>` slice of
 * `@forgeax/engine-types#Registry`. Declared structurally so the sandbox
 * stays free of value-imports from the Registry runtime class (charter P5
 * + AC-01 4-deny-list mirrored from check-console-not-import-engine.mjs).
 */
export interface MutatingMethodLookup {
  lookupMutatingMethods(): ReadonlySet<string>;
}

function denial(attemptedMethod?: string): InspectorError {
  return new InspectorError({
    code: 'inspector-write-denied',
    expected: 'world / engine / assets context is read-only in P0',
    hint:
      attemptedMethod !== undefined
        ? `write API is deferred to feat-future-inspector-write-api (asset-system-v1 loop / todo-079); attempted method: ${attemptedMethod}`
        : 'write API is deferred to feat-future-inspector-write-api (asset-system-v1 loop / todo-079); use inspect / script / eval for read-only introspection only',
  });
}

/**
 * Wrap a target object in an alpha-mode read-only Proxy. The wrapper has
 * three trap surfaces:
 *
 *   - `set`            : throws `inspector-write-denied` (covers
 *                        `proxy.field = value` assignments).
 *   - `deleteProperty` : throws `inspector-write-denied` (covers `delete
 *                        proxy.field`).
 *   - `get`            : passthrough via `Reflect.get(target, prop,
 *                        receiver)` for non-mutation property reads;
 *                        for property names in the merged mutating-method
 *                        set (generic blacklist union with the registry-
 *                        supplied set looked up once per wrap), the
 *                        returned function is wrapped in a function-level
 *                        Proxy whose `apply` trap throws.
 *
 * Non-mutation methods (e.g. `world.inspect()` / `array.map(...)` /
 * `map.entries()`) pass through unchanged with their `this` binding intact
 * (Reflect.get receiver semantics; g4 source §this-binding pitfall).
 *
 * @param target - object to wrap; primitives / functions short-circuit.
 * @param registry - optional Registry whose `lookupMutatingMethods()`
 *   contributes domain-specific mutating-method names (e.g. ECS spawn /
 *   despawn / flush). Omitted: only the generic 9-name blacklist applies.
 *   Passed once per top-level wrap; nested wraps reuse the same closure-
 *   cached merged Set (research F6 V8 O(1) lookup).
 */
function makeWrapper(merged: ReadonlySet<string>): <T extends object>(target: T) => T {
  const cache = new WeakMap<object, object>();
  function wrap<T extends object>(target: T): T {
    const cached = cache.get(target);
    if (cached !== undefined) return cached as T;
    const proxy = new Proxy(target, {
      get(t: T, prop: string | symbol, _receiver: unknown): unknown {
        // Read directly from the target with `t` as receiver. Forwarding the
        // proxy as receiver (Reflect.get's third arg) breaks internal-slot
        // methods on built-ins like Map / Set / TypedArray (TypeError "called
        // on incompatible receiver") because those rely on private slots
        // present only on the raw object. The g4 source §this-binding pitfall
        // documents this trade-off: receiver forwarding gives accessor support
        // on POJOs at the cost of internal-slot breakage on built-ins. For
        // P0 (charter P5: works uniformly across kinds) we choose
        // raw-receiver passthrough; accessor-heavy POJO patterns are not in
        // the inspector hot path (world / engine / assets are class instances
        // whose methods rebind `this` themselves via the function-level Proxy
        // below).
        const raw = Reflect.get(t, prop);
        // Only mutation method *names* (string) match the merged set.
        // Symbol properties (Symbol.iterator etc.) pass through.
        if (typeof prop === 'string' && typeof raw === 'function' && merged.has(prop)) {
          // Wrap the function in a function-level Proxy. The apply trap fires
          // on the next [[Call]] (alpha pattern; ECMA-262 + MDN).
          const fn = raw as (...args: unknown[]) => unknown;
          return new Proxy(fn, {
            apply(): never {
              throw denial(prop);
            },
          });
        }
        // Bind non-mutation methods back to the raw target so internal-slot
        // built-ins (Map.prototype.entries, TypedArray getters, etc.) execute
        // with the correct `this`. Non-built-ins receive an already-bound
        // function and behave identically.
        if (typeof raw === 'function') {
          const fn = raw as (...args: unknown[]) => unknown;
          return fn.bind(t);
        }
        // Recursive wrapping: wrap nested object-valued reads in the same
        // read-only Proxy so AI users writing `engine.assets.register(...)`
        // hit the apply-trap denial on the nested call rather than the raw
        // mutation propagating through. Cached via the closure-local
        // WeakMap so repeated reads return the same Proxy identity.
        if (raw !== null && typeof raw === 'object') {
          return wrap(raw as object);
        }
        return raw;
      },
      set(_t: T, _prop: string | symbol, _value: unknown, _receiver: unknown): never {
        // Throwing here (rather than `return false`) routes through the
        // closed InspectorError union and survives strict-mode evaluation.
        // ECMA-262 §9.5.x: the proxy invariant for `set` is satisfied by
        // throwing - the operation observably aborts.
        throw denial();
      },
      deleteProperty(_t: T, _prop: string | symbol): never {
        throw denial();
      },
    }) as T;
    cache.set(target, proxy);
    return proxy;
  }
  return wrap;
}

/**
 * Compute the merged mutating-method set once per top-level wrap.
 * Registry-supplied names are union-ed with the generic 9-name blacklist;
 * every nested wrap reuses the same `merged` reference via the closure
 * captured by `makeWrapper`.
 */
function mergeMutatingMethods(registry: MutatingMethodLookup | undefined): ReadonlySet<string> {
  if (registry === undefined) return MUTATION_BLACKLIST;
  const out = new Set<string>(MUTATION_BLACKLIST);
  for (const name of registry.lookupMutatingMethods()) out.add(name);
  return out;
}

export function wrapReadOnly<T extends object>(target: T, registry?: MutatingMethodLookup): T {
  const merged = mergeMutatingMethods(registry);
  return makeWrapper(merged)(target);
}
