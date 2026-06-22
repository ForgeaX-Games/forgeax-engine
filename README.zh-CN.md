# ForgeaX Studio — forgeax-engine

[English](./README.md) · [简体中文](./README.zh-CN.md) · [↑ studio](https://github.com/ForgeaX-Games/forgeax-studio)

> **AI 优先的 TypeScript 游戏引擎，基于 WebGPU 从零构建 —— 目标是超越 Three.js。**

`forgeax-engine` 是在 ForgeaX Studio 预览里**真实运行你游戏的那台引擎**，而不是对现有渲染器的
封装。它是一套从零构建的 **实体-组件-系统(ECS)+ WebGPU** 引擎,用严格模式 TypeScript 编写,
最热的路径(GPU 抽象层与着色器流水线)由 **Rust → WebAssembly** 编译而来。它的首要用户不是
照着教程敲代码的人,而是**正在编写游戏代码的 AI agent** —— 因此每个 API 都被设计成「仅凭结构化
信息就能正确调用」。

## 它为何不同

多数 Web 引擎以人为先、工具后补;ForgeaX 反其道而行。它的设计信条让引擎**对机器可读**,而这
——并非巧合地——也让它对人**可预测**:

| 原则 | 它带来什么 |
|---|---|
| **机器可读 > 散文** | 每个 API 都通过 schema / manifest / 类型自描述。你(或 agent)看类型就能正确调用——类型**就是**文档。 |
| **显式失败 > 静默行为** | 可失败的调用返回 `Result<T, E>`,携带 `.code` / `.expected` / `.hint`。没有抛出意外,没有字符串编码的语义,没有被吞掉的错误。 |
| **统一抽象 > 泄漏内部** | 先给一个干净接口;性能旋钮按需开启,而非强制仪式。 |
| **上下文经济** | API 表面小、命名自解释——整个引擎家族都能靠 `@forgeax/engine-` 前缀的 IDE 自动补全发现。 |

贯穿其中的公理是 **「压缩 == 智能」**:表达一项能力所需的表面越小越统一越好——对写代码的
agent 如此,对读代码的人亦然。

## 架构

引擎以一组职责单一的包发布,分属两条独立依赖链——**运行时链**根为 `@forgeax/engine-runtime`,
**构建时链**根为 `@forgeax/engine-vite-plugin-shader`。要点:

**渲染与 GPU**
- [`packages/rhi`](packages/rhi) —— **RHI**(渲染硬件接口):一个纯粹、无数学依赖、与
  `@webgpu/types` 形状对齐的接口,使用不透明句柄与能力门控的操作集(wgpu 的超集)。它**并排
  发布两套可互换实现**:`rhi-webgpu`(对浏览器原生 WebGPU 的薄壳)与 `rhi-wgpu`(对 Rust
  `wgpu` 绑定的 TS 壳)。
- `packages/wgpu-wasm` —— 一个**合并了 wgpu 29 + naga 29 的 `wasm-bindgen` crate**:支撑
  `rhi-wgpu` 与着色器工具链的 Rust→wasm 热路径。
- [`packages/render-graph`](packages/render-graph) —— 声明式渲染图(资源/通道声明 →
  `compile()` → `execute()`),只依赖 RHI + math。
- `packages/rhi-debug` —— 受 RenderDoc 启发的帧记录器,支持**确定性回放**与离线检视
  (首要用户:调试某一帧的 AI 子 agent)。

**着色器** —— 构建时三件套(`shader-compiler` 把 WGSL 编译为 wgsl/glsl/bindings + 反射、
`naga` 解析/校验、`wgpu-wasm`)喂给运行时的内容寻址 `shader` 注册表,由 `vite-plugin-shader`
接入 Vite。

**仿真核心**
- [`packages/ecs`](packages/ecs) —— **archetype(原型)ECS**(`World` / `Entity` /
  `Component` / `Query` / `System` / `Schedule`),带托管组件缓冲与 kubectl 风格的检视插件
  (entities / components / systems / resources / world)。
- `packages/math` —— 对 SoA 友好的 `Vec` / `Mat` / `Quat`。`packages/types` —— 全工程
  `Result<T, E>` 的 SSOT。`packages/state` —— 零侵入的类型化状态机,带状态作用域的实体生命周期。

**资产流水线** —— 由 GUID「导入稳定铁律」治理的显式 **导入(构建时)/ 加载(运行时)分离**:
- [`packages/pack`](packages/pack) —— 磁盘资产包 schema、GUID 工具与扫描器;`vite-plugin-pack`
  以 dev HMR 提供服务。
- `packages/import` —— 构建时运行器 + `ImporterRegistry`,把 `*.meta.json` sidecar 转成编译后的
  DDC(`.pack.json` / `.bin`)。导入器:[`gltf`](packages/gltf)(运行时 glTF 2.0)、`fbx`
  (Autodesk FBX SDK)、`image`、`font`(MSDF 图集烘焙)。运行时用 `loadByGuid` 取得 payload,
  再 `allocSharedRef` 进世界。

**玩法服务** —— [`physics`](packages/physics)(接口)配 Rapier 2D/3D 的 WASM 后端(SIMD 探测、
三阶段 `syncBackend` / `stepSimulation` / `writeback` tick、射线检测、碰撞事件);`audio`
(接口)+ Web Audio 后端;`input`(帧首冻结的 `InputSnapshot` 资源 + 指针锁定);`debug-draw`
(即时模式的 线 / 球 / AABB / 视锥)。

**项目契约** —— `packages/engine-project` 是 **`forge.json`** 的 SSOT,即权威的游戏清单
(zod schema + 可注入 loader)。`packages/app` 提供 app 外壳 + 游戏循环(rAF、start/stop/pause、
自动输入)。

## 你实际得到什么

- **WebGPU 原生渲染,带 WebGL2 回退路径** —— `@forgeax/engine-runtime` 是一个
  `Renderer + Backend(WebGPU / WebGL2)` 的异步工厂。
- **Rust 级别的热路径**,无需离开 Web —— GPU 与着色器核心是真正的 wgpu/naga 编译成 wasm。
- **可据以行动的错误** —— `Result<T, E>` 带 code 与 hint,而非一堆调用栈。
- **被守住的质量基线** —— 每次引擎改动都必须通过无头 dawn-node 冒烟(300 帧)、浏览器测试,
  以及对 **Three.js 的逐像素对齐基准**(ε ≤ 0.05)。`apps/learn-render` 套件按 LearnOpenGL
  课程跟踪渲染特性;`apps/parity` 持有与 three.js 的对比;`apps/hello/*` 是最小可运行 demo。

## 关键概念

`World` / `Component` / `Query`(ECS)· `Handle` / `allocSharedRef`(共享 GPU/资产资源)
· `createApp` / `createRenderer`(入口)· `loadByGuid` → payload → `instantiate`(资产)
· `pack` / `catalog`(资产包)· 经 `@forgeax/engine-project` 的 `forge.json`(游戏清单)
· `Result<T, E>`(通用错误模型)。

## 它如何融入 studio

Studio 把引擎嵌进实时预览 iframe:server 写入你游戏的源码,引擎热重载,你立刻看到结果。游戏
通过 `createApp` + `loadByGuid`/`instantiate` 消费,依据的是编辑器与构建流水线读取的同一份
`forge.json` 契约——同一台引擎,在 Play 与 Edit 中行为完全一致。

## 构建与运行(独立)

需要 **Node ≥ 22.13**、**pnpm ≥ 11.1.3**、**Bun ≥ 1.2**(重建 wasm crate 还需 Rust 工具链)。
用 `--recurse-submodules` 克隆。

```bash
pnpm install && pnpm build      # tsup (.mjs) + tsc -b (.d.ts)
pnpm test
pnpm dev                        # demo 在 http://localhost:5173
pnpm -F @forgeax/engine-wgpu-wasm build   # 重建 Rust → wasm crate
```

每个 `packages/<pkg>/README.md` 都是该包 API、错误码与能力门控的 SSOT。

---

本仓是 **ForgeaX Studio** 的一个子模块,隶属
[`ForgeaX-Games/forgeax-studio`](https://github.com/ForgeaX-Games/forgeax-studio) ——
用 `--recurse-submodules` 克隆超级仓即可运行完整 studio。许可:Apache-2.0。
