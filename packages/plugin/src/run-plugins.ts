// @forgeax/engine-plugin -- host-neutral plugin runner.
//
// runPlugins is the single seam that builds a World from a merged plugin set.
// It is the canonical host-neutral assembly authority; app and headless Node
// hosts both consume this same function.
//
// Contract:
//   1. Merge defaultSet ++ userPlugins (defaultSet first) into insertion
//      order, keyed by plugin.name in a Map.
//   2. A missing / empty name is an invalid plugin -> err('plugin-build-failed').
//   3. A duplicate name (across default + user) -> err('duplicate-plugin')
//      detected BEFORE any build runs.
//   4. await build(world) for each plugin in merged order. A build that
//      returns Result.err is accumulated into failures[] and the pass
//      CONTINUES.
//   5. After the full pass: any failure -> err('plugin-build-failed') with
//      .detail.pluginName / .detail.cause = the FIRST failure and
//      .detail.failures[] = every failure. No failure -> ok(Map<name, Plugin>).

import type { Result, World } from '@forgeax/engine-ecs';
import { err, ok } from '@forgeax/engine-ecs';
import { PLUGIN_ERROR_HINTS, PLUGIN_EXPECTED, type Plugin, PluginError } from './index';

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

function summarizeBuildCause(error: PluginError): string {
  if (error.code === 'plugin-build-failed' && typeof error.detail.cause === 'string') {
    return error.detail.cause;
  }
  return error.message;
}
