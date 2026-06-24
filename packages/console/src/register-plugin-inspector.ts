// register-plugin-inspector - Pure-function plugin inspector contributor
// (feat-20260623-plugin-system-unify-build-world-protocol M4 / w18,
//  plan-strategy D-7 + AC-09).
//
// Top-level pure function `registerPluginInspector(reg, pluginRegistry)`
// registers the 'plugins' JSON-RPC method on a Registry interface from
// `@forgeax/engine-types`. The method returns `{ name: string }[]` built
// from the plugin registry's keys (D-7: method name 'plugins' aligns with
// existing systems/components/resources/entities naming style).
//
// charter: proposition 1 (single registration entry per domain) +
// proposition 3 (Result<void, InspectorError>) + proposition 4 (explicit
// fail-fast on duplicate via 'console-startup-failed') +
// proposition 5 (consistent abstraction -- Handler signature shared with
// registerEcsInspector / registerRuntimeInspector).
//
// Pipeline isolation (architecture-principles #4): this module imports
// only `@forgeax/engine-types` (interface SSOT). `pluginRegistry` is typed
// as `unknown` -- the handler only reads `.keys()` as strings so console
// never statically depends on `@forgeax/engine-plugin` or
// `@forgeax/engine-app`. The reverse-grep gate
// `check-console-not-import-engine.mjs` enforces this invariant at CI.

import type { RegisterRootResult, Registry } from '@forgeax/engine-types';

/**
 * Result alias for `registerPluginInspector`. Mirrors `RegisterRootResult`
 * from `@forgeax/engine-types` -- same `Result<void, InspectorError>`
 * shape; the union member surfaced on failure is always
 * 'console-startup-failed'.
 */
export type RegisterPluginInspectorResult = RegisterRootResult;

/**
 * Register the 'plugins' JSON-RPC method on a Registry instance.
 *
 * The method returns `{ name: string }[]` extracted from
 * `pluginRegistry.keys()`. An empty registry returns `[]`; a populated
 * registry returns one `{ name }` entry per plugin in insertion order.
 *
 * Same-name duplicate fails fast and returns
 * `Result.err(InspectorError)` with `code: 'console-startup-failed'`.
 *
 * @param reg           `Registry` instance from `@forgeax/engine-console`.
 * @param pluginRegistry `Map<string, *>` -- the plugin registry produced by
 *                      `runPlugins()`. Typed as `unknown` so console avoids
 *                      importing `@forgeax/engine-plugin` -- only `.keys()`
 *                      is called, yielding `string` entries.
 */
export function registerPluginInspector(
  reg: Registry,
  pluginRegistry: unknown,
): RegisterRootResult {
  const handler = () => {
    // pluginRegistry is a Map<string, *> at runtime; we only call .keys()
    // and read each key as a string. The cast avoids importing Plugin.
    const map = pluginRegistry as { keys(): Iterable<string> };
    const names: { name: string }[] = [];
    for (const key of map.keys()) {
      names.push({ name: key });
    }
    return names;
  };
  return reg.registerMethod('plugins', handler);
}
