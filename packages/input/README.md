# @forgeax/engine-input

> **Frame-start scanned, frozen `InputSnapshot` Resource for forgeax-engine.** Multi-device surface frozen before user systems run each frame: keyboard (down/up edge) + mouse (movementDelta / button / wheelDelta) + gamepad (7 readpoints: button / buttonValue / justPressed / justReleased / axis / standardMapping / connected) + pointer (per-pointerId position / pressure / delta / phase event queue) + virtualAxis (named joystick readpoint). Higher-level abstractions: **action indirection** (declare once, forget device — `snap.action(name)` / `snap.getAxis` / `snap.getVector`) + **gesture recognizer** (pinch / rotate / swipe / long-press / double-tap — `snap.gesture` + `snap.gestureEvents`). Capability probe (`snap.capabilities`) available at attach time.

## 4 步 recipe

```ts
import { World } from '@forgeax/engine-ecs';
import {
  attachBrowserInputBackend,
  INPUT_BACKEND_KEY,
  INPUT_MAP_KEY,
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

// 2b. (optional) declare an InputMap to enable action readpoints.
//     Duplicate action names → last-wins. Per-action deadzone default: 0.2.
world.insertResource(INPUT_MAP_KEY, [
  { action: 'jump', bindings: [{ type: 'key', key: ' ' }, { type: 'gamepadButton', button: 0 }] },
  { action: 'moveLeft',  bindings: [{ type: 'key', key: 'a' }, { type: 'gamepadAxis', axis: 0, sign: -1 }] },
  { action: 'moveRight', bindings: [{ type: 'key', key: 'd' }, { type: 'gamepadAxis', axis: 0, sign: 1 }] },
  { action: 'moveUp',    bindings: [{ type: 'key', key: 'w' }, { type: 'gamepadAxis', axis: 1, sign: -1 }] },
  { action: 'moveDown',  bindings: [{ type: 'key', key: 's' }, { type: 'gamepadAxis', axis: 1, sign: 1 }] },
]);

world.addSystem(InputFrameStartScan);

// 3. user system reads the frozen snapshot via the standard Resource API;
//    multi-device surface: keyboard + mouse + gamepad + pointer + virtualAxis
//    + action + gesture
world.addSystem({
  name: 'first-person-camera',
  after: ['input-frame-start-scan'],
  queries: [],
  fn: (w) => {
    const snap = w.getResource<InputSnapshot>('InputSnapshot');
    // action: declare once, forget device — same isPressed() for keyboard AND gamepad
    if (snap.action('jump').justPressed()) {/* jump (space or gamepad A) */}
    const move = snap.getVector('moveLeft', 'moveRight', 'moveUp', 'moveDown');
    // move.x / move.y: circular deadzone [−1,1], WASD diagonal magnitude 1
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
    // gesture: pinch/rotate continuous values + one-frame lifecycle events
    const gs = snap.gesture.pinchScale;
    const ga = snap.gesture.rotationAngle;
    const gevs = snap.gestureEvents; // GestureEvent[] one-frame lifecycle
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

### mouse（4 读点）

| 调用 | 返回 | 语义 |
|:--|:--|:--|
| `snap.mouse.movementDelta` | `{ x: number; y: number }` | PointerLock `movementX/Y` 自上次扫描以来的累加；扫描后 backend 自动清零 |
| `snap.mouse.pointerLocked` | `boolean` | 合并锁态——W3C `pointerlockchange`（`pointerLockElement === canvas`）OR host `lockProvider.requestLock()` 置位；`required` 字段，非 optional。consumer 写 `if (snap.mouse.pointerLocked)` 判断"仅锁定态消费 look delta"。与 `movementDelta` 同位——两个事实在同一属性路径下（charter F1 单点可索引） |
| `snap.mouse.button(i)` | `boolean`（`i: 0 \| 1 \| 2`） | 对齐 W3C MouseEvent.button：0=主键 / 1=辅助键 / 2=次键。`i: 3` 触发 TS 编译错误 |
| `snap.mouse.wheelDelta` | `number` | 每帧 sign-discrete 滚轮 notches 累加（W3C `WheelEvent.deltaY`：正=下滚/负=上滚）；frame-start 冻结后清零。OOS-7：轨迹板高精度滚动未展开（sub-notch 量值保留给未来 `ScrollSnapshot`） |

### gamepad（7 读点）

| 调用 | 返回 | 语义 |
|:--|:--|:--|
| `snap.gamepad(i).connected` | `boolean` | slot `i` 已连接（index-based，null-padded 自动跳过）。越界 / 断连 → `false` |
| `snap.gamepad(i).standardMapping` | `boolean` | Standard layout available: **true** when browser reports `mapping==='standard'` **or** the SDL controller DB has normalized a non-standard layout (D-1 redline). `false` = not standard AND DB miss/unavailable — explicitly detectable (AC-10/E-2). When false, all readpoints return empty signals. |
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

### action（声明式设备无关语义层）

4-member `ActionBinding` discriminant union: `'key'` | `'mouseButton'` | `'gamepadButton'` | `'gamepadAxis'`. Declared via `INPUT_MAP_KEY` Resource (`ActionConfig[]`). Per-action deadzone default: **0.2** (Godot prior-art). Aggregation: OR for pressed, MAX for strength/raw. Duplicate action names: last-wins (D-8).

| 调用 | 返回 | 语义 |
|:--|:--|:--|
| `snap.action(name).isPressed()` | `boolean` | 任意绑定源当前激活（OR 聚合）。未注册 action → `false` |
| `snap.action(name).justPressed()` | `boolean` | 上帧未按、本帧按下（一帧寿命）。首帧无 prev → justPressed=pressed |
| `snap.action(name).justReleased()` | `boolean` | 上帧按下、本帧释放（一帧寿命） |
| `snap.action(name).strength` | `number` | 死区重映射模拟强度 [0, 1]。`\|raw\|<deadzone` → 0；`\|raw\|≥deadzone` → `inverse_lerp(deadzone, 1, \|raw\|)`。数字绑定 → 1.0 |
| `snap.getAxis(neg, pos)` | `number` | `strength(pos) − strength(neg)`，值域 [-1, 1]。一端/两端未注册 → 该端贡献 0；同 action 双端 → 恒 0 (E-12) |
| `snap.getVector(nX, pX, nY, pY, opts?)` | `{x: number, y: number}` | 四行动方向合成 2D 向量，单次径向死区（三分支公式，Godot input.cpp F2）：`length≤deadzone` → (0,0)；`length>1` → 单位圆 clamp；中段 → `vec·inverse_lerp(deadzone, 1, length)/length`。默认 deadzone = 4 个 action 的 per-action deadzone 均值；`opts.deadzone` 覆盖。读 action 的 `raw`（非 `strength`）避免逐轴死区叠加成方形死区。 |

WASD 斜向：键盘 a/d/w/s 绑为 `getVector('moveLeft','moveRight','moveUp','moveDown')` → 斜向模长 1（非 √2；AC-06）。

### gesture（触摸手势 recognizer，五类）

Five gesture recognizers running in the backend closure (C-3 single legal cross-frame state). All timers advance off injected `now()` (D-3), decoupled from pointer-event frequency. Two output channels (D-4): continuous values via `snap.gesture`, one-frame lifecycle events via `snap.gestureEvents`. No active gesture → identity empty signal (pinchScale=1.0, rotationAngle=0; AC-12).

| 调用 | 返回 | 语义 |
|:--|:--|:--|
| `snap.gesture.pinchScale` | `number` | 双指捏合缩放比值（累计）；无手势 → 1.0。begin 时复位为 1.0，2→1 指抬 end 后冻结，回 2 指 new begin 再复 1.0 (D-11) |
| `snap.gesture.rotationAngle` | `number` | 双指旋转累计角度（弧度）；无手势 → 0。与 pinch 共用同一双指 tracker，同帧 begin/end 成对 |
| `snap.gestureEvents` | `readonly GestureEvent[]` | 本帧手势生命周期事件队列（一帧寿命，对齐 pointerEvents）。`GestureEvent` 是封闭判别联合：`pinch-begin/end/cancel`、`rotate-begin/end/cancel`、`swipe`（含 direction）、`long-press`、`double-tap`。每个 event 带 `pointerType`（`'mouse' \| 'pen' \| 'touch'`，AC-19 消费路径） |

### 手势阈值默认表

| 常量 | 值 | 来源 |
|:--|:--|:--|
| 默认 per-action deadzone | `0.2` | Godot prior-art (F2) |
| `LONG_PRESS_DURATION_MS` | `500` | LayaAir prior-art |
| `LONG_PRESS_SLOP` | `10`（canvas px） | LayaAir prior-art |
| `DOUBLE_TAP_INTERVAL_MS` | `350` | LayaAir prior-art |
| `DOUBLE_TAP_DISTANCE` | `10`（canvas px） | LayaAir prior-art |
| `SWIPE_VELOCITY_THRESHOLD` | `0.5`（px/ms） | up 前 100ms 位移窗口推速度 |
| `SWIPE_WINDOW_MS` | `100` | 速度计算滑动窗口 (D-10) |

`engine.run()` 启动前调用返回空快照（不抛异常；charter P3 例外：构造阶段无事件源，空快照即"显式无信号"）。

## 形态铁律

- **Resource 形态唯一入口** — 用户胶水通过 `world.getResource<InputSnapshot>('InputSnapshot')` 消费；不暴露 `world.input` 平行 API（charter P4 一致抽象）
- **PointerLock 内部消化** — `requestPointerLock` 用户激活、`pointerlockchange` 状态机、`movementX/Y` 单位陷阱、`firstMouse` flag 全部封装在 `browser-backend.ts`；`InputSnapshot` 表面仅暴露 `snap.mouse.pointerLocked`（合并锁态 boolean）与 `snap.mouse.movementDelta`（累加 delta），不暴露 W3C DOM 细节（plan-strategy OOS-1）
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
| `snap.gamepad(i).standardMapping` 语义 | **true** when browser reports `mapping==='standard'` **or** SDL controller DB has normalized a non-standard layout (D-1 redline). `false` = not standard AND DB miss/unavailable — the downgrade is explicitly detectable (AC-10/E-2) |
| `snap.action(name)` 未注册 | 返回空信号：`isPressed()=false` / `strength=0` / `justPressed()=false` / `justReleased()=false`（不抛；AC-01/09） |
| `snap.gesture` 无活跃手势 | `pinchScale=1.0` / `rotationAngle=0`（恒等空信号，不抛；AC-12） |
| `snap.gestureEvents` 无生命周期事件 | 空数组 `[]`（不抛） |
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
| assemble form — action surface | Assemble-form hosts must manually `world.insertResource(INPUT_MAP_KEY, map)` to enable action readpoints (D-7). Canvas-form `createApp` does this automatically. |
| controller-db 子导出懒加载 | `@forgeax/engine-input/controller-db` is dynamically imported only on first connected non-standard gamepad (D-2). Until then (or on DB miss), non-standard slots maintain the Feat1 empty-signal behavior (`standardMapping=false`). Standard gamepads never trigger the load (C-5). |
| 手势 cancel on blur | `onBlur` resets all active gesture recognizers: emits cancel events for each active gesture type, resets continuous values to identity, and clears timers (AC-18). Prevent ghost gestures on refocus. |
| pointer-lock gate = game gate AND host predicate | `onCanvasClick` evaluates `gameGate && (predicate?.() ?? true)`. `gameGate` defaults to `true` and is set via `InputBackend.setPointerLockAllowed()`. `predicate` is `BrowserInputBackendOptions.pointerLockAllowed` (frozen at attach). Both must be true for a click to request lock. |
| `setPointerLockAllowed(false)` immediate release | When `gameGate` transitions from `true` to `false` and a lock is active, the backend immediately releases: W3C path calls `exitPointerLock()`, provider path calls `exitLock()` + clears `providerLocked`. This solves the "mode switches to top-down while locked" boundary. |
| lockProvider error → onLockError | W3C `requestPointerLock` promise rejection and provider `requestLock` throw/reject both route through `onLockError({ path, cause })`. Provider failure also rolls back `providerLocked = false`. The callback is wired by `attachInputAuto` into `AppError({ code: 'app-pointer-lock-failed' })` on the app's `onError` fan-out. |

## Pointer-lock contract: PointerLockProvider / lockProvider / setPointerLockAllowed / pointerLocked

Four anchors cover the full pointer-lock surface across the input-backend boundary.

### PointerLockProvider (type SSOT)

```ts
// @forgeax/engine-input — exported from barrel
interface PointerLockProvider {
  requestLock(): void | Promise<void>;  // request pointer capture (W3C replacement)
  exitLock(): void;                      // release pointer capture
}
```

A single object (not two flat callbacks) — structural typing requires both halves, preventing "requestLock-only" half-injected states. The engine never learns *why* locking is (dis)allowed; it delegates to the abstract callback.

### BrowserInputBackendOptions.lockProvider (injection point)

```ts
// BrowserInputBackendOptions — optional field, parallel to pointerLockAllowed
interface BrowserInputBackendOptions {
  pointerLockAllowed?: () => boolean;
  lockProvider?: PointerLockProvider;      // absent => fall back to W3C requestPointerLock()
  // ... other options
}
```

When `lockProvider` is present, `onCanvasClick` calls `requestLock()` instead of `requestPointerLock()`. The provider's `exitLock()` replaces `exitPointerLock()` in release paths (ESC provider branch, blur, detach, `setPointerLockAllowed(false)` immediate release).

### InputBackend.setPointerLockAllowed (command gate)

```ts
// InputBackend protocol — optional method
interface InputBackend {
  sample(): InputBackendSample;
  setPointerLockAllowed?(allowed: boolean): void;  // game-side gate
  detach(): void;
}
```

- `setPointerLockAllowed(true)` — allow pointer-lock on next trusted click
- `setPointerLockAllowed(false)` — block pointer-lock AND immediately release any active lock (W3C path: `exitPointerLock`; provider path: `exitLock()` + clears `providerLocked`)
- Default state: `true` (allow lock)
- Optional — backends without pointer-lock support omit this method

This works together with the pre-existing host predicate `pointerLockAllowed?: () => boolean` (evaluated fresh on each click, e.g. "is input focus in the game quadrant?"). Two gates AND-combine: both must be true for lock; neither duplicates the other's information.

### InputBackendSample.pointerLocked (readpoint)

```ts
// InputBackendSample — required field (not optional)
interface InputBackendSample {
  // ... movementX/Y, buttons, downKeys, upKeys, etc.
  readonly pointerLocked: boolean;  // W3C pointerlockchange OR provider requestLock engage
}
```

Frozen into `snap.mouse.pointerLocked` at frame-start. Consumers read `if (snap.mouse.pointerLocked)` to gate look/camera rotation — both facts (`movementDelta` + `pointerLocked`) sit at the same attribute path for single-point indexing (charter F1).

## 相关包

- [`@forgeax/engine-ecs`](../ecs) — 提供 `World` + Resource 存储 + Schedule（消费方契约依赖：`world.insertResource('InputSnapshot', frozenSnapshot)`）
- [`@forgeax/engine-runtime`](../runtime) — 在 `Engine.create({ canvas })` 流水线里调用 `attachBrowserInputBackend(canvas)`、`world.insertResource(INPUT_BACKEND_KEY, backend)` 与 `world.addSystem(InputFrameStartScan)`，对 AI 用户屏蔽组装细节
