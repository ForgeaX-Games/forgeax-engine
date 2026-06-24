// wire-default-inspectors - one-line host assembly helper that wires the
// canonical inspector roots + ecs/runtime contributor methods onto a
// Registry instance (plan-tasks.json w4wb round 2 + plan-strategy §2.6
// function-injection / §3.4 / §4.4 + scenario "game-code AI agent" + AC-08).
//
// Round 2 form (function injection): the host imports
// register*Inspector from the domain packages and passes them in as the
// third argument. console therefore never value-imports
// @forgeax/engine-{ecs,runtime} itself; this is the physical guarantee
// behind requirement AC-01 + AC-02 strict 4-deny-list. Reverse gate
// check-console-not-import-engine.mjs enforces the invariant at CI.
//
// charter: proposition 1 (single one-line entry — progressive disclosure
// for AI users that want the standard wiring without thinking about each
// contributor) + proposition 3 (Result<void, InspectorError>) + proposition
// 4 (explicit fail-fast on the first failing step; never silently
// overwrites a duplicate) + proposition 5 (consistent abstraction —
// returns the same Result shape as every individual register*Inspector) +
// F1 typed contract (the WireDefaultInspectorsInjectors interface is the
// API surface, not prose).
//
// Pipeline isolation (architecture-principles #4): this module imports
// only types from @forgeax/engine-types (Registry / RegisterRootResult /
// WireDefaultInspectorsInjectors). Domain packages are reachable only
// through the `injectors` argument the host supplies; the helper does not
// reach back into runtime / ecs class internals.
//
// Failure semantics (R-REG-CONFLICT plan-strategy §4): the helper invokes
// reg.registerRoot('world') -> reg.registerRoot('engine') ->
// reg.registerRoot('assets') -> injectors.registerEcsInspector(reg, world) ->
// injectors.registerRuntimeInspector(reg, engine) sequentially. The first
// `Result.err` short-circuits: subsequent steps are NOT attempted, and
// the err is returned verbatim. This matches the Bevy `App::add_plugins`
// + `AppError::DuplicatePlugin` pattern (research §Finding 3 (c)) and
// keeps the AI-user-facing failure compact (charter F1 information
// density discipline — one fault per Result, no list).

import type {
  RegisterRootResult,
  Registry,
  WireDefaultInspectorsInjectors,
} from '@forgeax/engine-types';

/**
 * Result alias for `wireDefaultInspectors`. Mirrors `RegisterRootResult`
 * from `@forgeax/engine-types` — same `Result<void, InspectorError>`
 * shape; the union member surfaced on failure is always
 * `'console-startup-failed'` per §2.11 wire-protocol freeze.
 */
export type WireDefaultInspectorsResult = RegisterRootResult;

/**
 * Context passed into `wireDefaultInspectors`. Exposes the three SSOT
 * roots that every inspector script needs: the ECS `World` / runtime
 * `Renderer` / `AssetRegistry`. Each is treated as opaque (`unknown`) so
 * this helper does not statically depend on the runtime / ecs / pack
 * module internals — only on the contributor function signatures
 * delivered through the `injectors` argument.
 *
 * The `world` and `engine` fields drive the upstream contributors:
 * - `world` -> `injectors.registerEcsInspector(reg, world)`
 * - `engine` -> `injectors.registerRuntimeInspector(reg, engine)`
 *
 * `assets` is exposed only as a top-level root (`assets.*` fields are
 * inspector-readable but no domain methods are pre-registered here; the
 * `pack` plugin bin handles `asset scan/lookup/verify` out-of-process).
 */
export interface WireDefaultInspectorsContext {
  readonly world: unknown;
  readonly engine: unknown;
  readonly assets: unknown;
  /**
   * Plugin registry (Map produced by `runPlugins()`). Typed as
   * `unknown` so console never statically depends on
   * `@forgeax/engine-plugin`. Optional -- when omitted, the
   * `plugins` JSON-RPC method is not registered.
   */
  readonly pluginRegistry?: unknown;
}

/**
 * Wire the canonical three roots + injected ecs + runtime contributor
 * methods onto a Registry in one call. After a successful invocation the
 * `Registry` instance carries:
 *
 *   roots:    world / engine / assets
 *   methods:  entities / components / systems / resources / renderer.info
 *
 * All five method names mirror the historic introspection target table
 * (entities / components / systems / resources / renderer.info); the
 * legacy `inspect <target>` built-in CLI subcommand was removed in
 * feat-20260517-console-ecs-plugin-extraction (D-4) and the same names
 * now ship as the kubectl 4th-path plugin bin
 * `forgeax-engine-console-ecs <target>` from `@forgeax/engine-ecs`.
 *
 * Full host-assembly example (with the canonical contributor injectors)
 * lives in `packages/console/README.md` §Host assembly. Inlining it here
 * would force this source file to mention the deny-listed engine package
 * names verbatim, breaking the 0-occurrence invariant the reverse grep
 * gate enforces at CI.
 */
export function wireDefaultInspectors(
  reg: Registry,
  ctx: WireDefaultInspectorsContext,
  injectors: WireDefaultInspectorsInjectors,
): WireDefaultInspectorsResult {
  const r1 = reg.registerRoot('world', ctx.world);
  if (!r1.ok) return r1;
  const r2 = reg.registerRoot('engine', ctx.engine);
  if (!r2.ok) return r2;
  const r3 = reg.registerRoot('assets', ctx.assets);
  if (!r3.ok) return r3;
  const r4 = injectors.registerEcsInspector(reg, ctx.world);
  if (!r4.ok) return r4;
  const r5 = injectors.registerRuntimeInspector(reg, ctx.engine);
  if (!r5.ok) return r5;
  if (injectors.debugRhi) {
    const r6 = injectors.debugRhi(reg);
    if (!r6.ok) return r6;
  }
  if (injectors.registerPluginInspector) {
    const r7 = injectors.registerPluginInspector(reg, ctx.pluginRegistry);
    if (!r7.ok) return r7;
  }
  return { ok: true, value: undefined };
}
