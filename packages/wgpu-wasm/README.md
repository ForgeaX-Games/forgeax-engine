# @forgeax/engine-wgpu-wasm

> Merged wgpu 29 + naga 29 wasm-bindgen crate. **AI 用户不应 import 此包** —— 仅对 `@forgeax/engine-rhi-wgpu` + `@forgeax/engine-naga` 两薄壳暴露 raw bindings。

## 命题（charter 命题 1 渐进披露 + 命题 5 一致抽象）

本包是 wgpu RHI + naga 三段 shader pipeline 的物理底层 — 一份 wasm artefact 同时持两条独立的 wasm-bindgen surface：

- `rhi.rs` → wgpu 29 RHI raw bindings（14 opaque handle + 17 描述符 + factory 入口 + queue / command-encoder 段）；上层由 `@forgeax/engine-rhi-wgpu` TS 薄壳包装为 `@forgeax/engine-rhi` 接口形态。
- `naga.rs` → naga 三段函数（parse / validate / emit_reflection）；上层由 `@forgeax/engine-naga` TS 薄壳包装为 `Result<T, ShaderError>` 形态，再由 `@forgeax/engine-shader-compiler` 在 build-time 消费。

合并的工程理由（research F-3）：两侧底层共享 wgpu 与 naga（Cargo dedup 保证同版本 naga 唯一实例），合并后单 wasm 体积估算 0.66–0.9 MB gzip，相对独立两包总和小 10–15%。AI 引擎用户在主路径（`navigator.gpu` 探测成功）下根本不下载这份 wasm（rhi-webgpu thin shim 直传 navigator.gpu），lazy-load 仅在非浏览器场景或显式 escape hatch 触发。

## 不向 AI 用户暴露的理由

AI 引擎用户的工程模型是「`Engine.create({ canvas })` → `world.spawn(5 component)` → `renderer.draw(world)`」三步串联，对 wasm raw bindings 一无所知也应正常工作（charter 命题 1 渐进披露 + 命题 5 一致抽象红线）。本包的 `wasm.requestAdapter() / wasm.parse(source)` 等顶层符号是 thin shell 的实现细节，不进 AGENTS.md `## Packages` 表的发现入口（feat-20260511-naga-rhi-wgpu-merge 兑现）。

## Implemented Methods

### Instance

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `RhiWgpuInstance.create()` | -- | `RhiWgpuInstance` | stable |
| `requestAdapter()` | -- | `JsValue` (adapter or null) | stable |
| `requestAdapterWithCanvas(canvas)` | `HtmlCanvasElement` | `JsValue` (adapter or null) | stable |
| `createSurface(canvas)` | `HtmlCanvasElement` | `Result<RhiWgpuSurface, JsValue>` | stable |

### RhiWgpuAdapter

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `requestDevice()` | -- | `Result<RhiWgpuDevice, JsValue>` | stable |

### RhiWgpuDevice

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `get queue` (getter) | -- | `RhiWgpuQueue` | stable |
| `createBuffer(desc)` | `BufferDescriptorJs` | `RhiWgpuBuffer` | stable |
| `createTexture(desc)` | `TextureDescriptorJs` | `Result<RhiWgpuTexture, JsValue>` | stable |
| `createSampler(desc)` | `SamplerDescriptorJs` | `Result<RhiWgpuSampler, JsValue>` | stable |
| `createBindGroupLayout(desc)` | `BindGroupLayoutDescriptorJs` | `Result<RhiWgpuBindGroupLayout, JsValue>` | stable |
| `createPipelineLayout(desc)` | `PipelineLayoutDescriptorJs` | `Result<RhiWgpuPipelineLayout, JsValue>` | stable |
| `createBindGroup(desc)` | `BindGroupDescriptorJs` | `Result<RhiWgpuBindGroup, JsValue>` | stable |
| `createRenderPipeline(desc)` | `RenderPipelineDescriptorJs` | `Result<RhiWgpuRenderPipeline, JsValue>` | stable |
| `createComputePipeline(desc)` | `ComputePipelineDescriptorJs` | `Result<RhiWgpuComputePipeline, JsValue>` | stable |
| `createShaderModule(code)` | `&str` (WGSL source) | `RhiWgpuShaderModule` | stable |
| `createCommandEncoder(desc)` | `CommandEncoderDescriptorJs` | `Result<RhiWgpuCommandEncoder, JsValue>` | stable |
| `createQuerySet(desc)` | `QuerySetDescriptorJs` | `Result<RhiWgpuQuerySet, JsValue>` | stable |
| `createRenderBundleEncoder(desc)` | `RenderBundleEncoderDescriptorJs` | `Result<RhiWgpuRenderBundleEncoder, JsValue>` | stable |
| `createBuffer2(desc)` | `BufferDescriptorJs` (Result-returning variant) | `Result<RhiWgpuBuffer, JsValue>` | stable |

### RhiWgpuCommandEncoder

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `beginRenderPass(desc)` | `RenderPassDescriptorJs` | `Result<RhiWgpuRenderPass, JsValue>` | stable |
| `finish()` | -- | `RhiWgpuCommandBuffer` | stable |

### RhiWgpuRenderPass

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `setPipeline(pipeline)` | `&RhiWgpuRenderPipeline` | -- | stable |
| `setVertexBuffer(slot, buffer, offset, size)` | `u32, &RhiWgpuBuffer, u64, Option<u64>` | -- | stable |
| `draw(vertexCount, instanceCount, firstVertex, firstInstance)` | `u32, Option<u32>, u32, u32` | -- | stable |
| `drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance)` | `u32, Option<u32>, u32, i32, u32` | -- | stable |
| `end()` | -- | -- | stable |

### RhiWgpuQueue

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `submit(commandBuffers)` | `js_sys::Array` of `CommandBuffer` | `Result<(), JsValue>` | stable |
| `writeBuffer(buffer, offset, data, dataOffset, size)` | `&RhiWgpuBuffer, u64, &[u8], Option<u32>, Option<u32>` | `Result<(), JsValue>` | stable |

### RhiWgpuSurface

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `configure(desc)` | `SurfaceConfigurationJs` | `Result<(), JsValue>` | stable |
| `getCurrentTexture()` | -- | `Result<RhiWgpuSurfaceTexture, JsValue>` | stable |

### RhiWgpuSurfaceTexture

| Method | Parameters | Returns | Status |
|:--|:--|:--|:--|
| `getTexture()` | -- | `RhiWgpuTexture` | stable |

### Opaque handle types (14 total)

`RhiWgpuInstance`, `RhiWgpuAdapter`, `RhiWgpuDevice`, `RhiWgpuQueue`, `RhiWgpuBuffer`, `RhiWgpuTexture`, `RhiWgpuSampler`, `RhiWgpuBindGroupLayout`, `RhiWgpuPipelineLayout`, `RhiWgpuBindGroup`, `RhiWgpuRenderPipeline`, `RhiWgpuComputePipeline`, `RhiWgpuShaderModule`, `RhiWgpuCommandEncoder`, `RhiWgpuRenderPass`, `RhiWgpuQuerySet`, `RhiWgpuRenderBundleEncoder`, `RhiWgpuCommandBuffer`, `RhiWgpuSurface`, `RhiWgpuSurfaceTexture`

## 构建 / 获取 pkg/

`pkg/`（`wgpu_wasm_bg.wasm` + `wgpu_wasm.js` glue + 两个 `.d.ts` + `package.json`）是 wasm-pack 产物，**不入 git**（ufbx 式 release，对齐 `packages/fbx/`）。两条获取路径：

```bash
# A. 有 Rust 工具链 —— 本地构建（首次或 src/*.rs / Cargo.* 改动后）
bash packages/wgpu-wasm/build.sh            # 或 pnpm -F @forgeax/engine-wgpu-wasm build:wasm

# B. 无 Rust 工具链 —— 从 wasm-artifacts release 拉预构建 bundle
pnpm -F @forgeax/engine-wgpu-wasm fetch-wasm
```

路径 A 需 Rust ≥ 1.93 + `wasm32-unknown-unknown` target + `wasm-pack`（详见 [CONTRIBUTING.md](../../CONTRIBUTING.md) §Rust toolchain）。`rust-toolchain.toml` 在本目录 pin 1.93，rustup 通常自动应用；若未生效，跑 `rustup show` 检查。

路径 B 由根 `postinstall` 在 `pkg/` 缺失时**非致命**自动执行（离线 / 私仓无 `GITHUB_TOKEN` / bundle 未发布时仅告警，不阻断 `pnpm install`）。release 资产按内容 hash 命名（`scripts/content-key.mjs` 覆盖 `src/**/*.rs` + `Cargo.{toml,lock}` + `rust-toolchain.toml` + `build.sh`），CI `publish-wgpu-wasm-release` job 在 main push 时打包发布——源码改一次，asset 名随之变，**旧 stale `pkg/` 无从被服务**（根治 `.d.ts` 与 `rhi.rs` 漂移）。

> `pnpm -F @forgeax/engine-wgpu-wasm build`（无 `:wasm`）只跑 `tsc -b` + tsup，围绕已存在的 `pkg/` 重建 JS shim；不生成 `pkg/`——先经路径 A 或 B 备好。

## 体积承诺

`forgeax.metrics.bundle-size` 阈值 5 MB（gzip），与 `@forgeax/engine-rhi-wgpu` 旧 baseline 同源（feat-20260511-rhi-wgpu-impl 实测 0.51 MB → 本闭环合并 naga 后预计 0.66–0.9 MB；超 1 MB 触发 RK-3 评审 wasm-opt -Oz override，超 5 MB 触发 fail-fast block）。
