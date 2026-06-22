# @forgeax/engine-vite-plugin-shader

> **本包是 `@forgeax/engine-shader-compiler` 的 Vite 插件薄壳，对齐 Vite 4-hook 模型（load / transform / generateBundle / handleHotUpdate）全装入，约束 transform 仅 forwarding 调 `compileShader`，不重新实现编译逻辑（AC-02）。** AI 用户（含 agentic AI runtime）通过 `import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader'` 在 `vite.config.ts` 里注入 plugin，得到 build-time `.wgsl` → 三件套 + manifest 落盘 + ShaderError → RollupLog wrap（plan-strategy §S-6 + §S-7）。

## 形态铁律

- **薄壳 forwarding** —— 4 hook（`load` / `transform` / `generateBundle` / `handleHotUpdate`）全部装入，但 `transform` 仅 forwarding 调 `@forgeax/engine-shader-compiler.compileShader`，不重新实现编译逻辑（AC-02 闸门）。
- **peerDep vite** —— 插件签名走 `'vite'` 的 `Plugin` 类型；vite 由 host 应用提供（`peerDependencies: { vite: ">=4" }`）。
- **hint 双投影** —— `toRollupLog(err)` 同时把 `ShaderError.hint` 放到 `RollupLog` 顶层与 `meta.hint`，AI 用户消费走 `err.hint` 顶层（charter 命题 5 一致抽象 + 命题 4 显式失败；plan-strategy §S-7）。
- **emitFile 必经路径** —— `generateBundle` 走 `this.emitFile({ type: 'asset', fileName, source })`，**禁止**直接 mutate `bundle[fileName]`（Rollup 官方 danger callout，research Finding 3）。
- **HMR 默认传播** —— `handleHotUpdate(ctx)` 返回 `ctx.modules` 即可；客户端 `import.meta.hot.accept(` 由 `transform` 注入字面量（whitespace-sensitive）。

## API 索引

| 入口 | 说明 |
|:--|:--|
| `forgeaxShader(options?)` | Vite plugin factory，返回含 4 hook + `resolveId` + `load`（virtual module 通道）的 `Plugin` 对象（w14 落地 + feat-20260608 M3 扩展） |
| `toRollupLog(err)` | `ShaderError` → `RollupLog`（hint 双投影，w14 落地） |
| `ForgeaXShaderRollupLog` | RollupLog 扩展类型（`hint` 顶层投影是 forgeax 自定义字段） |
| `virtual:forgeax/bundler` | Build-time virtual module emitting `forgeaxBundlerAdapter()` factory（feat-20260608 M3，详见下节） |

## `virtual:forgeax/bundler` virtual module

> feat-20260608-create-app-param-surface-trim / M3 / D-4 q7-A: a single inline-emit virtual module that surfaces the build-time bundler-injected wiring (`shaderManifestUrl` + optional `importTransport`) as a `BundlerOptions`-compatible factory call. AI users discover the entry through one import line; the manifest URL stays a single SSOT inside the plugin emit path.

```ts
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// One-screen takeoff: pass adapter() directly as the third arg.
const app = await createApp(canvas, {}, forgeaxBundlerAdapter());

// Spread form when a real dev import-transport must be wired:
import { createDevImportTransport } from '@forgeax/engine-runtime';
const bundler = { ...forgeaxBundlerAdapter(), importTransport: createDevImportTransport() };
const renderer = await createRenderer(canvas, {}, bundler);
```

**Form invariants:**

- `forgeaxShader(options?)` mounts `resolveId` (claims the virtual id) + `load` (returns the inline adapter source) hooks alongside the 4 build hooks. Same plugin, no second package.
- The adapter source closes over the plugin's `SHADER_MANIFEST_URL` constant -- a single SSOT shared with `generateBundle` emit + dev `configureServer` middleware. `apps/` source never types the literal `'/shaders/manifest.json'`; CI grep gate (AC-12) enforces zero hits.
- The adapter source **does NOT import** `@forgeax/engine-app`. The return value relies on TypeScript structural typing to satisfy `BundlerOptions` at every callsite (D-4 q7-A reverse-coupling guard: `vite-plugin-shader` -> `@forgeax/engine-app` is forbidden by the package layering).
- The TypeScript ambient module declaration (`declare module 'virtual:forgeax/bundler'`) ships in each app's `src/vite-env.d.ts` so per-app `tsc --noEmit` resolves the import without each app having to depend on the plugin's package types.

## 关联

- 决策 plan-strategy [§S-6 4 hook 分工](../../.forgeax-harness/forgeax-loop/feat-20260508-shader-pipeline-mvp/plan-strategy.md) / §S-7 ShaderError wrap（hint 双投影）/ §6 M2 范围。
- 上游 [`@forgeax/engine-shader-compiler`](../shader-compiler/README.md) 提供 `compileShader` 纯函数 + `ShaderError` 5 字段顶层错误类。
- 集成端 [`apps/hello/triangle/vite.config.ts`](../../apps/hello/triangle/vite.config.ts) M2 注入验证（w15）+ M3 替换 fixture 为 pbr.wgsl。
