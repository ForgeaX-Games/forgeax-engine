# forgeax-engine 使用手册：路由层

> 你是 forgeax 引擎的**主用户**（AGENTS.md §Core rule）。本 rule 是**常驻路由**——按任务名挑一个 `forgeax-engine-*` skill load 其正文；它**不教 API**，API 教学在各 skill 正文。

> [!IMPORTANT]
> **不要预先 load 全 15 个 skill。** 上下文有限。任务来时按下表选 1 个 load；自然跨域才 load 第 2 个。skill 名字+description 已常驻。

## 任务 → skill 索引

| 任务 | skill |
|:--|:--|
| 引导 app / 跑游戏循环 / 读输入快照 | `forgeax-engine-app` |
| 定义组件 / 写查询与系统 / 关系 / 反射 | `forgeax-engine-ecs` |
| 让东西可见：MeshFilter + MeshRenderer + Material + 灯光（含 `forgeax::sprite-lit` per-light forward） | `forgeax-engine-material` |
| 写自定义 WGSL + registerMaterialShader | `forgeax-engine-shader` |
| 加 pass / 后处理 / tonemap / bloom / fxaa / skybox | `forgeax-engine-render-pipeline` |
| Vec/Mat/Quat/Color / 从 mat4 读 pose / screenToRay | `forgeax-engine-math` |
| sidecar (`*.meta.json` / `*.pack.json`) → 导入 → loadByGuid（glTF .glb/.gltf / FBX .fbx）| `forgeax-engine-assets` |
| inspector (JSON-RPC WS) / kubectl 式 CLI 子命令 | `forgeax-engine-cli` |
| RigidBody / Collider / PhysicsWorld (rapier 2D/3D) | `forgeax-engine-physics` |
| AudioSource / AudioListener / bus 拓扑 | `forgeax-engine-audio` |
| immediate-mode 调试可视化：line / sphere / aabb / frustum / arrow / axes | `forgeax-engine-debug-draw` |
| 拾取 ray/pick：屏幕→实体 `pick` / 顶点级 `pickVertex` / tile-cell `pickTile` / `PickError` | `@forgeax/engine-picking`（无独立 skill,见 `packages/picking/README.md`) |
| 纯逻辑图形附属：字形布局/烘焙 `layoutGlyphText`/`bakeGlyphMesh` / 图块位编解码 `encodeTileBits`/`decodeTileBits` / 视频 `VideoPlayer`/`VideoElementProvider`/`videoLoader`/`probeVideoHighPerfUpload` | `@forgeax/engine-graphics-extras`（无独立 skill,见 `packages/graphics-extras/README.md`；系统入口 `tilemapChunkExtractSystem`/`glyphTextLayoutSystem` 仍在 runtime） |
| 状态机 / defineState / setNextState / 状态 scoped 实体 / OnEnter/OnExit | `forgeax-engine-state` |
| 底层后端（贡献者）：opaque handle / capability / 双实现 | `forgeax-engine-rhi` |
| 渲染 / 测试 / CI 出错 — 症状→根因→修法 | `forgeax-engine-debug` |
| RHI 录帧 / replay / 离线 per-draw inspect (capture→inspect→dispose) — 查 bindings+drawCall+RT PNG 定位渲染症状 | `forgeax-engine-rhi-debug` |

聚合非 1:1 对包：`input` 折进 `app`,`pack` 折进 `assets`,`geometry` 折进 `material`。包名册全表：`AGENTS.md §Packages`。

API 签名 / error 码 / capability 全表 SSOT 在 `packages/<pkg>/src/` 与 `packages/<pkg>/README.md`,skill 正文不复述,顺其"深入"锚点跳。

## feat / bug 合入后维护

任何对 AI 用户面的影响（公共 API 重命名、入口参数变化、`*ErrorCode` 增删、sidecar schema 变化、内置组件/系统默认行为变化、新增 `@forgeax/engine-*` 包、反复踩中的坑）必须在 finalize 前同步对应 skill。plan 阶段加 milestone `M-N: 同步 forgeax-engine-<cluster> skill`,与代码同 PR。direct-edit 也算。

基线：commit [`5c8c90f1`](../../commit/5c8c90f1) (2026-06-03, #297) 一次性产出 11 skill;累积偏离显著时再统一 bump。
