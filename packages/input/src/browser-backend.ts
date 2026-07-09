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

import type { ControllerDb, MappingTokens } from './controller-db';
import { diffGamepadFrame, type RawGamepadStub } from './gamepad-frame';
import {
  createRecognizerState,
  type GestureEvent,
  type GestureState,
  processGestureFrame,
  type RecognizerPointer,
  type RecognizerState,
} from './gesture-recognizer';
import type {
  Capabilities,
  GamepadSlotSample,
  InputBackend,
  InputBackendSample,
  PointerPhaseEvent,
  PointerSample,
  PointerType,
  VirtualAxisSample,
  VirtualJoystickConfig,
} from './input-snapshot';
import { type BindState, deriveVirtualAxes, handleVirtualJoystickUnbind } from './virtual-joystick';

// D-5: normalize W3C PointerEvent.pointerType to the canonical 3-literal union.
// The spec allows '' when device type is undetectable; we map it to 'mouse' so
// the snapshot consumers (action matchers, gesture recognizers) can exhaustively
// switch on PointerType without a default branch (AC-19).
export function coercePointerType(raw: string): PointerType {
  if (raw === 'pen') return 'pen';
  if (raw === 'touch') return 'touch';
  return 'mouse';
}

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
  /**
   * Optional SDL controller DB text loader (M3 D-13 test injection). When
   * omitted, the backend dynamic-imports the vendored 554KB DB from
   * `@forgeax/engine-input/controller-db-data` on first sight of a
   * non-standard gamepad (D-2 lazy-load: the 554KB never sits in the
   * default path). Tests inject a synthetic DB string to avoid loading the
   * real vendored file. Returns the raw gamecontrollerdb.txt contents.
   */
  readonly loadControllerDb?: () => Promise<string>;
  /**
   * Optional monotonic clock (M5 D-3 test injection). Defaults to
   * `() => performance.now()`. The gesture recognizer advances all timers
   * (long-press duration, double-tap / swipe windows) off this clock, NOT
   * off pointer-event arrival, so recognition stays decoupled from event
   * frequency (AC-16). Tests inject a fake clock for deterministic timing,
   * mirroring the `document` / `window` / `navigator` override pattern.
   */
  readonly now?: () => number;
  /**
   * Optional lock provider (D-2). When provided, pointer-lock requests
   * route through requestLock() / exitLock() instead of the W3C
   * requestPointerLock / exitPointerLock API. The backend remains
   * host-opaque -- it never learns whether the provider wraps Tauri
   * native-grab, postMessage, or any other mechanism.
   */
  readonly lockProvider?: PointerLockProvider;
  /**
   * Optional callback for lock request failures (D-4). When W3C
   * requestPointerLock rejects or lockProvider.requestLock/exitLock
   * throws/rejects, the backend calls this with a detail object.
   * Without this callback, failures are silently caught (backward
   * compatible but contrary to charter P3).
   */
  readonly onLockError?: (detail: { path: 'w3c' | 'provider'; cause: unknown }) => void;
}

/**
 * Lock provider interface (D-2). A host injects this to replace the
 * W3C Pointer Lock API path. requestLock() may return void (fire-and-forget,
 * D-7 optimistic placement) or Promise<void> (awaitable). exitLock() is
 * called when the backend needs to release the lock (ESC / blur / detach /
 * setPointerLockAllowed(false)).
 */
export interface PointerLockProvider {
  /**
   * Request pointer lock. The backend optimistically sets providerLocked=true
   * when this is called (D-7). On throw/reject, the backend calls onLockError
   * and rolls back providerLocked.
   */
  requestLock(): void | Promise<void>;
  /** Release pointer lock. */
  exitLock(): void;
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

  // w6: merged pointer-lock state tracking (D-1).
  // w3cLocked is driven by document-level pointerlockchange events,
  // isolated per-instance by comparing pointerLockElement === this canvas.
  let w3cLocked = false;
  // providerLocked is set optimistically when lockProvider.requestLock()
  // is called (D-7); cleared by exitLock() or on rejection.
  let providerLocked = false;
  // gameGate is a command-set boolean (setPointerLockAllowed), default true.
  let gameGate = true;

  // w8 (D-1/D-3): release the provider lock idempotently. Calls the injected
  // exitLock (routing any throw to onLockError as { path: 'provider' }) and
  // clears providerLocked unconditionally. Shared by every provider-release
  // site (ESC, blur, setPointerLockAllowed(false), detach) so the release
  // semantics live in one place.
  function releaseProviderLock(): void {
    if (providerLocked && options.lockProvider?.exitLock) {
      try {
        options.lockProvider.exitLock();
      } catch (err: unknown) {
        if (options.onLockError) options.onLockError({ path: 'provider', cause: err });
      }
    }
    providerLocked = false;
  }

  // D-4: capability detected once at attach time.
  const nav =
    options.navigator ?? (globalThis as { navigator?: { getGamepads?(): unknown } }).navigator;
  const gamepadAvailable = typeof nav?.getGamepads === 'function';
  const pointerAvailable = typeof globalThis.PointerEvent !== 'undefined';
  const caps: Capabilities = { gamepad: gamepadAvailable, pointer: pointerAvailable };

  // D-1: prevGamepadFrame is the only cross-frame state holder for gamepad diff.
  // Stored in backend closure; diffGamepadFrame compares prev vs cur each sample().
  let prevGamepadFrame = new Map<number, GamepadSlotSample>();

  // M3 D-2 lazy-load state. The SDL DB (554KB) is loaded once, on first sight
  // of a non-standard gamepad, then cached here. `controllerDb` stays
  // undefined until the async load resolves; frames before that keep the
  // Feat1 empty signal (graceful degradation). `dbLoadStarted` prevents
  // re-triggering the load on every frame while the promise is pending.
  let controllerDb: ControllerDb | undefined;
  let dbLoadStarted = false;
  // Per-id GUID resolution cache (avoids re-parsing the same Gamepad.id).
  const guidCache = new Map<string, string | undefined>();

  // M3 D-13: the DB parser + GUID helpers live in the pure controller-db
  // module. They are dynamic-imported alongside the data so neither the
  // parser nor the 554KB vendored text enters the main-entry bundle.
  let controllerDbApi:
    | {
        parseControllerDb: (txt: string) => ControllerDb;
        extractGuidFromGamepadId: (id: string) => string | undefined;
        selectBestMappingEntry: (
          db: ControllerDb,
          guid: string,
          platform: string | undefined,
        ) => { readonly tokens: MappingTokens } | undefined;
        platformFromUserAgent: (ua: string) => string | undefined;
      }
    | undefined;

  function kickOffDbLoad(): void {
    if (dbLoadStarted) return;
    dbLoadStarted = true;
    const loadApi = controllerDbApi
      ? Promise.resolve(controllerDbApi)
      : import('@forgeax/engine-input/controller-db').then((m) => {
          controllerDbApi = m;
          return m;
        });
    const loadText = options.loadControllerDb
      ? options.loadControllerDb()
      : import('@forgeax/engine-input/controller-db-data').then((m) => m.loadBundledControllerDb());
    Promise.all([loadApi, loadText])
      .then(([api, txt]) => {
        controllerDb = api.parseControllerDb(txt);
      })
      .catch(() => {
        // Load failed (offline chunk / bad text): keep the Feat1 empty
        // signal. Reset so a later frame may retry.
        dbLoadStarted = false;
      });
  }

  // Acquisition-layer remap lookup passed to diffGamepadFrame. Returns the
  // standard-layout mapping tokens for a Gamepad.id, or null when the DB is
  // not yet loaded / the GUID is unextractable / no DB entry matches.
  function remapLookup(gamepadId: string): MappingTokens | null {
    if (!controllerDb || !controllerDbApi) return null;
    let guid = guidCache.get(gamepadId);
    if (!guidCache.has(gamepadId)) {
      guid = controllerDbApi.extractGuidFromGamepadId(gamepadId);
      guidCache.set(gamepadId, guid);
    }
    if (!guid) return null;
    const ua =
      typeof globalThis.navigator?.userAgent === 'string' ? globalThis.navigator.userAgent : '';
    const platform = controllerDbApi.platformFromUserAgent(ua);
    const entry = controllerDbApi.selectBestMappingEntry(controllerDb, guid, platform);
    return entry ? entry.tokens : null;
  }

  // w15: pointer map (pointerId → live position), phase queue (one-frame lifecycle),
  // and per-pointer previous position for cross-frame delta.
  const pointerMap = new Map<
    number,
    {
      x: number;
      y: number;
      pressure: number;
      pointerType: PointerType;
      prevX: number;
      prevY: number;
    }
  >();
  const phaseQueue: PointerPhaseEvent[] = [];

  // w21: virtual joystick binding state (per-joystick name → BindState).
  const vjConfigs = options.virtualJoysticks ?? [];
  const vjBindState = new Map<string, BindState>();

  // M5 D-3/D-4: gesture recognizer cross-frame state lives in this closure
  // (C-3: the only sanctioned cross-frame gesture holder, alongside
  // prevGamepadFrame / pointerMap / vjBindState). `now` is injectable for
  // deterministic test timing; production uses performance.now().
  const now = options.now ?? (() => performance.now());
  let recognizerState: RecognizerState = createRecognizerState();

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
    // w8 (D-1): ESC releases provider lock (W3C path handles ESC via browser
    // pointerlockchange). Only acts when providerLocked is true.
    if (ev.key === 'Escape' && providerLocked) {
      releaseProviderLock();
    }
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
      pointerType: coercePointerType(ev.pointerType),
      prevX: coords.x,
      prevY: coords.y,
    });
    phaseQueue.push({
      pointerId: ev.pointerId,
      phase: 'down',
      x: coords.x,
      y: coords.y,
      pressure: ev.pressure,
      pointerType: coercePointerType(ev.pointerType),
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
        pointerType: coercePointerType(ev.pointerType),
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
        pointerType: coercePointerType(ev.pointerType),
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
        pointerType: coercePointerType(ev.pointerType),
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
    // w8 (D-1): release provider lock on blur (W3C path handles focus loss
    // via browser pointerlockchange).
    releaseProviderLock();
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

  // w6 (D-1): track W3C pointer-lock state via document-level pointerlockchange.
  // Per-instance isolation: only update w3cLocked when pointerLockElement matches
  // this backend's canvas. This handles ESC / blur / browser-auto-unlock natively
  // without backend-side ESC logic for the W3C path.
  function onPointerLockChange(): void {
    w3cLocked = doc.pointerLockElement === canvas;
  }
  safeAdd(doc, 'pointerlockchange', onPointerLockChange as EventListener);

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
    // D-3: dual gate synthesis -- gameGate (command-set by template) AND
    // hostPredicate (per-click evaluated by host). Both must pass to proceed.
    if (!gameGate) return;
    // Host gate: when the host says "not now" (e.g. an editor viewport that owns
    // the cursor outside the play-game quadrant) skip the lock entirely. Default
    // is always-allow, so the standalone game runtime is unchanged.
    if (options.pointerLockAllowed && !options.pointerLockAllowed()) return;
    // Pointer Lock requires window focus; skip silently when unfocused.
    if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return;

    // D-2 / D-7: lockProvider path takes priority over W3C.
    if (options.lockProvider) {
      providerLocked = true; // D-7 optimistic placement
      try {
        const result = options.lockProvider.requestLock();
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((cause: unknown) => {
            providerLocked = false;
            if (options.onLockError) {
              options.onLockError({ path: 'provider', cause });
            }
          });
        }
      } catch (cause: unknown) {
        // Synchronous throw from requestLock.
        providerLocked = false;
        if (options.onLockError) {
          options.onLockError({ path: 'provider', cause });
        }
      }
      return;
    }

    // W3C path: standard requestPointerLock.
    const fn = canvas.requestPointerLock;
    if (typeof fn !== 'function') return;
    const r = fn.call(canvas) as unknown;
    if (r && typeof (r as Promise<void>).catch === 'function') {
      (r as Promise<void>).catch((cause: unknown) => {
        if (options.onLockError) {
          options.onLockError({ path: 'w3c', cause });
        }
      });
    }
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
        let hasNonStandard = false;
        for (const gp of rawGamepads) {
          if (!gp?.connected) continue;
          valid.push(gp);
          if (gp.mapping !== 'standard') hasNonStandard = true;
        }
        // M3 D-2 / C-5: only a real non-standard gamepad triggers the DB
        // load. Standard pads never pull in the 554KB DB.
        if (hasNonStandard) kickOffDbLoad();
        gamepads = diffGamepadFrame(prevGamepadFrame, valid, remapLookup);
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

    // M5 D-4: run the gesture recognizer over this frame's phase queue BEFORE
    // it is drained below. onBlur / pointercancel pushed cancel phases into
    // the same queue, so the recognizer naturally resets active gestures +
    // emits cancel events (AC-18) without a separate reset path. All timers
    // advance off `now()` (D-3), decoupled from event frequency (AC-16).
    const gestureResult = processGestureFrame(
      phaseQueue,
      pointerMap as ReadonlyMap<number, RecognizerPointer>,
      recognizerState,
      now(),
    );
    recognizerState = gestureResult.newState;
    // Emit optional fields only when there is gesture signal to carry: an
    // active/frozen continuous value (non-identity) or lifecycle events.
    const gestureEvents: readonly GestureEvent[] | undefined =
      gestureResult.gestureEvents.length > 0 ? gestureResult.gestureEvents : undefined;
    const gs = gestureResult.gestureState;
    const gestures: GestureState | undefined =
      gs.pinchScale !== 1 || gs.rotationAngle !== 0 ? gs : undefined;

    const out: InputBackendSample = {
      downKeys: new Set(heldKeys),
      upKeys: new Set(upEdges),
      buttons: [buttons[0], buttons[1], buttons[2]] as readonly [boolean, boolean, boolean],
      movementX: mvx,
      movementY: mvy,
      wheelDelta: wheelAccum,
      focused: isFocused(),
      capabilities: caps,
      pointerLocked: w3cLocked || providerLocked,
      ...(gamepads ? { gamepads } : {}),
      ...(pointers ? { pointers } : {}),
      ...(pointerEvents ? { pointerEvents } : {}),
      ...(virtualAxes ? { virtualAxes } : {}),
      ...(gestures ? { gestures } : {}),
      ...(gestureEvents ? { gestureEvents } : {}),
    };
    // Reset per-frame accumulators (movement delta + up-edge set + wheel notches + phase queue).
    upEdges.clear();
    mvx = 0;
    mvy = 0;
    wheelAccum = 0;
    phaseQueue.length = 0;
    return out;
  }

  // w8 (D-3): command-set game gate for pointer-lock. set(false) immediately
  // releases any active lock on both W3C and provider paths.
  function setPointerLockAllowed(allowed: boolean): void {
    gameGate = allowed;
    if (!allowed) {
      // W3C path: exit pointer-lock if currently locked on this canvas.
      if (typeof doc.exitPointerLock === 'function' && doc.pointerLockElement === canvas) {
        doc.exitPointerLock();
      }
      // Provider path: call exitLock and clear providerLocked.
      releaseProviderLock();
    }
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
    safeRemove(doc, 'pointerlockchange', onPointerLockChange as EventListener);
    safeRemove(canvas, 'click', onCanvasClick as EventListener);
    // w8 (D-1): release provider lock on detach (symmetrical with W3C path).
    releaseProviderLock();
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
    recognizerState = createRecognizerState();
    buttons[0] = false;
    buttons[1] = false;
    buttons[2] = false;
    mvx = 0;
    mvy = 0;
    wheelAccum = 0;
  }

  const backend: InputBackend = { sample, detach, setPointerLockAllowed };

  // Returned callable doubles as the InputBackend (detach + sample). AI
  // users see one symbol with both shapes, mirroring the
  // produces-detach-and-protocol convention of `effect`-style libraries.
  const handle = Object.assign(detach, { backend });
  return handle;
}
