---
name: forgeax-engine-cli
description: >-
  forgeax-engine 远程求值：对运行中引擎活实例执行 eval(script) + kubectl 式 plugin bin。
  Use when eval'ing code against a running engine, discovering entities through
  World.query, capturing frames, querying the opt-in CPU profiler, or calling CLI bin tools on
  live/offline data.
---

# forgeax-engine-cli

> **唯一能力 = `eval` 活引擎**。`@forgeax/engine-remote` 把一段 JS 发给运行中的引擎实例求值并取回结果。用 `world.query` 发现 handle，再直接读写活根。

## 心智模型

`eval(script)` 就是全部。一段脚本被送到 host 进程中的 `new Function` 作用域执行，作用域内注入四个活根：

| 活根 | 类型 | 用途 |
|:--|:--|:--|
| `world` | `World`（来自 `@forgeax/engine-ecs`） | ECS 读写：spawn / despawn / set / query |
| `renderer` | `Renderer` | 渲染器控制：创建/销毁 RT、读 backbuffer |
| `assets` | `AssetRegistry` | 资产查询：loadByGuid / resolveName / rename |
| `debugAdapter` | `DebugRhiAdapter \| undefined` | RHI 帧抓取：`captureFrames(frames, label?)` / Dawn-Node `inspectAt(tapePath, drawIdx, fields?)`。**仅当 createApp 运行在 `FORGEAX_ENGINE_RHI_DEBUG=1` 时注入**，否则 `undefined`（用前先 guard）。world / renderer / assets 三根恒在场。 |
| `profiler` | `Profiler \| undefined` | Bounded CPU capture through `startCapture({ frameLimit, eventLimit })`; injected only when the host opts in. |

脚本内通过 `_import(specifier)` 按需引入组件 token。`_import` 是 eval 作用域注入的 import 函数；脚本内没有裸 `import` 关键字。

> [!NOTE]
> **协议层另有一个内建方法 `introspect`**（与 `eval` 并列）：返回 OpenRPC L2 子集文档，列出可用方法（`eval` / `introspect`）+ eval 作用域活根。AI 用户连上后可先 `introspect` 自描述，无需读源码即知能 eval 什么。错误码映射 JSON-RPC -32001..-32006。

**安全模型**：eval 全开（无只读拦截、无能力黑名单）。唯一边界是 host 起不起 server：`createApp` dev 模式默认 wire `app.remote`（WS server 在场）；production 默认不起 server（天然安全）。危险 API（`renderer.dispose()` / `world.despawn`）允许执行，详见末尾 NOTE。

## 传输路径

三条路径统一收束到同一个 `eval(script)` 协议：

```mermaid
flowchart TD
    A[AI 用户 / CLI / 进程内] -->|eval| E[eval 核心<br/>host realm new Function]
    E -.->|_import| ECS["component tokens"]
    E --> R["eval 作用域活根<br/>world · renderer · assets · debugAdapter"]
    R --> W[运行中 World / Renderer]
```

| 路径 | 形态 | 适用场景 |
|:--|:--|:--|
| 进程内 client | `app` 获取 `RemoteHandle`，`client.eval(script)` | host 自身做查询/调试（零网络开销） |
| WS JSON-RPC 2.0 | `ws://localhost:5732` 发 `{"method":"eval","params":{"script":"..."}}` | 外部工具 / AI 代理连运行中引擎 |
| CLI plugin bin | `forgeax-engine-remote-{ecs,asset,gltf,font,state}` | 离线/进程外数据工具 |

## 核心 API / bin 速查

| 名字 | 来源 | 形态 | 用途 |
|:--|:--|:--|:--|
| `client.eval(script)` | `@forgeax/engine-remote` | `async (script: string) => Promise<Result<unknown, RemoteError>>` | 对运行中引擎执行一段 JS，取返回值 |
| `RemoteHandle` | `@forgeax/engine-types` | `{ port: number; close(): Promise<void> }` | `app.remote` 的类型；暴露 server 端口与关闭方法 |
| `RemoteError` | `@forgeax/engine-remote` | class extends Error，含 `.code` / `.expected` / `.hint` | 结构化错误，4 成员 `RemoteErrorCode` 闭集 |
| `forgeax-engine-remote-ecs` | ecs | plugin bin | `entities` / `components` / `systems` / `resources` / `world` |
| `forgeax-engine-remote-asset` | pack | plugin bin | `scan` / `lookup` / `verify` / `atlas` |
| `forgeax-engine-remote-gltf` | gltf | plugin bin | `import` |
| `forgeax-engine-remote-font` | font | plugin bin | `bake` |
| `forgeax-engine-remote-state` | state | plugin bin | `list` / `get <name>` |

> [!IMPORTANT]
> CLI plugin bin 是各能力包自带的独立可执行文件，进程外直接调用。`RemoteErrorCode`（4 成员：`script-syntax-error` / `script-runtime-error` / `server-startup-failed` / `server-not-running`）SSOT 见 `packages/types/src/index.ts` + `packages/remote/src/errors.ts`。

## handle 发现配方

空 descriptor 访问所有启用实体；`row.entity` 是完整 packed handle。

```js
const query = world.query({});
if (!query.ok) throw query.error;
return Array.from(query.value, (row) => row.entity);
```

带组件数据时从所属包导入 token，并声明 `read` / `write` / `optional` / filter 角色：

```js
const { MeshRenderer } = await _import('@forgeax/engine-render');
const { Transform } = await _import('@forgeax/engine-scene');
const query = world.query({ read: [Transform], with: [MeshRenderer] });
if (!query.ok) throw query.error;
return Array.from(query.value, (row) => ({
  entity: row.entity,
  position: Array.from(row.get(Transform).pos),
}));
```

## 读写配方

### 读组件值

```js
const { Transform } = await _import('@forgeax/engine-scene');
const query = world.query({ read: [Transform] });
if (!query.ok) throw query.error;
return Array.from(query.value, (row) => ({
  entity: row.entity,
  position: Array.from(row.get(Transform).pos),
}));
```

`Transform.pos` is the flat `array<f32, 3>` column; row `i` starts at
`i * 3`. `quat` and `scale` use strides 4 and 3 respectively, and query
bundles do not expose `.x` / `.y` / `.z` sub-fields.

### 写组件值 / 生命周期

```js
// spawn——带组件
const scene = await _import('@forgeax/engine-scene');
const h = world.spawn({
  component: scene.Transform,
  data: { pos: [0, 5, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] },
}).unwrap();

// set——直接修改已存在实体的组件值
world.set(h, scene.Transform, { pos: [1, 2, 3] });

// despawn
world.despawn(h);
```

eval 无任何写入拦截——`spawn` / `set` / `despawn` 直接执行，不会返回 `inspector-write-denied`（该错误码已随 sandbox 删除）。危险操作（`renderer.dispose()` 等）见末尾 NOTE。

## debugAdapter 帧抓取

eval 内通过第 4 活根 `debugAdapter` 做 RHI 帧抓取：

```js
// 抓取当前帧的稳态 tape（结构化 draw-call 数据）
const capture = await debugAdapter.captureFrames(1, 'my-snapshot');
const tape = capture.tapes[0];
// tape.tapePath is the on-disk handoff for RHI-debug summary / inspect-offline

// per-draw inspect
const draw = await debugAdapter.inspectAt(tape.tapePath, 3);
// draw.pipelineState / draw.bindings / draw.renderTargetPNG
```

离线子命令（`inspect-offline` / `summary` / `trigger-browser`）是纯本地工具，不连 WS，不受 eval 收编影响。详见 [`forgeax-engine-rhi-debug`](../forgeax-engine-rhi-debug/SKILL.md)。

## Profiler artifact path

When the host passes the public `profiler` capability to `createApp`, use the existing `eval`
method to start a bounded capture. This adds no RPC method and does not change the remote transport.

```js
if (profiler === undefined) return { ok: false, error: { code: 'profiler-not-enabled' } };
const started = profiler.startCapture({ frameLimit: 120, eventLimit: 1024 });
if (!started.ok) return started;
// Drive the live App, then finish and persist the returned ProfileCapture.
return started.value.finish();
```

For offline analysis, use the package bin on the captured JSON:

```bash
forgeax-engine-profiler summary --file profile-capture.json
forgeax-engine-profiler frame --file profile-capture.json --frame-id 12
forgeax-engine-profiler phase --file profile-capture.json --source render --phase record
```

Read `validateProfileCapture` and `buildProfileModel` from the profiler package for schema and
semantic recovery. The profiler covers bounded App/Render CPU evidence only; it is not an ECS span,
GPU timestamp, UI, or external trace path.

## createApp 默认在场

`createApp` dev 模式默认起 remote server，消隐"没 wire 等于没有"黑洞：

```ts
import { createApp } from '@forgeax/engine-app';

const app = await createApp({ canvas });

// dev 模式：app.remote 非 undefined，port > 0
if (app.remote) {
  console.log('remote eval server on port', app.remote.port);
  // 进程内直接 client.eval(...)
  // 或外部工具连 ws://localhost:<port>
}

// production 模式：app.remote 为 undefined（server 不启，天然安全）
```

`RemoteHandle` 类型（`{ port: number; close(): Promise<void> }`）定义在 `@forgeax/engine-types`，host 类型面不静态引 `@forgeax/engine-remote`。

## remote-live：驱动**运行中的浏览器**引擎（环回中继）

> [!IMPORTANT]
> **WS server 只在 Node/dawn-node 活。** `@forgeax/engine-remote/server` 靠 `ws.WebSocketServer`（Node 监听 socket）。**浏览器起不了监听 socket**——所以 `pnpm --filter <app> dev`（:5173）跑起来的真浏览器引擎，`app.remote` 恒 `undefined`，经典 `forgeax-engine-remote eval` CLI 无处可连。这就是"remote 不支持运行时"的真相。

**解法（对齐 editor 的 gateway-live）**：浏览器页面只能**拨出**，没人能拨入。于是 `createApp` 在 dev 里让页面**拨出**一条 WS client 连到本机**环回中继**，中继再把 CLI 的 `POST /eval` 转发给页面，页面在自己的 realm 里跑 ws-free 的 eval 核（`@forgeax/engine-remote/execute`）打到活的 `world`/`renderer`/`assets`/`debugAdapter`。中继是两边都够得着的会合点。

```
 remote-live.mjs  --POST /eval-->  中继 (:5733, Node ws)  --WS /bridge-->  浏览器页面
   (CLI)          <--{ok,value}--   HTTP + WS 会合点        <--{result}--   (拨出)
                                                                           executeScript(...)
```

**opt-in（`VITE_FORGEAX_ENGINE_BRIDGE=1`）**：页面**只有**在 vite 见到该 flag 时才拨中继——`scripts/dev-live.mjs` 会注入它并同时起中继，所以 `node scripts/dev-live.mjs <app>` 一条命令即开。**为什么不默认开**：拨一个没起的中继会让**浏览器自己**往 console 打 `WebSocket connection failed`（JS `catch` 拦不住），踩爆所有 zero-console-error 浏览器 smoke（collectathon / hello-*）。所以裸 `pnpm --filter <app> dev` 和 CI 永远静默。production 整块 DCE（零注入）。中继起了、页面尚未连上时静默重连退避（1s→15s），不刷屏。

**帧起始 drain（确定性）**：WS `message` 可能落在 rAF tick 任意相位，页面**不内联 eval**，而是入队、在 `app.registerUpdate`（帧起始）里 drain——每次 bridge 写都保证过这一帧的 systems，跨运行可复现。代价：回复延到那次 drain（亚毫秒）；**页面被切到后台 → rAF 暂停 → drain 停 → 30s 超时**，保持窗口前台。

**安全**：中继给"任何能 POST 到 :5733 的东西"授予"在页面里跑任意 JS"。仅 loopback、仅 DEV、只由 dev 栈启动。**绝不**对 production / 公网暴露。

### 用法

```bash
# 一条命令起中继 + 选定 app 的 vite（bridge 默认开，无需注入 env）：
node scripts/dev-live.mjs @forgeax/remote-demo
# → 中继 :5733 + vite :5173；浏览器打开 http://localhost:5173

# 另一个终端，页面 boot 完后：
node skills/forgeax-engine-cli/scripts/remote-live.mjs --health
# → {"ok":true,"pageConnected":true}，exit 0

# 读：从活的浏览器 world 发现 handle
node skills/forgeax-engine-cli/scripts/remote-live.mjs \
  "const q=world.query({}); if(!q.ok) throw q.error; return Array.from(q.value,row=>row.entity)"

# 写：直接改活实体，屏幕立刻动（无 rebuild/refresh）
node skills/forgeax-engine-cli/scripts/remote-live.mjs \
  "world.set(<h>, (await _import('@forgeax/engine-runtime')).Transform, {pos:[5,0,0]})"

# 从文件读脚本
node skills/forgeax-engine-cli/scripts/remote-live.mjs --file snippet.js

# 换端口（中继 + CLI 都读同一 env）
FORGEAX_ENGINE_BRIDGE_PORT=6001 node scripts/dev-live.mjs @forgeax/remote-demo
FORGEAX_ENGINE_BRIDGE_PORT=6001 node skills/forgeax-engine-cli/scripts/remote-live.mjs --health
```

`remote-live.mjs` 严格 flag 解析：只认 `--file` / `--health`；未声明 flag（如 `--settle`）loud 失败 exit 2，绝不把裸值漏进 code 串。错误码（中继层）：`PAGE_NOT_CONNECTED` / `EVAL_TIMEOUT` / `BAD_REQUEST` / `SEND_FAILED`；eval 层仍是 4 成员 `RemoteErrorCode`。

| script | 角色 |
|:--|:--|
| `skills/forgeax-engine-cli/scripts/remote-bridge-server.mjs` | 环回中继（`GET /health` + `POST /eval` + WS `/bridge`），端口 `FORGEAX_ENGINE_BRIDGE_PORT ?? 5733` |
| `skills/forgeax-engine-cli/scripts/remote-live.mjs` | CLI：`--health` / `--file` / positional snippet，POST 到中继 |
| `skills/forgeax-engine-cli/scripts/remote-cli-common.mjs` | 严格 `parseArgs` / `readSnippet` / `printResult`（SSOT，防 flag 漏入 code） |
| `scripts/dev-live.mjs` | 一条命令起中继 + `pnpm --filter <pkg> dev` |

> [!NOTE]
> **remote-live 与 WS server 正交**：浏览器用 remote-live（中继），Node/dawn-node 用 WS server（`FORGEAX_ENGINE_REMOTE_SERVE=1`）。两条路都收束到同一个 `executeScript` eval 核 + 同一 `RemoteError` 模型；`app.remote` 语义不变（浏览器里仍 `undefined`，bridge 与它无关）。

## RemoteErrorCode 闭集（4 成员）

```mermaid
stateDiagram-v2
    direction LR
    script-syntax-error: 脚本语法错
    script-runtime-error: 脚本运行期抛错
    server-startup-failed: server 起不来（端口被占等）
    server-not-running: server 未运行（客户端尝试连接但 host 未起）
```

| code | JSON-RPC 段位 | `.expected` | `.hint` |
|:--|:--|:--|:--|
| `script-syntax-error` | -32001 | `'script body is valid JavaScript'` | `'check syntax position in errMessage; fix and resubmit'` |
| `script-runtime-error` | -32002 | `'script executes without throwing'` | `'inspect error; verify symbol availability; eval has full access to world/renderer/assets'` |
| `server-startup-failed` | -32003 | `'server starts successfully on requested port'` | `'check if port is already in use (default 5732); pass different port; or kill existing process holding the port'` |
| `server-not-running` | -32004 | `'server is reachable at ws://localhost:<port>'` | `'start the demo first; verify app.remote is wired; pass --port to override default 5732'` |

消费方式——`switch (err.code)` 穷举 4 成员，无 `default` 分支（TS 严格模式守完整性）：

```ts
import { RemoteError, type RemoteErrorCode } from '@forgeax/engine-remote';

function recover(code: RemoteErrorCode): string {
  switch (code) {
    case 'script-syntax-error':     return 'fix script body syntax and resubmit';
    case 'script-runtime-error':    return 'inspect stack trace; verify symbol availability';
    case 'server-startup-failed':   return 'pick a different port or free port 5732';
    case 'server-not-running':      return 'start demo dev or wire app.remote';
  }
}
```

## CLI plugin bin

plugin bin 是各能力包自带的独立可执行文件，进程外直接调用：

### Offline AssetEvidence probe

`forgeax-engine-remote-asset lookup` and `verify` have a machine-readable evidence form:

```bash
forgeax-engine-remote-asset lookup --guid <guid> --project <project> --catalog <catalog.json> --json
forgeax-engine-remote-asset verify --guid <guid> --project <project> --catalog <catalog.json> --json
```

The probe joins source inventory, catalog `packageUrl`/`cookReceiptUrl`, the producer `CookReceipt`, Pack v2 descriptors, and artifact bytes. Success writes one `AssetEvidence` JSON object. Failure writes exactly one structured JSON object to stderr with `code`, `expected`, `hint`, and optional `detail`; there is no WS connection. Read `notCooked`, `ready/current`, `ready/stale`, `unknown`, `notChecked`, `passed`, and `failed` literally and follow the `.hint` recovery action. A catalog row by itself is navigation, not proof.

```bash
# ECS 查询
forgeax-engine-remote-ecs entities
forgeax-engine-remote-ecs entities --with Transform,Velocity --without Frozen
forgeax-engine-remote-ecs systems
forgeax-engine-remote-ecs components

# 资产扫描/校验
forgeax-engine-remote-asset scan ./assets
forgeax-engine-remote-asset verify
forgeax-engine-remote-asset lookup <guid>

# glTF 导入
forgeax-engine-remote-gltf import ./model.glb

# 字体烘焙
forgeax-engine-remote-font bake ./font.ttf

# 状态机查询
forgeax-engine-remote-state list
forgeax-engine-remote-state get <tokenName>

# 切端口
forgeax-engine-remote-ecs entities --port 5731
```

## 踩坑

- **eval 内不能用裸 `import`**：脚本作用域不认 `import` 关键字——用注入的 `_import(specifier)` 函数做动态 ESM 引入。`const ecs = await _import('@forgeax/engine-ecs')`。
- **`world.query` 返回 `Result`**：先处理失败，再迭代 `result.value`；不要忽略 descriptor 冲突或 span capability 错误。
- **`app.remote` 为 `undefined`（尤其浏览器里）**：`app.remote` 是 **Node WS server** 句柄。浏览器起不了监听 socket，`createApp` 尝试 `startServer` 会在 `ws` 浏览器 shim 上抛错并被静默吞掉 → 浏览器 dev 里 `app.remote` 恒为 `undefined`。想在**运行中的浏览器引擎**里 eval，用下面的 **remote-live** 环回中继（不是 `app.remote`）。dawn-node / headless 无 GUI 时才用 WS server：设环境变量 `FORGEAX_ENGINE_REMOTE_SERVE=1` opt-in（源码 SSOT：`packages/app/src/internal/remote-serve-flag.ts`）。
- **plugin bin 找不到**：确认 `@forgeax/engine-{ecs,pack,font,gltf,state}` 已安装（`pnpm install`），bin 会自动出现在 `node_modules/.bin/`。

## 深入

- 包定位 / RemoteError 类 / RemoteErrorCode SSOT / 物理隔离 gate：见 `packages/remote/README.md`
- 错误模型源码：`packages/remote/src/errors.ts`
- eval 执行引擎源码：`packages/remote/src/execute.ts`
- server 源码：`packages/remote/src/server.ts`
- `RemoteHandle` / `RemoteErrorCode` / `RemoteError` 类型定义：`packages/types/src/index.ts`
- 5 个 plugin bin 的 owner 包源码：`packages/ecs/src/cli-ecs.ts` / `packages/pack/src/cli-pack.ts` / `packages/font/src/cli-font.ts` / `packages/gltf/src/cli-gltf.ts` / `packages/state/src/cli-state.ts`

## RHI 录帧 CLI（capture-frame / inspect-at / inspect-offline / summary）

> `@forgeax/engine-rhi-debug` 的 `capture-frame` / `inspect-at` 子命令经 `client.eval` 通道（构造 `debugAdapter.captureFrames(frames, label?)` / `debugAdapter.inspectAt(tapePath, drawIdx, fields?)` 脚本发送），不再走独立 JSON-RPC method。离线子命令 `inspect-offline <tape> <drawIdx>`（自举 dawn-node，per-draw，输出含 `pipelineState`）与 `summary <tape>`（纯函数零 GPU，整帧 `FrameModel`——RHI debug viewer 与 CLI 同一 SSOT）不连 WS。flag 表、输出 schema、症状定位工作流全在 [`forgeax-engine-rhi-debug`](../forgeax-engine-rhi-debug/SKILL.md)（SSOT）。

## forgeax-engine-remote-state plugin bin

> `@forgeax/engine-state` provides a CLI plugin bin for inspecting state machines. Two subcommands, discoverable via the `forgeax-engine-remote-` prefix scan.

### list

```bash
forgeax-engine-remote-state list
```

Output format: one line per registered state token:

```
<tokenName>: <currentVariant> (variants: <variant1>, <variant2>, ...)
```

If no state tokens are registered, prints `(no state tokens registered)`.

### get

```bash
forgeax-engine-remote-state get <tokenName>
```

Prints the current variant string for the named state token. Exit code 0 on success, exit code 1 with structured error on unknown token name or if `getState` returns `Result.err`.

### Deeper

- Plugin bin source: `packages/state/src/cli-state.ts`
- State machine API surface: [`forgeax-engine-state`](../forgeax-engine-state/SKILL.md)

---

> [!CAUTION]
> **危险 API NOTE**：eval 全开可读写——脚本内可以调用 `renderer.dispose()`（销毁 GPU 上下文、整个 app 崩溃）、`world.despawn` 批量清实体、`AssetRegistry.clear()` 等破坏性操作。引擎不做代码层拦截。production 环境的天然安全来自不起 server（`app.remote` 为 `undefined`）；dev 环境的保护靠开发者自觉。AI 用户在 dev 模式 eval 前确认脚本不含毁灭性 API 调用。

## Visibility diagnostics quick start

Use the existing `introspect` and `eval` surfaces; there is no visibility CLI
command. First inspect `components.schemas.Visibility`, then evaluate the
same live path used by the app:

```ts
const render = await _import('@forgeax/engine-render');
const query = world.query({ read: [render.Visibility] }).unwrap();
for (const row of query) console.log(row.get(render.Visibility).state);
console.log(render.resolveVisibility(world).effective(entity));
console.log(renderer.visibilityStats);
```

| Signal | Meaning | Recovery |
|:--|:--|:--|
| `current` | Component intent currently stored in ECS | Use reflected labels and retry a rejected `world.set` |
| `effective` | Parent-resolved state consumed by render candidates | Repair `snapshot.diagnostics` when hierarchy input is invalid |
| `visibilityStats` | Renderer count for explicitly hidden candidates | Inspect the real render path; do not add an RPC or CLI method |

The remote server receives a JSON-safe registry projection from app. It keeps
the two existing methods and the closed `RemoteError` shape; production remote
still has no ECS, render, or runtime dependency. Camera, picking, lifecycle,
assets, material authoring, and VFX shadow policy are out of scope.

## Simulation inspection through the existing front door

Discover the `simulation` root from `introspect`, then read
`simulation.inspect()` through existing `eval` transport. Consume the summary
fields and schema; do not add a Remote/CLI restore or replay method and do not
return raw World, Rapier, or Web Audio objects.

For errors, switch on the closed `code` and use `expected`, `hint`, and
`detail`. Repair the owner or fresh target and inspect again. RHI tape replay
and game replay have separate commands and evidence owners.
