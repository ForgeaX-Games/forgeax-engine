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

import type { InputBackend, InputBackendSample } from './input-snapshot';

/**
 * Options accepted by `attachBrowserInputBackend`. Reserved for the
 * post-MVP surface (sensitivity, key remap, gamepad probe). MVP keeps
 * the bag empty so additions are evolution-minor (plan-strategy OOS-1).
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
  function onMouseDown(ev: MouseEvent): void {
    if (ev.button === 0 || ev.button === 1 || ev.button === 2) {
      buttons[ev.button] = true;
    }
  }
  function onMouseUp(ev: MouseEvent): void {
    if (ev.button === 0 || ev.button === 1 || ev.button === 2) {
      buttons[ev.button] = false;
    }
  }
  function onMouseMove(ev: MouseEvent): void {
    // PointerLock movementX/Y are signed integer deltas in CSS pixels.
    // We accumulate until the next sample() call drains the value.
    mvx += ev.movementX;
    mvy += ev.movementY;
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
  safeAdd(canvas, 'mousedown', onMouseDown as EventListener);
  safeAdd(canvas, 'mouseup', onMouseUp as EventListener);
  safeAdd(canvas, 'mousemove', onMouseMove as EventListener);
  safeAdd(canvas, 'wheel', onWheel as EventListener);

  // PointerLock entry must be triggered by user activation (W3C requires
  // a click / keydown handler to call `requestPointerLock()`). The MVP
  // wires a click listener on the canvas as the activation surface;
  // OOS-1 keeps any explicit "request lock" / "exit lock" surface out
  // of the snapshot itself.
  function onCanvasClick(): void {
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
    const out: InputBackendSample = {
      downKeys: new Set(heldKeys),
      upKeys: new Set(upEdges),
      buttons: [buttons[0], buttons[1], buttons[2]] as readonly [boolean, boolean, boolean],
      movementX: mvx,
      movementY: mvy,
      wheelDelta: wheelAccum,
      focused: isFocused(),
    };
    // Reset per-frame accumulators (movement delta + up-edge set + wheel notches).
    upEdges.clear();
    mvx = 0;
    mvy = 0;
    wheelAccum = 0;
    return out;
  }

  function detach(): void {
    if (detached) return;
    detached = true;
    safeRemove(win, 'keydown', onKeyDown as EventListener);
    safeRemove(win, 'keyup', onKeyUp as EventListener);
    safeRemove(win, 'blur', onBlur as EventListener);
    safeRemove(canvas, 'mousedown', onMouseDown as EventListener);
    safeRemove(canvas, 'mouseup', onMouseUp as EventListener);
    safeRemove(canvas, 'mousemove', onMouseMove as EventListener);
    safeRemove(canvas, 'wheel', onWheel as EventListener);
    safeRemove(canvas, 'click', onCanvasClick as EventListener);
    // Best-effort exit of PointerLock; older specs require document.exitPointerLock.
    if (doc?.pointerLockElement === canvas && typeof doc.exitPointerLock === 'function') {
      doc.exitPointerLock();
    }
    heldKeys.clear();
    upEdges.clear();
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
