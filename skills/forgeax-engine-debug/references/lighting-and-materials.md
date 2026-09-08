# Lighting and material troubleshooting

Use this reference for skybox, shadow, ambient-lighting, and glTF material symptoms.

## 天空盒 V-flip

**信号**：天空盒（skybox）渲染出来的 cubemap **上下颠倒**——山的倒影在天顶,地面纹理在下方。

**根因**：`skybox.wgsl` 的 fragment 阶段对采样方向做了一次多余的 **V-flip**（`ndcY = -ndcY`）。常见于从 OpenGL 的 `texture(skybox, dir)` 直接搬运的 skybox shader——OpenGL 的 cubemap 采样 Y 轴与 WebGPU/WGSL 的 `textureSample` 不同。正确实现直接取 `uv` 计算 view direction,不 flip。

**判定**：
```bash
# 只要 skybox.wgsl 里有 -ndcY、-1 * uv.y * 2 之类的 V-flip 就是根因
grep -n "ndcY\|uv.y\" packages/shader/src/builtin/skybox.wgsl
```

**修法**：用当前最新 `skybox.wgsl`。如果手写自定义 skybox shader,**不要 V-flip 采样方向**——WGSL `textureSample` 的 cubemap 坐标系统与 OpenGL 相反。

---

## CSM 阴影全亮无遮挡

**信号**：方向光 + standard PBR（每材质带 `ShadowCaster` pass）场景**完全没有阴影**——diffuse 明暗正常（受光面/背光面对），唯独 shadow 项死掉。debug 采样所有点 `shadowFactor === 1.000`（全亮），即便正对太阳的遮挡点下方。`r.perFramePassNames` 含 `shadowCascade0-3`（CSM pass 在跑）、`r.directionalShadow.lightSpaceMatrix` 有效。

**根因**：**cascade 选择的 `viewZ` 符号不匹配**。VS 发 `out.viewZ = -clipPos.w`（相机前方为**负**——这是 cluster Z-slice 路径也依赖的故意约定），但 `pssmSplit` host 端产出**正**的 view-space split 深度。`_pickCascadeLayer` / `cascadeBlend` band 数学拿原始负 `viewZ` 跟正 `splitPlanes` 比 → 每个可见 fragment 都落进 cascade 0 的近 slab（约 0.1~1 单位深）→ 几单位外的物体投影出 [0,1] tile → `lighting-directional.wgsl` 的 NaN-safe 越界门返回 `1.0`（全亮）。整个 frame 看起来全受光。

**判定**：
```bash
# 看 cascade 选择是否拿带符号的 viewZ 直接跟 splitPlanes 比（未转正深度）
grep -n "viewZ\|viewDepth\|splitPlanes" packages/shader/src/lighting-directional.wgsl
# VS 端确认 viewZ 是负的（-clipPos.w）—— 这是对的，别改 VS
grep -n "out.viewZ" packages/shader/src/default-standard-pbr*.wgsl
```
关键陷阱：单测 `shadow-csm-shader.dawn.test.ts` 内嵌的 kernel 若复刻了**正** `viewZ` 直接比较，会复制 bug 并永绿——测试必须喂生产用的**负** `viewZ`。

**修法**：在消费侧转一次 `viewDepth = -viewZ`，让 `_pickCascadeLayer` + blend band 都是正比正（VS 的负 viewZ 约定不动，cluster 路径不受影响）。源码 SSOT `packages/shader/src/lighting-directional.wgsl`；split 计算 `packages/runtime/src/render-system-extract.ts` `pssmSplit`。

---

## 方向光阴影不出现（castShadow 与 ShadowCaster pass）

**信号**：场景有 `DirectionalLight`（`castShadow` 未设或为 `true`），`perFramePassNames` 含 `shadowCascade0-3`（shadow depth pass 在跑），但某个（或全部）mesh **完全不投射阴影**——其他 mesh 的阴影正常，或被遮挡面全亮。

**根因（两候选，按常见顺序排）**：

| 排序 | 根因 | 判定 | 修法 |
|:--|:--|:--|:--|
| **R1** | `DirectionalLight.castShadow` 被手动设为 `false` | `world.get(lightEntity, DirectionalLight).unwrap().castShadow === false` | 删掉 `castShadow: false`（走默认 true）或显式改回 `castShadow: true`。合并后（feat-20260621）shadow 字段全在同一个 `DirectionalLight` 组件上，不需要第二个组件 |
| **R2** | mesh 的材质缺少 `ShadowCaster` pass——depth-only shadow pass 靠 `passKind='shadow-caster'` 筛选 entity；`Materials.standard(...)` 工厂自动产出该 pass，但手写 `MaterialAsset` 字面量如果只写了 `forward` / `deferred` pass，该 mesh 静默不进入 shadow depth pass | `material.passes` 数组里没有 `passKind='shadow-caster'` 的条目 | 在 `passes[]` 里加 `{ name: 'ShadowCaster', shader: 'forgeax::default-standard-pbr' }`，或改用 `Materials.standard(...)` 工厂构造材质。详见 [`forgeax-engine-material`](../../forgeax-engine-material/SKILL.md) §材质工厂 |

**背景**：`DirectionalLight.castShadow` 是**灯侧开关**——控制引擎是否跑 shadow depth pass（populate shadow atlas）。ShadowCaster pass 是**材质/渲染侧开关**——控制某个 mesh 是否被画进该 atlas。两个条件必须同时满足才有阴影。`castShadow` 默认 `true`（合并后 zero-config 即开），所以 R1 只在手动改 `castShadow: false` 时触发。R2 在手写材质时最常见——忘记加 ShadowCaster pass，看着灯光、看着 shadow pass 在跑，就是没阴影。

**不要**：在 demo 里把 mesh 的 material 换回 unlit 绕开问题——那只是躲，下一个 standard mesh 一样踩。素材质的 `passes[]` 数组才是 SSOT。

**相邻条目**：
- 同症状但全场景阴影全无（不是个别 mesh 没阴影）：见 [§CSM 阴影全亮无遮挡](#csm-阴影全亮无遮挡)（viewZ 符号不匹配）
- 材质工厂用法：[`forgeax-engine-material`](../../forgeax-engine-material/SKILL.md) §规范调用顺序

---

## ambient 黑到 IBL 加载

**信号**：只挂 `DirectionalLight` 的 standard 场景**冷启动黑几秒**后才亮；或在 IBL float-texture 不可用处（如 WKWebView desktop）持续偏黑。新游戏（永远冷启动）必现多秒黑屏。

**根因**：唯一的环境光来源是 `Skylight`，而它过去**强制要 cubemap** 且经 `uploadCubemapFromEquirect` **异步** GPU 预计算（equirect→cube→irradiance 卷积→prefilter→BRDF LUT，冷启动几秒）。cubemap 就绪前 fallback irradiance cube 是全零 → ambient = 0。PBR shader 里**没有**任何常数/纯色环境项。

**判定**：
```bash
# PBR ambient 是否纯 IBL 派生（无常数项）
grep -n "ambient" packages/shader/src/default-standard-pbr.wgsl
# Skylight 是否支持无 equirect 的纯色模式（equirect 字段是否可选）
grep -n "equirect\|color\|intensity" packages/runtime/src/components/skylight.ts
```

**修法**（引擎已支持，别在 demo 里塞常亮 PointLight 当 crutch）：spawn **无 equirect 的 Skylight** 拿即时纯色环境光——`world.spawn({ component: Skylight, data: {} })`（白）或带 `color: [r, g, b]` + `intensity` 调色调强。引擎绑 1×1 白 fallback irradiance cube，首帧即 `ambient = kD·albedo·color·intensity`，零 async；给了 equirect 才升级完整 IBL。源码 SSOT `packages/runtime/src/components/skylight.ts` + `packages/runtime/src/ibl/skylight-bind-group.ts`（白 fallback）。详见 [`forgeax-engine-material`](../../forgeax-engine-material/SKILL.md) §踩坑。

---

## glTF bridge 多 mesh 材质串

**信号**：一个 glTF 文件含多个 mesh（每个 mesh 各有自己的材质槽）,导入后**不同 entity 绑定了所有 mesh 的材质合集**,而非各自 mesh 的材质。单 mesh 文件无感;多 mesh 文件（如含附件的小场景）渲染出来材质错位 / 全黑。

**根因**：`gltf/src/bridge.ts` 的 B1 路径遍历的是展开后的 `doc.meshes`（所有 `(gltf-mesh, primitive)` 元组平列表）,未按 node 的 mesh index 过滤。每个 node 收集材质时拿到的是全局拼接,而非自己 mesh 的 `primitives`。提交 `42c3335e` verifier 发现并修复。

**判定**：
```bash
# 检查 bridge.ts 的 B1 路径是否有 meshIndex 过滤逻辑
grep -n "meshIndex" packages/gltf/src/bridge.ts
# 上一行应该出现 filter——如果只有 meshIr.meshIndex 的赋值而无对照 filter,还是旧代码
```

**修法**：bump 到 `42c3335e` 之后。当前 bridge 里 `MeshIr.meshIndex` 记录了所属 glTF mesh 索引,B1 路径用 `meshIr.meshIndex === ir.meshIndex` 过滤,每个 node 只拿自己 mesh 的材质。

---
