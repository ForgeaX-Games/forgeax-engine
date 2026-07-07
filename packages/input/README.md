# @forgeax/engine-input

> **Frame-start scanned, frozen `InputSnapshot` Resource for forgeax-engine.** Multi-device surface frozen before user systems run each frame: keyboard (down/up edge) + mouse (movementDelta / button / wheelDelta) + gamepad (7 readpoints: button / buttonValue / justPressed / justReleased / axis / standardMapping / connected) + pointer (per-pointerId position / pressure / delta / phase event queue) + virtualAxis (named joystick readpoint). Capability probe (`snap.capabilities`) available at attach time.

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

// 3. user system reads the frozen snapshot via the standard Resource API;
//    multi-device surface: keyboard + mouse + gamepad + pointer + virtualAxis
world.addSystem({
  name: 'first-person-camera',
  after: ['input-frame-start-scan'],
  queries: [],
  fn: (w) => {
    const snap = w.getResource<InputSnapshot>('InputSnapshot');
    if (snap.keyboard.down('w')) {/* move forward */}
    const { x, y } = snap.mouse.movementDelta;
    if (snap.mouse.button(0)) {/* primary down */}
    // gamepad: button / buttonValue / justPressed / justReleased / axis
    if (snap.gamepad(0).button(0)) {/* gamepad A pressed */}
    const lx = snap.gamepad(0).axis(0); // left stick X
    // pointer: per-pointerId position + pressure + delta
    const touch = snap.pointer(0);
    if (touch.active) {/* use touch.x, touch.y, touch.pressure */}
    // virtualAxis: named joystick readpoint (zero-vector for unbound)
    const joy = snap.virtualAxis('move');
    // capability probe (frozen at attach time)
    const hasGamepad = snap.capabilities.gamepad;
  },
});

// 4. on shutdown: detach the listeners so multiple Engine instances do not
//    leak handlers (charter P3 explicit failure: detach is part of the contract)
detach();
```

## 多设备表面（charter F2 minimal surface）

### keyboard（2 读点）

| 调用 | 返回 | 语义 |
|:--|:--|:--|
| `snap.keyboard.down(key)` | `boolean` | `key` 当前帧首仍处于按下状态（`document.hasFocus()` 失焦时保持上一帧状态） |
| `snap.keyboard.up(key)` | `boolean` | `key` 上一帧 down、本帧 up 的边沿（一帧内 true，下一帧自动消失） |

### mouse（3 读点）

| 调用 | 返回 | 语义 |
|:--|:--|:--|
| `snap.mouse.movementDelta` | `{ x: number; y: number }` | PointerLock `movementX/Y` 自上次扫描以来的累加；扫描后 backend 自动清零 |
| `snap.mouse.button(i)` | `boolean`（`i: 0 \| 1 \| 2`） | 对齐 W3C MouseEvent.button：0=主键 / 1=辅助键 / 2=次键。`i: 3` 触发 TS 编译错误 |
| `snap.mouse.wheelDelta` | `number` | 每帧 sign-discrete 滚轮 notches 累加（W3C `WheelEvent.deltaY`：正=下滚/负=上滚）；frame-start 冻结后清零。OOS-7：轨迹板高精度滚动未展开（sub-notch 量值保留给未来 `ScrollSnapshot`） |

### gamepad（7 读点）

| 调用 | 返回 | 语义 |
|:--|:--|:--|
| `snap.gamepad(i).connected` | `boolean` | slot `i` 已连接（index-based，null-padded 自动跳过）。越界 / 断连 → `false` |
| `snap.gamepad(i).standardMapping` | `boolean` | 标准布局（`mapping==='standard'`）。非标准布局 → `false` + 全读点空信号 |
| `snap.gamepad(i).button(b)` | `boolean`（`b: 0\|1\|...\|16`） | 按钮 `b` 当前帧按下（held）。越界字面量触发 TS 编译错误 |
| `snap.gamepad(i).buttonValue(b)` | `number` | 按钮 `b` 模拟值（0..1）；扳机半程典型 0.5。OOS-4：不施加 gamepad 死区（轴 deadzone 排除） |
| `snap.gamepad(i).justPressed(b)` | `boolean`（`b: 0\|1\|...\|16`） | 按钮 `b` 边沿——上帧未按、本帧按下（一帧寿命） |
| `snap.gamepad(i).justReleased(b)` | `boolean`（`b: 0\|1\|...\|16`） | 按钮 `b` 边沿——上帧按、本帧释放（一帧寿命） |
| `snap.gamepad(i).axis(a)` | `number`（`a: 0\|1\|2\|3`） | 轴 `a` 原始值（-1..1）。越界字面量触发 TS 编译错误。OOS-4：不施加死区——轴 raw 值直读 |

### pointer（per-pointerId reader）

| 调用 | 返回 | 语义 |
|:--|:--|:--|
| `snap.pointer(id).active` | `boolean` | `pointerId` 当前活跃（触点在 pointerMap 内）。不存在 → `false` + 全字段空信号 |
| `snap.pointer(id).x` / `.y` | `number` | 当前帧末最后 pointermove 的 canvas-pixel 坐标（DPR 换算：`(clientX-rect.left)*(canvas.width/rect.width)`）。getBoundingClientRect 缺失 → `clientX/Y` 直存（fallback） |
| `snap.pointer(id).pressure` | `number` | W3C `PointerEvent.pressure`（0..1）。无压感网 → 缺省 0.5 或 0 |
| `snap.pointer(id).pointerType` | `string` | `'mouse'` / `'pen'` / `'touch'`——W3C `PointerEvent.pointerType` |
| `snap.pointer(id).delta` | `{ x: number; y: number }` | 跨帧位移（本帧冻结位置 − 上帧冻结位置）。一帧内 N 次 pointermove → delta 为末端 − 上帧末端（AC-09：非 0，避 Bevy #12442 反例） |
| `snap.pointerEvents` | `readonly PointerPhaseEvent[]` | 本帧相位事件队列（down / move / up / cancel），一帧寿命——sample() 末尾 drain |

### virtualAxis（独立命名空间）

| 调用 | 返回 | 语义 |
|:--|:--|:--|
| `snap.virtualAxis(name)` | `{ x: number; y: number }` | 名为 `name` 的虚拟摇杆向量：`|vec|<deadzone` → `(0,0)`；`|vec|>radius` → clamp 到模长 1.0；中段 → `clamp(cur−origin, radius)/radius`。不存在 → `(0,0)`（空信号）。fixed 模式 origin=anchor；floating 模式 origin=落点 |

### capabilities（一次性探针）

| 调用 | 返回 | 语义 |
|:--|:--|:--|
| `snap.capabilities` | `{ gamepad: boolean; pointer: boolean }` | 后端 attach 时冻结的环境探针（`typeof navigator.getGamepads === 'function'` / `typeof PointerEvent !== 'undefined'`）。不须每帧重查 |

`engine.run()` 启动前调用返回空快照（不抛异常；charter P3 例外：构造阶段无事件源，空快照即"显式无信号"）。

## 形态铁律

- **Resource 形态唯一入口** — 用户胶水通过 `world.getResource<InputSnapshot>('InputSnapshot')` 消费；不暴露 `world.input` 平行 API（charter P4 一致抽象）
- **PointerLock 内部消化** — `requestPointerLock` 用户激活、`pointerlockchange` 状态机、`movementX/Y` 单位陷阱、`firstMouse` flag 全部封装在 `browser-backend.ts`；`InputSnapshot` 表面不暴露这些细节（plan-strategy OOS-1）
- **帧首扫描后冻结** — `InputFrameStartScan` system token（顶层 `defineSystem`）先于其他用户系统跑（用 `before` 约束），从 `INPUT_BACKEND_KEY` resource 取 backend、扫描累积器后调用 `world.insertResource` 写入冻结快照；当帧内任何系统调 `snap.*` 看到的都是同一份值（architecture-principles #2 Derive）。backend 经 `world.insertResource(INPUT_BACKEND_KEY, backend)` 注入，descriptor 的 `resources:[INPUT_BACKEND_KEY]` 走结构化 ParamValidation（依赖未注入 -> invalid，非裸 throw）
- **OOS-1 范围外** — PointerLock 进入/退出事件、`unadjustedMovement` 选项、hot-reload 不在本 MVP 内；后续作为独立 feat 拆出

## 错误模型（charter P3 显式失败）

| 行为 | 形态 |
|:--|:--|
| `engine.run()` 启动前调用 `snap.*` | 返回空快照（`down/up=false` / `movementDelta={x:0,y:0}` / `button=false`）；不抛 |
| `keyboard.down(unknownKey)` | 返回 `false`（不抛；未按下即 down=false） |
| `mouse.button(3)` | TS 编译错误（字面量类型 `0 \| 1 \| 2` 收紧）；运行时表面不暴露 |
| `snap.gamepad(i)` 越界 / `i` 断连 | `connected=false` + 全读点 `false`/`0`（空信号不抛） |
| `snap.gamepad(i)` 非标准布局 | `connected=true` + `standardMapping=false` + 全读点空信号（区分断连——显式可检测） |
| `snap.gamepad(i).button(17)` / `.axis(4)` | TS 编译错误（字面量 union `0\|1\|...\|16` / `0\|1\|2\|3` 收紧） |
| `typeof navigator.getGamepads !== 'function'` | `snap.capabilities.gamepad=false` + `snap.gamepad(0..N)` 全空信号（不抛） |
| `snap.pointer(id)` 不存在 | `active=false` + 全字段空信号（不抛） |
| `snap.virtualAxis(name)` 不存在 | 零向量 `{ x: 0, y: 0 }`（不抛） |
| pointer 移出 canvas | 越界坐标原样保留不 clamp——`x`/`y` 可为负或超出 canvas 尺寸（文档化行为，charter P3） |

## 边界行为

| 场景 | 行为 |
|:--|:--|
| 越界坐标 | pointer `x`/`y` 原样保留不 clamp（可为负或超出 canvas 尺寸）；charter P3：显式文档化不隐式行为 |
| `touch-action` | `attach` 时浏览器 backend 内部设置 `canvas.style.touchAction='none'`（existential 探测——fake canvas 无 `.style` 时静默跳过）；detach 恢复原值。AI 用户不需手动设 CSS |
| 失焦（blur / visibilitychange `hidden`） | pointerMap 全清 + 每活跃触点 push cancel 相位事件进入队列；gamepad justPressed/justReleased 集合复位——下帧不喷幽灵边沿。恢复焦点后下次 `sample()` 自然恢复 |

## 相关包

- [`@forgeax/engine-ecs`](../ecs) — 提供 `World` + Resource 存储 + Schedule（消费方契约依赖：`world.insertResource('InputSnapshot', frozenSnapshot)`）
- [`@forgeax/engine-runtime`](../runtime) — 在 `Engine.create({ canvas })` 流水线里调用 `attachBrowserInputBackend(canvas)`、`world.insertResource(INPUT_BACKEND_KEY, backend)` 与 `world.addSystem(InputFrameStartScan)`，对 AI 用户屏蔽组装细节
