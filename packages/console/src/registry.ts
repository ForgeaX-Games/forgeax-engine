// @forgeax/engine-console/src/registry - in-process Registry runtime class.
//
// SSOT split (parallel to errors.ts InspectorError type/class layout):
// the **Registry interface** + `Handler` / `RegisterRootResult` /
// `RegisterMethodResult` type aliases live in `@forgeax/engine-types`
// (feat-20260516-console-dependency-inversion plan-strategy §2.4); this
// file owns the **runtime class** only and `implements Registry` so the
// two sides cannot drift (architecture-principles #1 SSOT).
//
// Behaviour (plan-strategy §2.5 + §3.2 sequence B + AC-09):
// - Two-table state: `Map<string, unknown>` for roots, `Map<string,
//   Handler>` for methods.
// - `registerRoot(name, root)` / `registerMethod(method, handler)` returns
//   `Result.ok(undefined)` on first registration; same-name duplicate
//   returns `Result.err(InspectorError { code: 'console-startup-failed',
//   expected, hint })` — never throws, never overwrites silently. This is
//   the `AppError::DuplicatePlugin` parallel from research §Finding 3 (c).
// - `expected` literal contains the offending name + the descriptor
//   (`root` / `method`) so AI users can grep the failure.
// - `hint` literal contains "call register*Inspector at most once" plus
//   the recovery copy "create a new Registry()" for the lifecycle case
//   (charter proposition 3 hint > prose; plan-strategy §3.3 error path 1).
//
// charter mapping: proposition 3 (machine-readable structured failure) +
// proposition 4 (Result<T,E> over throw — same style as
// `startConsoleServer` already returns) + proposition 5 (consistent
// abstraction — InspectorError 4-field surface unchanged; no new error
// code added per §2.11 wire-protocol freeze).
//
// Wire-protocol freeze: `console-startup-failed` is the only existing
// `InspectorErrorCode` member that semantically covers "the console
// subsystem failed to come up" — register-time fail-fast is squarely
// inside that semantic family (the JSON-RPC server cannot dispatch the
// duplicate method consistently). No new code added (OOS-3).

import type {
  Handler,
  RegisterMethodResult,
  RegisterRootResult,
  Registry as RegistryInterface,
} from '@forgeax/engine-types';
import { InspectorError } from './errors';

/**
 * In-process Registry runtime class — implements
 * {@link RegistryInterface} from `@forgeax/engine-types`.
 *
 * Lifecycle (plan-strategy §3.3 success path):
 *
 * ```ts
 * const reg = new Registry();
 * wireDefaultInspectors(reg, { world, engine, assets });
 * registerEcsInspector(reg, world);
 * await startConsoleServer({ port: 5732, registry: reg });
 * ```
 *
 * Same-name duplicate fail-fast example (plan-strategy §3.3 error path 1):
 *
 * ```ts
 * const reg = new Registry();
 * registerEcsInspector(reg, world); // ok
 * const r = registerEcsInspector(reg, world); // duplicate
 * // r.ok === false
 * // r.error.code === 'console-startup-failed'
 * // r.error.expected contains 'entities'
 * // r.error.hint contains 'call registerEcsInspector at most once'
 * ```
 *
 * @see {@link RegistryInterface} for the interface SSOT (plan-strategy
 *      §2.4 / §8.5 — JSDoc on the interface owns the four-sentence
 *      contract; this class merely materialises the abstraction).
 */
export class Registry implements RegistryInterface {
  private readonly roots = new Map<string, unknown>();
  private readonly methods = new Map<string, Handler>();
  // Mutating-method contributions (feat-20260517 D-5). `mutatingSets`
  // accumulates each contributor's frozen set keyed by reference; same
  // ReadonlySet identity = duplicate (Result.err 'console-startup-failed').
  // `mergedMutatingMethods` is the cached union recomputed on each
  // successful registerMutatingMethods call and `Object.freeze`-locked so
  // sandbox.ts can read it once per wrap-time and trust the reference is
  // immutable (research F6 + plan-tasks w8 acceptance d).
  private readonly mutatingSets = new Set<ReadonlySet<string>>();
  private mergedMutatingMethods: ReadonlySet<string> = Object.freeze(new Set<string>());

  registerRoot(name: string, root: unknown): RegisterRootResult {
    if (this.roots.has(name)) {
      return {
        ok: false,
        error: new InspectorError({
          code: 'console-startup-failed',
          expected: `root "${name}" not yet registered`,
          hint: `call registerEcsInspector at most once per Registry instance; if reusing across reloads, create a new Registry() (registerRoot duplicate on "${name}")`,
        }),
      };
    }
    this.roots.set(name, root);
    return { ok: true, value: undefined };
  }

  registerMethod(method: string, handler: Handler): RegisterMethodResult {
    if (this.methods.has(method)) {
      return {
        ok: false,
        error: new InspectorError({
          code: 'console-startup-failed',
          expected: `method "${method}" not yet registered`,
          hint: `call registerEcsInspector at most once per Registry instance; if reusing across reloads, create a new Registry() (registerMethod duplicate on "${method}")`,
        }),
      };
    }
    this.methods.set(method, handler);
    return { ok: true, value: undefined };
  }

  lookupRoot(name: string): unknown {
    return this.roots.get(name);
  }

  lookupMethod(method: string): Handler | undefined {
    return this.methods.get(method);
  }

  registerMutatingMethods(names: ReadonlySet<string>): RegisterRootResult {
    if (this.mutatingSets.has(names)) {
      return {
        ok: false,
        error: new InspectorError({
          code: 'console-startup-failed',
          expected: 'mutating-methods set not yet registered (by reference)',
          hint: 'call registerEcsInspector at most once per Registry instance; if reusing across reloads, create a new Registry() (registerMutatingMethods duplicate by reference)',
        }),
      };
    }
    this.mutatingSets.add(names);
    const merged = new Set<string>(this.mergedMutatingMethods);
    for (const n of names) merged.add(n);
    this.mergedMutatingMethods = Object.freeze(merged);
    return { ok: true, value: undefined };
  }

  lookupMutatingMethods(): ReadonlySet<string> {
    return this.mergedMutatingMethods;
  }
}
