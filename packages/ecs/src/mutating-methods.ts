// @forgeax/engine-ecs/src/mutating-methods - the
// `ECS_MUTATING_METHODS` SSOT (feat-20260517 D-6 / research §F1).
//
// Single module-level frozen Set listing every World public method whose
// invocation mutates ECS state. Sandbox-side ReadOnly Proxy traps consult
// the merged set returned by `Registry.lookupMutatingMethods()` (see
// `@forgeax/engine-types` Registry interface) to deny calls; the ECS
// inspector contributor `registerEcsInspector` (M2 w14) calls
// `reg.registerMutatingMethods(ECS_MUTATING_METHODS)` exactly once at
// wire-time.
//
// Frozen list (14 names):
//   Schedule  (5)  : addSystem / removeSystem / replaceSystem /
//                    setErrorHandler / update
//   Resource  (2)  : insertResource / removeResource
//   Entity    (4)  : spawn / despawn / addComponent / removeComponent
//   Field     (3)  : set / push / pop
//
// Reference SSOT: `packages/ecs/src/world.ts` (the World public class).
// Each member name appears verbatim on the World class (research §F1
// directly inspected the source); same-name collisions with generic
// Array/Map methods (`set` / `push` / `pop`) are intentional — sandbox
// merges generic + ECS contributors so a single trap-time lookup covers
// both name spaces (plan-strategy §3.2 sequence diagram).
//
// Identity stability: this constant is a **module-level singleton**
// because `Registry.registerMutatingMethods` uses `===` reference
// equality as the duplicate-detection key (plan-strategy §2 D-5). Two
// `import` statements across the codebase resolve to the same instance
// via the V8 module cache; the test
// `packages/ecs/src/__tests__/mutating-methods.test.ts` (w6) pins this
// invariant.
//
// Not Object.freeze'd: a JS `Set` already prevents structural mutation
// from outside callers when typed as `ReadonlySet<string>` (`.add` /
// `.delete` are not on the Readonly interface; tsc strict guards
// compile-time misuse). Object.freeze on a Set is a no-op for the
// internal `[[SetData]]` slot — no benefit.
//
// Anchors: requirements §3 AC-07; plan-strategy §2 D-5 + D-6 + §3.1
// component map; research §F1.

export const ECS_MUTATING_METHODS: ReadonlySet<string> = new Set<string>([
  // Schedule (5)
  'addSystem',
  'removeSystem',
  'replaceSystem',
  'setErrorHandler',
  'update',
  // Resource (2)
  'insertResource',
  'removeResource',
  // Entity (4)
  'spawn',
  'despawn',
  'addComponent',
  'removeComponent',
  // Field (3) — same-name collisions with generic Array/Map are intentional
  'set',
  'push',
  'pop',
]);
