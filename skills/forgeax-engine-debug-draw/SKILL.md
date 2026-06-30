---
name: forgeax-engine-debug-draw
description: >-
  forgeax-engine immediate-mode 调试可视化层：line / sphere / aabb / frustum 线框 overlay，
  runtime 自动挂载 app.debugDraw（零配置），low path 手写 RHI flush（自定义 graph / 录帧脚本）。
  Use when visualizing positions, colliders, camera frustums, audio radii in gameplay code
  without creating ECS entities. 与 engine-math 同层级最底层 RHI 便利封装。
---

# forgeax-engine-debug-draw

> 基线: 首次 (`feat-20260615-debug-draw-immediate-mode-rhi-convenience-layer`)

> **debug-draw 是 gameplay 调试可视化层** -- 一行 `app.debugDraw.line(a, b, RED)` 在最终渲染帧上画线框，不需要创建 ECS entity / component / system。GPU 帧回放与 RHI 调用录制走 [`forgeax-engine-debug`](../forgeax-engine-debug/SKILL.md) + [`forgeax-engine-cli`](../forgeax-engine-cli/SKILL.md)（rhi-debug 包）。本 skill 面向**所有 forgeax AI 用户**：写 demo、调物理参数、调相机、可视化音频半径时随时用。

## 心智模型

`@forgeax/engine-debug-draw` 是 **immediate-mode** 的 RHI 便利封装：

- 每帧调用 shape API（`line` / `sphere` / `aabb` / `frustum`）**累积顶点**到 CPU staging
- frame end 时 `flush(encoder, view, viewProj)` 将 CPU staging 上传到 GPU，起一次 draw call，然后**清空缓存**为下一帧准备
- 无持久存储：上帧画的线框不会"留在"下一帧 -- 不调就不画
- 不依赖 ECS / render-graph / shader-registry -- 包内自行编译 WGSL、自行建 PSO

runtime 用户（99%）走 `app.debugDraw.*` 自动路径；底层用户（手写 RHI 录帧脚本）走 `createDebugDraw(...)` + 手动 `flush(...)`。

### 与 engine-math 同层级

| 包 | 依赖 | 用途 |
|:--|:--|:--|
| `engine-math` | 零 forgeax 依赖 | Vec / Mat / Quat / Color / frustum 反推 |
| `engine-debug-draw` | rhi + math + types（仅三包） | 线框 overlay 收集 + GPU flush |
| `engine-runtime` | debug-draw (thin glue) | createApp 时自动挂 `app.debugDraw` |

runtime 的 wiring 住在 `packages/runtime/src/debug-draw-glue.ts`（反向依赖 debug-draw），debug-draw 包本身**不含** runtime / ECS / render-graph / shader 依赖。

## 两条接入路径

### Runtime path（零配置，推荐）

```ts
import { createApp } from '@forgeax/engine-runtime';

const app = await createApp({ canvas });

// In any update system or hook:
app.debugDraw.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);   // red line
app.debugDraw.sphere([0, 0, 0], 1, [0, 1, 0, 1]);          // green sphere
app.debugDraw.aabb([-1, -1, -1], [1, 1, 1], [0, 0, 1, 1]); // blue box
app.debugDraw.frustum(cameraViewProj, [1, 1, 0, 1]);        // yellow frustum

// No manual flush -- runtime appends a DebugOverlay pass at the end of the
// URP/HDRP render graph (after tonemap), and auto-flushes every frame.
```

- `app.debugDraw` 在 `createApp` 内自动挂载（`debug-draw-glue.ts` 钩子）
- 在任意 update system / 任意时刻调 shape API -- vertex 积累，frame end 自动清空
- 不需要 `flush()` / `destroy()` -- runtime 管生命周期

### Low path（手写 RHI + 自定义 graph）

```ts
import { createDebugDraw } from '@forgeax/engine-debug-draw';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';

const r = await createDebugDraw({ device, queue, createShaderModule });
if (!r.ok) {
  switch (r.error.code) {
    case 'pipeline-create-failed':  /* ... */
    case 'buffer-allocation-failed': /* ... */
  }
}
const dd = r.value;

// Per-frame:
dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);
// ... more shape calls ...
dd.flush(encoder, swapChainView, cameraViewProj);

// When done:
dd.destroy();
```

- 你负责提供 `device` / `queue` / `createShaderModule`（注入的 WGSL 编译工厂，import from `@forgeax/engine-rhi-webgpu`）
- 你负责在自定义 render graph 末端或录帧脚本中调用 `flush(encoder, view, viewProj)`
- `destroy()` 释放 GPU 资源；后续 shape 调用 = no-op（单次 console.warn）+ flush 返回 `Result.err`

## 核心 API 速查

| API | 形态 | 顶点数 |
|:--|:--|:--|
| `dd.line(a, b, color)` | `a: Vec3, b: Vec3, color: ColorLike => void` | 2 |
| `dd.sphere(center, radius, color, segments?)` | `center: Vec3, radius: number, color: ColorLike, segments?: number => void` | $3 \times 2 \times \text{segments}$（default `segments=16`: 96） |
| `dd.aabb(min, max, color)` | `min: Vec3, max: Vec3, color: ColorLike => void` | 24 (12 edges) |
| `dd.frustum(viewProj, color)` | `viewProj: Mat4, color: ColorLike => void` | 24 (12 edges) |
| `dd.flush(encoder, view, viewProj)` | `encoder: RhiCommandEncoder, view: TextureView, viewProj: Mat4 => Result<void, DebugDrawError>` | -- |
| `dd.destroy()` | `() => void` | -- |

> `ColorLike` 接受 `[r, g, b, a?]` (plain tuple)、`Float32Array`、或 branded `Color` from `@forgeax/engine-math`。不需要 `as Vec4` 断言。

### Depth mode

| Mode | 行为 |
|:--|:--|
| `'always'`（默认） | overlay 始终在 scene 之上（无视深度；editor 风格） |
| `'less-equal'` | overlay 被前景物体遮挡（与场景正确 depth 关系） |

`createDebugDraw({ depthMode: 'less-equal', depthFormat: 'depth24plus' })` 时需要提供 `depthFormat`。每实例编译一条 PSO（按 `depthMode` 入参决定），运行时不切换。同帧两模式 → 创两个实例（`AC-06` demo 路径）。

### Capacity resize + truncation

| 触发条件 | 行为 |
|:--|:--|
| 累积顶点超过当前容量但未达 `MAX_VERTEX_CAPACITY` (1M) | 容量翻倍 resize + `console.warn` 一行（含旧 / 新容量） |
| 累积顶点超过 `MAX_VERTEX_CAPACITY` | 上限内正常 flush + 超出丢弃 + `console.warn`（每帧至多一次） |

三个常量可 import：`INITIAL_VERTEX_CAPACITY` (1024) / `MAX_VERTEX_CAPACITY` (1_000_000) / `VERTEX_STRIDE_BYTES` (16)。

## 错误模型

`DebugDrawErrorCode` 是 **封闭 union**（4 成员），每成员携带 `.code` / `.expected` / `.hint` / `.detail` 四字段（per AGENTS.md Error model）：

| `err.code` | 触发 | `.hint` 可执行 fix |
|:--|:--|:--|
| `'pipeline-create-failed'` | PSO 或 shader 编译失败 | `Pipeline creation failed: <rhiError>. Check WGSL syntax, vertex layout, and depth-stencil state.` |
| `'buffer-allocation-failed'` | GPU buffer 分配失败 | `Buffer allocation failed: <rhiError>. Check available device memory and buffer usage flags.` |
| `'flushed-after-destroy'` | destroy 后调 flush | `DebugDraw was destroyed; create a new instance via createDebugDraw().` |
| `'viewProj-required'` | flush 缺 viewProj | `Pass a viewProj Mat4 to flush(encoder, view, viewProj).` |

`switch (err.code)` 穷尽四分支，无需 default。错误全表 SSOT 在 `packages/debug-draw/src/errors.ts`。

## 踩坑

- **在 demo 中创建 ECS entity (MeshFilter + MeshRenderer) 代替 `dd.line()`**：debug-draw 是 immediate-mode -- 不调就消失，不用 component 注册。用 mesh entity 顶替 = 把引擎缺口冻进 demo（违反 AGENTS.md 原则），且 ECS entity 的生命周期比单帧长，下次跑 demo 会残留。
- **忘记 import `createShaderModule` 就从 `rhi-webgpu` 传**：`createDebugDraw` 的 `createShaderModule` 参数是注入式 WGSL 编译工厂；必须从 `@forgeax/engine-rhi-webgpu` import。缺它 → 包无法建 PSO。
- **在 `less-equal` 深度模式下不给 `depthFormat`**：`depthMode: 'less-equal'` 时 PSO descriptor 需要 `depthStencil.format`；未提供 → PSO 创建失败（`pipeline-create-failed`）。给 `depthFormat: 'depth24plus'` 即可。
- **认为 debug-draw 是 `rhi-debug` 的替代品**：两者正交 -- `debug-draw` 画线框到屏幕（游戏调试），`rhi-debug` 录制 GPU 调用到 tape（帧分析）。见 `packages/debug-draw/README.md` Distinction from engine-rhi-debug 段。
- **在 `destroy()` 后调 shape API 期望抛错**：destroy 后 shape 调用 = **no-op**（不抛 exception，不写 staging）。首次调用会 `console.warn` 一次（不刷屏）。错误状态集中在下一次 `flush()` → `Result.err({ code: 'flushed-after-destroy' })`。
- **忘记 `flush` 是 idempotent 操作**：空 staging（本帧未调任何 shape API）→ `flush` 返回 `ok(undefined)` 且**不调 beginRenderPass** -- 无 GPU 副作用。同帧两连 flush（第一次 flush 后 staging 已重置）→ 第二次返回 `ok(undefined)`，不重画。
- **大量 sphere 的 segments 值开得太高**：`segments=10000` → 60,000 顶点；可能触发 capacity resize（warn 一行），但不会崩帧。默认 16 是视觉上圆滑的折中（96 顶点）。

## 深入

- 四个 shape 完整签名 + depth mode 表 + capacity 行为 + 4 error code 全表：`packages/debug-draw/README.md`（SSOT）
- `DebugDrawErrorCode` 封闭 union + discriminated `.detail`：`packages/debug-draw/src/errors.ts`
- `DebugDraw` class + `createDebugDraw` factory + GPU resource lifecycle：`packages/debug-draw/src/debug-draw.ts`
- Runtime wiring glue（`createApp` 自动挂 `app.debugDraw` + graph 末端 pass）：`packages/runtime/src/debug-draw-glue.ts`
- Hello demo（5 modes: runtime / low / depth / hdrp-tonemap / empty）：`apps/hello/debug-draw/src/main.ts`
- 与 `@forgeax/engine-rhi-debug` 区分：`packages/debug-draw/README.md` 对照表