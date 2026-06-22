# @forgeax/engine-input

> **Frame-start scanned, frozen `InputSnapshot` Resource for forgeax-engine.** Browser keyboard / mouse / PointerLock state is captured before user systems run each frame and exposed through a 4-method surface (`keyboard.down/up` + `mouse.movementDelta` + `mouse.button(0|1|2)`).

## 4 步 recipe

```ts
import { World } from '@forgeax/engine-ecs';
import {
  attachBrowserInputBackend,
  INPUT_BACKEND_KEY,
  InputFrameStartScan,
  type InputSnapshot,
} from '@forgeax/engine-input';

// 1. attach browser backend (PointerLock + keyboard/mouse listeners) to a canvas
const detach = attachBrowserInputBackend(canvas);

// 2. insert the backend as a Resource + add the frame-start scan system token;
//    it freezes the snapshot into the 'InputSnapshot' Resource before any user
//    system runs (charter P5 split: backend = producer, scan-system + Resource
//    = consumer). Insert the backend BEFORE the system so its ParamValidation
//    finds the resource on the first tick.
const world = new World();
world.insertResource(INPUT_BACKEND_KEY, detach.backend);
world.addSystem(InputFrameStartScan);

// 3. user system reads the frozen snapshot via the standard Resource API
world.addSystem({
  name: 'first-person-camera',
  after: ['input-frame-start-scan'],
  queries: [],
  fn: (w) => {
    const snap = w.getResource<InputSnapshot>('InputSnapshot');
    if (snap.keyboard.down('w')) {/* move forward */}
    const { x, y } = snap.mouse.movementDelta;
    if (snap.mouse.button(0)) {/* primary down */}
  },
});

// 4. on shutdown: detach the listeners so multiple Engine instances do not
//    leak handlers (charter P3 explicit failure: detach is part of the contract)
detach();
```

## 4 方法表面（charter F2 minimal surface）

| 调用 | 返回 | 语义 |
|:--|:--|:--|
| `snap.keyboard.down(key)` | `boolean` | `key` 当前帧首仍处于按下状态（`document.hasFocus()` 失焦时保持上一帧状态） |
| `snap.keyboard.up(key)` | `boolean` | `key` 上一帧 down、本帧 up 的边沿（一帧内 true，下一帧自动消失） |
| `snap.mouse.movementDelta` | `{ x: number; y: number }` | PointerLock `movementX/Y` 自上次扫描以来的累加；扫描后 backend 自动清零 |
| `snap.mouse.button(i)` | `boolean`（`i: 0 \| 1 \| 2`） | 对齐 W3C MouseEvent.button：0=主键 / 1=辅助键 / 2=次键。`i: 3` 触发 TS 编译错误 |

`engine.run()` 启动前调用返回空快照（不抛异常；charter P3 例外：构造阶段无事件源，空快照即"显式无信号"）。

## 形态铁律

- **Resource 形态唯一入口** — 用户胶水通过 `world.getResource<InputSnapshot>('InputSnapshot')` 消费；不暴露 `world.input` 平行 API（charter P4 一致抽象）
- **PointerLock 内部消化** — `requestPointerLock` 用户激活、`pointerlockchange` 状态机、`movementX/Y` 单位陷阱、`firstMouse` flag 全部封装在 `browser-backend.ts`；`InputSnapshot` 表面不暴露这些细节（plan-strategy OOS-1）
- **帧首扫描后冻结** — `InputFrameStartScan` system token（顶层 `defineSystem`）先于其他用户系统跑（用 `before` 约束），从 `INPUT_BACKEND_KEY` resource 取 backend、扫描累积器后调用 `world.insertResource` 写入冻结快照；当帧内任何系统调 `snap.*` 看到的都是同一份值（architecture-principles #2 Derive）。backend 经 `world.insertResource(INPUT_BACKEND_KEY, backend)` 注入，descriptor 的 `resources:[INPUT_BACKEND_KEY]` 走结构化 ParamValidation（依赖未注入 -> invalid，非裸 throw）
- **OOS-1 范围外** — PointerLock 进入/退出事件、`unadjustedMovement` 选项、gamepad、touch、hot-reload 不在本 MVP 内；后续作为独立 feat 拆出

## 错误模型（charter P3 显式失败）

| 行为 | 形态 |
|:--|:--|
| `engine.run()` 启动前调用 `snap.*` | 返回空快照（`down/up=false` / `movementDelta={x:0,y:0}` / `button=false`）；不抛 |
| `keyboard.down(unknownKey)` | 返回 `false`（不抛；未按下即 down=false） |
| `mouse.button(3)` | TS 编译错误（字面量类型 `0 \| 1 \| 2` 收紧）；运行时表面不暴露 |

## 相关包

- [`@forgeax/engine-ecs`](../ecs) — 提供 `World` + Resource 存储 + Schedule（消费方契约依赖：`world.insertResource('InputSnapshot', frozenSnapshot)`）
- [`@forgeax/engine-runtime`](../runtime) — 在 `Engine.create({ canvas })` 流水线里调用 `attachBrowserInputBackend(canvas)`、`world.insertResource(INPUT_BACKEND_KEY, backend)` 与 `world.addSystem(InputFrameStartScan)`，对 AI 用户屏蔽组装细节
