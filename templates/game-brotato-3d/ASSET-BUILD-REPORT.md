# Brotato 3D 资产与性能测量报告

> [!NOTE]
> 本报告针对 `templates/game-brotato-3d` 的最终交付版本。SDK 请求按用户后续更正忽略；本轮重点是视觉反馈、粒子生命周期、真实阴影和长跑性能取证。代码交付入口为 [ForgeaX Engine PR #2649](https://github.com/ForgeaX-Games/forgeax-engine/pull/2649)。

## 结论先行

- 已确认并修复一个引擎内部重建问题：实体在 `FixedUpdate` 中产生 derived `Transform` 后又被销毁时，渲染持久场景会错误地触发 full rebuild。
- 已用真实浏览器复现“一分钟后掉到几帧”：修复前 94.5 秒只收到 `2469` 次 rAF，间隔 p95 `66.7 ms`、p99 `100 ms`。
- 根因已经定位到引擎侧 `rhi-debug`：`destroyBuffer/destroyTexture` 每次都扫描增长中的 `bootstrapCreates`；改成反向依赖索引后，该热点从 5 秒 CPU profile 前列消失，idle 采样约 `3.62 s`。
- 修复后同一浏览器长跑收到完整 `3600` 次 rAF，间隔 p95 `18.4 ms`、最大 `18.7 ms`；Engine Profiler 的 3600 帧 p95 `6.599 ms`，末 300 帧 p95 `7.399 ms`，`0` 帧超过 `16.667 ms`。
- 另修复了模板 HUD 每帧重建生命值 DOM 的分配问题；节点增长从每 10 秒约 6000 个降为一分钟长跑仅增加 `25` 个。粒子关闭与物理关闭对照都没有表现出原先的退化；物理关闭组 p95 `6.5 ms`，且没有物理系统运行。
- 没有用拾取物、粒子或帧率上限掩盖问题；`profileNoPickups=1`、`profileNoParticles=1`、`profileNoPhysics=1` 仅是诊断开关，默认玩法保持不变。
- 已修复引擎侧两级 CSM 图集采样错误：深度 pass 有真实写入，但接收端把 `2048×1024` 的 2×1 图集误当成 2×2，导致可见物体采样错误区域。
- 修复后玩家附近 64 个 GPU 阴影探针中有 55 个检测到遮挡，最小 `shadowFactor=0`；场景投影来自真实网格和方向光 shadow pass，没有额外制造投影物体。

## 资产建设

作者源为 [`brotato-3d.pack.ts`](</Users/you/projects/ForgeaX-Games/forgeax-engine/templates/game-brotato-3d/assets/brotato-3d.pack.ts>)，统一声明：

| 类别 | 当前内容 |
| --- | --- |
| 材质 | 地板、两种砖块、墙、主角、受击态、武器、武器细节、敌人、Boss、子弹、拾取物、VFX |
| 网格 | 地板、两套合批砖场、墙、主角、武器、敌人、Boss、子弹、拾取物、角落装饰标记 |
| 场景 | Arena、Player、Enemy、Boss、Weapon、Projectile、Pickup |
| 光照 | `DirectionalLight`、`Skylight`、真实 `PointLight`、`SkyboxBackground` |
| VFX | `brotato-impact.vfx.wgsl` + `brotato-impact-vfx.pack.json`，GPU 粒子命中特效 |
| UI | `assets/ui/hud.pack.json`，通过 `UiAsset` 挂载 HUD |

砖场不是 225 个独立 ECS 砖块实体，而是两张 A/B 合批网格；砖块颜色使用连续 uniform 材质色阶，避免旧的低分辨率颜色量化纹理造成马赛克感。`Arena Marker` 只是四角装饰网格，不承担阴影或投影功能。

角色、敌人、Boss、武器和子弹均使用独立建模网格。武器是持久实体，包含 receiver、stock、grip、magazine、barrel、muzzle ring 和 top rail；发射时只生成子弹，不重新生成武器。

## 视觉与粒子修复

| 反馈 | 处理与验证 |
| --- | --- |
| 场景偏黑 | 使用方向光、天空环境和真实点光照明；相机保留 ACES 曝光。 |
| 物体没有投影 | 所有场景材质声明 `castShadow: true`，方向光启用两级 CSM；修复接收端紧凑图集 UV 后，主角、敌人、武器和墙体使用各自真实网格投影。源码中不存在影子 blob、压扁圆片或额外投影实体。 |
| 看不到点光 | Pack 中的真实 `PointLight` 调整到 `[7.5, 4.5, 4.5]`，强度 `82`、范围 `14`，形成可辨认的局部蓝色光区；Skylight 调整为 `0.28`，避免均匀环境光洗掉方向光投影。当前未启用 point-light shadow。 |
| 粒子回到原点/消失帧闪烁 | VFX burst 从 `time=0` 开始；VFX RenderFeature 在 `render consumption=false` 后清空投影和 draw，不再提交 retained `lastIntent`；销毁顺序为关闭播放、关闭 render consumption、再 deferred despawn。 |
| 新粒子偶发一帧不显示 | [`prepared-gpu-work.ts`](</Users/you/projects/ForgeaX-Games/forgeax-engine/packages/render/src/features/prepared-gpu-work.ts>) 为相同 WGSL 使用稳定 shader-module label，避免每个粒子实体创建一次实例化缓存键并在异步编译期间整帧失败。 |
| 镜头像在旋转 | 相机保持作者设定的俯视朝向，只在角色离开 dead zone 后平滑平移。 |

当前浏览器画面已能看到：多部件主角、悬浮枪、红色小兵、紫色 Boss、沿目标方向飞行的子弹，以及在命中位置出现的白蓝粒子环。

## 性能测量方法

`?profile=1` 使用 Engine Profiler，且主角启用生存模式以避免提前死亡：

```text
frameLimit = 3600
eventLimit = 3000000
detail = nested
```

本轮给 `apps/preview/src/main.ts` 增加了可复现实验参数：

```text
profileFrames=<positive integer>
profileEvents=<positive integer>
```

Profiler 原始时间单位是微秒；报告中的 `ms` 已按 `1000 μs = 1 ms` 换算。每一项分布都直接由 3600 条 frame duration 计算，包含 p50、p90、p95、p99、最大值和长帧计数。

Profiler 不是唯一口径。本轮另外用浏览器 CDP `Runtime.evaluate` 在页面原生上下文安装 60 秒 `requestAnimationFrame` 采样，并用 `Performance.getMetrics` 读取 `TaskDuration`、`ScriptDuration`、`Nodes`；再用 `Profiler.start/stop` 抓 5 秒 JS CPU profile。这样能区分“引擎内部 CPU frame-total 正常”和“浏览器真正呈现间隔异常”。

### 最终复现与引擎修复对照

复现页不启用 Engine Profiler，避免把采集开销混入实际帧率：

```text
http://localhost:5173/?game=game-brotato-3d&survival=1&rev=post-hud-fix-repro
```

| 口径 | 修复前 | 修复后 |
| --- | ---: | ---: |
| 约 1 分钟 rAF 样本 | 2469 / 94.5 s | 3600 / 80.6 s（完整 60 s 采样窗口） |
| rAF 间隔 p50 / p95 | 17 / 66.7 ms | 16.7 / 18.4 ms |
| rAF 间隔 p99 / max | 100 / 135.3 ms | 18.6 / 18.7 ms |
| Chrome `TaskDuration` 增量 | 89.9 s / 94.4 s | 39.6 s / 80.6 s |
| DOM `Nodes` 增量 | 109 / 94.4 s | 25 / 80.6 s |
| 5 s CPU profile | `hasBootstrapDependency` 1.54 s，`destroyBuffer` 0.996 s，`destroyTexture` 0.739 s | 3.62 s idle；上述热点消失 |

修复前的 Engine Profiler 3600 帧窗口也复现了同一趋势：前 300 帧 p95 `6.201 ms`，末 300 帧 p95 `19.1 ms`，末段 `142/300` 帧超过 `16.667 ms`。修复后默认组为整体 p95 `6.599 ms`、末 300 帧 p95 `7.399 ms`、长帧 `0/3600`。

### 最终 3600 帧模块对照

以下三组均使用 `frameLimit=3600`、`eventLimit=3000000`、`complete`、`dropped=0`；窗口 p95 是末 300 帧。

| 实验 | 关闭项 | overall p95 | 末 300 帧 p95 | `>16.667 ms` | 结论 |
| --- | --- | ---: | ---: | ---: | --- |
| 默认（修复后） | 无 | `6.599 ms` | `7.399 ms` | `0` | 长跑稳定 |
| 粒子对照 | GPU 粒子 | `4.901 ms` | `5.4 ms` | `0` | 不是原始退化主因 |
| 物理对照 | 物理插件 | `6.5 ms` | `7.3 ms` | `0` | 无物理系统运行，结果基本一致 |
| 掉落物历史对照 | 掉落物生成 | `7.701 ms` | `9.401 ms` | `0` | 会增加工作量，但不是原始几帧退化根因 |

物理关闭组的 `world.inspect()` 明确返回 `physicsSystems=[]`；默认组末段仍有约 `190` 个拾取物却保持 p95 `6.599 ms`，因此当前证据不支持把物理或掉落物堆积当成引擎级根因。

> [!WARNING]
> 下方实验 A/B 是第一轮持久场景修复后的历史记录，采集时 `rhi-debug` 的 O(N) 销毁扫描仍存在；它们保留用于说明最初如何定位问题，不是当前最终性能结论。最终结论以上方“最终复现与引擎修复对照”为准。

### 实验 A：初始持久场景修复后的默认长跑（历史记录）

地址：

```text
http://localhost:5173/?game=game-brotato-3d&survival=1&profile=1&profileFrames=3600&profileEvents=3000000&rev=perf-engine-fix
```

证据：`capture-0001`，完整，无丢弃事件。

| 指标 | 结果 |
| --- | ---: |
| 帧数 | 3600 |
| Profiler records | 887258 |
| dropped events | 0 |
| frame p50 / p90 | 4.9 / 16.0 ms |
| frame p95 / p99 | 18.201 / 20.8 ms |
| frame max | 47.799 ms |
| `>16.667 ms` | 295 帧 |
| `>33.333 ms` | 1 帧 |
| 首 300 帧 p95 | 5.1 ms |
| 末 300 帧 p95 | 21.599 ms |

窗口 p95 的变化：

| 帧窗口 | p95 |
| --- | ---: |
| 1–300 | 5.1 ms |
| 1201–1500 | 4.9 ms |
| 1801–2100 | 7.801 ms |
| 2401–2700 | 12.7 ms |
| 2701–3000 | 14.3 ms |
| 3001–3300 | 17.301 ms |
| 3301–3600 | 21.599 ms |

热点阶段 p95：

| 阶段 | p95 |
| --- | ---: |
| `app.frame-total` | 18.201 ms |
| `app.renderer-draw` | 11.5 ms |
| `app.world-update-primary` | 6.7 ms |
| `render.extract` | 4.2 ms |
| `render.record` | 3.401 ms |
| `render.features` | 3.2 ms |
| `render.record/graph-execute` | 2.1 ms |
| `render.record/graph-execute/main` | 1.5 ms |

同步引擎计数：

```text
world.entityCount = 283
pickup entities   = 239
projectionRecords = 267
fullRebuilds      = 1
deltaFrames       = 3823
transformUpdates  = 325569
topologyReconciled = 5588
removals          = 1970
lastResyncReason  = attach
```

这里的 `fullRebuilds=1` 是初始 attach，不是长跑过程中的反复重建。

### 实验 B：同一长跑、关闭拾取物掉落（历史记录）

地址：

```text
http://localhost:5173/?game=game-brotato-3d&survival=1&profile=1&profileNoPickups=1&profileFrames=3600&profileEvents=3000000&rev=perf-no-pickups
```

`profileNoPickups=1` 只用于 A/B 测量，不是默认配置，也不是数量上限。

| 指标 | 结果 |
| --- | ---: |
| 帧数 | 3600 |
| Profiler records | 480152 |
| dropped events | 0 |
| frame p50 / p90 | 3.8 / 6.8 ms |
| frame p95 / p99 | 7.701 / 9.0 ms |
| frame max | 11.601 ms |
| `>16.667 ms` | 0 帧 |
| 首 300 帧 p95 | 5.6 ms |
| 末 300 帧 p95 | 9.401 ms |

同步引擎计数：

```text
world.entityCount = 47
pickup entities   = 0
projectionRecords = 32
fullRebuilds      = 1
transformUpdates  = 78747
```

### 历史 A/B 归因修正

历史 A/B 说明拾取物确实会增加 `Transform` 更新和渲染提取工作，但不能解释“原始默认组一分钟后掉到几帧”：粒子关闭、物理关闭和修复后仍保留拾取物的默认组都没有持续退化。真正决定长跑曲线的是 `rhi-debug` 资源销毁路径的 `bootstrapCreates` 全表扫描；掉落物只是放大资源创建/销毁频率，让这个 O(N) 问题更快暴露。

因此没有把拾取物上限当作性能修复，也没有改变默认掉落语义。诊断开关只用于复现矩阵。

## 引擎内部修复

实现位置：[`persistent-render-scene.ts`](</Users/you/projects/ForgeaX-Games/forgeax-engine/packages/render/src/persistent-render-scene.ts>)。

### 复现

回归测试先在旧实现上失败：

1. 实体产生 derived `Transform` 变更；
2. 同一实体在渲染 projection poll 前被销毁；
3. 旧实现读取已不存在的 `Transform`，触发一次 full rebuild。

最小测试为 `does not rebuild when a stale derived transform is followed by entity removal`。

### 修复

实体移除记录已经是 projection 的权威结果；处理 derived Transform 时，如果实体已在 `removedRenderables` 中，直接跳过陈旧记录。若出现非预期的 Transform 缺失，仍返回带 entity 的 `derived-transform-unavailable:<entity>` 诊断，而不是静默吞掉错误。

### 前后对照

| 指标 | 修复前 | 修复后 |
| --- | ---: | ---: |
| full rebuilds / 3600 帧 | 731 | 1 |
| overall frame p95 | 22.2 ms | 18.201 ms |
| 首 300 → 末 300 p95 | 4.9 → 28.1 ms | 5.1 → 21.599 ms |
| `render.extract` p95 | 9.1 ms | 4.2 ms |
| `renderer-draw` p95 | 17.5 ms | 11.5 ms |
| dropped events | 0 | 0 |

### RHI-debug 销毁路径修复

实现位置：[`recorder.ts`](</Users/you/projects/ForgeaX-Games/forgeax-engine/packages/rhi-debug/src/recorder.ts>)。

`bootstrapCreates` 必须保留资源创建事件，才能在 capture 时构造自包含 tape。旧实现为了判断一个 buffer/texture 是否仍被 view、bind group 或 pipeline 引用，在每次 `destroyBuffer` / `destroyTexture` 时遍历整个 `bootstrapCreates` 并重新解析每个 create event 的依赖。长期运行会积累大量不再参与当前渲染的依赖事件，销毁路径从 O(1) 退化为 O(N)。

修复增加同一 SSOT 的反向依赖索引：写入或删除 bootstrap create event 时同步维护 `dependency -> dependents`，销毁检查改为 Set size 查询；tape closure 的正向遍历逻辑没有改变，capture 语义保持不变。这个改动可以作为 engine PR 单独提交。

### HUD 分配修复

实现位置：[`hud.ts`](</Users/you/projects/ForgeaX-Games/forgeax-engine/templates/game-brotato-3d/assets/plugins/hud.ts>)。

模板 HUD 原来每个 `Update` 都 `replaceChildren()` 并重新创建全部生命值心形，同时无条件重写文本节点。现在只在最大生命变化时重建心形，在当前生命变化时切换 class，文本内容不变时不触碰 DOM。它是模板侧修复，不应冒充 engine renderer 修复；但它消除了独立的持续分配噪声，使 engine 侧 CPU 证据可复现。

## 阴影与 RHI-debug 证据

> [!IMPORTANT]
> 旧结论只证明了 shadow pass 存在，不能证明最终像素真的收到投影。本次同时检查深度写入、接收端采样和浏览器最终画面。

修复前的单帧 RHI capture 离线解析结果：

| Pass | draw |
| --- | ---: |
| `shadowCascade0` | 0 |
| `shadowCascade1` | 53（该帧） |
| `spot-shadow` | 0 |
| `main` | 53 个场景 draw，另含当帧 VFX pass |

`shadowCascade1` 的首个真实 draw 的 pipeline facts：

```text
format           = depth32float
depthWrite       = true
depthCompare     = less
cullMode         = none
depth attachment = 2048×1024 depth32float atlas
```

离线 `inspect-depth` 对 cascade 1 的整块读取给出：

| 指标 | 修复前 capture |
| --- | ---: |
| 非清空深度像素 | `89,948` |
| 最小深度 | `0.1750466` |
| 最大深度 | `1` |
| 平均深度 | `0.9466921` |

这证明场景网格确实写进了真实深度图。断点位于接收端：host 创建的是紧凑 2×1 图集，但生产 WGSL 和 `debugSampleShadowFactor` 都按 2×2 计算 UV，Y 轴错误缩小为一半。修复前玩家附近 64 点全部为 `sampledDepth=1`、`shadowFactor=1`；修复后同一组探针有 55 点被遮挡，采样深度范围为 `0.3454665..0.3875752`，最小 `shadowFactor=0`。

修复后的投影链路为：场景真实网格 → `shadowCascade1` 深度写入 → 与 host 相同的 2×1 图集坐标 → 主材质 comparison sampler。`shadowCascade0=0` 只是当前高位俯视相机下的级联分布。`PointLight` 是真实照明光源，但没有启用 point-light shadow；`spot-shadow=0` 不代表点光源不存在。

## 粒子与运行时证据

- `renderer.renderFeatureDiagnostics()` 在修复后为 `active`。
- 当前运行时 pass 中能看到 `simulate-and-project` 和 `draw.depth-sampled`。
- 浏览器 console 的最新 error/warn 检查只有 Vite deprecated initialization warning，没有游戏系统错误、VFX preparation failure 或 device-lost。
- 命中特效不再固定出现在世界原点；截图中粒子环出现在敌人命中位置。

## 验证记录

- `FORGEAX_SKIP_HARNESS_SYNC=1 pnpm install --frozen-lockfile`：通过；跳过的是本地浮动 Harness 同步，不影响 Engine 依赖安装与产品代码验证。
- `pnpm build:engine`：通过。
- `pnpm test:layout && pnpm lint`：通过；仅保留 Preview Profiler 中既有的一条 `console` warning。
- Render、Shader、ECS、RHI-debug、VFX Render、Vite Pack 六组包级测试：分别通过 `470`、`221`、`1008`、`521`、`45`、`288` 项；Vite Pack 另有 `130` 项按环境跳过。
- `pnpm exec vitest run packages/render/src/__tests__/persistent-render-scene.unit.test.ts -t "stale derived transform"`：通过，1 passed，type errors 0。
- `pnpm exec vitest run packages/rhi-debug/src/__tests__/recorder-bootstrap.unit.test.ts packages/rhi-debug/src/__tests__/recorder.unit.test.ts`：通过，71 passed，type errors 0。
- `pnpm exec biome check packages/rhi-debug/src/recorder.ts`：通过。
- 同文件回归先在旧实现上失败，再在修复后通过。
- Dawn 全量测试：`96` 个文件通过、`1` 个按环境跳过；`324` 项通过、`9` 项跳过、`1` 项 todo。
- `hello/directional-shadow` 与 `hello/cascaded-shadow-maps` Dawn smoke：均完成 `300` 帧；前者确认 `shadowPresent=true`，后者确认四个 cascade 都同时存在 lit/shadowed probe。
- Preview template smoke：`game-default`、`game-arpg`、`game-brotato-3d`、`game-fps` 四个模板全部通过。
- `learn-render/4.3-blending` 独立 Browser/WebGPU smoke：通过。根目录聚合式 `pnpm test:browser` 仍会在第 6 组把同一应用报告为 `asset-not-imported`，但独立 Vite 资产路径已通过；该基线问题不在本次修改路径内，保留给 PR CI 复核，未将其伪报为全量 browser gate 通过。
- 真实浏览器 WebGPU profiler：最终默认组、物理关闭组均 3600 帧、`complete`、0 dropped events；粒子关闭组和历史掉落物对照同样完整。
- 浏览器原生 rAF：修复前/后均完成长跑采样，修复后的 60 秒窗口收到 3600 次回调，p95 `18.4 ms`。
- Chrome JS CPU profile：修复前明确命中 `hasBootstrapDependency` 全表扫描；修复后该热点消失。
- `rhi-debug trigger-browser --frames=1`：成功生成上面的 tape/report，并离线解析出真实 shadow depth pass。
- `rhi-debug inspect-depth --cascade=1 --rect=1024,0,1024,1024`：确认 89,948 个非清空深度像素。
- `debugSampleShadowFactor`：修复前 64/64 全亮；修复后 55/64 有遮挡，最小因子为 0。
- 最终普通观察页使用真实 WebGPU 渲染；画面可见主角、武器、敌人和墙体按各自网格形状投射的阴影，以及右上区域真实点光形成的局部蓝色照明。浏览器控制台无游戏 error，只有一条既有 deprecated initialization warning。

## 当前打开页面

普通观察页：

```text
http://localhost:5173/?game=game-brotato-3d&survival=1&rev=real-shadows-final-main-clean
```

`survival=1` 只保证观测期间主角不会因接触伤害提前结束；去掉它即可恢复正常受伤/失败规则。性能结论同时要求 Engine Profiler 的每帧分布和浏览器真实 rAF 证据，不以单一口径代替另一口径。
