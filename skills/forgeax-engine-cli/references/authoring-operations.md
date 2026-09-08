# Authoring operations

> [!IMPORTANT]
> 这里描述单一 `forgeax` 产品入口背后的 project operation。RHI tape 的抓取、回放与逐 draw 检查改读 [`forgeax-engine-rhi-debug`](../../forgeax-engine-rhi-debug/SKILL.md)。

## 从发现开始

```bash
forgeax list --json
forgeax describe project.build --json
forgeax run project.build --input request.json --json
```

`list` 只从 `forge.json` 与 `package.json` 投影 Tool Catalog，不执行游戏模块。`describe` 返回稳定 `id`、执行 `realm`、`argsSchema`、`resultSchema` 与所需 `evidence`；请求必须以该 descriptor 为准，不能从 operation 名称猜输入。

命令 envelope 与 `ToolTerminal` 是两层结果：

```ts
const envelope = JSON.parse(stdout);
if (!envelope.ok) recoverCommand(envelope.error);
else if (envelope.value.outcome === 'failed') recoverTool(envelope.value.failure);
else consume(envelope.value.result, envelope.value.artifacts);
```

失败时按 `failure.code` 分支，再读 `expected`、`hint` 与收窄后的 `detail`。项目文件、Meta/Pack/WGSL 与导入源码是 author truth；Catalog、缓存、preview carrier 与 run evidence 都只是可重建投影。

## 插件与 operation

游戏模块默认导出原生 Cordis plugin，`forge.json.plugins[]` 的 Entry 是持久权威：

```bash
forgeax plugin install ./src/weather.ts --id weather --realm engine --dry-run --json
forgeax plugin install @example/weather --id weather --realm engine \
  --dependency @example/weather --json
forgeax plugin uninstall weather --dependency @example/weather --json
```

Entry 与 dependency 在同一事务中提交，dependency 失败时恢复 `forge.json`。选择 `host` 或 `build` realm 的 Consumer 必须实际启动对应 Catalog Loader，不能留下静默未激活 Entry。

自定义 operation 通过 `defineTool(descriptor, executor)` 将静态 descriptor 与 executor 放在一起。executor 只返回 JSON-safe result、`SnapshotRef` 与 `ArtifactRef`；实时 World、Renderer、Canvas、Context、Fiber 或 session handle 不得越过边界。进度用 `context.emit`，子工作用 `context.runChild`，可失败资源在开始工作前用 `context.addCleanup` 注册。预期失败返回结构化 `{ ok: false, error }`。

`forgeax exec` 还向同一个 lexical program context 注入 `browser.open()`，用于 CPU-only 的真实
Playwright 游玩和多检查点 compositor 截图。它不是 operation，也不进入 Catalog：`Page` 和
session 只在 program 内存活，program 仍只能返回 JSON-safe capture rows/report path；退出时
DevKit 关闭全部 session。一次性 `forgeax capture --software` 复用同一 browser owner。

## 组合与证据

使用普通 TypeScript 组合，不创建 workflow DSL、第二 registry 或隐藏 current snapshot：

```ts
export default async function run(operations) {
  const authored = await operations.run('author.write-value', input);
  if (authored.outcome === 'failed') return authored;
  return operations.run('project.build', buildArgs, {
    snapshot: authored.snapshotAfter,
    deadlineMs: 30_000,
  });
}
```

```bash
forgeax exec program.mjs --json-stream
```

Preview 先 `describe` 再形成 recipe。公开资源操作是 `material.preview`、`mesh.preview`、`vfx.preview` 与 `texture.preview`；它们以 GUID 走 Engine-owned AssetRegistry 路径。默认 hidden presentation 仍必须创建真实 Canvas/WebGPU Renderer、推进 World、提交 draw 并返回可验证 artifact，不能用 RHI Null 或 screenshot mock 代替。

可选 service 只在 DevKit benchmark admission 明确允许时加速同一个 operation；缺失或无效 admission 选择 private executor。service 只运输序列化输入、snapshot 与 artifact ref，不拥有 operation 或实时 Engine state；传输断开要保留失败 terminal，再从项目权威显式重试 private path。

## Source authorities

| Contract | Source |
|:--|:--|
| Tool types、terminal、runtime error | `packages/tool-runtime/src/` |
| CLI、Catalog、built-in contribution | `packages/devkit/src/tools/` |
| Project Entry transaction | `packages/devkit/src/plugin-authoring.ts` |
| Cordis Catalog Loader | `packages/plugin/src/loader.ts` |
| Preview recipe/evidence | `packages/app/src/tool-preview/` |
| Service admission | `packages/devkit/src/tools/benchmark/` |

修改这些 owner 时运行对应 package tests；preview 或画面路径还必须执行适用的 Browser/Dawn gate，unit-only 不能证明真实 GPU 路径。
