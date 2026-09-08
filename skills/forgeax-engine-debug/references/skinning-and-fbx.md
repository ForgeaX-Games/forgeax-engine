# Skinning and FBX troubleshooting

Use this reference for skinned pipeline, browser pack, animation, and FBX failures.

## pbr-skin pipeline build fail

**信号**：浏览器 console 出现下列一条或多条（按出现顺序，越靠前越接近 root）：

```
1) Binding doesn't exist in [BindGroupLayoutInternal "pbr-mesh-array-bgl"].
   - While validating vertex stage [ShaderModule "module-forgeax::pbr-skin#..."]
   - While calling [Device].CreateRenderPipeline([RenderPipelineDescriptor "pbr-pipeline-forgeax::pbr-skin"])
2) Vertex attribute slot 5 used in [ShaderModule "module-forgeax::pbr-skin#..."]
   is not present in the VertexState.
3) RhiError: limit-exceeded ... Invalid RenderPipeline "pbr-pipeline-forgeax::pbr-skin" is invalid due to a previous error.
4) [Invalid CommandBuffer from CommandEncoder "render-system-frame"] is invalid due to a previous error.
```

`(3)` + `(4)` 是 **后果**，不是根因。先 grep 之前的 `(1)` / `(2)` —— 那才是 GPU validation 拒绝 pipeline 的真原因。

**判定**：用 Playwright probe 拦 `device.createRenderPipeline` + `dev.addEventListener('uncapturederror')`，把 `[gpu-uncapturederror]` 信息打到 console。dawn smoke 永远抓不到这条 —— 它走 `gltfDocToSceneAsset` -> `register(handle)`，整条 WebGPU validation 路径不触达。范本：`apps/hello/skin/scripts/smoke-browser.mjs`（bug-20260611）。

**根因 + 修法分两层**：

| Layer | 根因 | 修法 | 状态 |
|:--|:--|:--|:--|
| **L1 BGL shape** | `forgeax::pbr-skin` shader 在 `@group(2)` 用 binding 0 (meshes) + binding 1 (palette)，但 pipeline 创建时拿到了 standard PBR 的 `pbr-mesh-array-bgl`（仅 binding 0）。`selectPipelineLayoutForVariant` 没有 skin 分支 | `pbr-pipeline.ts buildPbrSkinLayouts()` 出 2-binding mesh-array BGL；`PipelineState.pbrSkinPipelineLayout` slot；`selectPipelineLayoutForVariant` 接受 `LayoutKind = 'pbr-skin'`；`render-system-record` 把 `materialShaderId='forgeax::pbr-skin'` 透到 `buildPipelineContext` | bug-20260611 已修 |
| **L2 vertex attributes** | `gltfImporter` 不提取 JOINTS_0 / WEIGHTS_0 accessor；mesh 上传写死 `BUILTIN_FLOATS_PER_VERTEX = 12` (4-attribute 12-float interleave)；`buildPipelineContext` 也硬编码 4-attribute vertexBuffers。skin shader 申明 slot 4 (skinIndex) + 5 (skinWeight) 在 GPU 端找不到对应 vertex attribute | feat-20260611 已修：`parse-gltf` MeshIr 含 `skinAttrs?: { skinIndex, skinWeight }`；bridge 写 18F (12 + 4 idx + 4 weight) 当 skinAttrs 在；mesh-loader 双契约 + render-data layout `'12F'\|'18F'`；`buildPipelineContext` 走 `deriveVertexBufferLayout(map)`；extract 校验 mesh 18F 与 material `pbr-skin` 同进同退 | bug-20260611 + feat-20260611 已修 |

**调用链回溯**：
```
render-system-record:3539  materialShaderId = entry.skin !== undefined ? SKIN_MATERIAL_SHADER_ID : ...
  ↓
createRenderer.ts buildAndCachePipeline(materialShaderId)
  ↓
buildPipelineContext(variantSet, materialShaderId)
  ↓
selectPipelineLayoutForVariant(state, variantSet, layoutKind = 'pbr-skin')
  ↓
state.pbrSkinPipelineLayout    ← L1 修这里，2-binding mesh-array BGL
   +
ctx.vertexBuffers              ← L2 修这里，扩 6-attribute layout
```

**Don't**：在 demo 里 fallback 到 unlit material 绕过 skin shader —— 那只是把 gap 冻结到下一次有人尝试 skin。

---

## skin vertex attribute chain

**信号**：browser console 报 `Vertex attribute slot 5 used in [ShaderModule "...pbr-skin..."] is not present in the VertexState`，或 `cube-vbo size=768 (16 vertices x 48B stride)` 而 skin shader 实际期望 72B stride。dawn smoke `frames=300 PASS` 但 browser 全黑。

**根因链**：skin 渲染要求 4 个独立环节同时让 JOINTS_0 / WEIGHTS_0 数据贯通：

```
parse-gltf MeshIr.skinAttrs (Float32Array x2)
  -> bridge.ts 18F interleave (4 pos + 4 normal + 4 uv + 4 idx + 4 weight)
  -> mesh-loader dual contract (Float32Array AND number[] both produce skin slots)
  -> render-data layout '12F' | '18F' + gpu-resource-store divisor=18
  -> buildPipelineContext deriveVertexBufferLayout(map) (no hardcode)
  -> render-system-extract fail-fast: 18F mesh ↔ pbr-skin material co-presence
```

任何一环掉头：dawn smoke 过 (`gltfDocToSceneAsset -> register(handle)` 不走 dev-server pack-body)，browser 红。

**判定**：跑 `apps/hello/skin/scripts/smoke-browser.mjs` (`smoke:browser`) layer-3 探针。它拦截 `device.createBuffer` + `queue.writeBuffer` 比对 cube-vbo `size = vertexCount × 72`（18F skinned）vs `× 48`（12F unskinned），并统计 `device.createRenderPipeline` 中 `pbr-skin` 变体数量。layer-3 GREEN = 21 pipelines + 1 skin variant + 18F VBO ctor=Float32Array byteLength=1152。

**修法 pointer**：见上面 §pbr-skin pipeline build fail 表格 L2 行；feat-20260611 把 6 个文件一次性接通，不要试图只动其中一个（如只在 buildPipelineContext 加 `'18F'` 而不动 mesh-loader / parse-gltf）—— 浏览器仍会因上游 16 顶点 × 12F = 768B VBO 而 slot 5 = oob。

**Don't**：用 dawn smoke 的 PASS 当作 skin 链路 OK 的证据。dawn 永远绕过 dev-server pack-body 序列化和 WebGPU validation，凡 typed-array survival / BGL shape mismatch / vertex-attribute presence 必走 browser layer-3 (AGENTS.md §Smoke gate)。

---

## fox demo dev 加载报 asset-not-imported

**信号**：`pnpm -F @forgeax/hello-skin dev` 后，浏览器 console 红：

```
[skin] loadByGuid<SceneAsset> failed: AssetError code=asset-not-imported
  expected="import transport to fetch pack for GUID 019eb2ce-..."
```

Fox 不渲染（黑屏 / 占位 cube）。但 `pnpm -F @forgeax/hello-skin smoke` (dawn-node) **全绿**——`frames=300 PASS`、`pixelDelta≈0`。

**根因 ranking**：99% 是环境层假象，src 真坑极少。**先按 H-env-1/2/3 证伪三连**，全否定后才走 bisect。

| 排序 | 假说 | 体感信号 |
|:--|:--|:--|
| **H-env-1** | fresh worktree 没跑 `pnpm build`；`@forgeax/engine-gltf` 缺 `dist/index.mjs` → vite optimizeDeps crash → dev server 实际没起来，浏览器看的是上一次 sibling worktree 的 vite 残留 | vite stderr 含 `Failed to resolve entry for package "@forgeax/engine-gltf"` |
| **H-env-2** | `localhost:5173` 被另一 worktree 的 `pnpm dev` 占着，浏览器加载的是别的 demo 页 | 不带 `--strictPort` 时 vite 静默用 5174/5175；浏览器 tab title 不是 hello-skin |
| **H-env-3** | `forgeax-engine-assets` submodule 未 init —— Fox.glb / `*.meta.json` sidecar 缺 → vite-plugin-pack 没把 GUID 折进 `pack-index` → loadByGuid fail-fast | `git submodule status forgeax-engine-assets` 前缀 `-` |
| H-src（少见） | 真 import / loader 链 bug | 仅当 H-env-1/2/3 全否定后才考虑；走 `git bisect` |

**判定 + 修法**（按顺序逐条排除）：

```bash
# 1) H-env-1 — 看 vite stderr 是否有 optimizeDeps crash
pnpm -F @forgeax/hello-skin dev --strictPort 2>&1 | head -50
# 如有 "Failed to resolve entry for package ..." → 跑根 build：
pnpm build                                    # tsup .mjs + tsc -b .d.ts，两者必须都出
pnpm -F @forgeax/hello-skin dev --strictPort  # --strictPort 让端口冲突立即报错而非静默换端口

# 2) H-env-3 — 确认 submodule
git submodule status forgeax-engine-assets    # SHA 应非全 0、前缀非 '-'
git submodule update --init forgeax-engine-assets

# 3) fresh worktree 必需的 wgpu_wasm 拷贝（与本症状相邻常并发）
cp <main-tree>/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm packages/wgpu-wasm/pkg/

# 4) 跑 smoke:browser 的 /__import positive probe（feat-20260612 M3 落地）
pnpm -F @forgeax/hello-skin smoke:browser     # 期望 importProbeHits ≥3，kindUnion 含 'scene'
```

**闸门**：`apps/hello/skin/scripts/smoke-browser.mjs` 在 bug-20260612 M3 加了 `/__import` positive probe——拦截 dev-server 的 import transport 命中，若 `hits<3` 或 `kindUnion` 不含 `scene` 即红。FALSIFY 模式（人为把 vite-plugin-pack 的 `roots=[]` 清空 / 删 sidecar）下必红。dawn smoke 走 `gltfDocToSceneAsset -> register(handle)` 整条绕过 dev-server pack-body fetch，所以**永远不会**抓到此症状。

**相邻条目**：
- 同型上游错配盲区：[§worktree-本地假失败](assets-and-ci.md#worktree-本地假失败)（H-env-1/3 cousin，submodule + build 不到位）
- 同体感的 host-side 假象：[§edge-webgpu-disabled](backends-and-ci.md#edge-webgpu-disabled)（先验环境，再修引擎）
- dawn 假绿盲区基类：[§skin-vertex-attribute-chain](#skin-vertex-attribute-chain)（dawn smoke 不触达 dev-server pack-body 的另一证据）

**审计**：完整 7-GUID HTTP 实证 + browser e2e + bisect 全证伪在 floating-clone harness 仓 `forgeax-loop/bug-20260612-skin-fox-loadbyguid-asset-not-imported-in-dev/`（M1 root-cause witness）。PR [#368](https://github.com/ForgeaX-Games/forgeax-engine/pull/368)。

> [!CAUTION]
> 看到 `asset-not-imported` 不要立刻去翻 `asset-registry.ts:3138` 的 fail-fast 分支——那是**正确**行为（shipped form / DDC miss 时严格失败，AGENTS.md §Error model）。先证伪环境三连，再证伪 dev-server transport，最后才考虑 src bug。

---

## skin entity 静止不动

**信号**：`apps/hello/skin` 三只 Fox 在浏览器里维持 bind-pose 静态；`hasSkin === true`、`AnimationPlayer` 时间轴在推、`advanceAnimationPlayer` 把 joint TRS 写进了 `Transform`、`propagateTransforms` 把 `Transform.world` 烘出来了——但画面就是不动。dawn smoke `frames=300 PASS` 同样观察不到该症状（因为 dawn smoke 不读 palette buffer 字节）。

**根因 ranking**（按 PR #361 → feat-20260612 的 4 个 milestone 修法落点排）：

| Layer | 根因 | 修法落点 | feat-20260612 兑付 |
|:--|:--|:--|:--|
| **L1** | palette UBO 仍是 PR #361 留下的 16320 B identity-mat4 静态 stub（`skinPaletteIdentityBuffer`），allocator 没接进 `PipelineState`，每帧 vertex shader 拿到同一份 identity | 删 stub；`createRenderer` 启动期 `createSkinPaletteAllocator(device, 16320)` 挂 `PipelineState.skinPaletteAllocator`；record-stage 从 allocator 取 buffer | M1 m1-2 / m1-3 |
| **L2** | extract `hasSkin` 段 T-21 placeholder 写死 `skinSlice = { jointCount: 0, byteOffset: 0 }`，没调 `allocator.allocateSlice` / `writeJointPalette` | `extractFrame` 入口 `allocator.resetForFrame()`；per-skin entity 调 `allocateSlice(jointCount) → writeJointPalette(slice, ibms, jointWorlds)`；`jointWorlds` 直读 `Skin.joints[i]` entity 的 `Transform.world` view | M2 m2-6 |
| **L3** | record-stage `group2DynamicOffsets[1]` 写死 `0`，多 skin entity 共享 palette[0..255]；只有第一只 Fox 的数据进 vertex shader | `group2DynamicOffsets[1] = entry.source.skin.byteOffset`；多 entity 各自 slice 不互覆盖 | M3 m3-2 |
| **L4** | `MAX_JOINTS = 256` off-by-one：`256 × 64 = 16384 B` 超过 BGL `@group(2)@binding(1)` 16320 B cap，第一帧 `allocateSlice` 即抛 `SkinPaletteOverflowError` 整路径走不通 | `MAX_JOINTS = 255` 与 PR #361 BGL 容量对齐；255 × 64 = 16320 等号成立 | M4 hotfix |

**判定**：跑 `pnpm -F @forgeax/hello-skin smoke` 看 m4-4 dawn smoke 注入的 globalThis palette readback 计数器：

```bash
pnpm -F @forgeax/hello-skin smoke 2>&1 | grep -E "paletteWrites|distinctFullHash"
# 期望：paletteWrites >= 900（300 frame × 3 Fox）；distinctFullHash >= 3（三 Fox / 三 clip 的 mat4 各异）
# 全 0 / distinctFullHash=1 → 上面 L1/L2/L3 任一未兑付
```

浏览器层用 `apps/hello/skin/scripts/smoke-browser.mjs`（M4 m4-1..m4-3）：拦截 `device.queue.writeBuffer` 抓 palette buffer 字节，跨帧 hash 互异。FALSIFY 模式（人为短路 `writeJointPalette` 写 identity）必红。

**修法 pointer**：feat-20260612 已把 4 层一次性接通；如再次出现，先按 L1→L4 顺序 grep `git log` + 检查 `git grep -n 'skinPaletteIdentityBuffer'` 是否复活。

引 PR #TBD（finalize 后 backfill）。

**Don't**：在 demo 里塞手动 rAF mutation 假装 joint 在动 / 强制重 spawn entity 绕过 allocator——这正是 PR #361 留下 stub 的形态，下一只 Fox 进来又复发。沿调用链走到 4 个 milestone 的落点修。

---

## fbx-skin 动画扭曲（SDK 时代，已修复）

> [!NOTE]
> This entry describes a bug that existed in the **removed Autodesk FBX SDK
> native addon** era (`packages/fbx` pre-feat-20260704). With the migration to
> the ufbx WASM parser, animation extraction runs through `bridge.c` (not
> `binding.cc`), and the quad-correctness checks from M1 cover the equivalent
> paths. This entry is retained for historical reference; new animation
> regressions go through the parity snapshot gate (see §parity snapshot diff).

**信号**：`apps/hello/fbx-skin`（humanoid.fbx，80 joints，clips run/punch/shot）能渲染但**整体扭曲、上下颠倒、动作乱抽**。

**根因（已修复）**：SDK 时代的 `binding.cc::WriteAnimationData` 将欧拉角度数直接当四元数使用，且只读 X 轴曲线。在 ufbx WASM 的 `bridge.c` 中，动画提取走 `ufbx_evaluate_transform` + `ufbx_evaluate_quat` —— 与 bind-pose 同一条权威路径，输出真四元数。

**判定（ufbx 时代）**：若怀疑动画数据异常，跑 parity snapshot 测试：
```bash
pnpm --filter @forgeax/engine-fbx test -- parity-snapshot
```
快照 JSON 冻结了 cube + humanoid 的完整动画数据基线。diff 红 → bridge.c 语义漂移（见 §parity snapshot diff）。

**dist 陈旧陷阱（仍适用）**：`@forgeax/engine-fbx` 解析到 `dist/index.mjs`，改 `bridge.c` 后**必须 `pnpm --filter @forgeax/engine-fbx build:wasm && pnpm --filter @forgeax/engine-fbx build`**，否则 Node 拿旧 WASM 二进制。

## FBX parity snapshot diff 红

**信号**：`pnpm --filter @forgeax/engine-fbx test` 中 `parity-snapshot.test.ts` 失败。快照 JSON（`__tests__/__snapshots__/cube-snapshot.json` + `humanoid-snapshot.json`）与当前 bridge.c 输出不一致。

**根因**：`bridge.c` 语义漂移 —— 轴转换、材质判别、节点过滤、动画提取四类路径的任一一处改动改变了 POD JSON 输出。快照是 M1 人工签署冻结的基线。

**判定**：
```bash
# 跑 parity diff 脚本看具体差异字段
node packages/fbx/scripts/parity-diff.mjs
# 检查 bridge.c 改动
git log --oneline -- packages/fbx/src/native/bridge.c
```

**修法**：如果 bridge.c 改动是刻意的（如新增 feature 必然改变输出），必须：
1. 双跑新旧 bridge 输出逐字段 diff
2. 更新快照 JSON
3. 更新 `parity-snapshot.test.ts` 期望值
4. **人工签署**（architecture-principles #8）—— 记录到 `human-inputs.jsonl`

如果是无意漂移（重构时顺手改），回退 bridge.c 到语义等价态。

## FBX WASM 缺失（pkg/ empty or missing）

**信号**：`initFbxWasm()` 抛错 `ENOENT: no such file or directory .../pkg/fbx-wasm.wasm` 或 `pkg/fbx-wasm.mjs` 找不到。

**根因**：`pkg/` 不在 git 中（零二进制约定）。首次 checkout 后缺少 WASM 产物。

**判定**：
```bash
ls -la packages/fbx/pkg/
# 期望：fbx-wasm.wasm + fbx-wasm.mjs 都存在
```

**修法（两路径二选一）**：
```bash
# 路径 1：拉取预构建 WASM（推荐，无需 emsdk）
pnpm -F @forgeax/engine-fbx fetch-wasm

# 路径 2：本地编译（需 emsdk）
pnpm -F @forgeax/engine-fbx build:wasm
```

`fetch-wasm` 对公开仓库匿名工作，私有仓库需设 `GITHUB_TOKEN`。`build:wasm` 依赖 emsdk 环境（`emcc` 在 PATH 中）。两条路径的详细错误码（E1-E5）见 `packages/fbx/README.md` §Contributor toolchain。

## FBX Node WASM 初始化失败

**信号**：`initFbxWasm()` 在 Node.js 下抛类似 `RuntimeError: Aborted(Module.instantiateWasm)` 或 `TypeError: WebAssembly.instantiate is not a function` 的异常。浏览器环境下正常。

**根因**：Emscripten 胶水文件的 `ENVIRONMENT` 编译标志与运行时环境不匹配。ufbx WASM 编译时使用 `ENVIRONMENT=web,node`（`scripts/build-wasm.mjs`），胶水自动检测环境。若看到 `ENVIRONMENT=web` 残留，Node 下的 `fs` 加载路径被跳过，`locateFile` 逻辑失效。

**判定**：
```bash
# 检查胶水文件的环境检测头
head -20 packages/fbx/pkg/fbx-wasm.mjs | grep ENVIRONMENT
# 应含 'web,node' 或类似的 Node+web 双环境逻辑
grep "ENVIRONMENT_IS_NODE\|ENVIRONMENT_IS_WEB" packages/fbx/pkg/fbx-wasm.mjs | head -5
```

**修法**：
```bash
# 重新编译（确保 build-wasm.mjs 使用正确的 ENVIRONMENT 标志）
pnpm -F @forgeax/engine-fbx build:wasm

# 如果本地 Node 版本过旧（<18），升级到 Node 18+ (WebAssembly 稳定)
node --version  # 应 >= 18
```

若仍失败，检查 `index.ts` 中 `initFbxWasm` 的 `locateFile` 是否正确指向 `pkg/` 目录（相对 import.meta.url）。`scripts/build-wasm.mjs` 中的 `ENVIRONMENT=web,node` 是 SSOT —— 不要手动改胶水文件。

---

## SkinPaletteOverflowError needs 16384 B exceeds 16320 B

**信号**：浏览器跑 `apps/hello/skin` 首帧即 console 红：

```
RhiError: 'webgpu-runtime-error'
detail.error.name = 'SkinPaletteOverflowError'
detail.error.message = 'Skin palette allocation needs 16384 B exceeds device max binding size 16320 B'
```

300-frame smoke 全部失败（`onError fired ≥1`）。Fox 不渲染。

**根因**：`MAX_JOINTS = 256` × `MAT4_BYTES = 64` = 16384 B，**超过** PR #361 R2/M8 立的 `pbr-skin` BGL `@group(2)@binding(1)` worst-case 容量 16320 B（= 255 × 64）。allocator 启动期 `grow(needed)` 用 `newCapacity = MAX_JOINTS * MAT4_BYTES` 当首轮容量，第一次 `allocateSlice(N)` 即触发 overflow——和 N 是多少无关，是常量级别的 off-by-one。

**判定**：grep 当前 allocator 的 `MAX_JOINTS` 常量。

```bash
grep -n "MAX_JOINTS" packages/runtime/src/systems/skin-palette-allocator.ts
# 期望：MAX_JOINTS = 255（与 BGL 16320 容量对齐）
# 命中 256 即根因
```

**修法**：`MAX_JOINTS = 255`。等式 `255 × 64 = 16320 = BGL cap` 成立——allocator 首轮 capacity 等于 BGL `maxBindingSize`，刚好不溢出。改 BGL 容量是另一条路（`buildPbrSkinLayouts()` + `selectPipelineLayoutForVariant` 同步 bump），但 PR #361 已把 16320 立为硬契约，本 feat 选 allocator 跟 BGL 对齐而非反过来（charter F1 / architecture-principles #1 SSOT——BGL 是先立的契约）。

引 PR #TBD（finalize 后 backfill）。

**相邻条目**：
- 同 feat 兄弟症状：[§skin-entity-静止不动](#skin-entity-静止不动)（L4 修法点同源）
- BGL 容量契约源头：[§pbr-skin-pipeline-build-fail](#pbr-skin-pipeline-build-fail)（PR #361 立的 16320 B = 255 mat4）

---
