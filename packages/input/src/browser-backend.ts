// browser-backend.ts -- DOM PointerLock + keyboard / mouse listener producer.
//
// charter awareness:
//   F2 minimal surface -- exposes only `attachBrowserInputBackend(canvas)`
//     returning a `(): void` detach handle; PointerLock + listener wiring
//     is internal (plan OOS-1 explicit -- not part of the user-facing
//     surface)
//   P3 explicit failure -- detach is part of the contract; double-detach
//     is a no-op (idempotent)
//   P4 consistent abstraction -- the snapshot consumer does not see
//     PointerLock state machine or `movementX/Y` units; only
//     `mouse.movementDelta`
//   P5 producer/consumer split -- this file is the only DOM-touching
//     surface in the package; everything else operates on the
//     `InputBackend` protocol (see input-snapshot.ts)
//
// Note: the actual PointerLock pump runs in a real browser; node-based
// vitest unit tests inject fake backends through the `InputBackend`
// protocol. The browser-mode coverage of this file is the M2b layer
// (plan-strategy section 5.4 reason for the 70% floor).

import { diffGamepadFrame, type RawGamepadStub } from './gamepad-frame';
import type {
  Capabilities,
  GamepadSlotSample,
  InputBackend,
  InputBackendSample,
  PointerPhaseEvent,
  PointerSample,
  VirtualAxisSample,
  VirtualJoystickConfig,
} from './input-snapshot';
import { type BindState, deriveVirtualAxes, handleVirtualJoystickUnbind } from './virtual-joystick';

/**
 * Options accepted by `attachBrowserInputBackend`.
 */
export interface BrowserInputBackendOptions {
  /**
   * Optional document handle (testing override). Defaults to `document`.
   * Plan-strategy section 9 row 7 (`document.hasFocus()` semantics)
   * relies on this to decide whether the up-edge set should be cleared
   * when focus is lost.
   */
  readonly document?: Document;
  /**
   * Optional window handle (testing override). Defaults to `window`.
   * Used to attach key listeners (capturing focus loss) without
   * requiring the canvas itself to receive keyboard events.
   */
  readonly window?: Window;
  /**
   * Neutral gate for the auto PointerLock-on-click. When provided and it
   * returns false, the click handler skips `requestPointerLock()` — the host
   * decides whether a click should capture the cursor right now. Defaults to
   * always-locking (returns true), so the standalone game runtime keeps its
   * MVP behaviour unchanged. This predicate is deliberately host-opaque: the
   * backend never learns WHY locking is (dis)allowed — it only asks. A host
   * that mounts this canvas in a non-game context (e.g. an editor viewport
   * that owns the cursor for orbit/pick) supplies a predicate that returns
   * false there. The input package carries zero knowledge of those contexts.
   */
  readonly pointerLockAllowed?: () => boolean;
  /**
   * Optional navigator handle (testing override). Defaults to
   * `globalThis.navigator`. Used to poll `navigator.getGamepads()` each
   * frame. Mirrors the `document`/`window` override pattern.
   */
  readonly navigator?: { getGamepads?(): (Gamepad | null)[] };
  /**
   * Optional virtual joystick configurations (M3). When provided, the
   * backend auto-binds the first pointerdown within each config's region
   * and derives per-frame VirtualAxisSample outputs via deriveVirtualAxes.
   */
  readonly virtualJoysticks?: readonly VirtualJoystickConfig[];
}

/**
 * Attach DOM listeners (keydown / keyup / mousedown / mouseup /
 * pointerlockchange / mousemove inside lock / blur) to `canvas` and the
 * surrounding window. Returns a `detach` callable that:
 *
 *   - removes all listeners
 *   - exits PointerLock if currently locked
 *   - drops every internal accumulator
 *
 * The returned object also implements the `InputBackend` protocol -- the
 * runtime inserts it under `INPUT_BACKEND_KEY` and adds the
 * `InputFrameStartScan` system, which reads it back each tick.
 * Calling `detach()` and the protocol's `detach()` are equivalent
 * (idempotent; double-detach is safe -- charter P3).
 */
export function attachBrowserInputBackend(
  canvas: HTMLCanvasElement,
  options: BrowserInputBackendOptions = {},
): (() => void) & { backend: InputBackend } {
  const doc = options.document ?? globalThis.document;
  const win = options.window ?? globalThis.window;

  const heldKeys = new Set<string>();
  const upEdges = new Set<string>();
  const buttons: [boolean, boolean, boolean] = [false, false, false];
  let mvx = 0;
  let mvy = 0;
  let wheelAccum = 0;
  let detached = false;

  // D-4: capability detected once at attach time.
  const nav =
    options.navigator ?? (globalThis as { navigator?: { getGamepads?(): unknown } }).navigator;
  const gamepadAvailable = typeof nav?.getGamepads === 'function';
  const pointerAvailable = typeof globalThis.PointerEvent !== 'undefined';
  const caps: Capabilities = { gamepad: gamepadAvailable, pointer: pointerAvailable };

  // D-1: prevGamepadFrame is the only cross-frame state holder for gamepad diff.
  // Stored in backend closure; diffGamepadFrame compares prev vs cur each sample().
  let prevGamepadFrame = new Map<number, GamepadSlotSample>();

  // w15: pointer map (pointerId → live position), phase queue (one-frame lifecycle),
  // and per-pointer previous position for cross-frame delta.
  const pointerMap = new Map<
    number,
    { x: number; y: number; pressure: number; pointerType: string; prevX: number; prevY: number }
  >();
  const phaseQueue: PointerPhaseEvent[] = [];

  // w21: virtual joystick binding state (per-joystick name → BindState).
  const vjConfigs = options.virtualJoysticks ?? [];
  const vjBindState = new Map<string, BindState>();

  // DPR coordinate helpers. computePointerCoords applies the standard DPR-correct
  // canvas-pixel formula; falls back to clientX/clientY when getBoundingClientRect
  // is missing (fake canvas in unit tests).
  function computePointerCoords(ev: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect?.();
    if (!rect) return { x: ev.clientX, y: ev.clientY };
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (ev.clientX - rect.left) * scaleX,
      y: (ev.clientY - rect.top) * scaleY,
    };
  }

  function isFocused(): boolean {
    // `document.hasFocus()` indicates whether the tab is foreground;
    // when unfocused we suppress up-edges so stale releases do not fire
    // after alt-tabbing back (section 9 row 7).
    return typeof doc?.hasFocus === 'function' ? doc.hasFocus() : true;
  }

  function onKeyDown(ev: KeyboardEvent): void {
    heldKeys.add(ev.key);
    upEdges.delete(ev.key);
  }
  function onKeyUp(ev: KeyboardEvent): void {
    heldKeys.delete(ev.key);
    if (isFocused()) {
      upEdges.add(ev.key);
    }
  }
  function onPointerDown(ev: PointerEvent): void {
    // Only mouse-type pointers affect the mouse button cluster (D-3).
    if (ev.pointerType === 'mouse') {
      if (ev.button === 0 || ev.button === 1 || ev.button === 2) {
        buttons[ev.button] = true;
      }
    }
    // D-5: setPointerCapture for coherent pointer event dispatching.
    if (typeof canvas.setPointerCapture === 'function') {
      canvas.setPointerCapture(ev.pointerId);
    }
    // Track pointer in map for multi-pointer + delta (w15).
    const coords = computePointerCoords(ev);
    pointerMap.set(ev.pointerId, {
      x: coords.x,
      y: coords.y,
      pressure: ev.pressure,
      pointerType: ev.pointerType,
      prevX: coords.x,
      prevY: coords.y,
    });
    phaseQueue.push({
      pointerId: ev.pointerId,
      phase: 'down',
      x: coords.x,
      y: coords.y,
      pressure: ev.pressure,
      pointerType: ev.pointerType,
    });
    // w21: virtual joystick auto-bind -- first config whose region contains
    // the pointerdown position, if not already bound to another pointer.
    if (vjConfigs.length > 0) {
      for (const cfg of vjConfigs) {
        const { region } = cfg;
        if (
          coords.x >= region.x &&
          coords.x <= region.x + region.width &&
          coords.y >= region.y &&
          coords.y <= region.y + region.height
        ) {
          const existing = vjBindState.get(cfg.name);
          if (!existing?.pointerId) {
            const originX =
              cfg.mode === 'fixed' ? (cfg.anchor?.x ?? region.x + region.width / 2) : coords.x;
            const originY =
              cfg.mode === 'fixed' ? (cfg.anchor?.y ?? region.y + region.height / 2) : coords.y;
            if (existing) {
              existing.pointerId = ev.pointerId;
              existing.originX = originX;
              existing.originY = originY;
            } else {
              vjBindState.set(cfg.name, { pointerId: ev.pointerId, originX, originY });
            }
            // Only bind the first matching config per pointerdown.
            break;
          }
        }
      }
    }
  }
  function onPointerUp(ev: PointerEvent): void {
    if (ev.pointerType === 'mouse') {
      if (ev.button === 0 || ev.button === 1 || ev.button === 2) {
        buttons[ev.button] = false;
      }
    }
    const entry = pointerMap.get(ev.pointerId);
    if (entry) {
      phaseQueue.push({
        pointerId: ev.pointerId,
        phase: 'up',
        x: entry.x,
        y: entry.y,
        pressure: ev.pressure,
        pointerType: ev.pointerType,
      });
      pointerMap.delete(ev.pointerId);
    }
    // w21: unbind virtual joystick bound to this pointer.
    if (vjBindState.size > 0) {
      handleVirtualJoystickUnbind(vjBindState, ev.pointerId);
    }
  }
  function onPointerMove(ev: PointerEvent): void {
    // D-3: movementDelta from pointermove (PointerEvent extends MouseEvent).
    if (ev.pointerType === 'mouse') {
      mvx += ev.movementX;
      mvy += ev.movementY;
    }
    // Update live position; prevX/prevY NOT updated here (AC-09: prev only
    // snapshots at sample() time, preventing Bevy #12442 zero-delta bug).
    const coords = computePointerCoords(ev);
    const entry = pointerMap.get(ev.pointerId);
    if (entry) {
      entry.x = coords.x;
      entry.y = coords.y;
      entry.pressure = ev.pressure;
      phaseQueue.push({
        pointerId: ev.pointerId,
        phase: 'move',
        x: coords.x,
        y: coords.y,
        pressure: ev.pressure,
        pointerType: ev.pointerType,
      });
    }
  }
  function onPointerCancel(ev: PointerEvent): void {
    const entry = pointerMap.get(ev.pointerId);
    if (entry) {
      phaseQueue.push({
        pointerId: ev.pointerId,
        phase: 'cancel',
        x: entry.x,
        y: entry.y,
        pressure: ev.pressure,
        pointerType: ev.pointerType,
      });
      pointerMap.delete(ev.pointerId);
    }
    // w21: unbind virtual joystick on pointer cancel.
    if (vjBindState.size > 0) {
      handleVirtualJoystickUnbind(vjBindState, ev.pointerId);
    }
  }
  function onVisibilityChange(): void {
    if (doc.visibilityState === 'hidden') {
      onBlur();
    }
  }
  function onWheel(ev: WheelEvent): void {
    // plan-strategy D-5 sign-discrete normalization: collapse `WheelEvent`
    // across the three `deltaMode` units (PIXEL / LINE / PAGE) by taking
    // `Math.sign(deltaY)` per event. Trade-off documented at the
    // InputSnapshot.mouse.wheelDelta JSDoc + plan-strategy R-7.
    const dy = ev.deltaY;
    if (typeof dy === 'number' && dy !== 0) {
      wheelAccum += dy > 0 ? 1 : -1;
    }
  }
  function onBlur(): void {
    // OOS-1 caveat: held-keys persist across focus loss (so users do
    // not appear to release every key while alt-tabbing); up-edges are
    // dropped because the matching down-events were never observed by
    // this window.
    upEdges.clear();
    // w16 (AC-10): clear active pointers and push cancel phase events.
    if (pointerMap.size > 0) {
      for (const [id, entry] of pointerMap) {
        phaseQueue.push({
          pointerId: id,
          phase: 'cancel',
          x: entry.x,
          y: entry.y,
          pressure: entry.pressure,
          pointerType: entry.pointerType,
        });
      }
      pointerMap.clear();
    }
    // w16 (AC-10): reset gamepad edge state so next frame does not
    // emit phantom justPressed/justReleased for stale slots.
    prevGamepadFrame.clear();
    // w21: clear virtual joystick bindings on blur.
    vjBindState.clear();
  }

  // Use try-blocks: jsdom / fake canvases passed by tests may lack
  // `addEventListener`. We probe and skip silently to keep the unit-test
  // surface workable (charter P3: detach must always succeed even if
  // attach was a partial wiring).
  const safeAdd = <K extends string>(
    target: { addEventListener?: (k: K, h: EventListener) => void } | undefined,
    kind: K,
    handler: EventListener,
  ): void => {
    target?.addEventListener?.(kind, handler);
  };
  const safeRemove = <K extends string>(
    target: { removeEventListener?: (k: K, h: EventListener) => void } | undefined,
    kind: K,
    handler: EventListener,
  ): void => {
    target?.removeEventListener?.(kind, handler);
  };

  safeAdd(win, 'keydown', onKeyDown as EventListener);
  safeAdd(win, 'keyup', onKeyUp as EventListener);
  safeAdd(win, 'blur', onBlur as EventListener);
  safeAdd(canvas, 'pointerdown', onPointerDown as EventListener);
  safeAdd(canvas, 'pointerup', onPointerUp as EventListener);
  safeAdd(canvas, 'pointermove', onPointerMove as EventListener);
  safeAdd(canvas, 'pointercancel', onPointerCancel as EventListener);
  safeAdd(canvas, 'wheel', onWheel as EventListener);
  safeAdd(doc, 'visibilitychange', onVisibilityChange as EventListener);

  // PointerLock entry must be triggered by user activation (W3C requires
  // a click / keydown handler to call `requestPointerLock()`). The MVP
  // wires a click listener on the canvas as the activation surface;
  // OOS-1 keeps any explicit "request lock" / "exit lock" surface out
  // of the snapshot itself.
  // D-5: touch-action:none on the canvas so the browser does not interpret
  // touch gestures (scroll/pinch/zoom) and deprioritizes pointer events.
  // Presence-detect .style (fake canvas in unit tests may lack it).
  let _prevTouchAction: string | undefined;
  if (canvas.style) {
    _prevTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';
  }

  function onCanvasClick(): void {
    // Host gate: when the host says "not now" (e.g. an editor viewport that owns
    // the cursor outside the play·game quadrant) skip the lock entirely. Default
    // is always-allow, so the standalone game runtime is unchanged.
    if (options.pointerLockAllowed && !options.pointerLockAllowed()) return;
    const fn = canvas.requestPointerLock;
    if (typeof fn !== 'function') return;
    // Pointer Lock requires window focus; skip silently when unfocused
    // (the next focused click will acquire it) and swallow the async
    // rejection so a post-load / iframe `WrongDocumentError` never
    // surfaces as an unhandled promise rejection.
    if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return;
    const r = fn.call(canvas) as unknown;
    if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => {});
  }
  safeAdd(canvas, 'click', onCanvasClick as EventListener);

  function sample(): InputBackendSample {
    // D-1: gamepad edge diff derived inside sample() — the only
    // cross-frame state holder. getGamepads() is polled once per frame;
    // null-padded arrays use gamepad.index as slot key.
    let gamepads: GamepadSlotSample[] | undefined;
    if (gamepadAvailable) {
      try {
        const rawGamepads = (nav.getGamepads?.() ?? []) as (RawGamepadStub | null)[];
        const valid: RawGamepadStub[] = [];
        for (const gp of rawGamepads) {
          if (gp?.connected) valid.push(gp);
        }
        gamepads = diffGamepadFrame(prevGamepadFrame, valid);
        // Store this frame's state for next frame's diff.
        const nextFrame = new Map<number, GamepadSlotSample>();
        for (const slot of gamepads) {
          // Only store currently-connected slots for the next diff.
          // Disconnected slots (standardMapping=false, pressed=empty)
          // are not stored; they won't appear in next frame's prev.
          if (slot.pressed.size > 0 || slot.standardMapping) {
            nextFrame.set(slot.index, slot);
          }
        }
        prevGamepadFrame = nextFrame;
      } catch {
        // getGamepads() threw — treat as if no gamepad API.
        // AC-05: API unstable environment does not crash.
      }
    }

    // w15: freeze pointer map → PointerSample[] with cross-frame delta.
    // Delta = current frozen position − previous frozen position (AC-09).
    let pointers: PointerSample[] | undefined;
    if (pointerMap.size > 0) {
      pointers = [];
      for (const [id, entry] of pointerMap) {
        const deltaX = entry.x - entry.prevX;
        const deltaY = entry.y - entry.prevY;
        pointers.push({
          pointerId: id,
          x: entry.x,
          y: entry.y,
          pressure: entry.pressure,
          pointerType: entry.pointerType,
          active: true,
          delta: Object.freeze({ x: deltaX, y: deltaY }),
        });
        // Update prev position for next frame's delta (D-1 frame-end freeze).
        entry.prevX = entry.x;
        entry.prevY = entry.y;
      }
    }

    // w15: snapshot the phase queue for this frame.
    const pointerEvents: PointerPhaseEvent[] | undefined =
      phaseQueue.length > 0 ? [...phaseQueue] : undefined;

    // w21: derive virtual joystick axes from live pointer positions.
    let virtualAxes: VirtualAxisSample[] | undefined;
    if (vjConfigs.length > 0) {
      virtualAxes = deriveVirtualAxes(vjConfigs, pointerMap, vjBindState);
    }

    const out: InputBackendSample = {
      downKeys: new Set(heldKeys),
      upKeys: new Set(upEdges),
      buttons: [buttons[0], buttons[1], buttons[2]] as readonly [boolean, boolean, boolean],
      movementX: mvx,
      movementY: mvy,
      wheelDelta: wheelAccum,
      focused: isFocused(),
      capabilities: caps,
      ...(gamepads ? { gamepads } : {}),
      ...(pointers ? { pointers } : {}),
      ...(pointerEvents ? { pointerEvents } : {}),
      ...(virtualAxes ? { virtualAxes } : {}),
    };
    // Reset per-frame accumulators (movement delta + up-edge set + wheel notches + phase queue).
    upEdges.clear();
    mvx = 0;
    mvy = 0;
    wheelAccum = 0;
    phaseQueue.length = 0;
    return out;
  }

  function detach(): void {
    if (detached) return;
    detached = true;
    safeRemove(win, 'keydown', onKeyDown as EventListener);
    safeRemove(win, 'keyup', onKeyUp as EventListener);
    safeRemove(win, 'blur', onBlur as EventListener);
    safeRemove(canvas, 'pointerdown', onPointerDown as EventListener);
    safeRemove(canvas, 'pointerup', onPointerUp as EventListener);
    safeRemove(canvas, 'pointermove', onPointerMove as EventListener);
    safeRemove(canvas, 'pointercancel', onPointerCancel as EventListener);
    safeRemove(canvas, 'wheel', onWheel as EventListener);
    safeRemove(doc, 'visibilitychange', onVisibilityChange as EventListener);
    safeRemove(canvas, 'click', onCanvasClick as EventListener);
    // Best-effort exit of PointerLock; older specs require document.exitPointerLock.
    if (doc?.pointerLockElement === canvas && typeof doc.exitPointerLock === 'function') {
      doc.exitPointerLock();
    }
    // D-5: restore original touch-action value.
    if (canvas.style && _prevTouchAction !== undefined) {
      canvas.style.touchAction = _prevTouchAction;
    }
    heldKeys.clear();
    upEdges.clear();
    pointerMap.clear();
    phaseQueue.length = 0;
    prevGamepadFrame.clear();
    vjBindState.clear();
    buttons[0] = false;
    buttons[1] = false;
    buttons[2] = false;
    mvx = 0;
    mvy = 0;
    wheelAccum = 0;
  }

  const backend: InputBackend = { sample, detach };

  // Returned callable doubles as the InputBackend (detach + sample). AI
  // users see one symbol with both shapes, mirroring the
  // produces-detach-and-protocol convention of `effect`-style libraries.
  const handle = Object.assign(detach, { backend });
  return handle;
}
