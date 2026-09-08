# ForgeaX Engine 能力目录

> [!IMPORTANT]
> 本文按 **一个特性一行** 盘点当前 Engine 工作树中可由公开契约、源码或真实示例确认的能力；“形态”描述交付边界，不代表稳定性等级，也不把结构 smoke、调试后端或教学示例冒充视觉验收。

> [!NOTE]
> 这是首个带可复现版本身份的正式扫描；旧清单只记录了 2026-08-25，没有 commit，所以本次使用保守范围复查。

| 扫描事实 | 值 |
|:--|:--|
| 能力内容基线 | `e5cddd16fe6796b85559945c9637bd67faffbcc7`（`sdk-v0.1.6`）；这是本轮能力复查的源码基线，不是 SDK 归档身份。精确归档身份由 `sdk-manifest.json#engineCommit` 与发布 semver 决定。 |
| 完成时间 | 2026-08-27 20:14:08 UTC+08:00；2026-08-27 12:14:08 UTC |
| 本次复查范围 | `f58184ad3d3430ee6b27d6cac408b75748f5e5d6..e5cddd16fe6796b85559945c9637bd67faffbcc7`；本轮同时核对 Render core、App/Catalog、Pack/Meta、Shader portability、外部资产和 SDK 交付闭环。 |
| 下次增量范围 | `git diff --stat e5cddd16fe6796b85559945c9637bd67faffbcc7..HEAD`；审查受影响 package README、公开 exports、focused skill、CLI operation 与真实 gate，完成后推进基线。 |

这份目录回答“Engine 有什么、边界在哪里”；它不是游戏启用清单。锁文件或 SDK 中包含某个 package 只证明能力可用，不证明当前游戏已注册组件、pipeline、plugin 或资产。

## 版本增量导览：SDK v0.1.4 → v0.1.6

> [!IMPORTANT]
> 上面的能力表是当前快照；本节补上“这些能力何时、因何进入 SDK”的历史索引。版本边界以可复现的 SDK tag 为准，而不是 npm 发布日志或 PR 标题。`sdk-v0.1.4` 是本次增量起点，`sdk-v0.1.5` 带入绝大多数 Engine/DevKit 代码变化，`sdk-v0.1.6` 没有新增运行时能力，主要修复了 carrier/canonical kit 的交付闭环。

| SDK tag | Engine commit | 时间（UTC+08:00） | 这次扫描中的定位 |
|:--|:--|:--|:--|
| `sdk-v0.1.4` | `991e857eeb8e5adcaebe147cffa1853264ab3887` | 2026-08-26 19:29:41 | 增量起点；已有能力以本目录当前快照为准。 |
| `sdk-v0.1.5` | `2d24560bf4e6677def8228f04f1f443d1c7d558a` | 2026-08-27 18:47:06 | `sdk-v0.1.4..sdk-v0.1.5` 的 Engine、资产、渲染和 DevKit 关键变化集中落点。 |
| `sdk-v0.1.6` | `e5cddd16fe6796b85559945c9637bd67faffbcc7` | 2026-08-27 19:09:27 | `sdk-v0.1.5..sdk-v0.1.6` 只有 SDK 归档/发布面修复，没有新的 Engine runtime API。 |

### `0.1.4 → 0.1.5`：引擎和创作链的关键变化

下表按消费者会遇到的契约分组；括号中的 commit 是可直接 `git show` 的证据锚点。它不是把 `sdk-v0.1.4..sdk-v0.1.5` 的 2,661 个文件变更压成“版本升级”四个字，而是说明 Agent 需要改变什么判断。

| 领域 | 关键 Engine 变化 | 对游戏工程的实际影响 | 证据 owner |
|:--|:--|:--|:--|
| Render core | 渲染核心完成 M7 owner 收敛：Standard Pipeline、`RenderScene`、`DeviceScope`、extract → prepare → record 与 FrameReceipt 统一；删除旧 pipeline registry、宽 barrel 和重复单 World 路径。 | 自定义 RenderFeature 必须接入同一条 typed pipeline；不要再寻找旧 registry/legacy facade。先读 `packages/render/README.md` 的 Render happy path。 | `6e4f51db6` |
| Render 状态 | 环境 generation 的失败 stage 由 owner 推导；公开 visibility decoder；Render/Runtime 保留 LKG、health/recovery 与可观察 receipt。 | 失败时按结构化 `code/detail` 修复对应 producer，不以黑屏或 console 文本猜测；可见性诊断直接复用公开 decoder。 | `06ec1fb21`, `336e1ed41`, `1b5e40900` |
| App execution | 执行 realm 携带可序列化的 scoped asset catalog；Host 不把自己的 AssetRegistry/World-bound 对象捕获进 Engine Worker。 | `engine-worker`/`shared` tier 通过 `execution.assetCatalog` 建立 realm 内 Catalog；`CreateAppOptions.assetCatalog` 不能跨 realm。 | `ef34c2713` |
| Pack / Catalog | Pack runtime binding 成为 Catalog SSOT，`vite-plugin-pack` 暴露只读 `runtimeBinding()` 与唯一 `rebind()` seam；ScriptablePack 构建会 stage Meta 外部依赖。 | 开发、预览、Worker 和 production 都从同一 scope/generation 读资产；新增资产先走 `pack`/Meta/importer，不在游戏代码里维护第二份 URL 表。 | `63d6b71af`, `1299fee44`, `c9319b002` |
| Scene | 增加 payload-shaped scene instantiation，公开 projected scene payload 的实例化和 ownership 测试。 | 场景加载可从 Catalog 得到的 payload 建立实体层级；不要绕过 scene owner 手工复制 GUID/Transform。 | `254ca4319` |
| Shader | WGSL portability pass 集中到 shader-compiler，并规范化 Safari 不接受的长 f32 literal。 | 自定义 WGSL 在构建期统一经过 compatibility pipeline；不在 runtime 临时编译或为 Safari 写游戏侧分支。 | `7b1f623f`, `d6f328597` |
| VFX | channel overflow policy 改由 renderer owner 推导。 | VFX source 只声明效果意图；容量/溢出恢复按 renderer capability 和 owner 诊断处理。 | `4053fdd9c` |
| 外部资产 | FBX 恢复 external texture resolver contract；`assets-runtime` 恢复 custom asset kind helper。 | FBX 外部贴图使用统一 resolver；自定义资产 kind 通过公开 helper 注册/识别，GUID 与 Meta 仍是身份 SSOT。 | `51226adc0`, `f8d20f276` |
| 媒体与调试 | 视频 backend kind 从 RHI capabilities 推导；RHI-debug 浏览器 codec 随包打入。 | 按 capability 选择 video lane；浏览器端 `rhi-debug` 不再依赖未声明的外部 codec。 | `a3375408c`, `aa4fc5846` |
| DevKit / 诊断 | bootstrap roots 从 `BaseHost` 推导；CLI/Preview/RHI-debug/GLTF 诊断保留结构化 owner、source key、port 与 build graph 失败信息；benchmark vocabulary 从 report 派生。 | `forgeax doctor`、`preview`、`asset`、`rhi-debug` 的失败应读取 JSON `code/detail/hint`，而不是 grep 日志；按输出的 root/sourceKey/port 找 owner。 | `324161844`, `1b5e40900`, `6eb1b264b` |
| 物理与 App 错误 | `createApp` 保留 dispatch/Worker terminal error，Rapier WASM/plugin 激活失败在创建 PhysicsWorld 前归一化。 | `App.lastError`/`onError` 是 Agent 的故障入口；WASM 失败不会留下半初始化 PhysicsWorld。 | `1b5e40900` |
| ECS 写入安全 | 组件结构写入和已有实体更新统一做 numeric preflight；`NaN` 返回带 entity/component/field/index 的闭合错误，避免部分列写入。 | Agent 生成组件数据时必须先修复 `component-numeric-value-invalid`；不要用 `Infinity`/`NaN` 试探运行时容错。 | `1b5e40900` |
| glTF 输入合同 | required extension admission 增加 `KHR_texture_transform`；source-key 冲突改为带 key、sourceIndices 和 entry 详情的结构化错误。 | 导入前检查扩展和稳定 semantic/name key；材质槽拓扑或 source key 失败时按 `detail` 修复源文件，而不是用 sourceIndex 兜底。 | `1b5e40900` |

### `0.1.5 → 0.1.6`：交付面变化

| 变化 | 影响 | 证据 |
|:--|:--|:--|
| canonical kit 使用独立输出目录 | SDK 构建不再把验证/烹饪副作用写回 contributor checkout。 | `e5cddd16f` |
| npm carrier 根级 README、元数据和 publish guard | `@forgeax/engine-sdk@0.1.6` 的 npm 页面可直接读到安装/初始化入口；缺 README 或版本闭包会 fail-closed。 | `e5cddd16f` |
| carrier 去掉 offline store，完整 ZIP 保留 `store/pnpm/` | npm 适合联网安装，ZIP 继续提供离线闭包；两者仍共享同一锁文件和裸 `packages/`。 | `e5cddd16f` |

> [!NOTE]
> 同一范围还包含 Snake M16 网络重连、parity fixture 和 required-CI/harness 调整。它们分别是 demo/evidence 或交付基础设施，不应被 Agent 当成新的 Engine runtime 能力；需要追踪时请单独查看 `4d1fdc8b0`、`0cbf6dba5`、`b820923da` 等提交。

### 下次更新怎么扫

以本节最后一个 tag 作为冻结基线，先看引擎代码再看交付文件：

```bash
git log --first-parent --oneline e5cddd16fe6796b85559945c9637bd67faffbcc7..HEAD -- packages scripts skills templates
git diff --stat e5cddd16fe6796b85559945c9637bd67faffbcc7..HEAD -- packages scripts skills templates
```

只把有公开 owner、README/export 和真实 gate 的变更加入“关键 Engine 变化”；CI、demo、parity 或 Harness 变化放入末尾的非能力说明。更新表格后，同时推进顶部“能力内容基线/完成时间/下次增量范围”，这样下一次 Agent 不会把历史快照误当成新增能力。

## 阅读约定

| 形态 | 含义 |
|:--|:--|
| **内建** | 当前公开运行时或核心包直接提供的能力；仍可能受具体数据和平台限制。 |
| **按需** | 需要显式配置、安装 feature/pipeline/plugin，或通过 capability gate 后才启用。 |
| **构建期** | 只在导入、cook、编译、打包或离线验证阶段运行，不进入 player runtime。 |
| **宿主侧** | 浏览器/Node/桌面 Host 持有的能力，不跨入 ECS World、Engine Worker 或 Kernel Worker。 |
| **开发期** | 调试、检查、证据或开发服务器能力；生产默认关闭或应被 tree-shake。 |
| **测试/实验** | 只证明结构、确定性或探索性结论，不等于真实 GPU/产品路径。 |

## 导航

| 分类 | 内容 |
|:--|:--|
| [版本增量导览](#版本增量导览sdk-v014--v016) | `sdk-v0.1.4`、`sdk-v0.1.5`、`sdk-v0.1.6` 的 tag、Engine commit、关键变化与升级影响。 |
| [渲染管线与画面效果](#渲染管线与画面效果) | Renderer、URP/HDRP、RenderGraph、光照、阴影、后处理与环境。 |
| [材质、Shader 与几何](#材质shader-与几何) | MaterialAsset、WGSL、几何布局、场景、动画、2D 与媒体。 |
| [GPU、RHI 与 VFX](#gpurhi-与-vfx) | RHI 后端、GPU-driven、帧图、GPU 粒子。 |
| [核心架构与 ECS](#核心架构与-ecs) | 类型、数学、World、查询、关系、调度与状态机。 |
| [App、输入与插件](#app输入与插件) | Host frame loop、执行 tier、多 World、输入与 Cordis/DSH。 |
| [物理、音频、网络与智能](#物理音频网络与智能) | Rapier、Web Audio、Replication、Activity 与 NPC。 |
| [资产与内容生产](#资产与内容生产) | GUID、Pack、Importer、DDC、Catalog、格式导入与 runtime load。 |
| [AI 工具、检查与交付](#ai-工具检查与交付) | CLI、Preview、Profiler、Remote、RHI-debug、SDK。 |
| [当前未计入已交付清单](#当前未计入已交付清单) | 尚未形成真实 owner 或仅有局部投影的候选能力。 |

---

## 渲染管线与画面效果

### 渲染核心

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Renderer 抽取—准备—记录 | **内建** | 从 ECS World 抽取渲染事实、准备持久资源并记录 GPU 命令；`runtime` 只组装具体服务，不复制渲染域。 | `render` · `runtime` |
| `createRenderer` 组装入口 | **内建** | 选择 RHI/backend、创建 AssetRegistry 与 Renderer，并统一管理 `ready/draw/dispose`；资产 authoring 与游戏调度不归该入口。 | `runtime` |
| URP 前向管线 | **内建** | `forgeax::urp` 提供阴影、环境、场景、透明、Bloom、Tonemap、FXAA 与输出拓扑，是默认产品管线。 | `render` |
| HDRP 延迟/前向混合管线 | **按需** | `forgeax::hdrp` 提供 G-buffer、deferred lighting、clustered forward、可选 SSAO 与前向透明，需显式注册/安装。 | `render` |
| Typed RenderGraph | **内建** | 以 typed resource、access 与 pass 声明帧图，编译为不可变执行图；不承载 ECS、材质或 pipeline 产品策略。 | `render-graph` |
| RenderGraph 依赖与 barrier | **内建** | 根据 RAW/WAR/WAW 访问、生命周期与 backend kind 推导顺序和 barrier，feature 不另建资源 ledger。 | `render-graph` |
| RenderGraph last-known-good | **内建** | Renderer 在新图编译失败时保留可执行 LKG，并在成功帧中保持单 encoder/finish/submit 事务；LKG/recovery 不属于通用 RenderGraph 包。 | `render` |
| RenderFeature 注入 | **按需** | Producer 通过 extract/prepare/contribute 接入同一张帧图，Active RenderPipeline 决定逻辑目标投影；App 只透传 feature。 | `render` |
| 自定义 RenderPipeline | **按需** | 用户可注册并安装完整 typed pipeline，自行声明 scene、target、feature 与 output topology；不会得到一条隐藏并行管线。 | `render` |
| 自定义全屏后处理 | **按需** | 已编译 WGSL effect 可追加到 pipeline post stage；Shader 编译仍是 build-time owner，不在 runtime 临时编译。 | `render` · `shader` |
| 统一颜色域合同 | **内建** | URP/HDRP 共用 linear HDR → linear LDR → display-encoded 的阶段语义与 `transparent → bloom → tone → fxaa → output` 顺序。 | `render` |
| 持久化 Render Scene | **内建** | 消费 World change evidence，维护稳定 scene id、dirty range、Transform/Material/Instance 表；完整重建仍从 World query 获取。 | `render` |
| 多 World 合成渲染 | **内建** | 一个 Renderer 可合并多个 World 的 renderables/lights，同时显式指定 camera owner 与 singleton resource owner。 | `render` · `app` |
| Frame observation | **开发期** | 在同一帧图中采集当前 linear-HDR frame 的 bounded metadata/readback，用于证据观察；它不新增第二套 capture renderer。 | `render` |
| Renderer 健康与恢复 | **内建** | 以结构化 health、device-lost、internal-fault 与 recoverability 报告失效；实际重建由 Runtime/App owner 发起。 | `render` · `app` |

### 相机、可见性与几何提交

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| 透视相机 | **内建** | `Camera` 支持 FOV、aspect、near/far 与自动 aspect；World/Scene 提供 pose，Render 只消费解析后的变换。 | `render` |
| 正交相机 | **内建** | `Camera` 支持正交范围与 near/far，Picking 与渲染共用投影语义。 | `render` · `picking` |
| 层级可见性 | **内建** | `Visibility` 沿 `ChildOf` 层级解析 effective state，隐藏项在材质准备前被排除。 | `scene` · `render` |
| 视锥裁剪 | **内建** | 使用 MeshAsset AABB 与 `Transform.world` 做 frustum culling；包围盒事实由 geometry/import producer 提供。 | `render` · `math` |
| Layer 与排序键 | **内建** | Layer/SortKey 提供可见层和稳定排序事实，透明排序仍由 renderer 统一完成。 | `render` |
| 透明材质排序 | **内建** | 透明 draw 按相机距离、layer 与稳定键排序；Blend/depth/cull 等状态来自 MaterialAsset，而非实体侧临时开关。 | `render` |
| GPU Instancing | **内建** | `Instances` 承载批量 instance-local transforms，支持 glTF `EXT_mesh_gpu_instancing` 与普通引擎实例化路径。 | `render` · `gltf` |
| 多子网格/多材质 | **内建** | 一个 MeshAsset 可含多个 submesh，`MeshRenderer.materials[]` 与 `materialSlots` 对位选择材质。 | `types` · `render` |
| 混合 primitive topology | **内建** | 不同 submesh 可使用 triangle-list、line-list 等 topology 并选择各自 PSO；debug line 不要求独立 mesh 系统。 | `geometry` · `render` |
| Shadow participation | **内建** | `castShadow` 与可见性共同决定 caster 资格；VFX/特殊 producer 仍由各自 feature 声明阴影边界。 | `render` |

### 光照、阴影与环境

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Standard PBR | **内建** | 金属度/粗糙度 PBR 消费 base color、normal、metallic、roughness、emissive、occlusion 与 IBL；参数合同来自 MaterialAsset。 | `shader` · `render` |
| Unlit shading | **内建** | 无光材质只消费材质/纹理与 render state，不注入 direct light 或 IBL 策略。 | `shader` · `render` |
| Directional Light | **内建** | 使用方向、线性 RGB 与 lux 强度，可参与 CSM；太阳自动化只在 Atmosphere 环境链中显式发生。 | `render` |
| Point Light | **内建** | 使用 Transform、candela、米制 range 与平方衰减窗口，可选 cube-array shadow。 | `render` |
| Spot Light | **内建** | 使用 Transform、range、inner/outer cone 与 candela，支持独立 spot shadow atlas。 | `render` |
| 多光源 PBR | **内建** | 从当前 Light components 提取有界 direct-light 集合；DirectionalLight 是单一快照，point/spot 容量受 backend/capability 约束。 | `render` |
| Directional CSM | **内建** | 方向光支持 1–4 cascades、split lambda、cascade blend、depth/normal bias 与 PCF kernel。 | `render` |
| Point cube shadow | **按需** | PointLightShadow 为点光生成六面 cube-array depth atlas；仅有 `PointLight` 不会自动分配阴影。 | `render` |
| Spot shadow atlas | **按需** | Spot shadow 使用独立 2D atlas，当前产品路径最多分配 4 个有效 tile。 | `render` |
| Shadow caster opt-out | **内建** | Material pass 可 `castShadow:false`，让对象保留主 pass 但不进入 shadow caster。 | `types` · `render` |
| Custom ShadowCaster pass | **按需** | 材质可提供 alpha-test/cutout shadow WGSL；Render 只执行已 cook 的 pass，不推断透明纹理阈值。 | `shader` · `render` |
| Skylight IBL | **按需** | 从 equirect 环境生成 diffuse irradiance 与 prefiltered specular cubemap，注入 Standard PBR 间接光。 | `render` · `image` |
| Cubemap Skybox | **按需** | 将环境纹理投影为可见背景；Skybox background 与 Skylight lighting 共用环境资源但语义独立。 | `render` |
| Analytic Sky | **按需** | `Atmosphere` 与同实体 DirectionalLight 构成唯一 analytic environment/Sun source，生成天空背景、sun disc 与环境光资源。 | `render` |
| Environment generation/LKG | **内建** | Atmosphere/IBL GPU bundle 以 generation、ready/failed/LKG 管理，并在设备重建与 TAA inspection 中保持单一状态源。 | `render` |
| Scene Fog | **按需** | World 中零或一个 `Fog` 组件声明线性雾颜色、密度、高度衰减和最大不透明度；URP/HDRP、透明、Sprite、Text、Skybox 与 VFX producer 在 temporal resolve 前共享同一 scene-radiance contract。 | `render` · `shader` · `runtime` · `vfx-render` |
| Fog inspection/LKG | **内建** | Renderer 只在成功提交后发布 accepted Fog revision；冲突或非法参数保留上一份可用事实，并以闭合 RenderError code 指向同一 owner 的修复路径。 | `render` |

### 抗锯齿与后处理

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| HDR scene color | **按需** | 非 `none` tonemap 使用 linear HDR scene target，曝光/曲线在 tone stage 处理；不把教学 exposure shader当成产品 SSOT。 | `render` |
| Tone Mapping | **按需** | Camera 支持 Linear、Reinhard、Reinhard Extended、Cineon、ACES Filmic、AgX 与 Neutral 输出曲线。 | `render` · `shader` |
| Bloom | **按需** | Camera 开启后执行 bright extract、horizontal blur、vertical blur 与 HDR composite 四个 pass；关闭时绕过 bloom 写入/合成。 | `render` · `shader` |
| FXAA | **按需** | Camera 选择 FXAA 后在 tonemap 之后执行 fullscreen FXAA；不分配 TAA history。 | `render` · `shader` |
| MSAA | **按需** | Camera 选择 MSAA 后使用 4× scene/depth attachment 与 resolve target；WebGL2/downlevel capability 可拒绝或降级该 lane。 | `render` · `rhi` |
| TAA | **按需** | 使用 jitter、velocity/depth/reactive coverage、双 history 与单次 resolve，在 unjittered output domain 合成历史。 | `render` |
| TAA history reset | **内建** | `Camera.historyVersion` 是 camera cut/不连续事件的显式 reset 权威；普通相机运动不应递增。 | `render` |
| TAA inspection/recovery | **内建** | Renderer 暴露 bounded temporal inspection、coverage、reset reason、failure 与 recovery；应用不得保留 graph texture 另建 history registry。 | `render` |
| HDRP SSAO | **按需** | 半分辨率 AO raw/blur pass 读取 deferred normal/depth 并调制 ambient；只在 HDRP 配置中启用。 | `render` · `shader` |
| HDRP clustered lighting | **按需** | Storage/compute 路径以 cluster membership、grid 与 light-index list 驱动最高 256 punctual lights；uniform/downlevel fallback 上限为 128。 | `render` |

---

## 材质、Shader 与几何

### 材质与 Shader

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| MaterialAsset 单一路径 | **内建** | 材质沿 `paramSchema → derive → compile/reflect → cook/load → extract/record` 流转，各层不创建兼容材质或 runtime compiler。 | `types` · `shader` · `pack` · `assets-runtime` · `render` |
| Pass-based MaterialAsset | **内建** | MaterialAsset 以 passes、values、render state、parent 与 cooked specialization 表达材质，shader id 是 pass 的组成事实。 | `types` |
| 材质继承 | **内建** | Child material 通过 GUID parent chain 继承并覆盖有效 values/passes；缺失或 stale parent 必须修 producer 后重载同一 GUID。 | `assets-runtime` |
| Material texture transform | **内建** | 每个纹理槽携带 coordinate set 与 transform，Render 消费 cooked 值，不在 app 侧补写 UV。 | `types` · `render` |
| Material render state | **内建** | Depth compare/write、stencil、blend、cull 与 pass tag 由 `MaterialPass.renderState` 决定；primitive topology 归 MeshAsset submesh。 | `types` · `render` |
| Material `paramSchema` 派生 | **内建** | 一个 schema 派生 bind-group layout、uniform offsets、texture fields 与 loader projection，避免手写平行 binding 合同。 | `shader` |
| Material reflection gate | **构建期** | Compiler reflection 必须与 `paramSchema` 派生接口一致，mismatch 在 cook/load readiness 前失败。 | `shader-compiler` · `pack` |
| Runtime Shader Registry | **内建** | Player 按 content-addressed manifest 查找已编译 artifact 并创建 shader module，不携带 Naga/compiler。 | `shader` |
| 内建 WGSL 模块 | **内建** | 提供 PBR、skinned PBR、unlit、sprite、MSDF text、shadow、lighting、BRDF、IBL 与 post-process 模块。 | `shader` |
| WGSL `#import` composition | **构建期** | 按模块 id 组合 WGSL import graph，并检测缺失、冲突与循环；runtime 不解析 source graph。 | `shader-compiler` |
| Shader variants | **构建期** | `#ifdef`/define set 生成确定性 specialization artifact，variant identity 随 cook receipt 进入 runtime readiness。 | `shader-compiler` · `pack` |
| Naga validation/reflection | **构建期** | TypeScript 薄壳调用 Naga WASM 完成 WGSL parse、validate 与 reflection，不持有 renderer policy。 | `naga` |
| Vite Shader plugin | **构建期** | 通过 load/transform/generateBundle/HMR 转发 compiler，发布 WGSL/GLSL/bindings/manifest 并传播跨文件变更。 | `vite-plugin-shader` |
| Custom Material Shader | **按需** | 用户 WGSL 与 MaterialAsset 经同一 cook/load/record 路径工作；示例侧 workaround 或临时 runtime shader 不算引擎材质。 | `shader` · `pack` · `render` |

### Geometry、Scene、Skinning 与 Animation

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| 3D Procedural Geometry | **内建** | 纯函数生成 box、capsule、cone、cylinder、plane、sphere、torus MeshAsset，不创建 ECS entity 或 GPU buffer。 | `geometry` |
| 2D Procedural Geometry | **内建** | 纯函数生成 circle、sector、ellipse、annulus、capsule、rhombus、rectangle、polygon、triangle 与 polyline。 | `geometry` |
| Tangent generation | **内建** | 以面积加权、Gram–Schmidt 与 handedness 生成 tangent vec4，供 normal/parallax mapping 使用。 | `geometry` |
| Canonical vertex layout | **内建** | 从一个 attribute map 派生 location、offset、format 与 stride，Importer、Render 与 Shader 不各写一份布局。 | `geometry` |
| Mesh vertex color | **内建** | `MeshAsset.attributes.color` 是唯一 linear RGBA runtime 事实；glTF `COLOR_0` 与程序化几何汇入该字段，缺失时走白色/no-stream 路径，不增加材质开关。 | `types` · `geometry` · `gltf` · `render` |
| 多 UV set | **内建** | Vertex layout 支持多个 TEXCOORD；shader 要求超过 mesh 实际数量时可合法 alias 最后一套 UV。 | `geometry` · `rhi` |
| Scene hierarchy | **内建** | `ChildOf/Children` 与 `scenePlugin` 维护层级，`Transform.world` 是渲染、物理、音频与拾取的解析 pose 权威。 | `scene` · `ecs` |
| SceneAsset 实例化 | **内建** | 通过 AssetRegistry 将 SceneAsset 事务性实例化为 ECS hierarchy，并在失败时只回滚本次创建的实体/引用。 | `assets-runtime` · `scene` |
| Nested Scene mounts | **内建** | SceneAsset 可挂载其他 SceneAsset 并应用 mount override；引用身份仍由 Catalog/GUID 管理。 | `assets-runtime` · `scene` |
| Renderer-independent Skin | **内建** | `Skin` 与 joint path resolution 归 `skinning`，不持有 Renderer、Material 或 GPU palette。 | `skinning` |
| GPU skin palette | **内建** | Render 由 joint `Transform.world × inverseBindMatrix` 生成 palette 并供 skinned PBR shader 采样。 | `render` · `skinning` |
| AnimationClip playback | **内建** | `AnimationPlayer` 推进 clip 并写 translation/rotation/scale target，最终仍由 Scene Transform propagation 解析 world pose。 | `animation` · `scene` |
| Stable animation target id | **内建** | 目标路径派生稳定 id，普通 Transform 与 skin joint 共用同一个 animation target 模型。 | `animation` |
| AnimationGraph | **内建** | Graph 支持 clip lookup、blend、slot/nesting 与 node weight evaluation，复用 AnimationPlayer schedule 而非另建 FSM。 | `animation` |
| Morph/BlendShape GPU 变形 | **按需** | `createMorphFeature` 在 compute+storageBuffer 可用时处理最多 8 个 morph targets 的 extract/prepare/compute/cull/re-entry；当前不宣称已完成浏览器像素验收。 | `render` |

### 2D、文本、视频与 UI

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Sprite | **内建** | 2D sprite 使用 MaterialAsset/mesh/Layer 与透明排序进入同一 Renderer，不建立 Canvas2D 并行栈。 | `render` |
| Sprite Atlas | **内建** | Asset atlas CLI 生成 PNG/Meta，runtime 的 SpriteAnimation/region override 消费 region 并进入统一 Sprite 绘制。 | `pack` · `render` |
| Sprite Instances | **内建** | 多 sprite region/transform 可走 instanced draw，受 count、uniform/storage capability 与 shader gate 约束；不匹配时分批/fallback 或结构化拒绝。 | `render` |
| Sprite Lit | **内建** | 纯 2D sprite-lit shader 消费 directional、point 与 spot light；仍不把 3D mesh shading policy搬到 Sprite authoring。 | `shader` · `render` |
| Tilemap | **内建** | Tilemap/TileLayer/TileSetAsset 通过 chunk extraction 进入 Renderer；tile authoring 与 GPU record 分属资产/渲染 owner。 | `render` |
| Tile flip/rotation bits | **内建** | 纯数据 codec 编解码 tile flip/rotation flags，不依赖 Renderer 或 World。 | `graphics-extras` |
| TileLayer object semantics | **内建** | Tile object 支持多格、pivot/flip 与多 atlas；`sortScope='per-cell'` 时可与普通 Sprite 做 Y-interleave，不代表内建 Tiled object-layer importer。 | `render` |
| World-space MSDF Text | **内建** | FontAsset glyph metrics 生成/更新 MeshAsset，MSDF shader 支持深度遮挡、透明与 HDR bloom；字体 bake 不在 runtime。 | `font` · `graphics-extras` · `render` |
| Video Texture | **按需** | VideoAsset/VideoPlayer 通过 Host `VideoElementProvider` 获取 `HTMLVideoElement`，Render 以 external-image copy 更新纹理；当前未实现 `GPUExternalTexture` 快速路径。 | `graphics-extras` · `render` |
| Prepared UiAsset | **宿主侧** | HTML/CSS payload 挂载到 open ShadowRoot，UiInstance 拥有 layer、AbortSignal 与幂等 dispose；动态行为由 consumer 提供。 | `ui` |
| UI authoring validation | **构建期** | Headless validator 区分 native、normalizable 与 runtime-bound 内容并输出诊断，不内置 React/Vue adapter。 | `ui` |
| UI preview evidence | **开发期** | 在显式 viewport、DPR、字体、资源、scenario 与 clock 条件下生成 PNG/JSON evidence；不是游戏 Renderer 的第二 UI 管线。 | `ui` |

---

## GPU、RHI 与 VFX

### RHI 与后端

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Spec-aligned RHI | **内建** | math-free、opaque-handle、Result-based、capability-gated 的 WebGPU 形状接口，高层代码不分支具体 backend 名。 | `rhi` |
| Opaque GPU handles | **内建** | Buffer/Texture/Pipeline/Pass 等句柄隐藏 backend 对象，跨包只交换 RHI contract。 | `rhi` |
| RHI capability model | **内建** | Backend kind、features、limits 与可选操作作为数据查询；能力缺失返回结构化结果而非假实现。 | `rhi` |
| Browser WebGPU backend | **内建** | 薄 shim 转发真实 browser GPUDevice、command recording、queue submit、timestamp 与 runtime error。 | `rhi-webgpu` |
| wgpu WASM backend | **内建** | TypeScript shell 通过合并的 Rust wgpu+naga WASM substrate 实现同一 RHI。 | `rhi-wgpu` · `wgpu-wasm` |
| WebGL2 downlevel lane | **按需** | wgpu 在无可用 WebGPU 时可通过 `wgpu-webgl2` 运行受限路径；compute、storage、MSAA 等能力按真实 caps 降级。 | `rhi-wgpu` |
| RhiNull | **测试** | 零 GPU/DOM 的结构 backend，记录 handle/pass/draw/dispatch 生命周期；不执行 shader、validation 或像素 readback。 | `rhi-null` |
| Native wgpu/Ray Query spike | **实验** | 私有 Rust crate 验证 desktop native-wgpu、surface 与 Ray Query；不等于完整公共 native renderer。 | `rhi-wgpu-native` |
| Compute pass | **内建** | RHI 与 RenderGraph 支持 compute pipeline、dispatch 与资源依赖；产品 feature 仍必须声明 capability 和 fallback。 | `rhi` · `render-graph` |
| Indirect drawing | **按需** | 支持 indexed/non-indexed indirect draw，实际生产使用受 `indirectDrawing` 与 storage/compute capability gate。 | `rhi` · `render` |
| Timestamp query | **按需** | Backend 能力允许时提供 GPU timestamp/query contract；CPU Profiler 不拥有或伪造 GPU 时间。 | `rhi` · `rhi-webgpu` |

### GPU-driven rendering

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| GPU Scene tables | **按需** | StorageBuffer capability 可用时，从持久 CPU Render Scene 派生 Primitive、Instance、Transform、DrawTemplate 与 Material 表；否则走 CPU lane。 | `render` |
| GPU view culling | **按需** | Compute kernel 对 eligible rigid objects做视图裁剪，普通 CPU/specialized lane 仍处理不满足条件的对象。 | `render` |
| GPU draw compaction | **按需** | 将可见实例压缩为有界 stream 并写 indirect args，overflow 作为显式 inspection/error 事实暴露。 | `render` |
| CPU capability fallback | **内建** | Compute/storage/indirect 不可用或对象不合资格时回到 CPU/specialized record，不模拟不存在的 GPU 能力。 | `render` |
| Deferred membership timing | **开发期** | 以 CPU control 或 GPU timestamp 生成 membership timing 证据，报告 accepted/rejected 与矩阵完整性；App 只透传配置。 | `render` · `app` |

### VFX

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Code-first VFX source | **按需** | Schema-v2 source 以 emitter metadata 与 `vfx_spawn/vfx_update` WGSL hooks 表达行为，不创建节点图或 CPU particle mirror。 | `vfx` |
| VFX compiler/cooker | **构建期** | 组合 managed prelude/shell、验证 Naga reflection 并产出确定性 Pack artifact，World/Renderer 不进入 compiler。 | `vfx-compiler` |
| VFX ECS player | **按需** | `ParticleEffectPlayer` 与 FixedUpdate 产生 ordered intents，按 GUID 加载 cooked program；不直接持有 RHI state。 | `vfx` |
| Persistent GPU simulation | **按需** | GPU buffer 上执行 spawn/update/scan/compact，不把粒子逐帧读回 CPU。 | `vfx-render` |
| VFX indirect rendering | **按需** | Simulation 结果驱动 indirect draw，与 RenderFeature 生命周期绑定。 | `vfx-render` |
| Billboard particles | **按需** | 面向相机的 quad output 使用独立 material/topology/capacity；不是 CPU sprite fallback。 | `vfx-render` |
| Mesh particles | **按需** | 粒子实例可驱动 mesh output，geometry/material 仍通过 cooked VFX contract 进入 renderer。 | `vfx-render` |
| Ribbon particles | **按需** | GPU 输出连续 ribbon topology，容量与 bounds 由 effect asset 显式声明。 | `vfx-render` |
| Trail particles | **按需** | GPU trail output 维护其专用历史/连接语义，不复用 ECS entity trail 列表。 | `vfx-render` |
| Beam particles | **按需** | GPU beam output 使用独立生成与 draw lane，仍共享同一 VFX program/readiness owner。 | `vfx-render` |
| VFX fixed-bounds culling | **按需** | VFX 以 asset fixed bounds 参与 culling；不运行 CPU 粒子 mirror 推导动态 bounds。 | `vfx-render` |
| VFX capability refusal | **内建** | 缺少 compute/indirect 能力时结构化拒绝，不静默切到不同视觉结果的 CPU fallback。 | `vfx-render` |
| VFX inspection/LKG | **开发期** | 暴露 program、buffer、draw、failure 与 recovery 状态并支持 LKG；Browser/Dawn evidence 才能证明真实画面。 | `vfx-render` |

---

## 核心架构与 ECS

### 类型与数学

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| POD/Result SSOT | **内建** | 跨包 POD、`Result`、`ok/err` 与共享结构化错误形状集中定义，具体领域错误 code 仍归所属包。 | `types` |
| Typed Handle | **内建** | `Handle<Target, unique/shared>` 在类型层约束资源标签与释放模式，不承担 GUID 或 Catalog 身份。 | `types` |
| Format-independent asset POD | **内建** | Mesh/Material/Scene/Texture/Skeleton/Skin/Animation 等运行时结构不携带 glTF/FBX 源格式对象。 | `types` |
| Out-param 数学库 | **内建** | 品牌化 Float32Array 的 vec/mat/quat/euler/color 纯函数以 out-param 为主，避免隐藏对象图与分配。 | `math` |
| WebGPU/WebGL/Reverse-Z 投影 | **内建** | 明确提供不同 NDC/depth 约定的投影族，调用方必须选择合同而不是依赖隐式平台状态。 | `math` |
| 3D 几何查询 | **内建** | 提供 frustum、ray、AABB、sphere、triangle 等纯函数相交/投影基础。 | `math` |
| 2D 几何查询 | **内建** | 提供 box2、circle2、ray2 与相交基础，物理/拾取 owner 可复用但不把策略放入 math。 | `math` |
| Color conversion | **内建** | 提供 sRGB/Linear/Hex 等纯函数转换；渲染颜色域与 tone policy 仍归 Render。 | `math` |

### ECS World

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| World 状态权威 | **内建** | World 统一拥有 entity、component、query、system、resource 与 time；Scene/Render/Physics 不另建 ECS facade。 | `ecs` |
| Schema-defined component | **内建** | `defineComponent` 产生冻结 token，支持数值、bool、string、entity、shared 与定长/变长 array 等闭集字段。 | `ecs` |
| Archetype SoA storage | **内建** | 组件按 archetype/column 组织，公开数据面不暴露 Table/Column 内部对象。 | `ecs` |
| Sparse tag component | **内建** | 空 schema 表达 presence-only tag，不需要额外布尔字段或对象实例。 | `ecs` |
| Query row | **内建** | `world.query` 的 row iterator 提供 entity identity 与按 token 的 read/mut，适合灵活 gameplay 访问。 | `ecs` |
| QuerySpan | **内建** | 数值 query 可投影为 packed spans 做批处理，仍由 World 控制写入与 entity 对应关系。 | `ecs` |
| Update schedule | **内建** | 每次 `world.update(delta)` 执行一次可变步 schedule；App 不提供第二套 frame callback DSL。 | `ecs` |
| FixedUpdate schedule | **内建** | World 根据 TimePolicy 执行零到多次固定步并处理 catch-up/drop，Physics 等固定模拟挂在该 schedule。 | `ecs` |
| Deferred commands | **内建** | System 结构修改先进入 command buffer，预期失败在 commit 前保持 World 不变。 | `ecs` |
| ECS Resource | **内建** | World 存放非拥有型 resource 值，外部对象的 dispose 仍由 Cordis/App/feature owner 管理。 | `ecs` |
| Relationship reverse index | **内建** | source 是唯一可写事实，target 是 ECS 物化的只读反向索引，direct children 查询为 $O(1+k)$。 | `ecs` |
| Bounded change projection | **内建** | `ecs/projection` 发布有界 entity/component change journal，溢出只发 rebuild 信号而不复制完整数据面。 | `ecs` |
| Externalization/remap | **内建** | Projection 移除 transient 字段并重写 entity refs；non-portable 字段由消费 profile 校验拒绝，网络 profile/codec 仍归 Net owner。 | `ecs` |
| Shared numeric kernels | **按需** | 只允许 module-loadable named function 与合资格的数值 QuerySpan，拒绝对象字段和结构变更。 | `ecs` |
| World inspection | **开发期** | `world.inspect()` 返回 detached、deep-frozen POD 摘要；不是 live registry 或 storage escape hatch。 | `ecs` |
| World-local ComponentCatalog lease | **内建** | 每个 World 独立租用 component registration；Fiber 释放 lease 时若实体/系统仍在使用则返回 `component-in-use`。 | `ecs` · `plugin` |
| UniqueRef/SharedRef write barrier | **内建** | 每个 World 的 store 与 spawn/set/despawn/removeComponent 屏障维护 resolve/retain/release；payload disposal 仍归外部 owner。 | `ecs` |
| World poison | **内建** | System throw 或共享 kernel partial write 使 World fail-closed 并停止更新；Worker execution 可由 App rebuild，main-serial 由 Host 替换 World。 | `ecs` · `app` |

### State machine

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Typed StateToken | **内建** | `defineState` 创建单 World typed state resource，variant union 在编译期闭合。 | `state` |
| Deferred state transition | **内建** | `setNextState` 请求下一状态，由 transition system 在 Update 中按固定步骤提交 state flip 与范围清理；callback 失败不会事务回滚。 | `state` |
| State-scoped entities | **内建** | `despawnOnExit/despawnOnEnter` 在状态切换时清理标记实体；非 scoped entity 可跨状态保留。 | `state` |
| OnEnter/OnExit hooks | **内建** | 以 state token/variant 的 label/callback 执行钩子；错误沿 ECS system failure 传播，但此前 state flip/部分清理可能已提交。 | `state` |
| `inState` condition | **内建** | 返回 World predicate 门控系统，不创建独立状态调度器。 | `state` |

---

## App、输入与插件

### App 与执行层

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| App Host adapter | **内建** | Host 每帧只测量一次 delta、调用 `world.update` 再 `renderer.draw`；时间、fixed-step 与 gameplay 属于 World。 | `app` |
| Canvas assembly | **内建** | Canvas 入口创建 World、Renderer、默认 plugin、browser input 与 rAF loop，并要求先处理结构化 Result。 | `app` |
| Injected assembly | **内建** | 高级入口接收 host-owned World/Renderer/plugin，不改变各 owner 的生命周期与 time policy。 | `app` |
| Start/stop/pause/resume | **内建** | 管理 frame scheduling 而不复制 World；pause 后的 step 仍复用同一 update/draw 路径。 | `app` |
| Main-serial tier | **内建** | World 与 Renderer 都在 Host realm，tier 本身无 Worker 前置条件；Renderer/GPU 环境仍可能使 App 创建失败。 | `app` |
| Engine-worker tier | **按需** | World、Renderer、Assets、RenderFeatures 与 gameplay plugin 共置 Engine Worker；Host 保留 DOM、Web Audio 与 frame credit。 | `app` |
| Shared tier | **按需** | 在 Engine Worker 外增加持久 Kernel Worker pool 处理合资格 QuerySpan，不拆分 live World 或 RenderGraph。 | `app` · `ecs` |
| Auto tier selection | **内建** | 按 capability 选择最佳已证明 tier 并报告 requested/actual/reason；只有 `auto` 可降级。 | `app` |
| One-credit Worker frame pacing | **按需** | Engine Worker 路径只允许一个在途 frame credit，避免 Worker 排队造成输入/模拟延迟；main-serial rAF 不经过该 ledger。 | `app` |
| Execution report | **内建** | 报告 realm/tier、World health、kernel/audio/capability、performance、fault 与 fallback reason；不把 liveness 当视觉验收。 | `app` |
| Explicit Worker World rebuild | **按需** | `execution.rebuild()` 在 poisoned Worker execution 中创建 fresh World identity；main-serial/local assembly 仍由 Host 重建。 | `app` |
| Surface handoff | **内建** | 可释放/恢复 canvas surface，同时保留 World、Renderer、Assets 与 execution identity。 | `app` |
| Draw source routing | **内建** | 一个 frame loop 可更新/绘制多个 World，并显式指定 camera/resource owner；setter 不创建第二 loop。 | `app` |
| Renderer feature passthrough | **内建** | Main/assemble 路径原样透传 feature/timing；显式 execution tier 必须在 realm bootstrap 内组装，生命周期仍归 feature/Render owner。 | `app` |
| Optional CPU profiler passthrough | **按需** | 只在 capture active 时记录 App/Render phase，默认构造没有 profiler 工作。 | `app` · `profiler` |
| Tool Preview Host | **开发期** | 在同一 App/WebGPU 路径执行 typed action timeline、capture 与 fresh-device replay；隐藏 presentation 不替换 renderer。 | `app` · `preview` |

### Input

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Frozen InputSnapshot | **内建** | Update 开始时扫描 backend 并冻结一帧输入；使用该输入包的 gameplay system 应只读 Resource，Host 仍可有独立 UI/示例 DOM listener。 | `input` |
| Keyboard input | **宿主侧** | 同时提供 logical key 与 physical code 的 held/pressed/released 边沿，并在焦点丢失时复位。 | `input` |
| Mouse input | **宿主侧** | 提供 position、movement delta、button 边沿与 wheel 等帧快照。 | `input` |
| Gamepad input | **宿主侧** | 扫描连接状态、button/value 边沿与 raw axis；deadzone 由 action mapping 层按需应用。 | `input` |
| Multi-pointer input | **宿主侧** | 按 pointerId 提供触摸/笔/鼠标的统一 reader，UI ownership 仍由 Host 决定。 | `input` |
| Pointer Lock | **宿主侧** | Engine realm 只控制 `setPointerLockAllowed`；request/release 与 `pointerLocked` snapshot 由 Host input backend/lockProvider 负责。 | `input` · `app` |
| Action mapping | **内建** | 将 keyboard/mouse/gamepad 映射为设备无关 action，不要求 gameplay 分支具体设备。 | `input` |
| Virtual axis/joystick | **内建** | 提供独立命名空间的 virtual axis 与 virtual joystick，值仍进入同一 InputSnapshot。 | `input` |
| Gesture recognition | **内建** | 识别 pinch、rotate、swipe、long-press、double-tap，并通过 snapshot/action 边界交付。 | `input` |
| Input capability probe | **内建** | 一次性报告 backend/device 能力，不根据用户手势结果伪造可用状态。 | `input` |

### Plugin、Project 与 DSH

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Cordis Context/Fiber | **内建** | Plugin 以 inject/provide/effect 绑定资源、system、listener 与 disposer，Fiber disposal 反向清理副作用。 | `plugin` |
| Static plugin Catalog | **构建期** | DevKit/forge.json 显式生成 browser-safe Catalog 并按 realm 过滤，不在 runtime 扫描 `node_modules`。 | `plugin` · `devkit` |
| Plugin realm placement | **内建** | `host/engine/build` 是唯一放置扩展；同一 plugin 不通过兼容 runner 同时执行两套生命周期。 | `engine-project` · `plugin` |
| `forge.json` manifest | **内建** | 严格校验 project、entry/executionEntry、plugin、defaultScene、physics/input/preview/NPC manifest facts，loader 通过注入 reader 工作。 | `engine-project` |
| Execution bootstrap entry | **内建** | Manifest 指定 realm-local bootstrap，Worker 内部组装真实 owner；Host 不把不可克隆对象塞进 bootstrap data。 | `engine-project` · `app` |
| DSH federation bridge | **按需** | Engine 与 DeepSeek Harness 各自保留原生 Context/Fiber tree，只通过版本化 POD 消息连接。 | `dsh` |
| DSH Engine panel | **按需** | DSH Web panel 可嵌入现有 Engine endpoint；未配置时不向 frame loop 添加工作。 | `dsh` |

---

## 物理、音频、网络与智能

### Physics

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Physics ECS interface | **内建** | 定义 RigidBody、Collider、CharacterController、CollidingEntities、CollisionEvent 与 PhysicsWorld Resource；接口包不实现 solver。 | `physics` |
| 2D Rapier backend | **按需** | Rapier2D WASM 实现三阶段 tick、Transform sync、collision translation、raycast、teleport 与 cleanup；当前没有与 3D 等价的 hello/browser 视觉 gate。 | `physics-rapier2d` |
| 3D Rapier backend | **按需** | Rapier3D WASM 提供对应 3D body/collider、collision、raycast、teleport 与 cleanup。 | `physics-rapier3d` |
| Three-phase physics tick | **内建** | sync backend → fixed-step simulation → Transform writeback，固定步权威来自 ECS World。 | `physics` · `ecs` |
| Rigid body types | **内建** | Static/dynamic/kinematic 由闭合集与 narrowing helpers 表达，backend 负责映射到 Rapier。 | `physics` |
| Collider shapes | **内建** | 2D/3D collider shape 与参数由 ECS schema 表达，source component 是 runtime intent。 | `physics` |
| Collision pairs/events | **内建** | Backend 将碰撞翻译为 ECS-owned transient/query facts，不暴露 Rapier handle。 | `physics` |
| Physics raycast | **内建** | PhysicsWorld 提供 backend raycast；通用 screen picking 仍归 Picking，不混用碰撞与渲染 AABB 权威。 | `physics` |
| Teleport | **内建** | 显式同步 backend body 与 ECS Transform，避免仅改一个状态源。 | `physics` |
| `moveAndSlide` KCC | **内建** | Kinematic character 以 desired delta 解析 slope、autostep、ground snap 与 grounded，并写回最终 Transform。 | `physics` |
| Physics readiness | **内建** | WASM/body 异步准备通过 `hasBody`/结构化错误暴露，gameplay 必须在调用 KCC 前检查。 | `physics` |

### Audio

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Realm-neutral AudioSource | **内建** | ECS 组件表达 clip、play/stop、loop、volume、spatialBlend 与 bus，Engine realm 不持有 Web Audio object。 | `audio` |
| AudioListener | **内建** | 首个 listener entity 的 `Transform.world` 生成 position/orientation intent；Web Audio pose 应用在 Host。 | `audio` · `scene` |
| Host Web Audio backend | **宿主侧** | Host 独占 AudioContext、AudioBuffer、source node、Gain/Panner 与 cleanup；Worker 只传 closed AudioIntent。 | `audio-webaudio` |
| Audio decode cache | **宿主侧** | 以 sourceKey/content identity 复用 decode，bytes 变化时替换 authority；旧 pending completion 不可覆盖新内容。 | `audio-webaudio` |
| SFX/Music buses | **宿主侧** | 固定 `sfx/music → master` topology，支持 bus volume/mute；不宣称任意嵌套 mixer graph。 | `audio-webaudio` |
| 3D spatial audio | **宿主侧** | `spatialBlend` 创建 PannerNode 并同步 listener/source pose；当前默认 equalpower，不宣称完整 HRTF 管线。 | `audio-webaudio` |
| Audio entity epoch fencing | **宿主侧** | stop、replace、despawn 后的旧 decode/play completion 被 entity epoch 与 source identity 拒绝。 | `audio-webaudio` |
| Audio cleanup | **宿主侧** | Entity despawn、stop 与 dispose 释放 source node/cache reference；AudioContext 不跨 realm 序列化。 | `audio` · `audio-webaudio` |

### Networking

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Host-neutral NetEndpoint | **内建** | 只传完整 bytes、PeerId 与连接生命周期，不知道 World、profile、replication 或 codec。 | `net` |
| NetSession | **内建** | 负责 endpoint polling、peer snapshot 与 bounded raw message，规定 receive/publish 时序。 | `net` |
| Replication profile | **按需** | `defineReplication` 固定可移植组件、limits、fingerprint 与 NetEntityId 映射。 | `net` |
| Authority replication | **按需** | Authority coordinator 从 profile 选择的 ECS facts 生成 portable snapshot/message；不复制任意 World 内部。 | `net` |
| Replica atomic validation | **按需** | 在 World mutation 前完成 size、profile、identity、reference closure 与 decode 校验，拒绝时保持 World 不变。 | `net` |
| Browser WebSocket client | **按需** | 将浏览器 WebSocket 映射为 NetEndpoint bytes/lifecycle，不实现 retry、rollback 或 prediction。 | `net-websocket` |
| Node WebSocket client/listener | **按需** | Node 侧提供 client 与 listener adapter；网络产品协议仍由 Net/Profile owner 定义。 | `net-websocket` |
| Memory fault transport | **测试** | 确定性注入 delay、duplicate、malformed bytes 与 disconnect，仅用于 headless contract test。 | `net` |

### Intelligence 与 NPC

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Provider-neutral Activity | **内建** | 提供 bounded submit、ordered poll、cancel 与 terminal failure，不定义 prompt、agent、tool、memory 或 gameplay policy。 | `intelligence` |
| Intelligence MessagePort bridge | **按需** | Host provider 与 Engine realm 通过结构化 Activity POD 交互，credentials 和 SDK object 留在 Host。 | `intelligence` |
| Deterministic fake provider | **测试** | `advance()` 确定性推进 Activity，用于 tests、demo 与离线验证，不模拟真实 provider timing。 | `intelligence-fake` |
| DSH Activity provider | **宿主侧** | 每 Activity 独立 JSON-RPC runtime/process，利用 DSH close semantics 实现取消与清理；DSH 类型不跨 realm。 | `intelligence-dsh` |
| NpcBrain ECS binding | **内建** | 保存 soul id、affordance ref、enabled 与 LOD；prompt/model/navigation/action policy 留给 host adapter。 | `npc` |
| Host-injected NPC adapter | **按需** | Plugin 按 NpcBrain signature change 与 Update tick 调用 host client adapter，并由 Fiber 管理生命周期。 | `npc` · `plugin` |

---

## 资产与内容生产

### 资产身份、Pack 与 Catalog

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| External Meta sidecar | **构建期** | `*.meta.json` 保存外部 source 的 importer、GUID、subAssets 与 provenance；运行时只读 projection。 | `pack` |
| Internal Pack sidecar | **构建期** | `*.pack.json` 表达已准备的内部资产包，不承担外部源格式 authoring。 | `pack` |
| AssetGuid | **内建** | 提供 UUID parse/format/compare/generate 与 builtin derivation，GUID 是稳定 runtime identity。 | `pack` |
| SourceKey identity reuse | **构建期** | Reimport 以 sourceKey 复用 GUID，sourceIndex 只定位源数据，不成为 runtime identity。 | `pack` · `import` |
| Pack scanner | **构建期** | 按 schema、GUID、冲突、缺失/孤儿 Meta、subAsset 与 payload 规则 fail-fast。 | `pack` |
| ScriptablePack | **构建期** | `*.pack.ts` 显式声明 output GUID、sourceKey 与 externalAssets；source 自身不得写 Pack/Catalog 或 World。 | `pack` |
| ScriptablePack executor | **构建期** | Node worker/pool 执行 source closure、cold build、timeout 与结构化 failure。 | `pack` |
| Asset output producers | **构建期** | 注入 producer 生成 Material/Mesh/Scene 等输出并记录 content/reference 依赖，Importer 不硬编码所有资产类型。 | `import` |
| Native cooker registry | **构建期** | Cooker 产出经验证的 cooked payload；runtime 不做源格式转换或静默回退。 | `pack` |
| Producer facts/receipts | **构建期** | Fingerprint、source closure、artifact 与 receipt 由 producer 发布，Catalog 不从 URL 或顺序重建事实。 | `pack` |
| AssetEnvelope refs | **内建** | `refs` 是跨资产依赖图 SSOT，携带 source field 等结构化来源；runtime loader按图递归。 | `types` · `assets-runtime` |
| Asset kind/runtime loader matrix | **内建** | Loader matrix 覆盖 mesh、material、scene、texture、equirect、sampler、font、render-pipeline、tileset、video、skeleton、skin、animation-clip、animation-graph、audio、particle-effect；其中 video 是 runtime URL descriptor，不要求 import/cook。 | `types` · `pack` · `assets-runtime` |
| AssetEvidence | **开发期** | 汇集 build-time source/producer/artifact/catalog/receipt 与可选 runtime state；它是检查证据，`unknown` 明确不等于 passed。 | `pack` · `assets-runtime` |
| Asset authority audit | **开发期** | Schema 与 executable gate 校验每类资产的 author、producer、runtimeSource、Catalog、sourceKey policy 与 owner 边界。 | Engine root schema/scripts |
| Pack index | **构建期** | Build 输出带 hash/artifact locator 的 `pack-index.json`，它是 producer facts 的 projection，不是第二 authoring source。 | `vite-plugin-pack` |
| Catalog authority | **构建期** | 明确 authoritative/degraded、revision、diagnostics 与 producer fields，禁止将不完整 catalog 冒充成功。 | `vite-plugin-pack` |
| Catalog delta | **开发期** | added/changed/removed 只携带 facts，consumer 自行选择 reload/merge policy，Catalog 不执行 decoder/GPU work。 | `vite-plugin-pack` · `assets-runtime` |
| CatalogSource lifecycle | **内建** | Runtime 先 subscribe 后 enumerate，以 GUID 合并完整 row；替换 source 会释放旧 subscription。 | `assets-runtime` |
| Runtime binding SSOT | **开发期** | Vite Pack 的虚拟模块提供 scope/generation-bound binding 与 lazy-import transport；生成 Host 和 AssetRegistry 消费同一 binding。生产构建改用静态 `pack-index.json`，两种 Catalog source 是互斥选择而非顺序覆盖。 | `vite-plugin-pack` · `assets-runtime` · `devkit` |

### Import、Cook、DDC 与 Runtime Load

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| ImporterRegistry | **构建期** | 按 Meta importer key 注册/选择 build-time importer，不进入 player bundle。 | `import` |
| Meta-driven import | **构建期** | 校验 GUID 集并生成 DDC Pack/bin；importer 保持 source → cooked 单向依赖。 | `import` |
| Lazy import transport | **开发期** | Studio/dev host 可按 GUID 请求 import；shipped/null transport 遇到未预导入资产时 fail-fast。 | `import` |
| Import cycle/timeout detection | **构建期** | ScriptablePack build bridge 检测 producer cycle、fingerprint conflict 与 timeout，返回结构化错误。 | `import` |
| Vite Pack plugin | **构建期** | 统一连接 Meta、Importer、Cooker、DDC、Pack 与 Catalog；不拥有 authoring 或 Editor write policy。 | `vite-plugin-pack` |
| Development Pack routes | **开发期** | 提供 pack index、lookup 与 import routes，消费已发布/按需准备的资产。 | `vite-plugin-pack` |
| DDC v2 | **构建期** | Node-only、可丢弃的 derived-data cache；不提供 Save/Undo/Promote 等 Editor 语义。 | `ddc` |
| DDC lifecycle/CAS | **构建期** | Lock、lease、generation、scope、CAS head 与 GC 约束并发 cook 的可验证性。 | `ddc` |
| AssetRegistry | **内建** | Instance-per-renderer 的 GUID→payload catalog、loader dispatch 与 scene instantiate；不写 Meta/Pack/DDC。 | `assets-runtime` |
| `loadByGuid` | **内建** | 从已配置 Catalog/Pack 载入 payload 和 refs，返回具体资产 POD；不 mint app-level generic handle。 | `assets-runtime` |
| LoaderRegistry | **内建** | 资产 kind→loader 映射可由 plugin 以 Fiber lease 注册/撤销；每 kind 保持一个实际 owner。 | `assets-runtime` |
| Recursive ref loading | **内建** | 按 AssetEnvelope refs 递归准备 dependency，遍历机制与具体 asset kind 解耦。 | `assets-runtime` |
| Builtin mesh handles | **内建** | Cube、Triangle、Quad、Sphere、Cylinder、Nine-slice Quad 使用保留 handle/payload，不进入 GUID reference counting。 | `assets-runtime` |
| World shared asset refs | **内建** | 载入 payload 后由 World intern/alloc shared ref，AssetRegistry 不替 World 管实体列引用生命周期。 | `assets-runtime` · `ecs` |
| Scene instantiate transaction | **内建** | Joint/mount/post-spawn 失败时只回滚本次实体、层级与 shared-ref grants，可修资产后重试同一 GUID。 | `assets-runtime` |
| DynamicTextureStore | **内建** | 管理运行时 transient texture 上传与 device replacement invalidation，不取代 source image importer。 | `assets-runtime` |
| Runtime PNG/JPEG decode | **内建** | 只将内存 PNG/JPEG bytes 转 TextureAsset POD，不 fetch 或上传 GPU；KTX2/Basis/HDR/equirect 继续走 codec/image/Pack loader。 | `assets-runtime` |

### 资产格式与内容类型

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Image importer | **构建期** | JPG/PNG/HDR 转 TextureAsset/EquirectAsset 与 raw bin/Basis KTX2；GPU upload 属于 runtime/render。 | `image` |
| Texture compression policy | **构建期** | `auto/etc1s/uastc/none` 按格式、颜色空间与 HDR 规则决定离线编码。 | `image` · `codec` |
| Offline mip chain | **构建期** | 压缩纹理 mip 在 import/cook 阶段生成，runtime 不重建已压缩 mip。 | `image` |
| HDR RGBE import | **构建期** | Image importer 产出 f16 EquirectAsset，runtime loader 负责加载，Render 再投影 cubemap/IBL；frame loop 不解析源文件。 | `image` · `assets-runtime` · `render` |
| Zstd runtime decode | **内建** | Player 只暴露确定性 decompress gate，encode 子路径物理隔离在 build-time。 | `codec` |
| KTX2/Basis transcode | **内建** | 解析 KTX2、选择 GPU target format 并执行 block-aware upload；格式选择受真实 caps。 | `codec` · `assets-runtime` |
| Build-time Zstd encode | **构建期** | `/encode` 子路径产出确定性压缩 artifact，isolation gate 防止进入 player。 | `codec` |
| glTF/GLB parse | **构建期** | 纯函数解析 source/GLB buffer，不直接 fetch、spawn World 或创建 GPU resource。 | `gltf` |
| glTF importer | **构建期** | 产出 mesh、material、scene、texture、skeleton、skin、animation-clip 与稳定 refs。 | `gltf` |
| glTF scene load | **内建** | Consumer 使用统一 `loadByGuid<SceneAsset> + instantiate`，不存在平行 `loadGltf(url)` runtime API。 | `gltf` · `assets-runtime` |
| glTF skin/animation | **按需** | Build-time Importer 产出 joint/clip，runtime post-spawn 解析 joint path；只宣称源码实际支持的 interpolation/morph 范围。 | `gltf` · `skinning` · `animation` |
| FBX WASM parser | **构建期** | ufbx Emscripten WASM 在 Browser/Node 共用，不依赖 Autodesk SDK/native addon。 | `fbx` |
| FBX importer | **构建期** | 产出 mesh、material、scene、texture、skeleton、skin 与 animation clip，并接入 Vite Pack。 | `fbx` |
| FBX material mapping | **构建期** | 映射 StingrayPBS、Phong、Lambert 与 fallback，并将 shininess 投影为 roughness。 | `fbx` |
| Font MSDF bake | **构建期** | TTF 生成 MSDF atlas、glyph metrics 与 sidecars，runtime 不依赖字体工具。 | `font` |
| Font runtime load | **内建** | Font 定义 asset/import，AssetRegistry 递归加载 atlas/sampler，runtime glyph layout system 生成文本 mesh；graphics-extras 只提供纯 layout/bake helpers。 | `font` · `assets-runtime` · `runtime` |
| Audio asset load | **内建** | GUID 路径返回 realm-neutral AudioClipAsset bytes/sourceKey，实际 decode/play 留在 Host Web Audio。 | `audio` · `assets-runtime` |
| Particle-effect asset | **内建** | Pack v2 保存 cooked VFX program/metadata，AssetRegistry `loadByGuid` 返回 payload 后由 consumer 建 shared handle，VFX player/GPU renderer 消费。 | `pack` · `assets-runtime` · `vfx` · `vfx-render` |

---

## AI 工具、检查与交付

### CLI、Tool Runtime 与 Preview

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| `forgeax` CLI front door | **开发期** | 统一 `list → describe → run → terminal`，不再维护第二 operation registry。 | `devkit` |
| Project lifecycle commands | **开发期** | 提供 SDK init、new、project init、doctor、test、dev、build、package、serve 与 preview，并显式路由 project/host/engine owner。 | `devkit` |
| Asset authoring commands | **开发期** | `asset add` 当前创建/复用 image 与 glTF sidecar，verify/inspect/list 负责扫描和查询；不宣称可 author 任意资产 kind。 | `devkit` |
| Asset/format CLI bins | **构建期** | 专用 bin 提供 asset scan/lookup/verify/atlas/meta、glTF import 与 font bake，输出进入既有 Meta/Pack/Catalog 链。 | `pack` · `gltf` · `font` |
| Shader check | **构建期** | 调用 build-time shader validation，不在 live renderer 编译或修复 WGSL。 | `devkit` · `shader-compiler` |
| Plugin install/uninstall | **开发期** | 事务性更新 plugin entry 与 package dependency，失败不留下半安装状态。 | `devkit` |
| Realm dispatch | **开发期** | Operation 分派到 project/host/engine/build owner，缺少 capability 时结构化失败。 | `devkit` |
| ToolContribution | **内建** | Realm-neutral descriptor/executor/snapshot/artifact/terminal contract，不含 filesystem、renderer 或 Editor policy。 | `tool-runtime` |
| Lexical ToolRun terminal | **内建** | Terminal 必须携带 artifact/snapshot/cleanup report，live handle、canvas、Fiber 不得泄漏。 | `tool-runtime` |
| Optional tool service contract | **按需** | Admission 校验 descriptor、recipe、backend、correctness、threshold 与 cleanup；当前没有 admitted service，默认仍走 private executor。 | `tool-runtime` · `devkit` |
| Project preview | **开发期** | 使用真实 project/build/renderer closure 生成 evidence；不以静态缩略图替代运行时。 | `devkit` · `preview` |
| Material preview | **开发期** | 以 GUID 加载 MaterialAsset 并生成 subject-bound capture/report；失败沿资产 readiness 恢复。 | `preview` |
| Mesh preview | **开发期** | 使用统一 AssetRegistry/Renderer 路径展示 mesh；不另建 preview mesh loader。 | `preview` |
| Texture preview | **开发期** | 通过 GUID 资产路径读取纹理并生成 evidence，不绕过 Catalog/Pack identity。 | `preview` |
| VFX preview | **开发期** | 加载 cooked effect、运行真实 GPU VFX host 并生成 evidence；缺能力时结构化拒绝。 | `preview` · `vfx-render` |
| Preview lexical session | **开发期** | `withSession` 管理 binding、frame、capture 与 dispose，并做 live-resource census。 | `preview` |
| Preview evidence artifacts | **开发期** | Report 可携带 RHI tape、PNG 与 profile capture ref，并绑定 subject/revision。 | `preview` |

### Profiler、Remote 与 RHI Debug

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| Bounded CPU Profiler | **开发期** | 以 frame/event limits 记录 App/Render phase、allocation、overflow 与 completeness；不拥有 GPU timestamp。 | `profiler` |
| Profile validation/model | **开发期** | 验证 versioned capture 并构建 deterministic phase/frame summary，不修改原 artifact。 | `profiler` |
| Profile comparison | **开发期** | 对两份 validated capture 生成 phase union 与 side summaries；不运行 live reconnect。 | `profiler` |
| Profiler CLI | **开发期** | 提供 summary、frame、phase、compare 等离线查询。 | `profiler` |
| Live Engine eval | **开发期** | `eval(script)` 直接访问 live World/Renderer/Assets 及可选 diagnostics；不是 sandbox 或 read-only inspector。 | `remote` |
| Remote introspection | **开发期** | `introspect` 返回 OpenRPC L2 subset、roots 与注入 component schema，不创建 remote-owned registry。 | `remote` |
| In-process Remote | **开发期** | Host 内直接 eval，零网络 transport；与 WebSocket 路径共用同一执行 core。 | `remote` |
| Node WebSocket JSON-RPC | **开发期** | Node/dawn host 可在 5732 暴露 eval/introspect；生产默认不启动。 | `remote` |
| Browser loopback relay | **开发期** | 浏览器主动连接 5733 relay，让脚本在 page realm 执行；浏览器本身不伪装成 WS server。 | `remote` |
| Remote full-access boundary | **开发期** | Eval 可写/销毁 live state，安全边界是 Host 是否启动入口，不是方法黑名单。 | `remote` |
| RHI frame tape | **开发期** | 从资源创建前安装 `wrap()` 后捕获 command/resource initial data 与 lifecycle 为 self-contained tape；任意中途接管可能得到 handle-graph-broken。 | `rhi-debug` |
| Deterministic RHI replay | **开发期** | 在 fresh device 复放 tape，并按 capability/format gate 拒绝不可复现输入。 | `rhi-debug` |
| Per-draw inspect | **开发期** | 展开 pipeline state、bindings、draw call 与 render-target PNG，服务黑屏/错纹理/错 binding 定位。 | `rhi-debug` |
| Paired differential | **开发期** | 对显式 baseline/comparison pair 输出 raw-first divergence、resource lineage 与 bounded derived metrics。 | `rhi-debug` |
| RHI debug viewer | **开发期** | 普通模式可 replay/inspect tape；paired-result 模式只消费既有 differential result，不重新 capture、配对或计算第二答案。 | `rhi-debug` · `apps/rhi-debug-viewer` |
| Vite RHI-debug routes | **开发期** | 注入 tape/trigger/artifact dev routes 与 build define，生产构建可 tree-shake capture。 | `vite-plugin-rhi-debug` |
| Immediate-mode Debug Draw | **开发期** | Line、sphere、AABB、frustum、arrow、axes CPU staging wireframe overlay；不创建 Scene asset/entity。 | `debug-draw` |
| Screen-to-entity picking | **内建** | Camera ray 选择最近 renderable AABB，支持 perspective/orthographic；不改变 World。 | `picking` |
| Vertex-level picking | **内建** | 在 triangle-list mesh 上返回 VertexHit；skinned mesh 的 world position 仍是 rest-pose query，交互 policy 留给 gameplay。 | `picking` |
| Tile-cell picking | **内建** | 以 world ray 与 tile layer 返回 topmost cell，不把 tile editing 写入 Renderer。 | `picking` |

### SDK 与仓库交付

| 特性 | 形态 | 内容与边界 | 主要 owner |
|:--|:-:|:--|:--|
| SDK archive build | **构建期** | 组装 built packages/CLI/game closure、clean source snapshot、预构建 WASM、manifest、digest 与 provenance。 | Engine root scripts |
| SDK source mode | **构建期** | `.forgeax-public-distribution` checkout 不依赖私有 asset submodule，可修改 TypeScript 并 `build:engine`；它不是 player runtime mode。 | Engine root |
| SDK ZIP offline bootstrap | **构建期** | SDK root `init` 在临时工程准备 native side-effects cache；`new` 从裸包、模板和不可变 pnpm store 创建 SDK 外部游戏，不重新执行 esbuild/Rapier/WASM postinstall。 | `devkit` · Engine root scripts |
| SDK npm carrier bootstrap | **构建期** | `@forgeax/engine-sdk` 携带同版 CLI、裸包、模板与 skill，但主动省略离线 store；init/new 从公开 npm registry 解析精确锁文件。 | `devkit` · Engine root scripts |
| SDK agent onboarding | **开发期** | `init` 与 `new` 的 JSON/文本输出给出本地 AGENTS、快速导览、正式能力目录与下一命令；游戏安装普通 skill 文件并为支持的 coding agents 建可重建发现链接。 | `devkit` · `forgeax-engine-sdk` skill |
| SDK update discovery | **开发期** | `new` 成功后以有界 best-effort registry 查询比较 `@forgeax/engine-sdk` latest；只提示严格新版本，离线/失败不阻塞，且明确已有游戏保持 pin、必须显式迁移与测试。 | `devkit` |
| SDK exact-archive verification | **构建期** | 校验 schema/digest/exclusion/WASM/skill closure，并从新解压 ZIP 真实执行 init/new/skill verify/doctor/test/build/dev/preview/package 路径。 | Engine root scripts |
| Maintenance CLI | **开发期** | `bun fx setup/update/clean/help` 区分 contributor 与 public source mode，并维护 Harness/submodule/构建边界。 | Engine root scripts |

---

## 当前未计入已交付清单

> [!WARNING]
> 下表不是路线图承诺，只解释为什么一些常见名称没有出现在上面的“已交付特性”中。

| 候选能力 | 当前边界 |
|:--|:--|
| FogExp2 compatibility mode | 当前公开 owner 是一个带 `heightFalloff` 的 `Fog` 组件，没有另一个 FogExp2 组件或模式；`heightFalloff = 0` 是统一密度路径。 |
| Full atmospheric aerial perspective | Scene Fog 已提供沿真实 world-space ray 的高度感知 scene-radiance 衰减，但没有与 analytic atmosphere 介质参数耦合的独立大气散射产品 owner。 |
| Volumetric Clouds | 当前没有公开 component、asset、pipeline 与真实像素链。 |
| Day/Night automation | Analytic Sky 接受显式 Atmosphere/Sun 事实，但 Engine 不拥有时间推进或天体自动化。 |
| Astronomy | 当前没有天体位置/历法/星体系统；Sun linkage 不应扩大解释为 astronomy。 |
| Auto Exposure | 静态 Camera exposure/whitePoint 与 tone pipeline 已实现；缺少的是自动曝光与持续 luminance adaptation owner。 |
| Client prediction / rollback / lockstep | Net 当前覆盖 bytes/session/profile replication，不拥有预测、插值、回滚、锁步、reconnect 或 ownership transfer。 |
| General-purpose Console sandbox | 当前没有受跟踪的 `packages/console` 公共源包；Remote 是 full-access eval，不是安全 sandbox。 |
| Public native Ray Query renderer | 已有私有 Rust `rhi-wgpu-native` spike 与 Tauri proof，但没有公共 TypeScript native RHI/BLAS/TLAS 产品面。 |
| `GPUExternalTexture` video path | 当前视频纹理使用 external-image copy；高性能 external texture 入口尚未形成产品能力。 |

---

## 维护规则

> [!TIP]
> 新增、删除或 materially repurpose 一个公开特性时，应在同一变更中更新对应行；描述必须同时回答“做什么”和“谁不负责什么”，并以当前源码/README/真实 gate 为准，不从旧 loop 名称或 demo 标题推断能力。

- [ ] 新特性是否只有一个 owner/SSOT，而不是兼容层或双栈？
- [ ] Runtime 特性是否有真实 package/export 或 end-to-end consumer 证据？
- [ ] 渲染特性是否区分结构 smoke、真实 GPU 执行与像素验收？
- [ ] 构建期能力是否避免被描述成 player runtime API？
- [ ] Capability-gated、Host-owned、开发期、测试/实验能力是否明确标注？
- [ ] 资产描述是否保持 authoring → import/cook → DDC → Catalog → runtime load → inspection 的 owner 顺序？
- [ ] 是否记录本次 Engine commit、UTC/本地时间，并把下次比较起点推进到该 commit？
