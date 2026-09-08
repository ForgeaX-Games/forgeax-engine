---
name: forgeax-engine-debug
description: >-
  ForgeaX symptom-to-owner troubleshooting index. Use when rendering is wrong, CI exits
  after green assertions, asset hot reload fails, or a clean worktree behaves differently.
---

# forgeax-engine-debug

> 渲染 / 测试 / CI 排查的症状索引。每条给出**判定信号**与**修法落点**；设计契约由对应 package README 与 `AGENTS.md` 持有。

> [!IMPORTANT]
> **Demo 渲染错 = 引擎暴露了真实 gap，修引擎不修 demo**（AGENTS.md §Change stance）。在 demo 里塞 1×1 占位 / 手动 rAF / ad-hoc fetch 只会冻结 gap 并误导下一个读样例的 AI。先沿调用链回溯到引擎层，再决定修法。

## 症状速查

| 症状 | 最可能根因 | 跳转 |
|:--|:--|:--|
| 贴图 demo 渲染**纯白方块**（无纹理、无光照梯度） | `paramValues` 里贴图槽是 GUID **字符串**，未解析成 Handle | [§贴图纯白](references/assets-and-ci.md#贴图纯白) |
| `world.spawn(...).unwrap()` 抛 `spawn-data-unknown-field` / 实体**隐形或灰白**（旧版本静默） | `data` 字段名拼写错或重命名残留（典型 `MeshRenderer { material }` vs schema `materials`） | [§spawn-data-字段名拼写错](references/assets-and-ci.md#spawn-data-字段名拼写错) |
| 材质静默不生效，控制台 `register<MaterialAsset> failed: ... shader 'X' not registered` | `.pack.json` 里的 shader 标识符是**改名残留** | [§shader 标识符残留](references/assets-and-ci.md#shader-标识符残留) |
| CI job 失败但**测试断言全过**（`N passed`，无 `failed`） | teardown 期 **unhandled rejection** 把退出码顶成 1 | [§断言全过却-exit-1](references/assets-and-ci.md#断言全过却-exit-1) |
| 测试只在**新 worktree** 本地失败（`ENOENT` fixture / `Failed to resolve` 包） | submodule 未初始化 / 未 `pnpm build` | [§worktree-本地假失败](references/assets-and-ci.md#worktree-本地假失败) |
| 贴图在 **hot-reload 后消失**（dev warm-refresh） | vite-plugin-pack DDC 丢失 sourcePath / 写入源树 | [§vite-plugin-pack-ddc-热更新](references/assets-and-ci.md#vite-plugin-pack-ddc-热更新) |
| 测试只在 **Windows** 失败，CRLF 污染 diff | `.gitattributes` 未强制 LF 或 grep/glob 路径分隔符 | [§windows-兼容性](references/assets-and-ci.md#windows-兼容性) |
| **天空盒（cubemap）渲染上下颠倒** | skybox.wgsl 含错误的 V-flip | [§天空盒-v-flip](references/lighting-and-materials.md#天空盒-v-flip) |
| **方向光 CSM 阴影完全无遮挡**（diffuse 正常有明暗，shadow 项恒为 1 全亮；`shadowCascade0-3` pass 都在跑、light matrix 有效） | VS 发 `viewZ=-clipPos.w`（负）与正 `splitPlanes` 比较，cascade 选择全压到 layer 0 近 slab → 远处投影出 tile → 越界门返回 1.0 | [§csm-阴影全亮无遮挡](references/lighting-and-materials.md#csm-阴影全亮无遮挡) |
| **方向光完全不投射阴影**（`castShadow` 开着但某些 mesh 不写入 shadow atlas） | mesh 的材质缺少 `ShadowCaster` pass（手写 `MaterialAsset` 只声明了 forward/deferred pass，没加 shadow-caster）——该 mesh 静默不进入 shadow depth pass | [§方向光阴影不出现](references/lighting-and-materials.md#方向光阴影不出现castshadow-与-shadowcaster-pass) |
| **standard 材质冷启动黑几秒 / 无 IBL 处全黑** | 唯一环境光是异步 IBL cubemap 的 Skylight，cubemap 就绪前 ambient=0 | [§ambient-黑到-ibl-加载](references/lighting-and-materials.md#ambient-黑到-ibl-加载) |
| **多 glTF mesh 文档材质错乱**（每节点绑了所有 mesh 的材质） | glTF bridge 未按 meshIndex 过滤材质 | [§glTF bridge 多 mesh 材质串](references/lighting-and-materials.md#gltf-bridge-多-mesh-材质串) |
| **pbr-skin pipeline 创建失败** (`Binding doesn't exist in pbr-mesh-array-bgl` / `Vertex attribute slot 5 not present`) | 标准 PBR pipeline-layout 被 skin shader 错误复用 (L1)；JOINTS_0/WEIGHTS_0 vertex 属性未上传 (L2) | [§pbr-skin-pipeline-build-fail](references/skinning-and-fbx.md#pbr-skin-pipeline-build-fail) |
| **skin browser 全黑而 dawn smoke 全绿**（`cube-vbo size=768` 不是 1152；slot 5 missing） | parse-gltf → bridge → mesh-loader → render-data → buildPipelineContext → extract 6 环节有断点 | [§skin-vertex-attribute-chain](references/skinning-and-fbx.md#skin-vertex-attribute-chain) |
| **`pnpm -F @forgeax/hello-skin dev` Fox 黑屏**，console `loadByGuid<SceneAsset> failed: AssetError code=asset-not-imported`，但 `smoke` (dawn) 全绿 | fresh worktree 漏 `pnpm build` / 端口被 sibling 占用 / submodule 未 init —— 99% 是环境，先证伪三连 | [§fox-demo-dev-加载报-asset-not-imported](references/skinning-and-fbx.md#fox-demo-dev-加载报-asset-not-imported) |
| **skin entity 静止不动**：hasSkin + AnimationPlayer 已挂，但 Fox 维持 bind-pose 静态；clip 时间轴在推、`Transform.world` 在变，画面就是不动 | palette UBO 没接 allocator / record dyn-offset 写死 0 / extract T-21 placeholder 没兑付 / **`MAX_JOINTS` off-by-one 256 vs 16320 BGL cap** / **browser-async pack-fetch 路径 SkinAsset 还没 register 就 instantiate**（`Skin.joints.length=0` + `JointCountMismatchError` 每帧；M2 fixup `e5e68b35` SceneAsset.skinGuids cross-edge 修；旧 silent-skip 改为 `'skin-asset-unresolved'` Result.err fail-fast） | [§skin-entity-静止不动](references/skinning-and-fbx.md#skin-entity-静止不动) |
| **FBX 骨骼动画整体扭曲 / 上下颠倒 / 动作乱抽**（SDK 时代，已修复；ufbx WASM 下走 `bridge.c`，历史参考） | SDK `binding.cc` 将欧拉度数当四元数 + 单轴读取（已删除）；ufbx `bridge.c` 使用 `ufbx_evaluate_transform` 同一权威路径 | [§fbx-skin 动画扭曲](references/skinning-and-fbx.md#fbx-skin-动画扭曲sdk-时代已修复) |
| **FBX parity snapshot diff 红**（`parity-snapshot.test.ts` 失败，快照 JSON 与 bridge.c 输出不一致） | `bridge.c` 语义漂移（轴转换 / 材质判别 / 节点过滤 / 动画提取四类路径任一改动） | [§fbx-parity-snapshot-diff-红](references/skinning-and-fbx.md#fbx-parity-snapshot-diff-红) |
| **FBX pkg/ 缺失**（`initFbxWasm()` ENOENT，WASM 文件不存在） | `pkg/` 不进 git（零二进制约定）；首次 checkout 无 WASM | [§FBX WASM 缺失](references/skinning-and-fbx.md#fbx-wasm-缺失pkg-empty-or-missing) |
| **FBX Node WASM 初始化失败**（Node 下 `initFbxWasm()` 抛 RuntimeError，浏览器正常） | `ENVIRONMENT` 编译标志不匹配 Node 运行时，或 Node 版本过旧 | [§fbx-node-wasm-初始化失败](references/skinning-and-fbx.md#fbx-node-wasm-初始化失败) |
| `'webgpu-runtime-error'` 300 frame，`detail.error.name=SkinPaletteOverflowError needs=16384 cap=16320` 首帧即报 | `MAX_JOINTS=256 × 64 = 16384 B` 超过 PR #361 立的 `pbr-skin` BGL `@group(2)@binding(1)` 16320 B 容量 | [§skinpaletteoverflowerror-needs-16384-b-exceeds-16320-b](references/skinning-and-fbx.md#skinpaletteoverflowerror-needs-16384-b-exceeds-16320-b) |
| Edge 浏览器报 `EngineEnvironmentError: webgpu inner=adapter-unavailable`，全屏黑 | 浏览器配置整体禁了硬件 GL 栈，**不是引擎可修** | [§edge-webgpu-disabled](references/backends-and-ci.md#edge-webgpu-disabled) |
| 启动页或发布校验只提示 WebGPU / `adapter-unavailable` / `[object Object]` | 诊断被压扁或只看到了 browser-native channel；**不能据此判定机器不支持 ForgeaX** | [§webgpu-提示不是整机能力判决](references/backends-and-ci.md#webgpu-提示不是整机能力判决) |
| wgpu-wasm WebGL2 fallback 路径 `wgpu error: Validation Error` panic（`pbr-pipeline-standard` storage/uniform mismatch · `msaaColor` `DownlevelFlags(VIEW_FORMATS)` · 类似形态） | 引擎在 fallback 路径上漏了 device-cap gate（写死单 axis variant key、graph 层 viewFormats 没按 cap 过滤、texture view-format reinterpret 没 gate） | [§wgpu-wasm-webgl2-fallback-cap-gates](references/backends-and-ci.md#wgpu-wasm-webgl2-fallback-cap-gates) |
| WebKit 上 mesh SSBO `ceiling 0 B`（伪 `mesh-ssbo-ceiling-reached`），场景全黑 | `downlevel_webgl2_defaults` 设 `maxStorageBufferBindingSize=0`，`growMeshSsbo` 读 0 当真实上限且超容后跳帧 | [§webkit-mesh-ssbo-ceiling-0](references/webkit-and-lifetimes.md#webkit-mesh-ssbo-ceiling-0) |
| WebKit 上 submit 后黑屏 / GPU 死、无任何 onError 事件 | wgpu submit 校验错误走 error-sink 静默投递，JS 侧不可见且无回调接住，GPU 进入不可恢复状态 | [§webkit submit 黑屏](references/webkit-and-lifetimes.md#webkit-submit-黑屏-gpu-死) |
| WebKit Channel 3 e2e 探针 `panicked at .../storage.rs: Surface[Id(0,N)] does not exist` + `Unreachable code`，截图全黑（hello-triangle 同 binary 不 panic） | **探针装配 bug 非引擎**：探针跑有限循环后 `main()` 返回，无持久引用 hold renderer → WebKit GC-finalize wasm-bindgen wrapper → 析构 Rust 侧 Surface | [§webkit-probe-renderer-gc-finalize](references/webkit-and-lifetimes.md#webkit-probe-renderer-gc-finalize) |
| CI 上 grep `Vitest unit (PR + main)` 显示在 main push **未跑**；或 `vitest-browser` / `vitest-dawn` 不再嵌在 `primary-pnpm` 内被误以为消失；或 `cache-tsbuildinfo.outputs.cache-hit == 'true'` 失效但 typecheck step 仍 skip | unit 由 main coverage 覆盖，browser/dawn 是独立 job，tsbuildinfo 使用 matched-key，Playwright cache 由三个 job 共享 | [§ci-form-2026-06-16](references/backends-and-ci.md#ci-form-2026-06-16) |
| **GPU 资源（buffer/texture/cubemap）单调增长**——长会话下资源计数持续上升、内存压力累积 | 四族对称释放缺失：store evict、instance buffer destroy、transient resize drain，或 handle-keyed WeakMap 生命周期不对称 | [§GPU 资源单调增长](references/webkit-and-lifetimes.md#gpu-资源单调增长) |


> [!TIP]
> Open only the linked recipe file; package READMEs remain the design SSOT.
