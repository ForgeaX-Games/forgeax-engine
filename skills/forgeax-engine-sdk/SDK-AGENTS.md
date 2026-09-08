# ForgeaX SDK：AI 入口

先读本文件。这个目录同时提供立即可用的浏览器游戏 SDK 和完整公开 Engine 源码快照；除非要修改引擎，不需要先构建 Engine。

该目录可以由 `pnpm dlx @forgeax/engine sdk install <dir>` 从公开 npm
registry 安装。私有 GitHub Release 只是内部归档，用户路径不需要 GitHub
身份。安装完成后 SDK 是普通文件目录，不保留 npm 的 `package/` 包装层。

## 必读引导链

在创建或修改游戏前依次阅读：

1. 本文件：SDK 与工程所有权、初始化和验证约束。
2. [`skills/forgeax-engine-sdk/SKILL.md`](skills/forgeax-engine-sdk/SKILL.md)：五分钟能力导览与“需求 → focused skill → 证据”选择法。
3. [`skills/forgeax-engine-sdk/references/feature-catalog.md`](skills/forgeax-engine-sdk/references/feature-catalog.md)：按已扫描 Engine commit 维护的正式完整能力目录；文件开头先读 `sdk-v0.1.4` → `sdk-v0.1.6` 版本增量导览，再查当前能力快照和低频能力。

`forgeax init` 会把以上绝对路径放进 JSON 的 `value.onboarding.read`，普通文本模式也逐行打印 `read:`，因此从 ZIP、npm carrier 或自动化入口开始都不需要猜文档位置。能力目录表示 SDK 可用能力，不表示新游戏已启用；先按实际游戏需求选择最小集合，再进入对应 focused skill 和 package README。

> [!IMPORTANT]
> `sdk-manifest.json` 是归档内容权威。`packages/` 中每个子目录都是已构建、可直接阅读的公开包，没有 `.tgz` 和额外 `package/` 包装层。不要手改 SDK stage、离线 store 或 manifest。

> [!CAUTION]
> 游戏开发默认走当前工程的 direct edit。只有用户在当前任务中明确同意，才可以启用 ForgeaX closed loop；SDK 或游戏中存在 skills 不等于获得了启动闭环的授权。

## 创建第一个游戏

```bash
node ./bin/forgeax.mjs init          # 下载 SDK 后先做一次环境预检
# 按 init 输出读取 AGENTS、五分钟导览和能力目录
node ./bin/forgeax.mjs new ../my-game
cd ../my-game
pnpm exec forgeax doctor --json && pnpm test && pnpm build
pnpm dev
```

默认模板是 `empty`：它以 `src/main.ts` 作为插件入口，将 starter test 收在 `src/__tests__/`，并包含 `assets/lib.ts + assets/empty-scene.pack.ts` 和一个空 `SceneAsset`。需要干净的 3D 光照基线时：

```bash
./bin/forgeax new ../game-3d --template game-3d
```

> [!IMPORTANT]
> 游戏目标必须位于 SDK 根目录之外。SDK 根及其任何子目录都会在复制文件前返回 `project-target-inside-sdk`；多个游戏应使用兄弟目录或其他外部绝对路径。

先执行 SDK 根的 `forgeax init`：它在临时工程中按 SDK 的 pnpm 11 锁文件安装
native 闭包，允许 `esbuild`、Rapier 和 Engine WASM 的构建脚本，并把成功的
平台元组记录到 `.forgeax/sdk-init.json`。创建是事务式的：`new` 从 `templates/`
复制普通文件，从 SDK 根 `skills/` 安装全部 Engine skills，然后在 staging 目录
以 `--ignore-scripts` 离线安装；native 二进制由 SDK 预检产生的 side-effects cache
复用，不在每个游戏中重新执行 postinstall。完整 ZIP 使用 `store/pnpm/`，npm carrier
则按同一份锁文件联网获取依赖。任何一步失败都会回滚目标目录。成功不得改变 SDK 的
package payload；pnpm 11 只可能更新无 package authority 的 `store/pnpm/**/index.db`
本地缓存。新游戏根目录的 `AGENTS.md` 是完整工程手册，应在写代码或资产
前阅读。

`new` 成功后会以两秒超时 best-effort 查询当前 npm registry 的
`@forgeax/engine-sdk` `latest` tag。发现严格更高版本时只提示，不自动升级：新 SDK
应安装到另一个目录；已有游戏仍锁定原 Engine 版本，需要阅读 release notes 后逐个迁移、
测试。离线、查询超时或 registry 错误不会阻塞或回滚已创建游戏；确定性自动化可设置
`FORGEAX_DISABLE_UPDATE_CHECK=1`。JSON 结果通过 `value.sdkUpdate.status` 区分
`available/current/skipped/unavailable`。

完整 ZIP 创建的游戏会把解压后 SDK 的规范化 `store/pnpm` 路径写入游戏 `.npmrc`；因此
后续从游戏根运行 `pnpm doctor/test/dev/build/preview` 会继续使用同一离线闭包，不会因
pnpm 默认 store 改变而重新解析。npm carrier 没有这个配置，按锁文件使用 registry。

若跳过 SDK 根 `init`，`new` 或外部工程的 `init` 会返回结构化的
`sdk-not-initialized`，不会留下半初始化工程；运行一次 `node ./bin/forgeax.mjs init`
即可恢复。

> [!TIP]
> macOS 下载归档可能带有 Gatekeeper quarantine。只有在确认来源可信且错误明确指向
> quarantine 时，才手动运行 `xattr -dr com.apple.quarantine /path/to/forgeax-sdk`；
> CLI 不会静默绕过系统安全策略。

## SDK 地图

| 路径 | 用途 |
|:--|:--|
| `bin/forgeax` | 独立 CLI；创建工程时从这里启动 |
| `packages/<name>/` | 已构建公开包；`package.json` 与 README 位于目录根 |
| `templates/game-empty/` | 默认最小工程 |
| `templates/game-3d/` | 仅用 `*.pack.ts` 生成 analytic daylight、PBR 材质、程序网格和方向光阴影/点光场景 |
| `store/pnpm/` | 完整 ZIP 中两个模板共享的 pnpm v11 离线闭包；npm carrier 为省体积不携带 |
| `skills/` | 全部 Engine 任务指南；SDK skill 含快速导览和带扫描基线的正式能力目录，`sdk-manifest.json#skills` 记录文件/字节闭包 |
| `source/engine/` | 公共 Engine 源码、包 README、rules/skills 和预构建 WASM |

## 工程、资产和工具

游戏工程的权威结构、`lib.ts` / `*.pack.ts` / `*.pack.json` / `*.meta.json` 分工、GUID 资产链、scene/mesh/texture/material/VFX/UI/audio/video/font/animation 类型、插件 realm、测试构建发布和调试顺序都在模板生成的 `AGENTS.md` 中。游戏根 `skills/` 保存普通文件；`.agents/skills`、`.claude/skills`、`.cursor/skills`、`.codebuddy/skills`、`.workbuddy/skills` 与 `.forgeax/skills` 是可重建发现链接：

```bash
pnpm exec forgeax skill verify --json
pnpm exec forgeax skill install --json
```

CLI 是唯一产品工具入口。优先走机器可读发现：

```bash
pnpm exec forgeax list --json
pnpm exec forgeax describe <operation-id> --json
pnpm exec forgeax run <operation-id> --input request.json --json
pnpm exec forgeax asset verify --json
pnpm exec forgeax shader check --json
pnpm exec forgeax exec inspect.mjs --json
```

无显示器、无物理 GPU 的高级 Linux 开发机若需要同时观察渲染与 HTML/Shadow DOM UI，先读
[`packages/devkit/README.md`](packages/devkit/README.md) 的 CPU-only capture 契约，然后运行：

```bash
pnpm exec forgeax capture --software --require-ui \
  --output artifacts/capture/game-ui.png --json
```

它使用开发态资产链和整页浏览器截图；JSON sidecar 的 adapter 与 browser errors 是证据。
跨机器比较时加 `--deterministic`，并让游戏在 `?forgeaxCapture=1` 模式固定状态后设置
Engine App 的 `frame-submitted` 事件会投影为
`document.documentElement.dataset.forgeaxFrameSubmitted` 和 canvas 的
`forgeax:frame-submitted` 事件；capture 工具先消费这个引擎信号，再检查非平坦 Canvas 像素，
最后才消费游戏发布的 `document.documentElement.dataset.forgeaxCaptureReady` 检查点。等待时间
只是额外 settle，不是确定帧，也不能替代引擎信号或像素证据。
同一局内的输入、断言和多检查点截图走 `pnpm exec forgeax exec <scenario.mjs> --json`：scenario
只开一个 `browser.open({ software: true })` session，使用原生 `session.page` 游玩，在游戏发布
命名 ready 值后多次调用 `session.capture(name)`，最后关闭 session。所有 PNG 追加到同一个
schema-v2 run manifest；不要循环调用一次性 `capture` 重启 World，也不要返回活 Page/session。
不得把 SwiftShader 截图写成物理 GPU 或 release acceptance 结论。

- authoring/import/build：[`skills/forgeax-engine-assets/SKILL.md`](skills/forgeax-engine-assets/SKILL.md)
- CLI、operations、remote eval：[`skills/forgeax-engine-cli/SKILL.md`](skills/forgeax-engine-cli/SKILL.md)
- App、World、插件与 execution tier：[`skills/forgeax-engine-app/SKILL.md`](skills/forgeax-engine-app/SKILL.md)
- ECS/state/physics/audio：`skills/forgeax-engine-{ecs,state,physics,audio}/SKILL.md`
- 材质、WGSL、渲染管线和 GPU VFX：`skills/forgeax-engine-{material,shader,render-pipeline,vfx}/SKILL.md`
- draw/binding/RT/像素问题：[`skills/forgeax-engine-rhi-debug/SKILL.md`](skills/forgeax-engine-rhi-debug/SKILL.md)

## 引擎和画面能力

App 组合 Host、World、Renderer 与插件；ECS World 是游戏态和时间权威；Render 负责 extract/prepare/record；typed RenderGraph 负责资源和 pass；RHI 优先把相同上层路径映射到 browser-native WebGPU，并可通过 wgpu/WASM 的 WebGL2 downlevel lane 运行。单独的 `adapter-unavailable` 或包含 “WebGPU” 的启动提示只描述一个 channel，不能判定用户机器不支持 ForgeaX；必须继续读取最终 `.code/.hint/detail`，其他 Asset/Shader/Pack/App 错误按 owner 修复，禁止为了消除异常而吞入口错误或注入第二套 Canvas 游戏。AssetRegistry 只消费 importer/cooker 生成的 GUID catalog。

对画面最重要的能力包括程序化天空和环境光、Directional/Point/Spot 光源、阴影/CSM、PBR MaterialAsset 与 IBL、GPU VFX、HDR/SSAO/TAA/bloom 等后处理。高级扩展通过 GPU particle、compute/raster RenderFeature、可组合 WGSL 与反射出的 MaterialAsset 参数 schema 完成，作用类似可审查、可编译的材质蓝图。

动态调试按证据深度前进：结构化 CLI 错误 → Playwright 真实浏览器交互/像素 → remote live inspection/profiler → RHI-debug tape、per-draw binding、resource lineage 和 render-target PNG。端口、HTTP 200 或 canvas 存在只说明服务活着，不说明画面正确。

> [!IMPORTANT]
> SDK 的精确 ZIP 验证只接受 distribution 与 canonical template，不替任何具体游戏完成 production acceptance。新游戏模板的 disabled metrics 必须在发布前由游戏自己的 workload 接管。

游戏 production gate 应对最终 `package`/`dist` 的 HTTPS 页面运行至少 300 帧，失败条件包括 App、page、console、uncaptured GPU 与静态资源错误；同时保留目标分辨率/设备、实体与 candidate/draw 峰值、frame-time median/p95。空场景或 canonical SDK verifier 的通过不能替代玩法峰值证据。

## 修改 Engine 源码

只有需要读写引擎本身时才进入 `source/engine/`，然后读其 `AGENTS.md`。该目录是 `git archive` 源码快照，不是嵌套 Git checkout；`.forgeax-public-distribution` 让 `bun fx setup` 跳过私有 submodule。已检查的 `packages/{wgpu-wasm,fbx,codec}/pkg/` 使常规源构建不要求先安装 Rust/Emscripten。

```bash
cd source/engine
pnpm install
pnpm build:engine
```

源码改动需要相关包测试和真实运行证据，再从干净 commit 重建并验证新的精确 ZIP。
