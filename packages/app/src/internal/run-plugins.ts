// @forgeax/engine-app -- plugin runner (M2 / w4, plan-strategy D-1 / D-7).
//
// runPlugins is the single seam createApp uses to wire capability packages
// into a World. It collapses N ad-hoc registration call sites (transform /
// animation / state / input / physics / audio) into one ordered pass over a
// flat Plugin[] (requirements OOS-4: no PluginGroup / disable / set;
// OOS-7: dependency == array order; C-12: each plugin self-guards its own
// prerequisites via hasResource checks inside build).
//
// Contract:
//   1. Merge defaultSet ++ userPlugins (defaultSet first) into insertion
//      order, keyed by plugin.name in a Map. canvas form passes the full
//      5-plugin default set; assemble form passes [] (plan-strategy D-2:
//      runner holds NO built-in default list -- the form decides).
//   2. A missing / empty name is an invalid plugin -> err('plugin-build-failed')
//      (a nameless plugin cannot be deduped or enumerated by the inspector).
//   3. A duplicate name (across default + user) -> err('duplicate-plugin')
//      with .detail.name = the conflicting name. Detected BEFORE any build
//      runs (fail fast: a name clash is a wiring bug, not a runtime fault).
//   4. await build(world) for each plugin in merged order. A build that
//      returns Result.err is accumulated into failures[] and the pass
//      CONTINUES (D-7: do not short-circuit; surface every failing plugin so
//      AI users diagnose multi-plugin failures in one pass).
//   5. After the full pass: any failure -> err('plugin-build-failed') with
//      .detail.pluginName / .detail.cause = the FIRST failure (AC-05 lower
//      bound: first failure always readable) and .detail.failures[] = every
//      failure. No failure -> ok(Map<name, Plugin>) (the registry M4's
//      registerPluginInspector consumes).
//
// charter awareness:
//   P3 explicit failure: every failure path returns a structured PluginError
//       (.code / .detail) -- never a silent skip or a thrown string.
//   F1 + P4: one runner shape for all capabilities; the AI user learns the
//       merge/dedup/await contract once and it covers every plugin.

import type { Result, World } from '@forgeax/engine-ecs';
import { err, ok } from '@forgeax/engine-ecs';
import {
  PLUGIN_ERROR_HINTS,
  PLUGIN_EXPECTED,
  type Plugin,
  PluginError,
} from '@forgeax/engine-plugin';

/**
 * Run the merged plugin set against `world`.
 *
 * @param world The target World (canvas form: createApp-owned; assemble form:
 *   host-owned). build(world) mutates it via addSystem / insertResource.
 * @param defaultSet Form-decided default plugins, run first in array order
 *   (canvas: transform/time/animation/state/input; assemble: []).
 * @param userPlugins User-supplied plugins from CreateAppOptions.plugins /
 *   AppAssembleArgs.plugins, run after the default set.
 * @returns ok(Map<name, Plugin>) registry on success; err(PluginError) on a
 *   duplicate name, an invalid (empty-name) plugin, or any build failure.
 */
export async function runPlugins(
  world: World,
  defaultSet: readonly Plugin[],
  userPlugins: readonly Plugin[],
): Promise<Result<Map<string, Plugin>, PluginError>> {
  const merged: Map<string, Plugin> = new Map();

  for (const plugin of [...defaultSet, ...userPlugins]) {
    const name = plugin.name;
    if (typeof name !== 'string' || name.length === 0) {
      return err(
        new PluginError({
          code: 'plugin-build-failed',
          expected: PLUGIN_EXPECTED['plugin-build-failed'],
          hint: PLUGIN_ERROR_HINTS['plugin-build-failed'],
          detail: {
            pluginName: '<unnamed>',
            cause:
              'plugin.name is missing or empty -- every plugin must declare a non-empty kebab-case name',
            failures: [
              {
                pluginName: '<unnamed>',
                cause: 'plugin.name is missing or empty',
              },
            ],
          },
        }),
      );
    }
    if (merged.has(name)) {
      return err(
        new PluginError({
          code: 'duplicate-plugin',
          expected: PLUGIN_EXPECTED['duplicate-plugin'],
          hint: PLUGIN_ERROR_HINTS['duplicate-plugin'],
          detail: { name },
        }),
      );
    }
    merged.set(name, plugin);
  }

  const failures: Array<{ pluginName: string; cause: string }> = [];
  for (const [name, plugin] of merged) {
    const result = await plugin.build(world);
    if (!result.ok) {
      failures.push({ pluginName: name, cause: summarizeBuildCause(result.error) });
    }
  }

  if (failures.length > 0) {
    const first = failures[0] as { pluginName: string; cause: string };
    return err(
      new PluginError({
        code: 'plugin-build-failed',
        expected: PLUGIN_EXPECTED['plugin-build-failed'],
        hint: PLUGIN_ERROR_HINTS['plugin-build-failed'],
        detail: {
          pluginName: first.pluginName,
          cause: first.cause,
          failures,
        },
      }),
    );
  }

  return ok(merged);
}

/**
 * Render a one-line cause string from the PluginError a plugin's build
 * returned. The build contract is `Result<void, PluginError>`, so the error
 * is a structured PluginError -- prefer its `.detail.cause` (the originating
 * exception text for a physics WASM failure) and fall back to `.message`.
 *
 * Kept local (not shared with errors.ts:summarizeCause) because that helper
 * targets arbitrary thrown values; here the input is always a PluginError and
 * the goal is a flat string for the aggregated failures[] entry.
 */
function summarizeBuildCause(error: PluginError): string {
  if (error.code === 'plugin-build-failed' && typeof error.detail.cause === 'string') {
    return error.detail.cause;
  }
  return error.message;
}
