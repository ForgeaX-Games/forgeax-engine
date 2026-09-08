# WebKit and GPU lifetime troubleshooting

Use this reference for WebKit surface failures and monotonic GPU-resource growth.

## webkit mesh SSBO ceiling 0

**信号**：WebKit（Safari / WKWebView）上场景全黑（或仅少数 mesh 渲染，其余消失），console 报 `mesh-ssbo-ceiling-reached`。Chromium / Dawn 路径正常。

**根因**：WebKit 的 wgpu-wasm WebGL2 回退路径（Channel 3）。`request_device` 请求 `downlevel_webgl2_defaults()` limits 预设，其 `max_storage_buffer_binding_size = 0`。`growMeshSsbo`（`createRenderer.ts`）过去直接读 `device.limits.maxStorageBufferBindingSize` 当上限，把 0 当真实上限——任何 mesh SSBO 请求都伪触 ceiling，调用点 `render-system-record.ts` 跳整帧（早期 `if (!ok) return`）。

**判定**：

```bash
# 看 deriveStorageBufferCeiling 是否存在（bug-20260622 R5 M1 引入）
grep -n "deriveStorageBufferCeiling" packages/runtime/src/createRenderer.ts
# 若不存在 → 旧代码，WebKit 路径 ceiling=0 跳帧 = 此 bug
```

**修法**（引擎已修，bug-20260622 R5 M1-M2）：

**(a) ceiling 派生** —— `createRenderer.ts` 新增 `deriveStorageBufferCeiling(device.limits)` helper（镜像 `SKIN_PALETTE_MAX_BINDING_BYTES` 的 0-floor 范式）：`maxStorageBufferBindingSize > 0` 直接取；`=== 0 || undefined` → 取 `maxBufferSize` → `maxUniformBufferBindingSize` → spec floor 128 MiB 兜底。

**(b) 超容降级** —— `render-system-record.ts` 调用点从 `if (!ok) return`（跳整帧）改为截断渲染子集：`validatedOrdered.slice(0, degradedToSlotCount)` 只容纳放不下的实体，丢弃溢出 + fire `mesh-ssbo-capacity-exceeded` 结构化 RuntimeError（`.detail { requested, capacity, ceiling }`）。**行为变化**：ceiling 触顶从「跳帧(黑屏)」改为「渲染子集(非黑)」。

**(c) AI 用户面**：零新增 API。`onError` 已订阅者无需改动即获降级信号；`switch (err.code)` 分支无需新增 case。

源码 SSOT：`packages/runtime/src/createRenderer.ts` `deriveStorageBufferCeiling` + `growMeshSsbo`；`packages/runtime/src/render-system-record.ts` `ensureMeshSsboCapacity`。

---

## webkit submit 黑屏 GPU 死

**信号**：WebKit（wgpu-wasm Channel 3）上 submit 后黑屏、GPU 死（后续 submit 全失败）、无任何 onError 事件、无 crash 日志。Chromium / Dawn 路径正常。

**根因**：wgpu backend 的 `queue_submit`（`wgpu_core.rs`）返回 `Err` 时走 `handle_error_nolabel` 投递到 **error sink**（非同步、非 panic）。但引擎未注册 `on_uncaptured_error` 全局回调，该投递对 JS 侧完全静默——相当于「submit 失败被吞掉、GPU 进入不可恢复状态」。这是 error-sink 断连问题，不是 Rust panic（`catch_unwind` / `error_scope` 对此无效——wasm32 `panic=abort` 下 catch_unwind 不可用，`pop_error_scope` 异步破坏同步合约）。

**判定**：

```bash
# 看 rhi.rs 是否有 on_uncaptured_error 注册（bug-20260622 R5 M4 引入）
grep -n "on_uncaptured_error" packages/wgpu-wasm/src/rhi.rs
# 若不存在 → 旧代码，submit 期 validation error 经 error-sink 静默投递 = 此 bug
```

**修法**（引擎已修，bug-20260622 R5 M3-M4）：

**(a) `on_uncaptured_error` 全局回调** —— device 初始化时注册（镜像 `register_lost_callback`（`rhi.rs:934`）的 `Closure::wrap` 范式），回调把 wgpu error-sink 投递的 validation / OOM / internal error 写入 per-queue thread_local last-error 槽位。

**(b) submit 错误扇出** —— Rust `submit()` 标 `#[wasm_bindgen(catch)]` 改返回 `Result`；调用 `self.inner.submit(...)` 后同步读 + 清空 last-error 槽位，命中则以稳定前缀 `[rhi-code:<code>]` 抛 JsValue 回 JS。TS shim `queue.ts` 按此前缀路由：`queue-submit-failed` → `queueSubmitFailed()`、其余 → `webgpuRuntimeError()`（复用 `RhiErrorCode` 既有成员，零新增）。

**(c) AI 用户面**：submit 期校验错误从「panic(GPU 死)」改为「经 onError 返回 RhiError(实例存活)」。下一帧 submit 正常（AC-06）。`switch (err.code)` 分支无需新增 case。

源码 SSOT：`packages/wgpu-wasm/src/rhi.rs` device init（`on_uncaptured_error`）+ `submit`；`packages/wgpu-wasm/src/rhi.rs` `classify_uncaptured_error` free helper；`packages/rhi-wgpu/src/queue.ts` `classifySubmitError`。

---

## webkit probe renderer GC finalize

**信号**：WebKit（或任何 Channel 3 = navigator.gpu 缺失）下跑 Playwright e2e 探针，`panicked at .../wgpu-core/src/storage.rs:N: Surface[Id(0,N)] does not exist` + `RuntimeError: Unreachable code should not be executed`，截图全黑。**关键鉴别**：同一 binary 的 hello-triangle `index.ts` 走 `/` 不 panic；把 `index.ts` 字节拷贝换文件名也不 panic——panic 只在探针自己的 `.ts` 内容。

**根因（探针装配 bug，非引擎）**：探针各 mode 跑**有限**循环（`for f<10 { draw; await rAF }`）后 `main()` 返回，**无任何持久引用 hold 住 renderer**。WebKit GC 回收 wasm-bindgen wrapper → FinalizationRegistry 析构掉 Rust 侧 `Surface` → 后续 present/lookup 命中已释放 slot（`Id(0,N)` 的 generation N = 释放后复用）。对比 `index.ts`：递归 `tick()` rAF 永久持有 renderer 闭包 → Surface 永不 GC，故永不 panic。

**确定性鉴别法**：`Engine.create` 后加一行 `(window as any).__keepRenderer = renderer` → panic 消失；删 → 复现。能确定性翻转即坐实此根因。

**修法（修探针，不动引擎）**：探针 `Engine.create` 后把 renderer 钉到模块生命周期（`win().__r5Renderer = renderer`，兼作 e2e 读取钩子）。正常 app 都跑持续 rAF 故无需此操作——只有「有限循环 + main 返回」的探针装配需要。

**连带坑（修 panic 后才暴露，均非引擎）**：
1. verify 脚本若只取 canvas 中心点判非黑 → 超容网格在下方带状渲染时假黑；改全画布网格扫描非黑计数。
2. 探针若请求**第二个** adapter 触发坏 submit 且不传 `compatibleSurface` → GL 后端 adapter 枚举必 `adapter-unavailable`（`rhi-wgpu/src/index.ts` requestAdapter 需 compatible surface）。改用 `renderer.device`（引擎活设备）——也更贴合「同一 renderer 存活」语义。坏 submit 配方：`copyBufferToBuffer(buf,0,buf,0,64)` + submit 前 `destroyBuffer(buf)`。

源码 SSOT：`apps/learn-render/1.getting-started/2.hello-triangle/src/r5-probe.ts`；`scripts/dev-verify/verify-webkit-r5-stability.mjs`。

---

## GPU 资源单调增长

**信号**：长会话（持续 spawn/despawn 数分钟或场景切换多轮）下 GPU buffer / texture / cubemap 计数持续上升，内存压力指纹（系统监控 / devtools GPU memory timeline 斜率 > 0）。`gpuStore` 三 Map 的 `.size` 随帧上升且不回落。

**根因（四族对称释放缺失）**：

| 族 | 泄漏点 | 现场坐标 | 机制 |
|:--|:--|:--|:--|
| **A** | `GpuResourceStore` 缺 per-handle evict 原语 + renderer owner 未消费 shared-release evidence | `gpu-resource-store.ts`（evictTexture / evictMesh / evictCubemap）+ renderer owner effect | despawn 时 SharedRefStore 压 refcount 至 0，owner 未消费 release evidence 时 GPU 资源永不释放——每次 spawn 建新 handle 进 Map，Map 只增不减 |
| **B** | 每帧 `instanceBuffers.delete(key)` 前未 `buffer.destroy()` + fingerprint 失配 `set()` 新 buffer 前未 destroy 旧 `cached.buffer` | `render-system-record.ts`（F11 每帧轮询 delete + F12 三处 `instanceBuffers.set` 点：shadow / main / sprite） | 旧 buffer 被 delete/set 丢弃后 RHI 层 handle 仍存活——只有 JS 侧 GC 回收 GpuBuffer 包装，但 `GPUBuffer` 自身永不释放 |
| **C** | resize（swapchain 尺寸变化）后旧尺寸的 transient texture 仍留在 `transientPool`，新尺寸产生新 key | `render-graph/src/graph.ts`（`transientPool` key 含尺寸 `${W}x${H}`，resize 后旧 key 永不被命中 → stranded） | 同 key 覆盖在当前代码流不可达（`transientPool.set` 仅在 `get`-miss 后执行），旧尺寸条目成实质 dead store |
| **D** | `handleToId` 分配器已消除（feat-20260622-handle-to-id-allocator-elimination）。先前 `Map<object, number>`（S1a 改为 `WeakMap` 止血），现已整体替换为嵌套 WeakMap——handle 对象本身作 cache key，GC 自动回收 | 旧坐标 `render-system-record.ts` + `render-system.ts`（字段已删，符号 zero-survival） | 原 D 族泄漏面已闭合：无 handle→id 映射、无 string cache key、死 handle GC 自然回收 |

**判定**：

```bash
# A 族 — grep store 三 Map 的 public evict 原语是否存在
grep -n "evictTexture\|evictMesh\|evictCubemap\|releaseUnreferenced" packages/runtime/src/gpu-resource-store.ts

# B 族 — instanceBuffers.delete 前是否有 buffer.destroy()
grep -n "instanceBuffers.delete\|instanceBuffers.set" packages/runtime/src/render-system-record.ts

# C 族 — resize 时是否调用 drainTransient()
grep -n "drainTransient\|setSwapChainSize" packages/render-graph/src/graph.ts

# D 族 — handleToId 分配器已消除（feat-20260622），确认符号 zero-survival
grep -n "handleToId\|nextHandleId\|getOrAssignHandleId\|buildBindGroupCacheKey" packages/runtime/src/render-system-record.ts
```

**修法**：本 feat（`feat-20260619-gpu-resource-ownership-symmetric-release-primitive`）引入对称释放原语覆盖四族。

> [!IMPORTANT]
> **「用户要不要手动调」一栏先看**：B/C/D 三族修法**全在引擎内部**，用户 app 零改动——它们是引擎帧循环/resize/类型层的自动行为，下表描述的是引擎实现、不是用户 API。只有 A 族暴露了**可选**的显式 escape-hatch（`evict*` / `releaseUnreferenced`），且日常 despawn 已由事件式自动回收，用户**通常也不需调**。

| 族 | 用户要手动调吗 | 修法（引擎实现） | 原语 |
|:--|:--|:--|:--|
| A | **否（日常自动）**；仅突变点（编目失效 / device 重建）可选显式调 | `evictTexture(handle)` / `evictMesh(handle)` / `evictCubemap(id)` — per-handle 显式 evict；renderer owner consumes `readReleaseEvidence()` and owns evict；`releaseUnreferenced(liveSet)` 兜底 | Per-handle evict + structured evidence + sweep |
| B | **否（引擎帧循环自动）** | F11：每帧 `instanceBuffers.entries()` 遍历，`isDestroyed` gate + `buffer.destroy()` → `delete(key)`；F12：三处 set 前 `cached.buffer.destroy()` 再 set 新 buffer；`disposeInstanceBuffers` 统一 fire errorRegistry | Delete-before-destroy + set-before-overwrite |
| C | **否（resize 自动）** | `drainTransient()` — resize 时清理旧尺寸 transient 条目（`compile()` 入口检测 `setSwapChainSize` 返 true 即调）；同 key 覆盖前 destroy 旧 PooledTexture（防御性 1 行 if） | Resize-drain + same-key guard |
| D | **否（类型层自动 GC）** | `handleToId` 分配器已整体消除（feat-20260622-handle-to-id-allocator-elimination）——改用嵌套 WeakMap（`Map<entityKey, WeakMap<handle, BG>>`），handle 对象自身作 key，死 handle GC 自然回收 | 嵌套 WeakMap |

所有错误路径统一为「吞错 + fire errorRegistry + 继续 sweep」——单条 destroy 失败不崩帧（charter P3 可观测）。SharedRefStore 不执行 owner disposal callback。

**深入锚点**：`packages/runtime/README.md` §GPU-asset layers——对称释放 API 签名、两种错误约定、releaseUnreferenced 用途。

**相邻条目**：
- 同型 root cause：demolisher spawn/despawn 长会话压测 → 浏览器 OOM (`GPUBuffer` 外泄) → 同上四族
- A 族前缀：见 worktree 本地假失败（环境层面 `ensureResident` 调不通 → store 空 → 症状不现——但 evict 后 store 空与 never-populated 行为一致）

**纪律**：**在 demo 里调 `releaseUnreferenced(new Set())` 临时 flush 是 workaround，不是修正**——每帧 owner 消费 release evidence 并 evict 才是引擎的正确对称释放行为。用户 app 代码**不**强制 wiring。
