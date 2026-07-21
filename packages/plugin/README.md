# @forgeax/engine-plugin

> **Plugin protocol + host-neutral assembly.** Holds the `Plugin` interface, `PluginError` closed union, and `runPlugins` — the single host-neutral assembly authority. Only depends on `@forgeax/engine-ecs`. Public consumption through `@forgeax/engine-app` (re-export). Direct import for capability package authors.

## What is this package?

`@forgeax/engine-plugin` is the **protocol contract** between `createApp` (the app shell) and every capability package (runtime, state, physics, audio). It lives at layer L1.5 — above `@forgeax/engine-ecs` (which provides `World` / `Result` / `ok` / `err`) and below every capability package. This layering is structurally forced by the dependency graph: capability packages need to return `Plugin` values, and the app package already depends on all capability packages — moving the types here breaks the cycle.

## Exports

| Export | Kind | Purpose |
|:--|:--|:--|
| `Plugin` | interface | `{ readonly name: string; build(world: World): Result<void, PluginError> \| Promise<Result<void, PluginError>> }` |
| `PluginErrorCode` | type | `'duplicate-plugin' \| 'plugin-build-failed'` — 2-member closed union |
| `PluginError` | class | Structured 4-field error (`.code` / `.expected` / `.hint` / `.detail`), discriminated by `code` |
| `PluginErrorDetail` | type | Tagged union of `PluginDetailDuplicatePlugin \| PluginDetailBuildFailed` |
| `PluginErrorDetailFor<C>` | type | Conditional resolver: `PluginErrorCode` → per-code detail payload |
| `PLUGIN_EXPECTED` | const | `Record<PluginErrorCode, string>` — invariant violated when each code surfaces |
| `PLUGIN_ERROR_HINTS` | const | `Record<PluginErrorCode, string>` — actionable recovery guidance per code |
| `isPluginError` | function | Type guard for narrowing `unknown` to `PluginError` |
| `runPlugins` | function | `(world, defaultSet, userPlugins) => Promise<Result<Map<string, Plugin>, PluginError>>` — host-neutral plugin assembly authority |

## Plugin runner

`runPlugins` is the **single host-neutral plugin assembly authority**. It merges `defaultSet` and `userPlugins` in insertion order, rejects duplicate names before any build runs, awaits each `build(world)` in order, and accumulates all failures. Both canvas-form `createApp` and headless Node hosts consume this same function.

```ts
import { runPlugins, type Plugin } from '@forgeax/engine-plugin';
import { World } from '@forgeax/engine-ecs';

const world = new World();
const result = await runPlugins(world, [transformPlugin()], [myPlugin]);
if (!result.ok) {
  switch (result.error.code) {
    case 'duplicate-plugin': // ...
    case 'plugin-build-failed': // ...
  }
}
```

## Who imports from here?

| Consumer | Import path | Why |
|:--|:--|:--|
| `@forgeax/engine-app` | Re-exports via barrel `index.ts` | AI-user convenience: `import { Plugin, PluginError } from '@forgeax/engine-app'` stays stable |
| Headless Node hosts | Direct `import { runPlugins } from '@forgeax/engine-plugin'` | Host-neutral assembly without app dependency |
| `@forgeax/engine-runtime` | Direct `import ... from '@forgeax/engine-plugin'` | `transformPlugin()` / `animationPlugin()` / `timePlugin()` return `Plugin` |
| `@forgeax/engine-state` | Direct | `statePlugin()` returns `Plugin` |
| `@forgeax/engine-physics` | Direct | `physicsPlugin(backend)` returns `Plugin` AND constructs `PluginError` for WASM failures |
| `@forgeax/engine-audio-webaudio` | Direct | `audioPlugin()` returns `Plugin` |
| Capability package authors | Direct | Write `xxxPlugin(): Plugin` factories that return `{ name, build }` |

> [!NOTE]
> Capability packages **must** import directly from `@forgeax/engine-plugin`, not through `@forgeax/engine-app` — the app already depends on all capability packages, so going through app would recreate the dependency cycle this package was created to break.

## PluginError closed union

```ts
type PluginErrorCode = 'duplicate-plugin' | 'plugin-build-failed';
```

| Code | Trigger | `.detail` payload |
|:--|:--|:--|
| `'duplicate-plugin'` | Two or more plugins share the same `name` | `{ name: string }` |
| `'plugin-build-failed'` | A `plugin.build(world)` call returned `Result.err` | `{ pluginName, cause, failures? }` — first failure + full list |

AI users consume via `switch (err.code)` with exhaustiveness checked by TypeScript (no `default` branch needed).

```ts
import { isPluginError, type PluginError } from '@forgeax/engine-app';

if (isPluginError(err)) {
  switch (err.code) {
    case 'duplicate-plugin':
      console.warn(`Duplicate plugin: ${err.detail.name}`);
      break;
    case 'plugin-build-failed':
      console.warn(`Plugin ${err.detail.pluginName} failed: ${err.detail.cause}`);
      // err.detail.failures contains the complete failure list
      break;
  }
}
```

## References

- Plugin interface SSOT: `packages/plugin/src/index.ts`
- Plugin runner: `packages/plugin/src/run-plugins.ts`
- PluginError structural unit tests: `packages/plugin/__tests__/plugin-error.test.ts`
- Plugin type-level tests: `packages/plugin/__tests__/plugin-types.test-d.ts`
- Plugin runner contract tests: `packages/plugin/__tests__/run-plugins.test.ts`
