---
name: forgeax-engine-math
description: >-
  forgeax-engine 的纯函数数学库：vec / mat / quat / euler / color 的 out-param 风格函数，
  从 Transform.world mat4 读 pose，screenToRay / rayAabbIntersects 做拾取。
  Use when reading an entity's world pose, doing vector/matrix/quaternion math, color space conversion, or screen-to-world ray casting.
---

# forgeax-engine-math

> 纯函数、out-param 优先、SoA 友好的数学库。所有函数第一参是 `out`（复用 buffer，零分配热路径）。聚合 `@forgeax/engine-math`。

## 心智模型

数学库按 namespace 组织（`vec3` / `mat4` / `quat` / `color` …），全是**纯函数**且**第一参为 `out`**：`vec3.add(out, a, b)` 写进 `out` 并返回它。这是为了让热路径复用 buffer、零 GC。最常见的 AI 任务不是手算矩阵，而是**从一个实体的世界变换里读出 pose**：`Transform.world` 是引擎每帧派生的 16 floats 列主序 mat4（你写 local TRS，引擎写 world），用 `mat4.getTranslation/getForward/getUp/getRight` 把位置 / 朝向基向量拽出来，别自己拆矩阵。屏幕拾取则反过来：`screenToRay` 从屏幕坐标 + view/proj 造一条世界射线。

## 核心 API 速查

| Namespace / 函数 | 形态 | 用途 |
|:--|:--|:--|
| `vec3.add/sub/scale/dot/cross/normalize/lerp(out, ...)` | out-param | 向量运算（`vec2`/`vec4` 同构） |
| `mat4.multiply/invert/lookAt/perspective/compose(out, ...)` | out-param | 矩阵运算 |
| `mat4.getTranslation(out, m)` | `=> Vec3` | 从 world mat4 取位置（col 3） |
| `mat4.getForward/getUp/getRight(out, m)` | `=> Vec3` | 取朝向基向量（forward = -Z） |
| `mat4.unproject(out, ndcPoint, invVP)` | `=> Vec3` | NDC → 世界坐标 |
| `quat.fromEuler/slerp/multiply/transformVec3(out, ...)` | out-param | 旋转 |
| `color.srgbToLinear/linearToSrgb/fromHex/toHex` | out-param / 值 | 颜色空间转换 |
| `screenToRay(out, sx, sy, vpW, vpH, view, proj, kind)` | `=> Ray` | 屏幕坐标 → 世界射线 |
| `worldToScreen(out, worldPos, viewProj, canvasW, canvasH)` | `=> { onScreen, behind }` | 世界坐标 → 屏幕像素（screenToRay 对偶） |
| `rayAabbIntersects(ray, aabb)` | `=> RayAabbResult` | 射线 / 包围盒求交 |
| `mat4.computeViewProj(out, eye, target, up, fov, aspect, near, far)` | `=> Mat4` | 便捷组合：perspective * lookAt（plain 数值参数，零依赖） |

> [!NOTE]
> 没有独立 `GlobalTransform` 组件（已删）。世界变换的唯一来源是 `Transform.world`，由引擎 `propagateTransforms` 每帧写；你只写 local TRS，读 world。

## 规范用法：从实体读 pose

```mermaid
flowchart LR
  T["world.get(e, Transform).unwrap().world<br/>（16 floats 列主序 mat4）"] --> G["mat4.getTranslation / getForward / getUp / getRight"]
  G --> P["拿到位置 / 朝向基向量，喂给逻辑"]
  S["screenX, screenY + view/proj"] --> R["screenToRay -> Ray"]
  R --> H["rayAabbIntersects -> 命中判定"]
```

## idiom 代码骨架

```ts
import { mat4, vec3 } from '@forgeax/engine-math';
import { Transform } from '@forgeax/engine-runtime';

// read world-space pose off Transform.world (a live 16-float column-major Float32Array)
const worldMat = world.get(entity, Transform).unwrap().world;
const pos = mat4.getTranslation(vec3.create(), worldMat); // m[12..14]
const fwd = mat4.getForward(vec3.create(), worldMat);     // -Z basis
const up = mat4.getUp(vec3.create(), worldMat);           // +Y basis

// out-param idiom: allocate once, reuse across frames
const tmp = vec3.create();
vec3.scale(tmp, fwd, 5);          // tmp = fwd * 5
vec3.add(pos, pos, tmp);          // pos = pos + tmp (writes into pos, returns it)
```

```ts
import { screenToRay, rayAabbIntersects, ray as rayNs } from '@forgeax/engine-math';

const r = screenToRay(rayNs.create(), mouseX, mouseY, vpW, vpH, viewMat, projMat, 'perspective');
const hit = rayAabbIntersects(r, entityAabb); // hit.hit -> boolean
```

```ts
import { ray, mat4, vec2 } from '@forgeax/engine-math';

// world → screen: 3D 点投影到像素坐标（y-down top-left）
const vp = mat4.computeViewProj(mat4.create(), eye, target, up, fovY, aspect, 0.1, 100);
const out = vec2.create();
const r = ray.worldToScreen(out, worldPos, vp, canvasW, canvasH);
if (r.onScreen && !r.behind) {
  // out[0], out[1] = 合法像素坐标，可做 DOM overlay 定位或 HUD 锚点
}
```

## worldToScreen：世界坐标 → 屏幕像素

`ray.worldToScreen` 是 `screenToRay` 的对偶——把世界空间的 3D 点投影回屏幕像素。内部自做 `mat4 * vec4` 取透视除前的 `w` 分量（`projectPoint` 丢 `w`，所以不能复用）。

```ts
import { ray, mat4 } from '@forgeax/engine-math';

const vp = mat4.computeViewProj(mat4.create(), eye, target, up, fovY, aspect, near, far);
const out = vec2.create();
const result = ray.worldToScreen(out, worldPos, vp, canvas.width, canvas.height);
// result.onScreen  — NDC xyz 全在 clip-space 范围内
// result.behind    — 相机后方（w < 0），此时 out 无意义
// result.onScreen 为 false 但 behind 为 false → 视锥外但相机前方，out 仍为有效像素（可做屏幕边缘 clamp）
```

- **out-param**：第一参是 `Vec2`，写入 y-down top-left 像素坐标（`px = (ndc.x * 0.5 + 0.5) * w`，`py = (1 - (ndc.y * 0.5 + 0.5)) * h`）
- **返回纯数据标志**：`{ onScreen: boolean, behind: boolean }`，不分配对象
- **退化画布**：`canvasW <= 0 || canvasH <= 0` 时返回 `{ onScreen: false, behind: false }`，`out` 不动
- **barrel 导入**：`import { ray } from '@forgeax/engine-math'; ray.worldToScreen(...)`——命名空间对称于 `screenToRay`

## computeViewProj：透视 × 视图便捷组合

`mat4.computeViewProj` 一步完成 `mat4.perspective * mat4.lookAt`，收 plain 数值 / Vec3Like 参数（不依赖任何 runtime POD 类型，与 `lookAt` / `perspective` 同风格——charter P4 一致抽象）。

```ts
const vp = mat4.computeViewProj(mat4.create(), eye, target, up, fovY, aspect, near, far);
// 等价于：
// const view = mat4.lookAt(mat4.create(), eye, target, up);
// const proj = mat4.perspective(mat4.create(), fovY, aspect, near, far);
// const vp = mat4.multiply(mat4.create(), proj, view);
```

- **签名**：`computeViewProj(out, eye, target, up, fovYRadians, aspect, near, far): Mat4`
- **out-param 风格**：写入第一参，返回同一实例
- **组合语义**：非本原操作（JSDoc 注明"便捷组合"），内部两步走 `lookAt` + `perspective` → `multiply`
- **典型用途**：喂给 `worldToScreen` 做 3D → 2D 投影，不绑定任何引擎组件

## 踩坑

- **out-param 不是返回新值**：`vec3.add(out, a, b)` 把结果写进 `out`（并返回它）。`const c = vec3.add(a, a, b)` 会覆盖 `a`——想保留 `a` 就分配独立 `out`。
- **列主序约定**：`Transform.world` 是列主序（GPU / WGSL `mat4x4<f32>` 布局），平移在 col 3（`world[12..14]`）。第一帧 propagate 前刚 spawn 的 `Transform`（`data: {}`）是单位阵，不是 stale 垃圾。
- **退化静默回退**：库内非法输入（零长度归一化、`w'=0` 透视除）静默回退到安全值（如 `(0,0,0)`），不 throw——调用方需自带守卫判断（charter P3 在 thin 数学层让位于性能）。见 README 退化策略表。
- **worldToScreen 的 `behind` 标志不可忽略**：当 `behind === true` 时 `out` 无意义——调用方必须先查该位再做屏幕边缘 clamp，否则相机后方点的像素坐标会凭空"飞"到对角象限。
- 渲染 / 拾取相关的更高层症状见 [`forgeax-engine-debug`](../forgeax-engine-debug/SKILL.md)。

## 深入

- 8 namespace × 119 函数 quick-ref / 命名风格 / 退化策略表 / 三档 NDC 投影：见 `packages/math/README.md` §quick-ref · §退化策略 · §三档 NDC 投影示例
- pose 读取助手（`getTranslation/getForward/getUp/getRight`）：源码 SSOT `packages/math/src/mat4.ts`
- 拾取（`screenToRay` / `rayAabbIntersects` / `mat4.unproject`）：源码 `packages/math/src/ray.ts` + `packages/math/src/mat4.ts`；runtime 侧封装 `pick(...)` 见 `packages/runtime/README.md` §Picking
- `Transform.world` 派生契约：见 `packages/runtime/README.md` §Transform: local TRS + world mat4
