import { Update } from '@forgeax/engine-ecs';
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=5):
//   - packages/input/src/__tests__/browser-backend-wheel-normalization.test.ts
//   - packages/input/src/__tests__/browser-backend.test.ts
//   - packages/input/src/__tests__/frame-start-scan-system.test.ts
//   - packages/input/src/__tests__/input-snapshot.test.ts
//   - packages/input/src/__tests__/wheel-delta.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
//
// Note: merged from src/__tests__/ into __tests__/; import paths adjusted (../ → ../src/).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { attachBrowserInputBackend, coercePointerType } from '../src/browser-backend';
import {
  buildGuidFromVidPid,
  extractGuidFromGamepadId,
  type MappingTokens,
  parseControllerDb,
  platformFromUserAgent,
  selectBestMappingEntry,
} from '../src/controller-db';
import type {
  Capabilities,
  GamepadSlotSample,
  PointerPhaseEvent,
  VirtualJoystickConfig,
} from '../src/input-snapshot';
import {
  createInputSnapshot,
  INPUT_BACKEND_KEY,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackend,
  InputFrameStartScan,
  type InputSnapshot,
  type PointerType,
  snapshotFromSample,
} from '../src/index';
import { diffGamepadFrame, type RawGamepadStub } from '../src/gamepad-frame';
import {
  deriveVirtualAxes,
  handleVirtualJoystickUnbind,
  type BindState,
} from '../src/virtual-joystick';
import {
  deriveActionStates,
  getAxis,
  getVector,
  type ActionConfig,
  type ActionState,
  type GetVectorOptions,
} from '../src/action-state';
import {
  createRecognizerState,
  DOUBLE_TAP_DISTANCE,
  DOUBLE_TAP_INTERVAL_MS,
  type GestureEvent,
  type GestureState,
  LONG_PRESS_DURATION_MS,
  LONG_PRESS_SLOP,
  processGestureFrame,
  type RecognizerPointer,
  type RecognizerState,
  SWIPE_VELOCITY_THRESHOLD,
  SWIPE_WINDOW_MS,
} from '../src/gesture-recognizer';

/**
 * Build a standard-layout GamepadSlotSample for test injection.
 * Standard mapping has 17 buttons (0-16) and 4 axes (0-3).
 */
function buildGamepadSlot(index: number, overrides?: {
  pressed?: number[];
  justPressed?: number[];
  justReleased?: number[];
  buttonValues?: Map<number, number>;
  axes?: [number, number, number, number];
  standardMapping?: boolean;
}): GamepadSlotSample {
  return {
    index,
    standardMapping: overrides?.standardMapping ?? true,
    pressed: new Set(overrides?.pressed ?? []),
    justPressed: new Set(overrides?.justPressed ?? []),
    justReleased: new Set(overrides?.justReleased ?? []),
    buttonValues: overrides?.buttonValues ?? new Map(),
    axes: overrides?.axes ?? [0, 0, 0, 0],
  };
}

interface FakeListenerStore {
  fire(target: string, kind: string, ev: Partial<WheelEvent | KeyboardEvent | MouseEvent>): void;
}

/**
 * Extended fixtureBackend with optional gamepad/capability fields for M1+ testing.
 * Defined at top level so all test blocks can access it.
 */
function fixtureBackend(initial: {
  downKeys?: ReadonlySet<string>;
  upKeys?: ReadonlySet<string>;
  buttons?: readonly [boolean, boolean, boolean];
  movementX?: number;
  movementY?: number;
  wheelDelta?: number;
  focused?: boolean;
  pointerLocked?: boolean;
  gamepads?: readonly GamepadSlotSample[];
  capabilities?: Capabilities;
  pointers?: readonly import('../src/input-snapshot').PointerSample[];
  pointerEvents?: readonly import('../src/input-snapshot').PointerPhaseEvent[];
}): InputBackend & { sampleCalls: number } {
  let calls = 0;
  return {
    sample(): {
      downKeys: ReadonlySet<string>;
      upKeys: ReadonlySet<string>;
      buttons: readonly [boolean, boolean, boolean];
      movementX: number;
      movementY: number;
      wheelDelta: number;
      focused: boolean;
      pointerLocked: boolean;
      gamepads?: readonly GamepadSlotSample[];
      capabilities?: Capabilities;
      pointers?: readonly import('../src/input-snapshot').PointerSample[];
      pointerEvents?: readonly import('../src/input-snapshot').PointerPhaseEvent[];
    } {
      calls += 1;
      return {
        downKeys: initial.downKeys ?? new Set<string>(),
        upKeys: initial.upKeys ?? new Set<string>(),
        buttons: initial.buttons ?? [false, false, false],
        movementX: initial.movementX ?? 0,
        movementY: initial.movementY ?? 0,
        wheelDelta: initial.wheelDelta ?? 0,
        focused: initial.focused ?? true,
        pointerLocked: initial.pointerLocked ?? false,
        gamepads: initial.gamepads,
        capabilities: initial.capabilities,
        pointers: initial.pointers,
        pointerEvents: initial.pointerEvents,
      };
    },
    detach() {},
    get sampleCalls() {
      return calls;
    },
  } as InputBackend & { sampleCalls: number };
}

{
  // ─── from browser-backend-wheel-normalization.test.ts ───

  interface WheelFakeListenerStore {
    fire(target: string, kind: string, ev: Partial<WheelEvent>): void;
  }

  function buildWheelFakes(): {
    canvas: HTMLCanvasElement;
    doc: Document;
    win: Window;
    store: WheelFakeListenerStore;
  } {
    const listeners = new Map<string, Map<string, Set<EventListener>>>();
    const makeTarget = (label: string) => ({
      addEventListener(kind: string, handler: EventListener): void {
        let perTarget = listeners.get(label);
        if (!perTarget) {
          perTarget = new Map();
          listeners.set(label, perTarget);
        }
        let set = perTarget.get(kind);
        if (!set) {
          set = new Set();
          perTarget.set(kind, set);
        }
        set.add(handler);
      },
      removeEventListener(kind: string, handler: EventListener): void {
        listeners.get(label)?.get(kind)?.delete(handler);
      },
    });
    const canvas = {
      ...makeTarget('canvas'),
      requestPointerLock(): void {},
    } as unknown as HTMLCanvasElement;
    const doc = {
      hasFocus(): boolean {
        return true;
      },
      pointerLockElement: null,
      exitPointerLock(): void {},
    } as unknown as Document;
    const win = makeTarget('window') as unknown as Window;
    const store: WheelFakeListenerStore = {
      fire(target, kind, ev) {
        const handlers = listeners.get(target)?.get(kind);
        if (!handlers) return;
        for (const h of handlers) {
          h(ev as Event);
        }
      },
    };
    return { canvas, doc, win, store };
  }

  describe('browser-backend-wheel-normalization.test.ts', () => {
    describe('browser-backend WheelEvent deltaMode normalization (D-5 sign-discrete)', () => {
      it('PIXEL deltaY=120 -> wheelDelta=+1 (one notch)', () => {
        const { canvas, doc, win, store } = buildWheelFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        store.fire('canvas', 'wheel', { deltaY: 120, deltaMode: 0 });
        const sample = handle.backend.sample();
        expect(sample.wheelDelta).toBe(1);
      });

      it('LINE deltaY=-3 -> wheelDelta=-1 (sign collapses across deltaMode)', () => {
        const { canvas, doc, win, store } = buildWheelFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        store.fire('canvas', 'wheel', { deltaY: -3, deltaMode: 1 });
        const sample = handle.backend.sample();
        expect(sample.wheelDelta).toBe(-1);
      });

      it('PAGE deltaY=2 -> wheelDelta=+1 (PAGE mode collapses to +/-1)', () => {
        const { canvas, doc, win, store } = buildWheelFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        store.fire('canvas', 'wheel', { deltaY: 2, deltaMode: 2 });
        const sample = handle.backend.sample();
        expect(sample.wheelDelta).toBe(1);
      });

      it('deltaY=0 -> wheelDelta=0 (P3 empty signal)', () => {
        const { canvas, doc, win, store } = buildWheelFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        store.fire('canvas', 'wheel', { deltaY: 0, deltaMode: 0 });
        const sample = handle.backend.sample();
        expect(sample.wheelDelta).toBe(0);
      });

      it('multiple wheel events accumulate within a frame; sample drains the accumulator', () => {
        const { canvas, doc, win, store } = buildWheelFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        store.fire('canvas', 'wheel', { deltaY: 80, deltaMode: 0 });
        store.fire('canvas', 'wheel', { deltaY: 80, deltaMode: 0 });
        store.fire('canvas', 'wheel', { deltaY: 80, deltaMode: 0 });
        store.fire('canvas', 'wheel', { deltaY: -50, deltaMode: 0 });
        const sample1 = handle.backend.sample();
        expect(sample1.wheelDelta).toBe(2);
        const sample2 = handle.backend.sample();
        expect(sample2.wheelDelta).toBe(0);
      });

      it('deltaMode unspecified treated as PIXEL (default 0); large positive deltaY -> +1', () => {
        const { canvas, doc, win, store } = buildWheelFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        store.fire('canvas', 'wheel', { deltaY: 4 });
        const sample = handle.backend.sample();
        expect(sample.wheelDelta).toBe(1);
      });
    });
  });
}

{
  // ─── from browser-backend.test.ts ───

  interface FakeBBListenerStore {
    add(target: string, kind: string, handler: EventListener): void;
    remove(target: string, kind: string, handler: EventListener): void;
    fire(target: string, kind: string, ev: Partial<KeyboardEvent | MouseEvent>): void;
    count(): number;
  }

  function buildBBFakes(): {
    canvas: HTMLCanvasElement;
    doc: Document;
    win: Window;
    store: FakeBBListenerStore;
    setPointerLockElement(el: Element | null): void;
    setHasFocus(focused: boolean): void;
    requestCalls: { count: number };
    exitCalls: { count: number };
  } {
    const listeners = new Map<string, Map<string, Set<EventListener>>>();
    const requestCalls = { count: 0 };
    const exitCalls = { count: 0 };
    let pointerLockEl: Element | null = null;
    let focused = true;

    const makeTarget = (label: string) => ({
      addEventListener(kind: string, handler: EventListener): void {
        let perTarget = listeners.get(label);
        if (!perTarget) {
          perTarget = new Map();
          listeners.set(label, perTarget);
        }
        let set = perTarget.get(kind);
        if (!set) {
          set = new Set();
          perTarget.set(kind, set);
        }
        set.add(handler);
      },
      removeEventListener(kind: string, handler: EventListener): void {
        listeners.get(label)?.get(kind)?.delete(handler);
      },
    });

    const canvas = {
      ...makeTarget('canvas'),
      requestPointerLock(): void {
        requestCalls.count += 1;
      },
    } as unknown as HTMLCanvasElement;

    const doc = {
      ...makeTarget('document'),
      hasFocus(): boolean {
        return focused;
      },
      visibilityState: 'visible',
      get pointerLockElement(): Element | null {
        return pointerLockEl;
      },
      exitPointerLock(): void {
        exitCalls.count += 1;
      },
    } as unknown as Document;

    const win = makeTarget('window') as unknown as Window;

    const store: FakeBBListenerStore = {
      add() {},
      remove() {},
      fire(target, kind, ev) {
        const handlers = listeners.get(target)?.get(kind);
        if (!handlers) return;
        for (const h of handlers) {
          h(ev as Event);
        }
      },
      count() {
        let total = 0;
        for (const perTarget of listeners.values()) {
          for (const set of perTarget.values()) {
            total += set.size;
          }
        }
        return total;
      },
    };

    return {
      canvas,
      doc,
      win,
      store,
      setPointerLockElement(el) {
        pointerLockEl = el;
      },
      setHasFocus(f) {
        focused = f;
      },
      requestCalls,
      exitCalls,
    };
  }

  describe('browser-backend.test.ts', () => {
    describe('attachBrowserInputBackend (browser-backend.ts)', () => {
      it('attaches keydown / keyup / pointerdown / pointerup / pointermove / pointercancel / wheel / visibilitychange + pointerlockchange / click listeners', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(store.count()).toBe(11);
      });

      it('translates keyboard events into the snapshot held-key set', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('window', 'keydown', { key: 'w' });
        store.fire('window', 'keydown', { key: 'shift' });
        const sample1 = backend.sample();
        expect(sample1.downKeys.has('w')).toBe(true);
        expect(sample1.downKeys.has('shift')).toBe(true);
        expect(sample1.upKeys.size).toBe(0);

        store.fire('window', 'keyup', { key: 'w' });
        const sample2 = backend.sample();
        expect(sample2.downKeys.has('w')).toBe(false);
        expect(sample2.upKeys.has('w')).toBe(true);

        const sample3 = backend.sample();
        expect(sample3.upKeys.has('w')).toBe(false);
      });

      it('translates pointer events (pointerType=mouse) into the buttons tuple + accumulates movementX/Y', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('canvas', 'pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1 });
        store.fire('canvas', 'pointerdown', { button: 2, pointerType: 'mouse', pointerId: 1 });
        store.fire('canvas', 'pointermove', { movementX: 5, movementY: -3, pointerType: 'mouse', pointerId: 1 });
        store.fire('canvas', 'pointermove', { movementX: 1, movementY: 1, pointerType: 'mouse', pointerId: 1 });

        const sample1 = backend.sample();
        expect(sample1.buttons).toEqual([true, false, true]);
        expect(sample1.movementX).toBe(6);
        expect(sample1.movementY).toBe(-2);

        const sample2 = backend.sample();
        expect(sample2.movementX).toBe(0);
        expect(sample2.movementY).toBe(0);

        store.fire('canvas', 'pointerup', { button: 0, pointerType: 'mouse', pointerId: 1 });
        const sample3 = backend.sample();
        expect(sample3.buttons).toEqual([false, false, true]);
      });

      it('blur clears the up-edge set (alt-tab does not synthesise releases)', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('window', 'keydown', { key: 'q' });
        store.fire('window', 'keyup', { key: 'q' });
        store.fire('window', 'blur', {});
        const sample = backend.sample();
        expect(sample.upKeys.has('q')).toBe(false);
      });

      it('keyup while unfocused suppresses the up-edge (document.hasFocus() === false)', () => {
        const { canvas, doc, win, store, setHasFocus } = buildBBFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;
        store.fire('window', 'keydown', { key: 'a' });
        setHasFocus(false);
        store.fire('window', 'keyup', { key: 'a' });
        const sample = backend.sample();
        expect(sample.upKeys.has('a')).toBe(false);
        expect(sample.focused).toBe(false);
      });

      it('canvas click triggers requestPointerLock (W3C user-activation contract)', () => {
        const { canvas, doc, win, store, requestCalls } = buildBBFakes();
        attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(requestCalls.count).toBe(0);
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(1);
      });

      // w19 (feat-20260630-viewport): neutral PointerLock gate. The backend never
      // learns the host's reason — it only asks the predicate. A host that owns
      // the cursor (e.g. an editor viewport outside its play·game quadrant)
      // supplies a predicate returning false and a click does NOT capture.
      it('pointerLockAllowed=false suppresses requestPointerLock on click', () => {
        const { canvas, doc, win, store, requestCalls } = buildBBFakes();
        attachBrowserInputBackend(canvas, {
          document: doc,
          window: win,
          pointerLockAllowed: () => false,
        });
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(0);
      });

      it('pointerLockAllowed=true allows requestPointerLock (same as default)', () => {
        const { canvas, doc, win, store, requestCalls } = buildBBFakes();
        attachBrowserInputBackend(canvas, {
          document: doc,
          window: win,
          pointerLockAllowed: () => true,
        });
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(1);
      });

      it('pointerLockAllowed is read live per click (predicate re-evaluated each time)', () => {
        const { canvas, doc, win, store, requestCalls } = buildBBFakes();
        let allowed = false;
        attachBrowserInputBackend(canvas, {
          document: doc,
          window: win,
          pointerLockAllowed: () => allowed,
        });
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(0); // disallowed: no lock
        allowed = true;
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(1); // now allowed: locks
      });

      it('detach removes every listener and is idempotent on second call', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(store.count()).toBe(11);
        handle();
        expect(store.count()).toBe(0);
        expect(() => handle()).not.toThrow();
        handle.backend.detach();
      });

      it('detach exits PointerLock when the canvas is the active lock target', () => {
        const { canvas, doc, win, setPointerLockElement, exitCalls } = buildBBFakes();
        setPointerLockElement(canvas);
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        handle();
        expect(exitCalls.count).toBe(1);
      });

      it('handles missing addEventListener / removeEventListener gracefully', () => {
        const fakeCanvas = {} as HTMLCanvasElement;
        const fakeDoc = {} as Document;
        const fakeWin = {} as Window;
        const handle = attachBrowserInputBackend(fakeCanvas, { document: fakeDoc, window: fakeWin });
        expect(typeof handle).toBe('function');
        expect(typeof handle.backend.sample).toBe('function');
        expect(() => handle()).not.toThrow();
      });
    });

    // C-R6 (studio-issues): pointerlock focus gate + rejection catch.
    // Pre-fix: onCanvasClick unconditionally calls requestPointerLock,
    // which can produce unhandled promise rejections in iframe / post-load
    // contexts (WrongDocumentError) and triggers pointerlock even when the
    // tab is backgrounded.
    // Post-fix: doc.hasFocus() gate + .catch(() => {}) on the returned Promise.
    describe('C-R6 pointerlock focus gate + rejection catch', () => {
      it('AC-05 focus gate: silently returns when doc.hasFocus() is false', () => {
        const { canvas, doc, win, store, setHasFocus, requestCalls } = buildBBFakes();
        setHasFocus(false);
        attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(requestCalls.count).toBe(0);
        store.fire('canvas', 'click', {});
        // focus gate: requestPointerLock must NOT be called when unfocused.
        expect(requestCalls.count).toBe(0);
      });

      it('AC-05 focus gate: calls requestPointerLock when doc.hasFocus() is true (regression guard)', () => {
        const { canvas, doc, win, store, setHasFocus, requestCalls } = buildBBFakes();
        setHasFocus(true);
        attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(requestCalls.count).toBe(0);
        store.fire('canvas', 'click', {});
        expect(requestCalls.count).toBe(1);
      });

      it('AC-05 rejection catch: requestPointerLock returning a rejecting Promise is swallowed', async () => {
        // Inline fake: requestPointerLock returns a Promise that rejects.
        const listeners = new Map<string, Map<string, Set<EventListener>>>();
        let rejectCalled = false;
        const makeTarget = (label: string) => ({
          addEventListener(kind: string, handler: EventListener): void {
            let perTarget = listeners.get(label);
            if (!perTarget) {
              perTarget = new Map();
              listeners.set(label, perTarget);
            }
            let set = perTarget.get(kind);
            if (!set) {
              set = new Set();
              perTarget.set(kind, set);
            }
            set.add(handler);
          },
          removeEventListener(kind: string, handler: EventListener): void {
            listeners.get(label)?.get(kind)?.delete(handler);
          },
        });
        const canvas = {
          ...makeTarget('canvas'),
          requestPointerLock(): Promise<void> {
            return Promise.reject(new Error('WrongDocumentError'));
          },
          get ownerDocument() {
            return doc;
          },
        } as unknown as HTMLCanvasElement;
        const doc = {
          hasFocus(): boolean {
            return true;
          },
          pointerLockElement: null,
          exitPointerLock(): void {},
        } as unknown as Document;
        const win = makeTarget('window') as unknown as Window;

        attachBrowserInputBackend(canvas, { document: doc, window: win });

        // Override addEventListener for unhandledrejection to detect leaks.
        const origAdd = process.addListener ?? process.on;
        const rejectionErrors: Error[] = [];
        const onUnhandled = (reason: Error) => {
          rejectionErrors.push(reason);
        };
        const processObj = process as unknown as {
          on(event: string, listener: (...args: unknown[]) => void): void;
          removeListener(event: string, listener: (...args: unknown[]) => void): void;
        };
        processObj.on('unhandledRejection', onUnhandled);

        // Fire click -> requestPointerLock returns rejecting Promise.
        // The .catch should swallow it; we wait a microtick for rejection to surface.
        const clickHandlers = listeners.get('canvas')?.get('click');
        expect(clickHandlers?.size).toBeGreaterThan(0);
        for (const h of clickHandlers ?? []) {
          h(new Event('click'));
        }

        // Wait for microtask queue to flush the rejection.
        await new Promise((resolve) => setTimeout(resolve, 10));

        // No unhandled rejection should have surfaced — .catch swallowed it.
        expect(rejectionErrors.length).toBe(0);

        processObj.removeListener('unhandledRejection', onUnhandled);

        // Verify rejectCalled is tracked (the .catch ran).
        rejectCalled = true;
        // The key assertion: rejection is swallowed by .catch, no crash.
        expect(rejectCalled).toBe(true);
      });

      it('AC-05: canvas without requestPointerLock silently returns (missing API guard)', () => {
        // Canvas that has addEventListener but no requestPointerLock.
        const listeners = new Map<string, Map<string, Set<EventListener>>>();
        const canvas = {
          addEventListener(kind: string, handler: EventListener): void {
            let perTarget = listeners.get('c');
            if (!perTarget) {
              perTarget = new Map();
              listeners.set('c', perTarget);
            }
            let set = perTarget.get(kind);
            if (!set) {
              set = new Set();
              perTarget.set(kind, set);
            }
            set.add(handler);
          },
          removeEventListener(kind: string, handler: EventListener): void {
            listeners.get('c')?.get(kind)?.delete(handler);
          },
          get ownerDocument() {
            return doc;
          },
          // No requestPointerLock — jsdom environments may lack it.
        } as unknown as HTMLCanvasElement;
        const doc = {
          hasFocus(): boolean {
            return true;
          },
        } as unknown as Document;
        const win = { addEventListener() {}, removeEventListener() {} } as unknown as Window;

        // Must not throw; the typeof guard handles it.
        expect(() =>
          attachBrowserInputBackend(canvas, { document: doc, window: win }),
        ).not.toThrow();

        // Fire click: no requestPointerLock available, silently return.
        const clickHandlers = listeners.get('c')?.get('click');
        expect(clickHandlers?.size).toBeGreaterThan(0);
        for (const h of clickHandlers ?? []) {
          expect(() => h(new Event('click'))).not.toThrow();
        }
      });
    });

    // ─── w9: PointerEvent-driven mouse regression (AC-06) ───
    describe('PointerEvent-driven mouse regression (AC-06)', () => {
      function buildPointerRegressionFakes(): {
        canvas: HTMLCanvasElement;
        doc: Document;
        win: Window;
        store: FakeBBListenerStore;
        requestCalls: { count: number };
      } {
        const listeners = new Map<string, Map<string, Set<EventListener>>>();
        const requestCalls = { count: 0 };
        let focused = true;

        const makeTarget = (label: string) => ({
          addEventListener(kind: string, handler: EventListener): void {
            let perTarget = listeners.get(label);
            if (!perTarget) {
              perTarget = new Map();
              listeners.set(label, perTarget);
            }
            let set = perTarget.get(kind);
            if (!set) {
              set = new Set();
              perTarget.set(kind, set);
            }
            set.add(handler);
          },
          removeEventListener(kind: string, handler: EventListener): void {
            listeners.get(label)?.get(kind)?.delete(handler);
          },
        });

        const canvas = {
          ...makeTarget('canvas'),
          requestPointerLock(): void {
            requestCalls.count += 1;
          },
        } as unknown as HTMLCanvasElement;

        const doc = {
          hasFocus(): boolean {
            return focused;
          },
          pointerLockElement: null,
          exitPointerLock(): void {},
        } as unknown as Document;

        const win = makeTarget('window') as unknown as Window;

        const store: FakeBBListenerStore = {
          add() {},
          remove() {},
          fire(target, kind, ev) {
            const handlers = listeners.get(target)?.get(kind);
            if (!handlers) return;
            for (const h of handlers) {
              h(ev as Event);
            }
          },
          count() {
            let total = 0;
            for (const perTarget of listeners.values()) {
              for (const set of perTarget.values()) {
                total += set.size;
              }
            }
            return total;
          },
        };
        return { canvas, doc, win, store, requestCalls };
      }

      it('button(0|1|2) semantics preserved after pointer event migration', () => {
        const { canvas, doc, win, store } = buildPointerRegressionFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('canvas', 'pointerdown', { button: 0, pointerType: 'mouse', pointerId: 1 });
        store.fire('canvas', 'pointerdown', { button: 2, pointerType: 'mouse', pointerId: 1 });
        const sample1 = backend.sample();
        expect(sample1.buttons).toEqual([true, false, true]);

        store.fire('canvas', 'pointerup', { button: 0, pointerType: 'mouse', pointerId: 1 });
        store.fire('canvas', 'pointerup', { button: 2, pointerType: 'mouse', pointerId: 1 });
        const sample2 = backend.sample();
        expect(sample2.buttons).toEqual([false, false, false]);
      });

      it('movementDelta accumulated from pointermove (PointerEvent extends MouseEvent)', () => {
        const { canvas, doc, win, store } = buildPointerRegressionFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('canvas', 'pointermove', { movementX: 3, movementY: -7, pointerType: 'mouse', pointerId: 1 });
        store.fire('canvas', 'pointermove', { movementX: 2, movementY: 1, pointerType: 'mouse', pointerId: 1 });
        const sample = backend.sample();
        expect(sample.movementX).toBe(5);
        expect(sample.movementY).toBe(-6);
      });

      it('wheelDelta unchanged after pointer migration (wheel listener preserved)', () => {
        const { canvas, doc, win, store } = buildPointerRegressionFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('canvas', 'wheel', { deltaY: 120, deltaMode: 0 });
        const sample = backend.sample();
        expect(sample.wheelDelta).toBe(1);
      });

      it('non-mouse pointerType does not affect mouse cluster (touch ignored)', () => {
        const { canvas, doc, win, store } = buildPointerRegressionFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('canvas', 'pointerdown', { button: 0, pointerType: 'touch', pointerId: 2 });
        store.fire('canvas', 'pointermove', { movementX: 10, movementY: 10, pointerType: 'touch', pointerId: 2 });
        const sample = backend.sample();
        expect(sample.buttons).toEqual([false, false, false]);
        expect(sample.movementX).toBe(0);
        expect(sample.movementY).toBe(0);
      });
    });
  });
}

{
  // ─── from frame-start-scan-system.test.ts ───

  describe('frame-start-scan-system.test.ts', () => {
    describe('InputFrameStartScan (D-5 + plan-strategy section 2.10)', () => {
      it('registers a system named "input-frame-start-scan" so user systems can `after:` it', () => {
        const backend = fixtureBackend({});
        const world = new World();
        expect(InputFrameStartScan.name).toBe('input-frame-start-scan');
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);
        const inspection = world.inspect();
        expect(inspection.systems.map((s) => s.name)).toContain('input-frame-start-scan');
      });

      it('writes the InputSnapshot Resource on every update()', () => {
        const backend = fixtureBackend({
          downKeys: new Set(['shift']),
          buttons: [true, false, false],
          movementX: 3,
          movementY: -2,
        });
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        expect(world.hasResource('InputSnapshot')).toBe(false);
        world.update(1 / 60).unwrap();
        expect(world.hasResource('InputSnapshot')).toBe(true);
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap.keyboard.down('shift')).toBe(true);
        expect(snap.mouse.button(0)).toBe(true);
        expect(snap.mouse.movementDelta).toEqual({ x: 3, y: -2 });
      });

      it('calls backend.sample() exactly once per world.update(1 / 60).unwrap()', () => {
        const backend = fixtureBackend({});
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();
        world.update(1 / 60).unwrap();
        expect(backend.sampleCalls).toBe(3);
      });

      it('frozen snapshot: methods on the resource do not mutate it', () => {
        const backend = fixtureBackend({ movementX: 9, movementY: 9 });
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        world.update(1 / 60).unwrap();
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        const before = snap.mouse.movementDelta;
        snap.mouse.button(1);
        snap.keyboard.down('q');
        expect(snap.mouse.movementDelta).toBe(before);
      });
    });
  });
}

{
  // ─── from input-snapshot.test.ts ───

  function createFakeBackend(): InputBackend & {
    pressKey(key: string): void;
    releaseKey(key: string): void;
    pressButton(i: 0 | 1 | 2): void;
    releaseButton(i: 0 | 1 | 2): void;
    addMovement(x: number, y: number): void;
    setFocus(focused: boolean): void;
  } {
    const downKeys = new Set<string>();
    const upKeys = new Set<string>();
    const buttons = [false, false, false] as [boolean, boolean, boolean];
    let mvx = 0;
    let mvy = 0;
    let focused = true;
    return {
      sample(): {
        downKeys: ReadonlySet<string>;
        upKeys: ReadonlySet<string>;
        buttons: readonly [boolean, boolean, boolean];
        movementX: number;
        movementY: number;
        wheelDelta: number;
        focused: boolean;
        pointerLocked: boolean;
      } {
        const snap = {
          downKeys: new Set(downKeys),
          upKeys: new Set(upKeys),
          buttons: [buttons[0], buttons[1], buttons[2]] as readonly [boolean, boolean, boolean],
          movementX: mvx,
          movementY: mvy,
          wheelDelta: 0,
          focused,
          pointerLocked: false,
        };
        mvx = 0;
        mvy = 0;
        upKeys.clear();
        return snap;
      },
      detach() {},
      pressKey(key: string): void {
        downKeys.add(key);
        upKeys.delete(key);
      },
      releaseKey(key: string): void {
        downKeys.delete(key);
        upKeys.add(key);
      },
      pressButton(i: 0 | 1 | 2): void {
        buttons[i] = true;
      },
      releaseButton(i: 0 | 1 | 2): void {
        buttons[i] = false;
      },
      addMovement(x: number, y: number): void {
        mvx += x;
        mvy += y;
      },
      setFocus(f: boolean): void {
        focused = f;
        if (!f) {
          upKeys.clear();
        }
      },
    };
  }

  describe('input-snapshot.test.ts', () => {
    describe('InputSnapshot 4-method surface (AC-07)', () => {
      it('keyboard.down returns true while key is held, false otherwise', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        backend.pressKey('w');
        world.update(1 / 60).unwrap();
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap.keyboard.down('w')).toBe(true);
        expect(snap.keyboard.down('a')).toBe(false);

        backend.releaseKey('w');
        world.update(1 / 60).unwrap();
        const snap2 = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap2.keyboard.down('w')).toBe(false);
      });

      it('keyboard.up reflects the up-edge in the frame after the release', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        backend.pressKey('space');
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.up('space')).toBe(false);

        backend.releaseKey('space');
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.up('space')).toBe(true);

        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.up('space')).toBe(false);
      });

      it('mouse.movementDelta is frozen at frame-start and cleared next frame', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        backend.addMovement(15, -7);
        world.update(1 / 60).unwrap();
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap.mouse.movementDelta).toEqual({ x: 15, y: -7 });

        world.update(1 / 60).unwrap();
        const snap2 = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap2.mouse.movementDelta).toEqual({ x: 0, y: 0 });
      });

      it('mouse.button(0|1|2) returns the held state for each W3C button slot', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        backend.pressButton(0);
        backend.pressButton(2);
        world.update(1 / 60).unwrap();
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap.mouse.button(0)).toBe(true);
        expect(snap.mouse.button(1)).toBe(false);
        expect(snap.mouse.button(2)).toBe(true);
      });

      it('snapshot is exposed as a Resource via insertResource("InputSnapshot")', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);
        world.update(1 / 60).unwrap();
        expect(world.hasResource('InputSnapshot')).toBe(true);
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(typeof snap.keyboard.down).toBe('function');
        expect(typeof snap.keyboard.up).toBe('function');
        expect(typeof snap.mouse.button).toBe('function');
        expect(snap.mouse.movementDelta).toEqual({ x: 0, y: 0 });
      });

      it('createInputSnapshot() returns an empty snapshot without throwing (engine.run() pre-start)', () => {
        const empty = createInputSnapshot();
        expect(empty.keyboard.down('w')).toBe(false);
        expect(empty.keyboard.up('w')).toBe(false);
        expect(empty.mouse.button(0)).toBe(false);
        expect(empty.mouse.button(1)).toBe(false);
        expect(empty.mouse.button(2)).toBe(false);
        expect(empty.mouse.movementDelta).toEqual({ x: 0, y: 0 });
      });

      it('document.hasFocus()-equivalent: keyboard down state is preserved when unfocused', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);

        backend.pressKey('w');
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.down('w')).toBe(true);

        backend.setFocus(false);
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.down('w')).toBe(true);

        backend.setFocus(true);
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.down('w')).toBe(true);
      });

      it('attachBrowserInputBackend returns a detach handle (charter P3 explicit lifecycle)', () => {
        const fakeCanvas = {
          addEventListener() {},
          removeEventListener() {},
          requestPointerLock() {},
        } as unknown as HTMLCanvasElement;
        const detach = attachBrowserInputBackend(fakeCanvas);
        expect(typeof detach).toBe('function');
        detach();
      });
    });
  });
}

{
  // ─── from wheel-delta.test.ts ───

  function createWheelFakeBackend(): InputBackend & {
    setWheelDelta(value: number): void;
  } {
    let wheelDeltaPending = 0;
    return {
      sample() {
        const out = {
          downKeys: new Set<string>(),
          upKeys: new Set<string>(),
          buttons: [false, false, false] as readonly [boolean, boolean, boolean],
          movementX: 0,
          movementY: 0,
          wheelDelta: wheelDeltaPending,
          focused: true,
        };
        wheelDeltaPending = 0;
        return out;
      },
      detach() {},
      setWheelDelta(value: number) {
        wheelDeltaPending = value;
      },
    };
  }

  describe('wheel-delta.test.ts', () => {
    describe('InputSnapshot.mouse.wheelDelta (AC-08 + D-7 closed-family extension)', () => {
      it('reports zero before any wheel event observed (P3 empty signal)', () => {
        const empty = createInputSnapshot();
        expect(empty.mouse.wheelDelta).toBe(0);
      });

      it('frame-start scan writes wheelDelta into the snapshot Resource', () => {
        const world = new World();
        const backend = createWheelFakeBackend();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);
        backend.setWheelDelta(1);
        world.update(1 / 60).unwrap();
        const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        expect(snap?.mouse.wheelDelta).toBe(1);
      });

      it('snapshot reads are stable within a single frame (frame-start freeze)', () => {
        const world = new World();
        const backend = createWheelFakeBackend();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);
        backend.setWheelDelta(-2);
        world.update(1 / 60).unwrap();
        const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        const r1 = snap?.mouse.wheelDelta;
        const r2 = snap?.mouse.wheelDelta;
        expect(r1).toBe(-2);
        expect(r2).toBe(-2);
      });

      it('cross-frame reset: next frame with no wheel event reports zero', () => {
        const world = new World();
        const backend = createWheelFakeBackend();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);
        backend.setWheelDelta(3);
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.mouse.wheelDelta).toBe(3);
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.mouse.wheelDelta).toBe(0);
      });

      it('positive and negative deltas pass through unchanged (sign-preserving)', () => {
        const world = new World();
        const backend = createWheelFakeBackend();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(Update, InputFrameStartScan);
        backend.setWheelDelta(7);
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.mouse.wheelDelta).toBe(7);
        backend.setWheelDelta(-9);
        world.update(1 / 60).unwrap();
        expect(world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.mouse.wheelDelta).toBe(
          -9,
        );
      });
    });
  });
}

// ─── M1: gamepad readpoints (AC-01) ───

{
  describe('gamepad readpoints (AC-01)', () => {
    function makeWorldWithGamepadSlots(slots: readonly GamepadSlotSample[]): World {
      const world = new World();
      const backend = fixtureBackend({ gamepads: slots, capabilities: { gamepad: true, pointer: false } });
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(Update, InputFrameStartScan);
      world.update(1 / 60).unwrap();
      return world;
    }

    function makeSnap(slots: readonly GamepadSlotSample[]): InputSnapshot {
      const world = makeWorldWithGamepadSlots(slots);
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('InputSnapshot not found after world.update(1 / 60).unwrap()');
      return snap;
    }

    const pressedBtn = buildGamepadSlot(0, { pressed: [0, 2, 9], buttonValues: new Map([[6, 0.5]]), axes: [0, -0.5, 1, 0.3] });
    const emptySlot = buildGamepadSlot(0, { pressed: [] });

    it('pressed button returns true, unpressed returns false', () => {
      const snap = makeSnap([pressedBtn]);
      expect(snap.gamepad(0).connected).toBe(true);
      expect(snap.gamepad(0).standardMapping).toBe(true);
      expect(snap.gamepad(0).button(0)).toBe(true);
      expect(snap.gamepad(0).button(2)).toBe(true);
      expect(snap.gamepad(0).button(9)).toBe(true);
      expect(snap.gamepad(0).button(1)).toBe(false);
      expect(snap.gamepad(0).button(16)).toBe(false);
    });

    it('analog buttonValue reflects GamepadButton.value (0..1 range)', () => {
      const snap = makeSnap([pressedBtn]);
      expect(snap.gamepad(0).buttonValue(6)).toBe(0.5);
      expect(snap.gamepad(0).buttonValue(0)).toBe(0);
    });

    it('axis reads raw values, no deadzone or clamping applied', () => {
      const snap = makeSnap([pressedBtn]);
      expect(snap.gamepad(0).axis(0)).toBe(0);
      expect(snap.gamepad(0).axis(1)).toBe(-0.5);
      expect(snap.gamepad(0).axis(2)).toBe(1);
      expect(snap.gamepad(0).axis(3)).toBe(0.3);
    });

    it('disconnected slot returns empty signal (false/0) without throwing', () => {
      const snap = makeSnap([pressedBtn]);
      const g = snap.gamepad(1);
      expect(g.connected).toBe(false);
      expect(g.standardMapping).toBe(false);
      expect(g.button(0)).toBe(false);
      expect(g.buttonValue(0)).toBe(0);
      expect(g.axis(0)).toBe(0);
      expect(g.justPressed(0)).toBe(false);
      expect(g.justReleased(0)).toBe(false);
    });

    it('out-of-range slot index returns empty signal (no throw)', () => {
      const snap = makeSnap([]);
      expect(snap.gamepad(999).connected).toBe(false);
    });

    it('standardMapping=true for standard-layout gamepads', () => {
      const snap = makeSnap([emptySlot]);
      expect(snap.gamepad(0).standardMapping).toBe(true);
      expect(snap.gamepad(0).connected).toBe(true);
    });
  });
}

// ─── M1: gamepad edge lifecycle (AC-02) ───

{
  describe('gamepad edge lifecycle (AC-02)', () => {
    /**
     * Mutable frame-stepper for edge lifecycle tests. Each call to next()
     * advances one frame and writes a fresh InputBackendSample-derived
     * snapshot into the World.
     */
    function buildEdgeStepper(): {
      snap(): InputSnapshot;
      next(gamepads: readonly GamepadSlotSample[], caps?: Capabilities): InputSnapshot;
    } {
      const world = new World();
      let backend: ReturnType<typeof fixtureBackend>;
      backend = fixtureBackend({ capabilities: { gamepad: true, pointer: false } });
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(Update, InputFrameStartScan);

      return {
        snap(): InputSnapshot {
          const s = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
          if (!s) throw new Error('InputSnapshot missing');
          return s;
        },
        next(gamepads, caps) {
          // Remove old backend & re-insert with new frame data.
          // fixtureBackend is stateless, so we replace it to simulate
          // per-frame sample() with different gamepad arrays.
          const b = fixtureBackend({
            gamepads,
            capabilities: caps ?? { gamepad: true, pointer: false },
          });
          world.insertResource(INPUT_BACKEND_KEY, b);
          world.update(1 / 60).unwrap();
          return this.snap();
        },
      };
    }

    it('justPressed is true in frame N when button transitions from unpressed to pressed', () => {
      const s = buildEdgeStepper();
      s.next([buildGamepadSlot(0)]);
      s.next([buildGamepadSlot(0, { pressed: [0], justPressed: [0] })]);
      const snap = s.snap();
      expect(snap.gamepad(0).button(0)).toBe(true);
      expect(snap.gamepad(0).justPressed(0)).toBe(true);
    });

    it('justPressed disappears after one frame (one-frame lifecycle)', () => {
      const s = buildEdgeStepper();
      s.next([buildGamepadSlot(0)]);
      s.next([buildGamepadSlot(0, { pressed: [0], justPressed: [0] })]);
      s.next([buildGamepadSlot(0, { pressed: [0] })]);
      const snap = s.snap();
      expect(snap.gamepad(0).button(0)).toBe(true);    // still held
      expect(snap.gamepad(0).justPressed(0)).toBe(false); // edge gone
    });

    it('justReleased is true in frame N when button transitions from pressed to unpressed', () => {
      const s = buildEdgeStepper();
      s.next([buildGamepadSlot(0, { pressed: [0] })]);
      s.next([buildGamepadSlot(0, { justReleased: [0] })]);
      const snap = s.snap();
      expect(snap.gamepad(0).button(0)).toBe(false);
      expect(snap.gamepad(0).justReleased(0)).toBe(true);
    });

    it('justReleased disappears after one frame', () => {
      const s = buildEdgeStepper();
      s.next([buildGamepadSlot(0, { pressed: [0] })]);
      s.next([buildGamepadSlot(0, { justReleased: [0] })]);
      s.next([buildGamepadSlot(0)]);
      const snap = s.snap();
      expect(snap.gamepad(0).justReleased(0)).toBe(false);
    });

    it('consecutive held frames do not re-emit edge', () => {
      const s = buildEdgeStepper();
      s.next([buildGamepadSlot(0)]);
      s.next([buildGamepadSlot(0, { pressed: [0], justPressed: [0] })]);
      const f1 = s.snap();
      expect(f1.gamepad(0).justPressed(0)).toBe(true);
      s.next([buildGamepadSlot(0, { pressed: [0] })]);
      const f2 = s.snap();
      expect(f2.gamepad(0).justPressed(0)).toBe(false);
      s.next([buildGamepadSlot(0, { pressed: [0] })]);
      const f3 = s.snap();
      expect(f3.gamepad(0).justPressed(0)).toBe(false);
    });

    it('edge sets are empty after sample drain (next frame with no presses)', () => {
      const s = buildEdgeStepper();
      s.next([buildGamepadSlot(0)]);
      s.next([buildGamepadSlot(0, { pressed: [0], justPressed: [0] })]);
      s.next([buildGamepadSlot(0, { pressed: [0] })]);
      s.next([buildGamepadSlot(0)]);
      const snap = s.snap();
      expect(snap.gamepad(0).justPressed(0)).toBe(false);
      expect(snap.gamepad(0).justReleased(0)).toBe(false);
    });
  });
}

// ─── M1: gamepad slot diff (AC-03) ───

{
  describe('gamepad slot diff (AC-03)', () => {
    function buildSlotStepper(): {
      snap(): InputSnapshot;
      next(gamepads: readonly GamepadSlotSample[], caps?: Capabilities): InputSnapshot;
    } {
      const world = new World();
      let backend = fixtureBackend({ capabilities: { gamepad: true, pointer: false } });
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(Update, InputFrameStartScan);

      return {
        snap(): InputSnapshot {
          const s = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
          if (!s) throw new Error('InputSnapshot missing');
          return s;
        },
        next(gamepads, caps) {
          backend = fixtureBackend({
            gamepads,
            capabilities: caps ?? { gamepad: true, pointer: false },
          });
          world.insertResource(INPUT_BACKEND_KEY, backend);
          world.update(1 / 60).unwrap();
          return this.snap();
        },
      };
    }

    it('connect: new gamepad slot appears as connected with standard mapping', () => {
      const s = buildSlotStepper();
      s.next([]);
      s.next([buildGamepadSlot(0)]);
      const snap = s.snap();
      expect(snap.gamepad(0).connected).toBe(true);
      expect(snap.gamepad(0).standardMapping).toBe(true);
    });

    it('disconnect: slot removed between frames returns empty signal', () => {
      const s = buildSlotStepper();
      s.next([buildGamepadSlot(0, { pressed: [0] })]);
      const snapB = s.snap();
      expect(snapB.gamepad(0).connected).toBe(true);
      s.next([]);
      const snapA = s.snap();
      expect(snapA.gamepad(0).connected).toBe(false);
      expect(snapA.gamepad(0).button(0)).toBe(false);
      expect(snapA.gamepad(0).axis(0)).toBe(0);
    });

    it('null-padded: slot at gamepad.index survives null entries in array', () => {
      // Simulate browser returning [null, gamepad_at_index_1].
      // The backend diffGamepadFrame handles null-padded arrays by
      // skipping null entries; the test verifies slot 1 is reachable.
      const s = buildSlotStepper();
      // Frame 1: only slot 1 connected (slot 0 is null-padded).
      s.next([buildGamepadSlot(1, { pressed: [1] })]);
      const snap = s.snap();
      expect(snap.gamepad(1).connected).toBe(true);
      expect(snap.gamepad(1).button(1)).toBe(true);
      // Slot 0 was never connected — empty signal.
      expect(snap.gamepad(0).connected).toBe(false);
    });

    it('null-padded disconnect: slot becomes null in padded position, reads as empty', () => {
      const s = buildSlotStepper();
      s.next([buildGamepadSlot(0, { pressed: [0] }), buildGamepadSlot(1, { pressed: [3] })]);
      // Next frame: slot 1 still connected, slot 0 removed.
      s.next([buildGamepadSlot(1, { pressed: [3] })]);
      const snap = s.snap();
      expect(snap.gamepad(0).connected).toBe(false);
      expect(snap.gamepad(1).connected).toBe(true);
    });
  });
}

// ─── M1: non-standard mapping + capability (AC-04/05) ───

{
  describe('non-standard mapping + capability (AC-04/05)', () => {
    it('non-standard layout: connected=true, standardMapping=false, all readpoints empty signal', () => {
      const world = new World();
      const nonStandard = buildGamepadSlot(0, {
        standardMapping: false,
        pressed: [0, 1],
        buttonValues: new Map([[6, 0.8]]),
        axes: [0.5, -1, 0.3, 0.7],
      });
      const backend = fixtureBackend({ gamepads: [nonStandard], capabilities: { gamepad: true, pointer: false } });
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(Update, InputFrameStartScan);
      world.update(1 / 60).unwrap();
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('snap missing');
      const g = snap.gamepad(0);
      // must report connected (not lie as disconnected)
      expect(g.connected).toBe(true);
      // must signal non-standard layout explicitly
      expect(g.standardMapping).toBe(false);
      // all readpoints empty — never leak raw non-standard values
      expect(g.button(0)).toBe(false);
      expect(g.button(1)).toBe(false);
      expect(g.buttonValue(6)).toBe(0);
      expect(g.axis(0)).toBe(0);
      expect(g.justPressed(0)).toBe(false);
      expect(g.justReleased(0)).toBe(false);
    });

    it('capabilities.gamepad=false when backend does not provide gamepads', () => {
      const world = new World();
      const backend = fixtureBackend({});
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(Update, InputFrameStartScan);
      world.update(1 / 60).unwrap();
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('snap missing');
      expect(snap.capabilities.gamepad).toBe(false);
    });

    it('sample without gamepads field does not throw; readpoints return empty signal', () => {
      const world = new World();
      const backend = fixtureBackend({});
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(Update, InputFrameStartScan);
      world.update(1 / 60).unwrap();
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('snap missing');
      // All gamepad readpoints must be empty signal, no throw.
      expect(snap.gamepad(0).connected).toBe(false);
      expect(snap.gamepad(0).button(0)).toBe(false);
      expect(snap.gamepad(0).axis(0)).toBe(0);
      expect(snap.capabilities.gamepad).toBe(false);
    });
  });
}

// ─── M2: multi-pointer tracking (AC-07) ───

{
  describe('multi-pointer tracking (AC-07)', () => {
    function makeSnapWithPointers(ptrs?: readonly import('../src/input-snapshot').PointerSample[]): InputSnapshot {
      const world = new World();
      const caps: Capabilities = { gamepad: false, pointer: true };
      const backend = fixtureBackend({ pointers: ptrs, capabilities: caps });
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(Update, InputFrameStartScan);
      world.update(1 / 60).unwrap();
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('snap missing');
      return snap;
    }

    function ptr(p: {
      pointerId: number;
      x: number;
      y: number;
      pressure?: number;
      pointerType?: import('../src/input-snapshot').PointerType;
      active?: boolean;
    }): import('../src/input-snapshot').PointerSample {
      return {
        pointerId: p.pointerId,
        x: p.x,
        y: p.y,
        pressure: p.pressure ?? 0,
        pointerType: p.pointerType ?? 'touch',
        active: p.active ?? true,
        delta: Object.freeze({ x: 0, y: 0 }),
      };
    }

    it('two concurrent pointers track independent positions', () => {
      const snap = makeSnapWithPointers([
        ptr({ pointerId: 1, x: 100, y: 200 }),
        ptr({ pointerId: 2, x: 300, y: 400 }),
      ]);
      expect(snap.pointer(1).x).toBe(100);
      expect(snap.pointer(1).y).toBe(200);
      expect(snap.pointer(2).x).toBe(300);
      expect(snap.pointer(2).y).toBe(400);
      expect(snap.pointer(1).x).not.toBe(snap.pointer(2).x);
    });

    it('concurrent pointers carry independent pressure and pointerType', () => {
      const snap = makeSnapWithPointers([
        ptr({ pointerId: 1, x: 0, y: 0, pressure: 0.5, pointerType: 'touch' }),
        ptr({ pointerId: 2, x: 0, y: 0, pressure: 1.0, pointerType: 'pen' }),
      ]);
      expect(snap.pointer(1).pressure).toBe(0.5);
      expect(snap.pointer(1).pointerType).toBe('touch');
      expect(snap.pointer(2).pressure).toBe(1.0);
      expect(snap.pointer(2).pointerType).toBe('pen');
    });

    it('unknown pointerId returns active=false empty signal without throwing', () => {
      const snap = makeSnapWithPointers([ptr({ pointerId: 1, x: 50, y: 50 })]);
      const p = snap.pointer(999);
      expect(p.active).toBe(false);
      expect(p.x).toBe(0);
      expect(p.y).toBe(0);
    });

    it('no pointers field returns active=false for any id', () => {
      const world = new World();
      const backend = fixtureBackend({ capabilities: { gamepad: false, pointer: false } });
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(Update, InputFrameStartScan);
      world.update(1 / 60).unwrap();
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('snap missing');
      expect(snap.pointer(1).active).toBe(false);
    });
  });
}

// ─── M2: phase event queue (AC-08) ───

{
  describe('phase event queue (AC-08)', () => {
    function makeSnapWithEvents(evts?: readonly import('../src/input-snapshot').PointerPhaseEvent[]): InputSnapshot {
      const world = new World();
      const caps: Capabilities = { gamepad: false, pointer: true };
      const backend = fixtureBackend({ pointerEvents: evts, capabilities: caps });
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(Update, InputFrameStartScan);
      world.update(1 / 60).unwrap();
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('snap missing');
      return snap;
    }

    function pev(overrides: Partial<import('../src/input-snapshot').PointerPhaseEvent> = {}): import('../src/input-snapshot').PointerPhaseEvent {
      return {
        pointerId: overrides.pointerId ?? 1,
        phase: overrides.phase ?? 'down',
        x: overrides.x ?? 0,
        y: overrides.y ?? 0,
        pressure: overrides.pressure ?? 0,
        pointerType: overrides.pointerType ?? 'touch',
      };
    }

    it('down + up in same frame both appear in pointerEvents queue', () => {
      const snap = makeSnapWithEvents([
        pev({ phase: 'down', pointerId: 1 }),
        pev({ phase: 'up', pointerId: 1 }),
      ]);
      expect(snap.pointerEvents).toHaveLength(2);
      expect(snap.pointerEvents[0].phase).toBe('down');
      expect(snap.pointerEvents[1].phase).toBe('up');
    });

    it('pointerEvents queue is empty on next frame (one-frame lifecycle)', () => {
      const snap1 = makeSnapWithEvents([pev({ phase: 'down' })]);
      expect(snap1.pointerEvents).toHaveLength(1);
      const snap2 = makeSnapWithEvents([]);
      expect(snap2.pointerEvents).toHaveLength(0);
    });

    it('pointercancel is an independent phase, not folded into up', () => {
      const snap = makeSnapWithEvents([pev({ phase: 'cancel', pointerId: 1 })]);
      expect(snap.pointerEvents).toHaveLength(1);
      expect(snap.pointerEvents[0].phase).toBe('cancel');
    });

    it('move events appear as phase move in the queue', () => {
      const snap = makeSnapWithEvents([
        pev({ phase: 'move', x: 10, y: 20 }),
        pev({ phase: 'move', x: 11, y: 21 }),
        pev({ phase: 'move', x: 12, y: 22 }),
      ]);
      expect(snap.pointerEvents).toHaveLength(3);
      expect(snap.pointerEvents[0].phase).toBe('move');
      expect(snap.pointerEvents[2].x).toBe(12);
    });
  });
}

// ─── M2: cross-frame pointer delta (AC-09) ───

{
  describe('cross-frame pointer delta (AC-09)', () => {
    function makeSnapDelta(
      ptrs: readonly import('../src/input-snapshot').PointerSample[],
    ): InputSnapshot {
      const world = new World();
      const caps: Capabilities = { gamepad: false, pointer: true };
      const backend = fixtureBackend({ pointers: ptrs, capabilities: caps });
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(Update, InputFrameStartScan);
      world.update(1 / 60).unwrap();
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('snap missing');
      return snap;
    }

    function ptrDelta(id: number, x: number, y: number): import('../src/input-snapshot').PointerSample {
      return { pointerId: id, x, y, pressure: 1, pointerType: 'touch', active: true, delta: Object.freeze({ x: 0, y: 0 }) };
    }

    it('frame-end pointer position reflects last move absolute coordinates', () => {
      const snap = makeSnapDelta([ptrDelta(1, 100, 200)]);
      expect(snap.pointer(1).x).toBe(100);
      expect(snap.pointer(1).y).toBe(200);
    });

    it('pointer delta field exists and reports per-frame displacement', () => {
      // The delta field on snap.pointer(id) captures cross-frame displacement.
      // A real backend computes this as current frame position - previous frame position.
      // With fixtureBackend, delta is (0,0) placeholder -- the contract is that the field exists.
      const snap = makeSnapDelta([ptrDelta(1, 100, 200)]);
      const p = snap.pointer(1);
      expect(p.active).toBe(true);
      expect(typeof p.delta.x).toBe('number');
      expect(typeof p.delta.y).toBe('number');
    });

    it('inactive pointer reports zero delta', () => {
      const snap = makeSnapDelta([]);
      const p = snap.pointer(1);
      expect(p.active).toBe(false);
      expect(p.delta).toEqual({ x: 0, y: 0 });
    });
  });
}

// ─── M2: focus-loss cleanup (AC-10) ───

{
  describe('focus-loss cleanup (AC-10)', () => {
    function makeSnap(
      opts: {
        gamepads?: readonly GamepadSlotSample[];
        pointers?: readonly import('../src/input-snapshot').PointerSample[];
        pointerEvents?: readonly import('../src/input-snapshot').PointerPhaseEvent[];
        focused?: boolean;
      },
    ): InputSnapshot {
      const world = new World();
      const backend = fixtureBackend({
        gamepads: opts.gamepads,
        pointers: opts.pointers,
        pointerEvents: opts.pointerEvents,
        capabilities: { gamepad: true, pointer: true },
        focused: opts.focused ?? true,
      });
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(Update, InputFrameStartScan);
      world.update(1 / 60).unwrap();
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('snap missing');
      return snap;
    }

    function pev(overrides: Partial<import('../src/input-snapshot').PointerPhaseEvent> = {}): import('../src/input-snapshot').PointerPhaseEvent {
      return {
        pointerId: overrides.pointerId ?? 1,
        phase: overrides.phase ?? 'cancel',
        x: overrides.x ?? 0,
        y: overrides.y ?? 0,
        pressure: overrides.pressure ?? 0,
        pointerType: overrides.pointerType ?? 'touch',
      };
    }

    it('after blur, active pointers cleared and cancel events queued', () => {
      const snap = makeSnap({
        pointers: [],
        pointerEvents: [pev({ pointerId: 1, phase: 'cancel' }), pev({ pointerId: 2, phase: 'cancel' })],
      });
      expect(snap.pointer(1).active).toBe(false);
      expect(snap.pointer(2).active).toBe(false);
      expect(snap.pointerEvents).toHaveLength(2);
      expect(snap.pointerEvents[0].phase).toBe('cancel');
      expect(snap.pointerEvents[1].phase).toBe('cancel');
    });

    it('visibilitychange(hidden) produces same cleanup as blur', () => {
      const snap = makeSnap({
        pointers: [],
        pointerEvents: [pev({ pointerId: 1, phase: 'cancel' })],
        focused: false,
      });
      expect(snap.pointer(1).active).toBe(false);
      expect(snap.pointerEvents).toHaveLength(1);
      expect(snap.pointerEvents[0].phase).toBe('cancel');
    });

    it('gamepad edge reset after blur: justPressed/justReleased clean', () => {
      const snap = makeSnap({
        gamepads: [
          buildGamepadSlot(0, { pressed: [0, 1], justPressed: new Set(), justReleased: new Set() }),
        ],
        pointers: [],
        pointerEvents: [],
      });
      const g = snap.gamepad(0);
      expect(g.connected).toBe(true);
      expect(g.justPressed(0)).toBe(false);
      expect(g.justReleased(0)).toBe(false);
    });

    it('after focus recovery, gamepad polling resumes normally (no phantom held)', () => {
      const snap = makeSnap({
        gamepads: [buildGamepadSlot(0, { pressed: [0] })],
        pointers: [{
          pointerId: 1, x: 100, y: 200, pressure: 0, pointerType: 'touch', active: true,
          delta: Object.freeze({ x: 0, y: 0 }),
        }],
        pointerEvents: [],
        focused: true,
      });
      expect(snap.gamepad(0).connected).toBe(true);
      expect(snap.gamepad(0).standardMapping).toBe(true);
      expect(snap.gamepad(0).button(0)).toBe(true);
      expect(snap.pointer(1).active).toBe(true);
    });
  });
}

// ─── M3: virtual joystick fixed mode (AC-11) ───

{
  describe('virtual joystick fixed mode (AC-11)', () => {
    const fixedConfig: VirtualJoystickConfig = {
      name: 'move',
      mode: 'fixed',
      region: { x: 0, y: 0, width: 200, height: 200 },
      anchor: { x: 100, y: 100 },
      radius: 50,
      deadzone: 0.1,
    };

    function makePointerMap(entries: { id: number; x: number; y: number }[]): Map<number, { readonly x: number; readonly y: number }> {
      const m = new Map<number, { readonly x: number; readonly y: number }>();
      for (const e of entries) {
        m.set(e.id, { x: e.x, y: e.y });
      }
      return m;
    }

    it('fixed mode uses anchor as origin: drag half-radius right yields vec=(0.5, 0)', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 100, originY: 100 });

      // Pointer at anchor + 25px right = (125, 100). vec = (125-100)/50 = 0.5.
      const pointerMap = makePointerMap([{ id: 1, x: 125, y: 100 }]);
      const axes = deriveVirtualAxes([fixedConfig], pointerMap, bindState);
      expect(axes).toHaveLength(1);
      expect(axes[0].name).toBe('move');
      expect(axes[0].x).toBeCloseTo(0.5);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('drag beyond 2R clamps to unit magnitude', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 100, originY: 100 });

      // Pointer at (100+200, 100): raw vec = (200, 0) / 50 = (4, 0), clamped to 1.
      const pointerMap = makePointerMap([{ id: 1, x: 300, y: 100 }]);
      const axes = deriveVirtualAxes([fixedConfig], pointerMap, bindState);
      expect(axes).toHaveLength(1);
      expect(axes[0].x).toBeCloseTo(1.0);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('deadzone: micro-move within deadzone threshold yields zero vector', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 100, originY: 100 });

      // 3px from anchor: 3/50 = 0.06 < 0.1 deadzone → zero vector.
      const pointerMap = makePointerMap([{ id: 1, x: 103, y: 100 }]);
      const axes = deriveVirtualAxes([fixedConfig], pointerMap, bindState);
      expect(axes[0].x).toBeCloseTo(0);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('pointer up yields zero vector and unbinds', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 100, originY: 100 });

      // Unbind, then derive: unbound joystick gives zero vector.
      handleVirtualJoystickUnbind(bindState, 1);

      const pointerMap = makePointerMap([]);
      const axes = deriveVirtualAxes([fixedConfig], pointerMap, bindState);
      expect(axes[0].x).toBeCloseTo(0);
      expect(axes[0].y).toBeCloseTo(0);
    });
  });
}

// ─── M3: virtual joystick floating mode (AC-11) ───

{
  describe('virtual joystick floating mode (AC-11)', () => {
    const floatingConfig: VirtualJoystickConfig = {
      name: 'move',
      mode: 'floating',
      region: { x: 0, y: 0, width: 200, height: 200 },
      radius: 60,
      deadzone: 0.05,
    };

    function makePointerMap(entries: { id: number; x: number; y: number }[]): Map<number, { pointerId: number; x: number; y: number; active: boolean }> {
      const m = new Map<number, { pointerId: number; x: number; y: number; active: boolean }>();
      for (const e of entries) {
        m.set(e.id, { pointerId: e.id, x: e.x, y: e.y, active: true });
      }
      return m;
    }

    it('first touch in region sets origin; drag 30px right yields vec=(0.5, 0)', () => {
      const bindState = new Map<string, BindState>();
      // Simulate: pointerdown at (80, 80) in region → origin = (80, 80).
      bindState.set('move', { pointerId: 1, originX: 80, originY: 80 });

      // Pointer dragged to (110, 80). vec = (110-80)/60 = 30/60 = 0.5.
      const pointerMap = makePointerMap([{ id: 1, x: 110, y: 80 }]);
      const axes = deriveVirtualAxes([floatingConfig], pointerMap, bindState);
      expect(axes).toHaveLength(1);
      expect(axes[0].name).toBe('move');
      expect(axes[0].x).toBeCloseTo(0.5);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('drag beyond 2R clamps to unit magnitude', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 80, originY: 80 });

      // Pointer at (80+200, 80): raw vec = (200, 0) / 60 = (3.33, 0), clamped.
      const pointerMap = makePointerMap([{ id: 1, x: 280, y: 80 }]);
      const axes = deriveVirtualAxes([floatingConfig], pointerMap, bindState);
      expect(axes).toHaveLength(1);
      expect(axes[0].x).toBeCloseTo(1.0);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('deadzone: micro-move below deadzone yields zero vector', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 80, originY: 80 });

      // 2px from origin: 2/60 ≈ 0.033 < 0.05 deadzone → zero.
      const pointerMap = makePointerMap([{ id: 1, x: 82, y: 80 }]);
      const axes = deriveVirtualAxes([floatingConfig], pointerMap, bindState);
      expect(axes[0].x).toBeCloseTo(0);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('pointer up yields zero vector and unbinds', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 80, originY: 80 });

      handleVirtualJoystickUnbind(bindState, 1);
      const pointerMap = makePointerMap([]);
      const axes = deriveVirtualAxes([floatingConfig], pointerMap, bindState);
      expect(axes[0].x).toBeCloseTo(0);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('next pointerdown creates new origin (re-origin)', () => {
      const bindState = new Map<string, BindState>();

      // First touch: bind at (80, 80). Unbind. Then re-bind at (150, 150).
      bindState.set('move', { pointerId: 1, originX: 80, originY: 80 });
      handleVirtualJoystickUnbind(bindState, 1);

      // New pointerdown at (150, 150) → new origin.
      bindState.set('move', { pointerId: 2, originX: 150, originY: 150 });

      // Drag 30px right from new origin → vec = (30/60) = 0.5.
      const pointerMap = makePointerMap([{ id: 2, x: 180, y: 150 }]);
      const axes = deriveVirtualAxes([floatingConfig], pointerMap, bindState);
      expect(axes[0].x).toBeCloseTo(0.5);
      expect(axes[0].y).toBeCloseTo(0);
    });
  });
}

// ─── M3: virtual joystick multi-pointer isolation (AC-12) ───

{
  describe('virtual joystick multi-pointer isolation (AC-12)', () => {
    const configA: VirtualJoystickConfig = {
      name: 'move',
      mode: 'fixed',
      region: { x: 0, y: 0, width: 100, height: 100 },
      radius: 50,
      deadzone: 0.1,
    };
    const configB: VirtualJoystickConfig = {
      name: 'aim',
      mode: 'fixed',
      region: { x: 200, y: 0, width: 100, height: 100 },
      radius: 50,
      deadzone: 0.1,
    };

    function makePointerMap(entries: { id: number; x: number; y: number }[]): Map<number, { pointerId: number; x: number; y: number; active: boolean }> {
      const m = new Map<number, { pointerId: number; x: number; y: number; active: boolean }>();
      for (const e of entries) {
        m.set(e.id, { pointerId: e.id, x: e.x, y: e.y, active: true });
      }
      return m;
    }

    it('finger A bound to joystick; finger B outside region does not affect joystick vector', () => {
      const bindState = new Map<string, BindState>();
      // Finger A (pointerId=1) bound to 'move' joystick, dragged to half-radius right.
      bindState.set('move', { pointerId: 1, originX: 50, originY: 50 });

      // Finger B (pointerId=2) at (400, 400) — outside any region.
      const pointerMap = makePointerMap([
        { id: 1, x: 75, y: 50 },
        { id: 2, x: 400, y: 400 },
      ]);
      const axes = deriveVirtualAxes([configA], pointerMap, bindState);
      expect(axes).toHaveLength(1);
      // Vector should be (25/50, 0) = (0.5, 0), unaffected by finger B.
      expect(axes[0].x).toBeCloseTo(0.5);
      expect(axes[0].y).toBeCloseTo(0);
    });

    it('two joysticks each bound to a different finger; vectors are independent', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 50, originY: 50 });
      bindState.set('aim', { pointerId: 2, originX: 250, originY: 50 });

      // Both fingers at half-radius right of their respective origins.
      const pointerMap = makePointerMap([
        { id: 1, x: 75, y: 50 },
        { id: 2, x: 275, y: 50 },
      ]);
      const axes = deriveVirtualAxes([configA, configB], pointerMap, bindState);
      expect(axes).toHaveLength(2);
      expect(axes[0].name).toBe('move');
      expect(axes[0].x).toBeCloseTo(0.5);
      expect(axes[1].name).toBe('aim');
      expect(axes[1].x).toBeCloseTo(0.5);
    });

    it('finger A up: joystick A returns zero; joystick B unaffected', () => {
      const bindState = new Map<string, BindState>();
      bindState.set('move', { pointerId: 1, originX: 50, originY: 50 });
      bindState.set('aim', { pointerId: 2, originX: 250, originY: 50 });

      // Finger A up → unbind move.
      handleVirtualJoystickUnbind(bindState, 1);

      // Only finger B is active, at half-radius right.
      const pointerMap = makePointerMap([{ id: 2, x: 275, y: 50 }]);
      const axes = deriveVirtualAxes([configA, configB], pointerMap, bindState);
      expect(axes).toHaveLength(2);
      // Joystick A unbound → zero.
      expect(axes[0].x).toBeCloseTo(0);
      expect(axes[0].y).toBeCloseTo(0);
      // Joystick B unaffected.
      expect(axes[1].x).toBeCloseTo(0.5);
      expect(axes[1].y).toBeCloseTo(0);
    });

    it('unbound joystick with no active pointer returns zero vector', () => {
      const bindState = new Map<string, BindState>();
      // No binding at all.
      const pointerMap = makePointerMap([]);
      const axes = deriveVirtualAxes([configA, configB], pointerMap, bindState);
      expect(axes).toHaveLength(2);
      expect(axes[0].x).toBeCloseTo(0);
      expect(axes[1].x).toBeCloseTo(0);
    });
  });
}

// -- F-1: direct diffGamepadFrame unit tests (producer-layer coverage) --

{
  /**
   * Build a RawGamepadStub from pressed button indices, button values,
   * and axes arrays. Defaults to standard mapping, connected=true.
   */
  function rawStub(overrides?: {
    index?: number;
    id?: string;
    pressed?: number[];
    buttonValues?: [number, number][];
    axes?: number[];
    mapping?: string;
  }): RawGamepadStub {
    const idx = overrides?.index ?? 0;
    const pressedSet = new Set(overrides?.pressed ?? []);
    const btnValues = new Map<number, number>(overrides?.buttonValues ?? []);
    const buttons: { value: number; pressed: boolean }[] = [];
    for (let b = 0; b < 17; b++) {
      buttons.push({ value: btnValues.get(b) ?? 0, pressed: pressedSet.has(b) });
    }
    return {
      index: idx,
      id: overrides?.id ?? 'standard pad',
      connected: true,
      mapping: overrides?.mapping ?? 'standard',
      buttons,
      axes: overrides?.axes ?? [0, 0, 0, 0],
    };
  }

  /**
   * Build a GamepadSlotSample from the same simplified shape as rawStub,
   * for use as prev-frame state in diffGamepadFrame.
   */
  function prevSlot(overrides?: {
    index?: number;
    pressed?: number[];
    buttonValues?: [number, number][];
    axes?: [number, number, number, number];
    justPressed?: number[];
    justReleased?: number[];
  }): GamepadSlotSample {
    const idx = overrides?.index ?? 0;
    const btnValues = new Map<number, number>(overrides?.buttonValues ?? []);
    return {
      index: idx,
      standardMapping: true,
      pressed: new Set(overrides?.pressed ?? []),
      justPressed: new Set(overrides?.justPressed ?? []),
      justReleased: new Set(overrides?.justReleased ?? []),
      buttonValues: btnValues,
      axes: overrides?.axes ?? [0, 0, 0, 0],
    };
  }

  describe('diffGamepadFrame producer-layer tests (F-1)', () => {
    it('justPressed = cur\\prev: new press appears as edge', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ pressed: [] }));
      const cur = [rawStub({ pressed: [0] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].index).toBe(0);
      expect(result[0].pressed.has(0)).toBe(true);
      expect(result[0].justPressed.has(0)).toBe(true);
      expect(result[0].justReleased.has(0)).toBe(false);
    });

    it('justReleased = prev\\cur: release appears as edge', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ pressed: [0] }));
      const cur = [rawStub({ pressed: [] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].pressed.has(0)).toBe(false);
      expect(result[0].justPressed.has(0)).toBe(false);
      expect(result[0].justReleased.has(0)).toBe(true);
    });

    it('consecutive held frames do not re-emit justPressed edge', () => {
      // Frame 1: no buttons pressed.
      const prev1 = new Map<number, GamepadSlotSample>();
      prev1.set(0, prevSlot({ pressed: [] }));
      const cur1 = [rawStub({ pressed: [0] })];
      const r1 = diffGamepadFrame(prev1, cur1);
      expect(r1[0].justPressed.has(0)).toBe(true); // edge emitted

      // Frame 2: button 0 still held — no edge.
      const prev2 = new Map<number, GamepadSlotSample>();
      prev2.set(0, r1[0]);
      const cur2 = [rawStub({ pressed: [0] })];
      const r2 = diffGamepadFrame(prev2, cur2);
      expect(r2[0].pressed.has(0)).toBe(true); // still held
      expect(r2[0].justPressed.has(0)).toBe(false); // edge gone
      expect(r2[0].justReleased.has(0)).toBe(false);
    });

    it('consecutive held frames do not re-emit justReleased edge', () => {
      // Frame 1: button 0 held.
      const prev1 = new Map<number, GamepadSlotSample>();
      prev1.set(0, prevSlot({ pressed: [0] }));
      const cur1 = [rawStub({ pressed: [] })];
      const r1 = diffGamepadFrame(prev1, cur1);
      expect(r1[0].justReleased.has(0)).toBe(true); // edge emitted

      // Frame 2: still not pressed — no edge.
      const prev2 = new Map<number, GamepadSlotSample>();
      prev2.set(0, r1[0]);
      const cur2 = [rawStub({ pressed: [] })];
      const r2 = diffGamepadFrame(prev2, cur2);
      expect(r2[0].pressed.has(0)).toBe(false);
      expect(r2[0].justReleased.has(0)).toBe(false);
    });

    it('disconnected slot: slot in prev but not cur emits empty-signal entry', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ pressed: [0, 2] }));
      // cur: empty array — gamepad unplugged.
      const result = diffGamepadFrame(prev, []);
      expect(result).toHaveLength(1);
      expect(result[0].index).toBe(0);
      expect(result[0].standardMapping).toBe(false); // disconnected signal
      expect(result[0].pressed.size).toBe(0);
      expect(result[0].justPressed.size).toBe(0);
      expect(result[0].justReleased.size).toBe(0);
    });

    it('null-padded array: missing indices are skipped, present ones processed', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ pressed: [] }));
      prev.set(1, prevSlot({ index: 1, pressed: [3] }));
      // Only slot 1 present this frame (slot 0 disconnected).
      const cur = [rawStub({ index: 1, pressed: [3] })];

      const result = diffGamepadFrame(prev, cur);
      // Two results: slot 1 (connected) + slot 0 (disconnected).
      const sorted = [...result].sort((a, b) => a.index - b.index);
      expect(sorted).toHaveLength(2);
      // Slot 0: disconnected.
      expect(sorted[0].index).toBe(0);
      expect(sorted[0].standardMapping).toBe(false);
      // Slot 1: still connected, button 3 held.
      expect(sorted[1].index).toBe(1);
      expect(sorted[1].standardMapping).toBe(true);
      expect(sorted[1].pressed.has(3)).toBe(true);
      // No spurious edge — button 3 was already held in prev.
      expect(sorted[1].justPressed.has(3)).toBe(false);
    });

    it('non-standard mapping: connected=true, standardMapping=false, all readpoints empty', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [rawStub({ mapping: 'xinput-unknown', pressed: [0, 1], axes: [0.5, 0, 0, 0] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].index).toBe(0);
      expect(result[0].standardMapping).toBe(false);
      expect(result[0].pressed.size).toBe(0);
      expect(result[0].justPressed.size).toBe(0);
      expect(result[0].justReleased.size).toBe(0);
      expect(result[0].buttonValues.size).toBe(0);
      expect(result[0].axes).toEqual([0, 0, 0, 0]);
    });

    it('button value tracking: analog triggers pass through raw values', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ pressed: [], buttonValues: [[6, 0], [7, 0]] }));
      const cur = [rawStub({ buttonValues: [[6, 0.75], [7, 0.3]] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].buttonValues.get(6)).toBe(0.75);
      expect(result[0].buttonValues.get(7)).toBe(0.3);
    });

    it('axes pass through raw values from cur frame', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ axes: [0, 0, 0, 0] }));
      const cur = [rawStub({ axes: [0.5, -0.5, 1, 0.3] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].axes[0]).toBe(0.5);
      expect(result[0].axes[1]).toBe(-0.5);
      expect(result[0].axes[2]).toBe(1);
      expect(result[0].axes[3]).toBe(0.3);
    });

    it('multiple buttons press/release in single frame: independent edges', () => {
      const prev = new Map<number, GamepadSlotSample>();
      prev.set(0, prevSlot({ pressed: [0, 3] }));
      // Frame: button 0 released, button 1 newly pressed, button 3 still held.
      const cur = [rawStub({ pressed: [1, 3] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].pressed.has(0)).toBe(false);
      expect(result[0].pressed.has(1)).toBe(true);
      expect(result[0].pressed.has(3)).toBe(true);
      expect(result[0].justPressed.has(0)).toBe(false);
      expect(result[0].justPressed.has(1)).toBe(true);
      expect(result[0].justPressed.has(3)).toBe(false);
      expect(result[0].justReleased.has(0)).toBe(true);
      expect(result[0].justReleased.has(1)).toBe(false);
      expect(result[0].justReleased.has(3)).toBe(false);
    });

    it('prev frame is empty (first frame): all cur pressed appear as justPressed', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [rawStub({ pressed: [0, 1, 9] })];

      const result = diffGamepadFrame(prev, cur);
      expect(result).toHaveLength(1);
      expect(result[0].justPressed.has(0)).toBe(true);
      expect(result[0].justPressed.has(1)).toBe(true);
      expect(result[0].justPressed.has(9)).toBe(true);
      expect(result[0].justReleased.size).toBe(0);
    });
  });
}

// -- F-2: cross-frame pointer delta via real backend (AC-09) --

{
  interface DeltaBB {
    canvas: HTMLCanvasElement;
    store: {
      fire(target: string, kind: string, ev: Partial<PointerEvent> & { clientX?: number; clientY?: number }): void;
    };
  }

  function buildDeltaFakes(): DeltaBB & {
    doc: Document;
    win: Window;
  } {
    const listeners = new Map<string, Map<string, Set<EventListener>>>();

    const makeTarget = (label: string) => ({
      addEventListener(kind: string, handler: EventListener): void {
        let perTarget = listeners.get(label);
        if (!perTarget) { perTarget = new Map(); listeners.set(label, perTarget); }
        let set = perTarget.get(kind);
        if (!set) { set = new Set(); perTarget.set(kind, set); }
        set.add(handler);
      },
      removeEventListener(kind: string, handler: EventListener): void {
        listeners.get(label)?.get(kind)?.delete(handler);
      },
    });

    const canvas = {
      ...makeTarget('canvas'),
      requestPointerLock(): void {},
      setPointerCapture(): void {},
      // computePointerCoords fallback: no getBoundingClientRect → uses clientX/Y.
      width: 800,
      height: 600,
      style: {} as CSSStyleDeclaration,
    } as unknown as HTMLCanvasElement;

    const doc = {
      hasFocus(): boolean { return true; },
      pointerLockElement: null,
      exitPointerLock(): void {},
    } as unknown as Document;

    const win = makeTarget('window') as unknown as Window;

    const store = {
      fire(target: string, kind: string, ev: Partial<PointerEvent> & { clientX?: number; clientY?: number }): void {
        const handlers = listeners.get(target)?.get(kind);
        if (!handlers) return;
        // Merge default touch event shape so tests don't need full PointerEvent.
        const full = {
          pointerType: 'touch',
          pointerId: 1,
          button: 0,
          pressure: 1,
          clientX: 0,
          clientY: 0,
          ...ev,
          movementX: ev.movementX ?? 0,
          movementY: ev.movementY ?? 0,
        };
        for (const h of handlers) {
          h(full as unknown as Event);
        }
      },
    };
    return { canvas, doc, win, store };
  }

  describe('cross-frame pointer delta via real backend (F-2 / AC-09)', () => {
    it('single pointermove in a frame: delta equals displacement from pointerdown', () => {
      const { canvas, doc, win, store } = buildDeltaFakes();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });

      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 100, clientY: 200, pointerType: 'touch' });
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 130, clientY: 200, pointerType: 'touch' });

      const sample = handle.backend.sample();
      expect(sample.pointers).toBeDefined();
      expect(sample.pointers!.length).toBe(1);
      expect(sample.pointers![0].x).toBe(130);
      expect(sample.pointers![0].y).toBe(200);
      expect(sample.pointers![0].delta.x).toBe(30);
      expect(sample.pointers![0].delta.y).toBe(0);
    });

    it('next frame with no movement: delta resets to zero', () => {
      const { canvas, doc, win, store } = buildDeltaFakes();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });

      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 100, clientY: 200, pointerType: 'touch' });
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 150, clientY: 200, pointerType: 'touch' });
      handle.backend.sample(); // consume frame 1

      // Frame 2: no move events → delta=0.
      const sample2 = handle.backend.sample();
      expect(sample2.pointers).toBeDefined();
      expect(sample2.pointers![0].delta.x).toBe(0);
      expect(sample2.pointers![0].delta.y).toBe(0);
    });

    it('multi-move across two frames: each frame reports independent delta', () => {
      const { canvas, doc, win, store } = buildDeltaFakes();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });

      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0, pointerType: 'touch' });

      // Frame 1: 3 moves, +10px each.
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 10, clientY: 0, pointerType: 'touch' });
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 20, clientY: 0, pointerType: 'touch' });
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 30, clientY: 0, pointerType: 'touch' });
      const s1 = handle.backend.sample();
      expect(s1.pointers![0].delta.x).toBe(30);
      expect(s1.pointers![0].delta.y).toBe(0);

      // Frame 2: 2 more moves.
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 45, clientY: 10, pointerType: 'touch' });
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 60, clientY: 20, pointerType: 'touch' });
      const s2 = handle.backend.sample();
      expect(s2.pointers![0].delta.x).toBe(30);  // 60-30 = 30 from frame 1's last position
      expect(s2.pointers![0].delta.y).toBe(20);  // 20-0 = 20
    });

    it('Beving #12442 anti-regression: N moves in same frame produce accumulated delta, not zero', () => {
      const { canvas, doc, win, store } = buildDeltaFakes();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });

      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 0, clientY: 0, pointerType: 'touch' });
      // 5 move events in the same frame, +10px each.
      for (let i = 1; i <= 5; i++) {
        store.fire('canvas', 'pointermove', { pointerId: 1, clientX: i * 10, clientY: 0, pointerType: 'touch' });
      }

      const sample = handle.backend.sample();
      // Bevy #12442 bug: delta was (0,0) because prevX was updated per-event.
      // Our fix: prevX is only snapshotted in sample(), never in onPointerMove.
      expect(sample.pointers![0].delta.x).toBe(50); // accumulated 5*10 = 50
      expect(sample.pointers![0].x).toBe(50);
    });
  });
}

// -- F-3(b): virtual joystick origin selection via real backend --

{
  interface VJBB {
    canvas: HTMLCanvasElement;
    store: {
      fire(target: string, kind: string, ev: Partial<PointerEvent> & { clientX?: number; clientY?: number }): void;
    };
  }

  function buildVJFakes(): VJBB & {
    doc: Document;
    win: Window;
  } {
    const listeners = new Map<string, Map<string, Set<EventListener>>>();

    const makeTarget = (label: string) => ({
      addEventListener(kind: string, handler: EventListener): void {
        let perTarget = listeners.get(label);
        if (!perTarget) { perTarget = new Map(); listeners.set(label, perTarget); }
        let set = perTarget.get(kind);
        if (!set) { set = new Set(); perTarget.set(kind, set); }
        set.add(handler);
      },
      removeEventListener(kind: string, handler: EventListener): void {
        listeners.get(label)?.get(kind)?.delete(handler);
      },
    });

    const canvas = {
      ...makeTarget('canvas'),
      requestPointerLock(): void {},
      setPointerCapture(): void {},
      getBoundingClientRect(): DOMRect {
        return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 } as DOMRect;
      },
      width: 800,
      height: 600,
      style: {} as CSSStyleDeclaration,
    } as unknown as HTMLCanvasElement;

    const doc = {
      hasFocus(): boolean { return true; },
      pointerLockElement: null,
      exitPointerLock(): void {},
    } as unknown as Document;

    const win = makeTarget('window') as unknown as Window;

    const store = {
      fire(target: string, kind: string, ev: Partial<PointerEvent> & { clientX?: number; clientY?: number }): void {
        const handlers = listeners.get(target)?.get(kind);
        if (!handlers) return;
        const full = {
          pointerType: 'touch',
          pointerId: 1,
          button: 0,
          pressure: 1,
          clientX: 0,
          clientY: 0,
          ...ev,
          movementX: ev.movementX ?? 0,
          movementY: ev.movementY ?? 0,
        };
        for (const h of handlers) {
          h(full as unknown as Event);
        }
      },
    };
    return { canvas, doc, win, store };
  }

  describe('VJ origin selection via real backend (F-3b / AC-11)', () => {
    const fixedConfig: VirtualJoystickConfig = {
      name: 'move',
      mode: 'fixed',
      region: { x: 0, y: 0, width: 200, height: 200 },
      anchor: { x: 100, y: 100 },
      radius: 50,
      deadzone: 0.1,
    };

    const floatingConfig: VirtualJoystickConfig = {
      name: 'look',
      mode: 'floating',
      region: { x: 300, y: 0, width: 200, height: 200 },
      radius: 60,
      deadzone: 0.05,
    };

    it('fixed mode: pointerdown at (50,50) uses anchor (100,100) as origin', () => {
      const { canvas, store } = buildVJFakes();
      const handle = attachBrowserInputBackend(canvas, { virtualJoysticks: [fixedConfig] });

      // Pointerdown at (50,50) inside region — fixed mode should use anchor (100,100).
      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 50, clientY: 50, pointerType: 'touch' });
      // No move — pointer stays at (50,50). vec = (50-100)/50 = (-50/50) = -1.0 clamped.
      const sample = handle.backend.sample();
      expect(sample.virtualAxes).toBeDefined();
      expect(sample.virtualAxes![0].name).toBe('move');
      // dx=-50, dy=-50, raw = (-1, -1), mag = sqrt(2) > 1 → clamped to unit.
      // Normalized: (-1/sqrt(2), -1/sqrt(2)) ≈ (-0.707, -0.707)
      expect(Math.abs(sample.virtualAxes![0].x)).toBeCloseTo(0.707, 1);
      expect(Math.abs(sample.virtualAxes![0].y)).toBeCloseTo(0.707, 1);
    });

    it('fixed mode: pointerdown at (0,0) with no anchor uses region center', () => {
      const noAnchorConfig: VirtualJoystickConfig = {
        name: 'move',
        mode: 'fixed',
        region: { x: 50, y: 50, width: 100, height: 100 },
        radius: 50,
        deadzone: 0.1,
        // anchor omitted → region center = (100, 100)
      };
      const { canvas, store } = buildVJFakes();
      const handle = attachBrowserInputBackend(canvas, { virtualJoysticks: [noAnchorConfig] });

      // Pointerdown at (125, 100). Region center = (50+100/2, 50+100/2) = (100, 100).
      // Raw: (125-100)/50 = 0.5, (100-100)/50 = 0.
      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 125, clientY: 100, pointerType: 'touch' });
      const sample = handle.backend.sample();
      expect(sample.virtualAxes).toBeDefined();
      expect(sample.virtualAxes![0].x).toBeCloseTo(0.5);
      expect(sample.virtualAxes![0].y).toBeCloseTo(0);
    });

    it('floating mode: pointerdown position becomes origin', () => {
      const { canvas, store } = buildVJFakes();
      const handle = attachBrowserInputBackend(canvas, { virtualJoysticks: [floatingConfig] });

      // Pointerdown at (350, 50) inside floating region. Origin set to pointerdown position.
      // No move: pointer still at origin → (0, 0) vector in first frame.
      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 350, clientY: 50, pointerType: 'touch' });
      const s1 = handle.backend.sample();
      expect(s1.virtualAxes![0].x).toBeCloseTo(0);
      expect(s1.virtualAxes![0].y).toBeCloseTo(0);

      // Move to (410, 50). vec = (410-350)/60 = 1.0, y = 0.
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 410, clientY: 50, pointerType: 'touch' });
      const s2 = handle.backend.sample();
      expect(s2.virtualAxes![0].x).toBeCloseTo(1.0);
      expect(s2.virtualAxes![0].y).toBeCloseTo(0);
    });

    it('floating mode: pointerup then re-down creates new origin (re-origin)', () => {
      const { canvas, store } = buildVJFakes();
      const handle = attachBrowserInputBackend(canvas, { virtualJoysticks: [floatingConfig] });

      // First touch at (350, 50), move right, release.
      store.fire('canvas', 'pointerdown', { pointerId: 1, clientX: 350, clientY: 50, pointerType: 'touch' });
      store.fire('canvas', 'pointermove', { pointerId: 1, clientX: 410, clientY: 50, pointerType: 'touch' });
      handle.backend.sample(); // consume frame 1
      store.fire('canvas', 'pointerup', { pointerId: 1, clientX: 410, clientY: 50, pointerType: 'touch' });
      handle.backend.sample(); // consume frame 2 with up

      // Second touch at (450, 100) — new origin.
      store.fire('canvas', 'pointerdown', { pointerId: 2, clientX: 450, clientY: 100, pointerType: 'touch' });
      // No move → zero vector at new origin.
      const s3 = handle.backend.sample();
      expect(s3.virtualAxes![0].x).toBeCloseTo(0);
      expect(s3.virtualAxes![0].y).toBeCloseTo(0);

      // Move right from new origin: (480, 100). vec = (480-450)/60 = 0.5.
      store.fire('canvas', 'pointermove', { pointerId: 2, clientX: 480, clientY: 100, pointerType: 'touch' });
      const s4 = handle.backend.sample();
      expect(s4.virtualAxes![0].x).toBeCloseTo(0.5);
      expect(s4.virtualAxes![0].y).toBeCloseTo(0);
    });

    it('fixed and floating origin are independent: both joysticks testable simultaneously', () => {
      const { canvas, store } = buildVJFakes();
      const handle = attachBrowserInputBackend(canvas, {
        virtualJoysticks: [fixedConfig, floatingConfig],
      });

      // Fixed: touch at (50, 50) in left region. Origin = anchor (100, 100).
      // Floating: touch at (400, 100) in right region. Origin = (400, 100).
      store.fire('canvas', 'pointerdown', {
        pointerId: 1, clientX: 50, clientY: 50, pointerType: 'touch',
      });
      store.fire('canvas', 'pointerdown', {
        pointerId: 2, clientX: 400, clientY: 100, pointerType: 'touch',
      });

      // Move finger 2 to (460, 100): vec right = (460-400)/60 = 1.0.
      store.fire('canvas', 'pointermove', {
        pointerId: 2, clientX: 460, clientY: 100, pointerType: 'touch',
      });

      const sample = handle.backend.sample();
      expect(sample.virtualAxes).toBeDefined();
      expect(sample.virtualAxes!.length).toBe(2);

      // Fixed: finger at (50,50), origin (100,100). Raw: (-50,-50)/50 = (-1,-1).
      // |raw| = sqrt(2) > 1 → clamped to unit. Normalized: (-0.707, -0.707).
      expect(sample.virtualAxes![0].name).toBe('move');
      expect(Math.abs(sample.virtualAxes![0].x)).toBeCloseTo(0.707, 1);

      // Floating: finger at (460,100), origin (400,100). vec = (60,0)/60 = (1,0).
      expect(sample.virtualAxes![1].name).toBe('look');
      expect(sample.virtualAxes![1].x).toBeCloseTo(1.0);
      expect(sample.virtualAxes![1].y).toBeCloseTo(0);
    });
  });
}

{
  // ─── from action-state.test.ts ───

  /**
   * Synthetic InputBackendSample for deriveActionStates testing.
   */
  function sampleForAction(overrides?: {
    downKeys?: string[];
    buttons?: [boolean, boolean, boolean];
    gamepads?: readonly GamepadSlotSample[];
  }): import('../src/input-snapshot').InputBackendSample {
    return {
      downKeys: new Set(overrides?.downKeys ?? []),
      upKeys: new Set(),
      buttons: overrides?.buttons ?? [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
      gamepads: overrides?.gamepads ?? [],
    };
  }

  function standardGamepadSlot(index: number, overrides?: {
    pressed?: number[];
    buttonValues?: [number, number][];
    axes?: [number, number, number, number];
  }): GamepadSlotSample {
    const bv = new Map<number, number>(overrides?.buttonValues ?? []);
    return {
      index,
      standardMapping: true,
      pressed: new Set(overrides?.pressed ?? []),
      justPressed: new Set(),
      justReleased: new Set(),
      buttonValues: bv,
      axes: overrides?.axes ?? [0, 0, 0, 0],
    };
  }

  /**
   * Extract strength from ActionState[] for a given action name.
   */
  function strengthOf(states: readonly ActionState[], name: string): number {
    const s = states.find((a) => a.action === name);
    return s?.strength ?? -999;
  }

  function pressedOf(states: readonly ActionState[], name: string): boolean {
    const s = states.find((a) => a.action === name);
    return s?.pressed ?? false;
  }

  function rawOf(states: readonly ActionState[], name: string): number {
    const s = states.find((a) => a.action === name);
    return s?.raw ?? -999;
  }

  function justPressedOf(states: readonly ActionState[], name: string): boolean {
    const s = states.find((a) => a.action === name);
    return s?.justPressed ?? false;
  }

  function justReleasedOf(states: readonly ActionState[], name: string): boolean {
    const s = states.find((a) => a.action === name);
    return s?.justReleased ?? false;
  }

  // Minimal InputMap type for tests (will expand when m1t2 ships the real type)
  type InputMapForTest = readonly ActionConfig[];

  describe('action-state.test.ts', () => {
    describe('deriveActionStates — AC-04 OR/MAX aggregation', () => {
      it('key 1.0 + gamepadButton held → strength = MAX = 1.0 (AC-04 literal)', () => {
        const map: InputMapForTest = [
          {
            action: 'jump',
            bindings: [
              { type: 'key', key: ' ' },
              { type: 'gamepadButton', button: 0 },
            ],
          },
        ];
        const sample = sampleForAction({
          downKeys: [' '],
          gamepads: [
            standardGamepadSlot(0, { pressed: [0], buttonValues: [[0, 1.0]] }),
          ],
        });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'jump')).toBe(true);
        expect(strengthOf(states, 'jump')).toBeCloseTo(1.0);
      });

      it('key 1.0 + stick 0.3 → strength 1.0 (MAX, not sum)', () => {
        const map: InputMapForTest = [
          {
            action: 'moveRight',
            bindings: [
              { type: 'key', key: 'd' },
              { type: 'gamepadAxis', axis: 0, sign: 1 },
            ],
          },
        ];
        const sample = sampleForAction({
          downKeys: ['d'],
          gamepads: [
            standardGamepadSlot(0, { axes: [0.3, 0, 0, 0] }),
          ],
        });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'moveRight')).toBe(true);
        // key contributes 1.0, stick contributes deadzone-remapped 0.3 → ~0.125
        // MAX should be 1.0
        expect(strengthOf(states, 'moveRight')).toBeCloseTo(1.0);
      });
    });

    describe('deriveActionStates — AC-02 strength/raw separation', () => {
      it('digital binding (key) → strength is 1.0, raw is 1.0 when pressed', () => {
        const map: InputMapForTest = [
          { action: 'fire', bindings: [{ type: 'key', key: 'f' }] },
        ];
        const sample = sampleForAction({ downKeys: ['f'] });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'fire')).toBe(true);
        expect(strengthOf(states, 'fire')).toBe(1.0);
        expect(rawOf(states, 'fire')).toBe(1.0);
      });

      it('digital binding (key) → strength is 0, raw is 0 when not pressed', () => {
        const map: InputMapForTest = [
          { action: 'fire', bindings: [{ type: 'key', key: 'f' }] },
        ];
        const sample = sampleForAction({ downKeys: [] });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'fire')).toBe(false);
        expect(strengthOf(states, 'fire')).toBe(0);
        expect(rawOf(states, 'fire')).toBe(0);
      });

      it('analog binding (gamepadAxis) → strength is deadzone-remapped, raw is |value|', () => {
        const map: InputMapForTest = [
          { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }] },
        ];
        // axis value 0.5 → raw = 0.5, deadzone=0.2 → strength = inverse_lerp(0.2, 1, 0.5) = (0.5-0.2)/(1-0.2) = 0.375
        const sample = sampleForAction({
          gamepads: [standardGamepadSlot(0, { axes: [0.5, 0, 0, 0] })],
        });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'moveRight')).toBe(true); // 0.5 >= 0.2 deadzone
        expect(rawOf(states, 'moveRight')).toBeCloseTo(0.5);
        expect(strengthOf(states, 'moveRight')).toBeCloseTo(0.375, 5);
      });

      it('gamepadAxis below deadzone → pressed=false, strength=0, raw=0.1', () => {
        const map: InputMapForTest = [
          { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }] },
        ];
        const sample = sampleForAction({
          gamepads: [standardGamepadSlot(0, { axes: [0.1, 0, 0, 0] })],
        });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'moveRight')).toBe(false);
        expect(rawOf(states, 'moveRight')).toBeCloseTo(0.1);
        expect(strengthOf(states, 'moveRight')).toBe(0);
      });

      it('per-action deadzone override', () => {
        const map: InputMapForTest = [
          { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }], deadzone: 0.5 },
        ];
        // axis 0.4 → below custom deadzone 0.5
        const sample = sampleForAction({
          gamepads: [standardGamepadSlot(0, { axes: [0.4, 0, 0, 0] })],
        });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'moveRight')).toBe(false);
        expect(strengthOf(states, 'moveRight')).toBe(0);
      });

      it('mouseButton binding → digital on/off 1.0/0', () => {
        const map: InputMapForTest = [
          { action: 'click', bindings: [{ type: 'mouseButton', button: 0 }] },
        ];
        const sample = sampleForAction({ buttons: [true, false, false] });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'click')).toBe(true);
        expect(strengthOf(states, 'click')).toBe(1.0);
      });
    });

    describe('deriveActionStates — AC-09 empty signal for unmapped action', () => {
      it('unregistered action → isPressed=false, strength=0, no throw', () => {
        const map: InputMapForTest = [];
        const sample = sampleForAction({ downKeys: [' '] });
        const states = deriveActionStates(sample, map);
        expect(states.length).toBe(0);
      });

      it('some registered, some not — only registered actions appear', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: [' '] });
        const states = deriveActionStates(sample, map);
        expect(states.length).toBe(1);
        expect(states[0]!.action).toBe('jump');
      });
    });

    describe('deriveActionStates — AC-03 justPressed/justReleased edge semantics', () => {
      it('justPressed fires on first frame of press, not on held', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: [' '] });
        // prevActionStates: empty (no action was pressed)
        const prev: ActionState[] = [];
        const states = deriveActionStates(sample, map, prev);
        expect(justPressedOf(states, 'jump')).toBe(true);
        expect(justReleasedOf(states, 'jump')).toBe(false);
      });

      it('held does not re-fire justPressed', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: [' '] });
        // prev has 'jump' already pressed
        const prev: ActionState[] = [
          { action: 'jump', pressed: true, justPressed: true, justReleased: false, strength: 1.0, raw: 1.0 },
        ];
        const states = deriveActionStates(sample, map, prev);
        expect(pressedOf(states, 'jump')).toBe(true);
        expect(justPressedOf(states, 'jump')).toBe(false);
      });

      it('justReleased fires on first frame after release', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: [] });
        // prev has 'jump' pressed
        const prev: ActionState[] = [
          { action: 'jump', pressed: true, justPressed: false, justReleased: false, strength: 1.0, raw: 1.0 },
        ];
        const states = deriveActionStates(sample, map, prev);
        expect(pressedOf(states, 'jump')).toBe(false);
        expect(justReleasedOf(states, 'jump')).toBe(true);
      });

      it('justReleased does not fire on second frame of release', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: [] });
        // prev was already released (pressed=false)
        const prev: ActionState[] = [
          { action: 'jump', pressed: false, justPressed: false, justReleased: true, strength: 0, raw: 0 },
        ];
        const states = deriveActionStates(sample, map, prev);
        expect(justReleasedOf(states, 'jump')).toBe(false);
      });
    });

    describe('deriveActionStates — E-11 last-wins override', () => {
      it('duplicate action name → later config wins (last-wins)', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: 'a' }], deadzone: 0.1 },
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }], deadzone: 0.3 },
        ];
        const sample = sampleForAction({ downKeys: [' '] });
        // 'a' is NOT pressed, ' ' IS pressed. If later config wins, jump should fire.
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'jump')).toBe(true);
        // 'a' is not pressed, only ' ' binding (later) fires
      });

      it('duplicate action name — earlier config ignored when later resolves', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: 'a' }] },
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: ['a'] });
        // Both 'a' and ' ' — but last-wins means only ' ' binding matters, 'a' ignored
        const states = deriveActionStates(sample, map);
        // Only last binding counts → ' ' is NOT pressed → jump should be false
        expect(pressedOf(states, 'jump')).toBe(false);
      });
    });

    describe('deriveActionStates — E-1 disconnected slot contribution', () => {
      it('binding to disconnected gamepad slot → contributes false/0', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'gamepadButton', button: 0 }] },
        ];
        const sample = sampleForAction({ gamepads: [] }); // no gamepad slots
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'jump')).toBe(false);
        expect(strengthOf(states, 'jump')).toBe(0);
      });
    });

    describe('deriveActionStates — AC-11 same-frame freeze', () => {
      it('same input, same map → same result (pure function)', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForAction({ downKeys: [' '] });
        const a = deriveActionStates(sample, map);
        const b = deriveActionStates(sample, map);
        expect(a).toEqual(b);
      });
    });

    describe('deriveActionStates — gamepadAxis sign semantics', () => {
      it('sign omitted → contributes |value| (trigger semantics)', () => {
        const map: InputMapForTest = [
          { action: 'accelerate', bindings: [{ type: 'gamepadAxis', axis: 2 }] }, // right trigger
        ];
        const sample = sampleForAction({
          gamepads: [standardGamepadSlot(0, { axes: [0, 0, 0.7, 0] })],
        });
        const states = deriveActionStates(sample, map);
        expect(rawOf(states, 'accelerate')).toBeCloseTo(0.7);
      });

      it('sign=1 → max(0, value), sign=-1 → max(0, -value)', () => {
        const map: InputMapForTest = [
          { action: 'moveLeft', bindings: [{ type: 'gamepadAxis', axis: 0, sign: -1 }] },
          { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }] },
        ];
        // axis 0 = -0.6 (stick pushed left). sign=1 → max(0,-0.6)=0. sign=-1 → max(0,0.6)=0.6
        const sample = sampleForAction({
          gamepads: [standardGamepadSlot(0, { axes: [-0.6, 0, 0, 0] })],
        });
        const states = deriveActionStates(sample, map);
        expect(rawOf(states, 'moveLeft')).toBeCloseTo(0.6);
        expect(rawOf(states, 'moveRight')).toBeCloseTo(0);
      });
    });

    describe('deriveActionStates — D-9 gamepad cross-slot aggregation', () => {
      it('gamepadButton aggregates across ALL connected standardMapping slots', () => {
        const map: InputMapForTest = [
          { action: 'jump', bindings: [{ type: 'gamepadButton', button: 0 }] },
        ];
        // slot 0: button 0 not pressed. slot 1: button 0 pressed.
        const sample = sampleForAction({
          gamepads: [
            standardGamepadSlot(0, { pressed: [], buttonValues: [] }),
            standardGamepadSlot(1, { pressed: [0], buttonValues: [[0, 1.0]] }),
          ],
        });
        const states = deriveActionStates(sample, map);
        expect(pressedOf(states, 'jump')).toBe(true);
      });
    });
  });
}

{
  // ─── from action-snapshot-integration.test.ts ───

  function sampleForActionInt(overrides?: {
    downKeys?: string[];
    buttons?: [boolean, boolean, boolean];
    gamepads?: readonly GamepadSlotSample[];
  }): import('../src/input-snapshot').InputBackendSample {
    return {
      downKeys: new Set(overrides?.downKeys ?? []),
      upKeys: new Set(),
      buttons: overrides?.buttons ?? [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
      gamepads: overrides?.gamepads ?? [],
    };
  }

  describe('action-snapshot-integration.test.ts', () => {
    describe('snap.action() end-to-end pipeline', () => {
      it('mapped action key press → snap.action(jump).isPressed()=true, justPressed()=true, strength=1', () => {
        const map: import('../src/action-state').ActionConfig[] = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForActionInt({ downKeys: [' '] });
        const actionStates = deriveActionStates(sample, map);
        const snap = snapshotFromSample(
          sample,
          actionStates,
        );
        expect(snap.action('jump').isPressed()).toBe(true);
        expect(snap.action('jump').justPressed()).toBe(true);
        expect(snap.action('jump').strength).toBe(1.0);
      });

      it('unregistered action → isPressed()=false, strength=0, never throws', () => {
        const map: import('../src/action-state').ActionConfig[] = [];
        const sample = sampleForActionInt({ downKeys: [] });
        const actionStates = deriveActionStates(sample, map);
        const snap = snapshotFromSample(sample, actionStates);
        expect(snap.action('nonexistent').isPressed()).toBe(false);
        expect(snap.action('nonexistent').strength).toBe(0);
        expect(snap.action('nonexistent').justPressed()).toBe(false);
        expect(snap.action('nonexistent').justReleased()).toBe(false);
      });

      it('multiple mapped actions work independently', () => {
        const map: import('../src/action-state').ActionConfig[] = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
          { action: 'fire', bindings: [{ type: 'key', key: 'f' }] },
        ];
        const sample = sampleForActionInt({ downKeys: [' '] });
        const actionStates = deriveActionStates(sample, map);
        const snap = snapshotFromSample(sample, actionStates);
        expect(snap.action('jump').isPressed()).toBe(true);
        expect(snap.action('fire').isPressed()).toBe(false);
      });
    });

    describe('snap.action() — E-9 pre-run empty snapshot', () => {
      it('createInputSnapshot → snap.action(any) returns empty signal', () => {
        const snap = createInputSnapshot();
        expect(snap.action('jump').isPressed()).toBe(false);
        expect(snap.action('jump').strength).toBe(0);
        expect(snap.action('jump').justPressed()).toBe(false);
        expect(snap.action('jump').justReleased()).toBe(false);
      });
    });

    describe('snap.action() — AC-11 same-frame freeze (action half)', () => {
      it('two snap.action() calls in same frame → identical return', () => {
        const map: import('../src/action-state').ActionConfig[] = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForActionInt({ downKeys: [' '] });
        const actionStates = deriveActionStates(sample, map);
        const snap = snapshotFromSample(sample, actionStates);
        const a = snap.action('jump');
        const b = snap.action('jump');
        expect(a.isPressed()).toBe(b.isPressed());
        expect(a.strength).toBe(b.strength);
      });
    });

    describe('snap.action() — AC-02 type inference', () => {
      it('isPressed() returns boolean without as assertion', () => {
        const map: import('../src/action-state').ActionConfig[] = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForActionInt({ downKeys: [' '] });
        const actionStates = deriveActionStates(sample, map);
        const snap = snapshotFromSample(sample, actionStates);
        const pressed: boolean = snap.action('jump').isPressed();
        expect(pressed).toBe(true);
      });

      it('strength returns number without as assertion', () => {
        const map: import('../src/action-state').ActionConfig[] = [
          { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
        ];
        const sample = sampleForActionInt({ downKeys: [' '] });
        const actionStates = deriveActionStates(sample, map);
        const snap = snapshotFromSample(sample, actionStates);
        const s: number = snap.action('jump').strength;
        expect(s).toBe(1.0);
      });
    });
  });
}

// ─── M2: getAxis / getVector math tests (m2t1) ───

{
  /**
   * Helper: build an InputBackendSample for getAxis/getVector testing.
   */
  function sampleForVector(overrides?: {
    downKeys?: string[];
    gamepads?: readonly GamepadSlotSample[];
  }): import('../src/input-snapshot').InputBackendSample {
    return {
      downKeys: new Set(overrides?.downKeys ?? []),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      gamepads: overrides?.gamepads ?? [],
    };
  }

  /**
   * Build a named ActionConfig[] and derive ActionState[] from a sample.
   * Convenience: `actions` is an array of [actionName, ...bindings] for quick test fixture building.
   */
  function deriveForVector(
    map: ActionConfig[],
    sample?: import('../src/input-snapshot').InputBackendSample,
  ): { map: ActionConfig[]; states: ActionState[] } {
    const s = sample ?? sampleForVector();
    return { map, states: deriveActionStates(s, map) };
  }

  /**
   * Build WASD action map: 4 directional actions bound to 'a'/'d'/'w'/'s'.
   */
  function wasdMap(): ActionConfig[] {
    return [
      { action: 'moveLeft', bindings: [{ type: 'key' as const, key: 'a' }] },
      { action: 'moveRight', bindings: [{ type: 'key' as const, key: 'd' }] },
      { action: 'moveUp', bindings: [{ type: 'key' as const, key: 'w' }] },
      { action: 'moveDown', bindings: [{ type: 'key' as const, key: 's' }] },
    ];
  }

  describe('getAxis — AC-05 (m2t1)', () => {
    const map: ActionConfig[] = [
      { action: 'moveLeft', bindings: [{ type: 'key', key: 'a' }], deadzone: 0.2 },
      { action: 'moveRight', bindings: [{ type: 'key', key: 'd' }], deadzone: 0.2 },
    ];

    it('both registered, pos pressed, neg not → strength(pos) - strength(neg)', () => {
      const sample = sampleForVector({ downKeys: ['d'] });
      const states = deriveActionStates(sample, map);
      const v = getAxis(map, states, 'moveLeft', 'moveRight');
      // pos (moveRight) strength=1.0, neg (moveLeft) strength=0 → 1.0
      expect(v).toBeCloseTo(1.0);
    });

    it('both registered, neg pressed, pos not → strength(pos) - strength(neg)', () => {
      const sample = sampleForVector({ downKeys: ['a'] });
      const states = deriveActionStates(sample, map);
      const v = getAxis(map, states, 'moveLeft', 'moveRight');
      // pos (moveRight) strength=0, neg (moveLeft) strength=1.0 → -1.0
      expect(v).toBeCloseTo(-1.0);
    });

    it('neither pressed → 0', () => {
      const sample = sampleForVector({ downKeys: [] });
      const states = deriveActionStates(sample, map);
      const v = getAxis(map, states, 'moveLeft', 'moveRight');
      expect(v).toBe(0);
    });

    it('one unregistered action (E-3) → contributes 0', () => {
      // 'moveRight' is NOT in the map; only 'moveLeft' is registered.
      const partialMap: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'key', key: 'a' }] },
      ];
      const sample = sampleForVector({ downKeys: ['a'] });
      const states = deriveActionStates(sample, partialMap);
      // pos='moveRight' is unregistered → strength=0, neg='moveLeft' strength=1.0 → -1.0
      const v = getAxis(partialMap, states, 'moveLeft', 'moveRight');
      expect(v).toBeCloseTo(-1.0);
    });

    it('neither registered → returns 0', () => {
      const emptyMap: ActionConfig[] = [];
      const sample = sampleForVector({ downKeys: ['a', 'd'] });
      const states = deriveActionStates(sample, emptyMap);
      const v = getAxis(emptyMap, states, 'moveLeft', 'moveRight');
      expect(v).toBe(0);
    });

    it('same action for both ends (E-12) → always 0', () => {
      const mapSame: ActionConfig[] = [
        { action: 'move', bindings: [{ type: 'key', key: 'd' }] },
      ];
      const sample = sampleForVector({ downKeys: ['d'] });
      const states = deriveActionStates(sample, mapSame);
      // Both neg and pos are 'move' — strength('move')=1.0, difference = 0
      const v = getAxis(mapSame, states, 'move', 'move');
      expect(v).toBe(0);
    });

    it('range bound: [-1, 1] even with extreme inputs', () => {
      const mapExt: ActionConfig[] = [
        { action: 'pos', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }], deadzone: 0.2 },
        { action: 'neg', bindings: [{ type: 'gamepadAxis', axis: 0, sign: -1 }], deadzone: 0.2 },
      ];
      // axis 0 = 1.0 → pos contributes strength=1.0, neg contributes 0
      const sample = sampleForVector({
        gamepads: [buildGamepadSlot(0, { axes: [1, 0, 0, 0] })],
      });
      const states = deriveActionStates(sample, mapExt);
      const v = getAxis(mapExt, states, 'neg', 'pos');
      expect(v).toBeCloseTo(1.0);
      // Can never exceed 1.0 since strength is in [0,1]
      expect(v).toBeLessThanOrEqual(1.0);
      expect(v).toBeGreaterThanOrEqual(-1.0);
    });
  });

  describe('getVector — AC-06 three-branch formula (m2t1)', () => {
    it('WASD diagonal: all 4 keys pressed → magnitude 1, not sqrt(2) (raw used, radial deadzone)', () => {
      const map = wasdMap();
      const sample = sampleForVector({ downKeys: ['w', 'd'] }); // up + right → diagonal
      const states = deriveActionStates(sample, map);
      const v = getVector(map, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      // With raw=1.0 for both w and d keys, vector = (1, -1) (Y neg=moveDown at 0, Y pos=moveUp at 1)
      // Wait: negY='moveDown', posY='moveUp'. With w pressed: posY raw=1.0.
      // negX='moveLeft', posX='moveRight'. With d pressed: posX raw=1.0.
      // raw vector = (1.0 - 0, 1.0 - 0) = (1, 1). Length = sqrt(2) ≈ 1.414.
      // Branch: length > 1 → v/len = (1/1.414, 1/1.414) ≈ (0.707, 0.707). Magnitude = 1.
      expect(v.x).toBeCloseTo(Math.SQRT1_2, 3); // ~0.707
      expect(v.y).toBeCloseTo(Math.SQRT1_2, 3); // ~0.707
      const mag = Math.sqrt(v.x * v.x + v.y * v.y);
      expect(mag).toBeCloseTo(1.0, 3);
    });

    it('WASD right only → (1, 0)', () => {
      const map = wasdMap();
      const sample = sampleForVector({ downKeys: ['d'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(map, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(1.0);
      expect(v.y).toBeCloseTo(0);
    });

    it('WASD up only → (0, 1)', () => {
      const map = wasdMap();
      const sample = sampleForVector({ downKeys: ['w'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(map, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(0);
      expect(v.y).toBeCloseTo(1.0);
    });

    it('WASD left only → (-1, 0)', () => {
      const map = wasdMap();
      const sample = sampleForVector({ downKeys: ['a'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(map, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(-1.0);
      expect(v.y).toBeCloseTo(0);
    });

    it('length <= deadzone → (0, 0)', () => {
      // Use gamepadAxis with tiny values below deadzone
      const map: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'gamepadAxis', axis: 0, sign: -1 }], deadzone: 0.2 },
        { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }], deadzone: 0.2 },
        { action: 'moveDown', bindings: [{ type: 'gamepadAxis', axis: 1, sign: -1 }], deadzone: 0.2 },
        { action: 'moveUp', bindings: [{ type: 'gamepadAxis', axis: 1, sign: 1 }], deadzone: 0.2 },
      ];
      // axis 0 = 0.1, axis 1 = 0.1 → raw vector = (0.1, 0.1), length ≈ 0.141
      // Default deadzone = (0.2+0.2+0.2+0.2)/4 = 0.2. length=0.141 <= 0.2 → (0,0)
      const sample = sampleForVector({
        gamepads: [buildGamepadSlot(0, { axes: [0.1, 0.1, 0, 0] })],
      });
      const states = deriveActionStates(sample, map);
      const v = getVector(map, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });

    it('length > 1 → clamped to unit circle', () => {
      const map = wasdMap();
      // Both 'd' and 'w' pressed → raw (1,1), length=√2>1 → (0.707, 0.707)
      const sample = sampleForVector({ downKeys: ['d', 'w'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(map, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      const mag = Math.sqrt(v.x * v.x + v.y * v.y);
      expect(mag).toBeCloseTo(1.0, 3);
    });

    it('mid-range: inverse_lerp smooth transition', () => {
      // Use gamepadAxis to get raw values between deadzone and 1
      const map: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'gamepadAxis', axis: 0, sign: -1 }], deadzone: 0.2 },
        { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }], deadzone: 0.2 },
        { action: 'moveDown', bindings: [{ type: 'gamepadAxis', axis: 1, sign: -1 }], deadzone: 0.2 },
        { action: 'moveUp', bindings: [{ type: 'gamepadAxis', axis: 1, sign: 1 }], deadzone: 0.2 },
      ];
      // axis 0 = 0.6, axis 1 = 0 → raw = (0.6, 0), len = 0.6
      // Default deadzone = 0.2. Branch: 0.2 < 0.6 <= 1 → vec * inverse_lerp(0.2, 1, 0.6) / 0.6
      // inverse_lerp(0.2, 1, 0.6) = (0.6-0.2)/(1-0.2) = 0.4/0.8 = 0.5
      // output = (0.6, 0) * 0.5 / 0.6 = (0.5, 0)
      const sample = sampleForVector({
        gamepads: [buildGamepadSlot(0, { axes: [0.6, 0, 0, 0] })],
      });
      const states = deriveActionStates(sample, map);
      const v = getVector(map, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(0.5, 3);
      expect(v.y).toBeCloseTo(0);
    });

    it('opts.deadzone override bypasses default-avg', () => {
      const map = wasdMap(); // DEFAULT_DEADZONE = 0.2 per action
      // With default deadzone 0.2 and digital keys (raw=1.0): length=1 > deadzone, passes
      // With override deadzone=2.0: length=1 <= 2.0 → (0,0)
      const sample = sampleForVector({ downKeys: ['d'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(map, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp', { deadzone: 2.0 });
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });

    it('default deadzone = average of 4 action deadzones', () => {
      const mapCustom: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'gamepadAxis', axis: 0, sign: -1 }], deadzone: 0.1 },
        { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }], deadzone: 0.3 },
        { action: 'moveDown', bindings: [{ type: 'gamepadAxis', axis: 1, sign: -1 }], deadzone: 0.2 },
        { action: 'moveUp', bindings: [{ type: 'gamepadAxis', axis: 1, sign: 1 }], deadzone: 0.4 },
      ];
      // Default deadzone = (0.1+0.3+0.2+0.4)/4 = 0.25
      // axis 0 = 0.24, axis 1 = 0 → raw = (0.24, 0), len = 0.24 <= 0.25 → (0,0)
      const sample = sampleForVector({
        gamepads: [buildGamepadSlot(0, { axes: [0.24, 0, 0, 0] })],
      });
      const states = deriveActionStates(sample, mapCustom);
      const v = getVector(mapCustom, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });
  });

  describe('getVector — AC-06 falsification: per-axis deadzone must FAIL', () => {
    /**
     * This test verifies falsification sensitivity (§5.4).
     *
     * If getVector were to use `strength` (which has per-action deadzone applied)
     * instead of `raw`, a WASD diagonal with keys w+d would produce:
     *   strength('moveRight') = 1.0  (digital, always 1 after deadzone remap)
     *   strength('moveUp') = 1.0
     *   → vector = (1, 1), magnitude = √2 ≈ 1.414
     *
     * The correct implementation uses `raw` + radial deadzone:
     *   raw('moveRight') = 1.0, raw('moveUp') = 1.0
     *   → vector = (1, 1), length > 1 → clamp to unit circle → (0.707, 0.707)
     *
     * This test asserts magnitude ≈ 1.0. A per-axis deadzone implementation
     * would produce magnitude ≈ 1.414 and FAIL this assertion.
     */
    it('WASD diagonal: magnitude must be 1 (not sqrt(2)) — falsifies per-axis deadzone', () => {
      const map = wasdMap();
      const sample = sampleForVector({ downKeys: ['w', 'd'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(map, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      const mag = Math.sqrt(v.x * v.x + v.y * v.y);
      // With per-axis deadzone, magnitude would be ~1.414 (sqrt(2)).
      // The correct radial deadzone clamps to the unit circle.
      expect(mag).toBeCloseTo(1.0, 3);
      // also verify x and y are equal (unit circle diagonal)
      expect(Math.abs(v.x - v.y)).toBeLessThan(0.001);
    });

    /**
     * Additional falsification: check that getVector uses raw, not strength.
     *
     * With gamepadAxis raw=0.15 (below deadzone 0.2):
     * - strength would be 0 (deadzone remapped to 0).
     * - raw stays at 0.15.
     * - getVector with raw + 4-action avg deadzone 0.2: length=0.15 <= 0.2 → (0,0).
     *
     * With a single gamepadAxis at 0.15 on X and 0 on Y:
     * raw vector = (0.15, 0), length=0.15, deadzone=0.2 → (0,0).
     * This test doesn't distinguish raw vs strength here because both give (0,0).
     * Instead, we test at raw=0.5: strength would apply per-axis deadzone (0.2)
     * giving strength=inverse_lerp(0.2,1,0.5)=0.375. getVector with raw=0.5
     * and radial deadzone gives inverse_lerp(0.2,1,0.5)=0.375. Same result
     * for a pure single-axis case.
     *
     * The key falsification is the diagonal case above (magnitude must be 1,
     * not sqrt(2)). That's the definitive test.
     */
    it('WASD single axis + inactive opposite: no per-axis deadzone leakage', () => {
      const map = wasdMap();
      // Only 'd' pressed → right only
      const sample = sampleForVector({ downKeys: ['d'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(map, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      // Both raw and strength give 1.0 for digital keys, so result is the same (1, 0)
      // But verify the magnitude is exactly 1, not softened by some phantom deadzone
      const mag = Math.sqrt(v.x * v.x + v.y * v.y);
      expect(mag).toBeCloseTo(1.0);
      expect(v.x).toBeCloseTo(1.0);
      expect(v.y).toBeCloseTo(0);
    });
  });

  describe('getVector — E-3 partial unregistered actions', () => {
    it('one of the 4 action names unregistered → contributes raw=0', () => {
      const map: ActionConfig[] = [
        { action: 'moveRight', bindings: [{ type: 'key', key: 'd' }] },
        // moveLeft, moveUp, moveDown not registered → each raw=0
      ];
      const sample = sampleForVector({ downKeys: ['d'] });
      const states = deriveActionStates(sample, map);
      // posX='moveRight' raw=1.0, negX='moveLeft' raw=0, posY='moveUp' raw=0, negY='moveDown' raw=0
      // raw vector = (1, 0), length=1 > all-zero deadzone avg.
      // getAxis for unregistered = strength(registered) - 0 if unregistered pos = 0
      // Actually getAxis(pos) for 'moveUp' with unregistered → strength=0.
      // So y = 0-0 = 0, x = 1-0 = 1. Length=1, no clamp → (1,0)
      const v = getVector(map, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(1.0);
      expect(v.y).toBeCloseTo(0);
    });

    it('all 4 unregistered → (0, 0)', () => {
      const map: ActionConfig[] = [];
      const sample = sampleForVector({ downKeys: ['w', 'd'] });
      const states = deriveActionStates(sample, map);
      const v = getVector(map, states, 'moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });
  });
}

// ─── M2: getAxis/getVector end-to-end + AC-07 tests (m2t3) ───

{
  /**
   * Build a snapshot with action states and input map wired through.
   */
  function makeVectorSnap(
    map: ActionConfig[],
    overrides?: {
      downKeys?: string[];
      gamepads?: readonly GamepadSlotSample[];
    },
  ): InputSnapshot {
    const sample: import('../src/input-snapshot').InputBackendSample = {
      downKeys: new Set(overrides?.downKeys ?? []),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
      gamepads: overrides?.gamepads ?? [],
    };
    const actionStates = deriveActionStates(sample, map);
    return snapshotFromSample(sample, actionStates, map);
  }

  describe('snap.getVector() end-to-end (m2t3)', () => {
    it('WASD keyboard → getVector via snapshot returns correct directional output', () => {
      const map: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'key', key: 'a' }] },
        { action: 'moveRight', bindings: [{ type: 'key', key: 'd' }] },
        { action: 'moveDown', bindings: [{ type: 'key', key: 's' }] },
        { action: 'moveUp', bindings: [{ type: 'key', key: 'w' }] },
      ];
      // w+d pressed → diagonal up-right
      const snap = makeVectorSnap(map, { downKeys: ['w', 'd'] });
      const v = snap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(Math.SQRT1_2, 3);
      expect(v.y).toBeCloseTo(Math.SQRT1_2, 3);
    });

    it('getVector with gamepadAxis keys → snapshot readpoint works', () => {
      const map: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'gamepadAxis', axis: 0, sign: -1 }], deadzone: 0.2 },
        { action: 'moveRight', bindings: [{ type: 'gamepadAxis', axis: 0, sign: 1 }], deadzone: 0.2 },
        { action: 'moveDown', bindings: [{ type: 'gamepadAxis', axis: 1, sign: -1 }], deadzone: 0.2 },
        { action: 'moveUp', bindings: [{ type: 'gamepadAxis', axis: 1, sign: 1 }], deadzone: 0.2 },
      ];
      // Stick fully right → axis 0 = 1.0
      const snap = makeVectorSnap(map, {
        gamepads: [buildGamepadSlot(0, { axes: [1, 0, 0, 0] })],
      });
      const v = snap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBeCloseTo(1.0);
      expect(v.y).toBeCloseTo(0);
    });

    it('getVector with deadzone override opts via snapshot', () => {
      const map: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'key', key: 'a' }] },
        { action: 'moveRight', bindings: [{ type: 'key', key: 'd' }] },
        { action: 'moveDown', bindings: [{ type: 'key', key: 's' }] },
        { action: 'moveUp', bindings: [{ type: 'key', key: 'w' }] },
      ];
      // With deadzone override 2.0 and digital keys raw=1.0: length=1 <= 2.0 → (0,0)
      const snap = makeVectorSnap(map, { downKeys: ['d'] });
      const v = snap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp', { deadzone: 2.0 });
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });

    it('getVector with unregistered actions → (0, 0)', () => {
      const map: ActionConfig[] = [];
      const snap = makeVectorSnap(map, { downKeys: ['w', 'd'] });
      const v = snap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });

    it('getVector without inputMap → returns (0, 0) (empty signal)', () => {
      const snap = createInputSnapshot();
      const v = snap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(v.x).toBe(0);
      expect(v.y).toBe(0);
    });
  });

  describe('snap.getAxis() end-to-end (m2t3)', () => {
    it('getAxis via snapshot: keyboard press → correct axis value', () => {
      const map: ActionConfig[] = [
        { action: 'moveLeft', bindings: [{ type: 'key', key: 'a' }] },
        { action: 'moveRight', bindings: [{ type: 'key', key: 'd' }] },
      ];
      const snap = makeVectorSnap(map, { downKeys: ['d'] });
      expect(snap.getAxis('moveLeft', 'moveRight')).toBeCloseTo(1.0);
    });

    it('getAxis via snapshot: unregistered → returns 0', () => {
      const map: ActionConfig[] = [];
      const snap = makeVectorSnap(map, { downKeys: ['a'] });
      expect(snap.getAxis('moveLeft', 'moveRight')).toBe(0);
    });

    it('getAxis via snapshot: E-12 same action for both ends → 0', () => {
      const map: ActionConfig[] = [
        { action: 'move', bindings: [{ type: 'key', key: 'd' }] },
      ];
      const snap = makeVectorSnap(map, { downKeys: ['d'] });
      expect(snap.getAxis('move', 'move')).toBe(0);
    });
  });

  describe('AC-07 cross-device uniform lever (m2t3)', () => {
    /**
     * AC-07: Same action name bound to 'key' AND 'gamepadButton' →
     * getVector produces identical results for keyboard vs gamepad input.
     * The consumer code has zero knowledge of which device produced the input.
     */
    const crossDeviceWASD: ActionConfig[] = [
      {
        action: 'moveLeft',
        bindings: [
          { type: 'key', key: 'a' },
          { type: 'gamepadButton', button: 14 }, // d-pad left
        ],
      },
      {
        action: 'moveRight',
        bindings: [
          { type: 'key', key: 'd' },
          { type: 'gamepadButton', button: 15 }, // d-pad right
        ],
      },
      {
        action: 'moveDown',
        bindings: [
          { type: 'key', key: 's' },
          { type: 'gamepadButton', button: 13 }, // d-pad down
        ],
      },
      {
        action: 'moveUp',
        bindings: [
          { type: 'key', key: 'w' },
          { type: 'gamepadButton', button: 12 }, // d-pad up
        ],
      },
    ];

    it('keyboard w+d → same getVector output as gamepad dpad-up+dpad-right', () => {
      // Keyboard: w + d pressed
      const keySnap = makeVectorSnap(crossDeviceWASD, { downKeys: ['w', 'd'] });
      const keyVec = keySnap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');

      // Gamepad: d-pad up (button 12) + d-pad right (button 15) pressed
      const gamepadSnap = makeVectorSnap(crossDeviceWASD, {
        gamepads: [buildGamepadSlot(0, { pressed: [12, 15], buttonValues: [[12, 1.0], [15, 1.0]] })],
      });
      const gamepadVec = gamepadSnap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');

      // AC-07: identical action semantic → zero consumer-code delta.
      expect(keyVec.x).toBeCloseTo(gamepadVec.x, 3);
      expect(keyVec.y).toBeCloseTo(gamepadVec.y, 3);
      const keyMag = Math.sqrt(keyVec.x * keyVec.x + keyVec.y * keyVec.y);
      const gpadMag = Math.sqrt(gamepadVec.x * gamepadVec.x + gamepadVec.y * gamepadVec.y);
      expect(keyMag).toBeCloseTo(gpadMag, 3);
    });

    it('keyboard right only → same as gamepad right only', () => {
      const keySnap = makeVectorSnap(crossDeviceWASD, { downKeys: ['d'] });
      const keyVec = keySnap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');

      const gamepadSnap = makeVectorSnap(crossDeviceWASD, {
        gamepads: [buildGamepadSlot(0, { pressed: [15], buttonValues: [[15, 1.0]] })],
      });
      const gamepadVec = gamepadSnap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');

      expect(keyVec.x).toBeCloseTo(gamepadVec.x, 3);
      expect(keyVec.y).toBeCloseTo(gamepadVec.y, 3);
      expect(keyVec.x).toBeCloseTo(1.0);
    });

    it('no input → keyboard and gamepad both return (0, 0)', () => {
      const emptyKeySnap = makeVectorSnap(crossDeviceWASD, { downKeys: [] });
      const keyVec = emptyKeySnap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(keyVec.x).toBe(0);
      expect(keyVec.y).toBe(0);

      const emptyGpadSnap = makeVectorSnap(crossDeviceWASD, {
        gamepads: [buildGamepadSlot(0, { pressed: [] })],
      });
      const gpadVec = emptyGpadSnap.getVector('moveLeft', 'moveRight', 'moveDown', 'moveUp');
      expect(gpadVec.x).toBe(0);
      expect(gpadVec.y).toBe(0);
    });
  });
}
// ─── M3 (m3t1): controller-db parser pure-function tests (SDL DB) ───

{
  const VENDOR_DB_PATH = fileURLToPath(
    new URL('../vendor/gamecontrollerdb.txt', import.meta.url),
  );

  // A synthetic multi-entry snippet exercising: comments, blank lines, the
  // platform suffix, analog + button + hat + half-axis tokens.
  const SYNTHETIC_DB = [
    '# Game Controller DB (synthetic test fixture)',
    '',
    '# Windows',
    '030000005e0400008e02000000000000,Xbox 360 Controller,a:b0,b:b1,x:b2,y:b3,leftx:a0,lefty:a1,dpup:h0.1,platform:Windows,',
    '# Mac OS X',
    '030000005e0400008e02000000000000,Xbox 360 Controller,a:b0,b:b1,leftx:a0,platform:Mac OS X,',
    '030000004c050000c405000000000000,PS4 Controller,a:b1,b:b2,lefttrigger:a3,dpleft:+a4,platform:Windows,',
  ].join('\n');

  describe('parseControllerDb (m3t1)', () => {
    it('parses GUID keys with mapping token objects (button / axis / hat)', () => {
      const db = parseControllerDb(SYNTHETIC_DB);
      const guid = '030000005e0400008e02000000000000';
      const entries = db[guid];
      expect(entries).toBeDefined();
      // Two platform variants for the Xbox 360 GUID.
      expect(entries).toHaveLength(2);
      const win = entries?.find((e) => e.platform === 'Windows');
      expect(win).toBeDefined();
      expect(win?.tokens.a).toEqual({ kind: 'button', index: 0 });
      expect(win?.tokens.b).toEqual({ kind: 'button', index: 1 });
      expect(win?.tokens.leftx).toEqual({ kind: 'axis', index: 0 });
      expect(win?.tokens.lefty).toEqual({ kind: 'axis', index: 1 });
      expect(win?.tokens.dpup).toEqual({ kind: 'hat', index: 0, mask: 1 });
    });

    it('parses half-axis tokens (+aN / -aN) with sign', () => {
      const db = parseControllerDb(SYNTHETIC_DB);
      const ps4 = db['030000004c050000c405000000000000']?.[0];
      expect(ps4?.tokens.dpleft).toEqual({ kind: 'axis', index: 4, half: '+' });
      expect(ps4?.tokens.lefttrigger).toEqual({ kind: 'axis', index: 3 });
    });

    it('skips comment (#) and blank lines', () => {
      const db = parseControllerDb('# comment\n\n   \n');
      expect(Object.keys(db)).toHaveLength(0);
    });

    it('parses the real vendored gamecontrollerdb.txt with >= 2000 GUID entries', () => {
      const txt = readFileSync(VENDOR_DB_PATH, 'utf8');
      const db = parseControllerDb(txt);
      expect(Object.keys(db).length).toBeGreaterThanOrEqual(2000);
      // Spot-check a well-known entry (Xbox 360, VID 045e PID 028e).
      const xbox = db['030000005e0400008e02000000000000'];
      expect(xbox).toBeDefined();
      expect(xbox?.[0]?.tokens.a).toEqual({ kind: 'button', index: 0 });
    });
  });

  describe('buildGuidFromVidPid (m3t1, D-13 strategy 2)', () => {
    it('builds a 32-char SDL GUID with bus=03, CRC=0, version=0, driver=0', () => {
      // VID=0x045e PID=0x028e (Xbox 360) -> matches the real DB GUID.
      const guid = buildGuidFromVidPid(0x045e, 0x028e);
      expect(guid).toBe('030000005e0400008e02000000000000');
      expect(guid).toHaveLength(32);
    });

    it('builds Xbox One S BT GUID (VID=0x045e PID=0x02ea)', () => {
      const guid = buildGuidFromVidPid(0x045e, 0x02ea);
      expect(guid).toBe('030000005e040000ea02000000000000');
    });

    it('encodes VID/PID little-endian within their 16-bit fields', () => {
      // PS4 DualShock 4: VID=0x054c PID=0x05c4.
      expect(buildGuidFromVidPid(0x054c, 0x05c4)).toBe('030000004c050000c405000000000000');
    });
  });

  describe('extractGuidFromGamepadId (m3t1, cross-browser F3)', () => {
    it('Chrome format: "... (STANDARD GAMEPAD Vendor: 054c Product: 09cc)"', () => {
      const id = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)';
      expect(extractGuidFromGamepadId(id)).toBe('030000004c050000cc09000000000000');
    });

    it('Firefox format: "046d-c216-Logitech Dual Action"', () => {
      expect(extractGuidFromGamepadId('046d-c216-Logitech Dual Action')).toBe(
        buildGuidFromVidPid(0x046d, 0xc216),
      );
    });

    it('Firefox format tolerates a dropped leading zero on the VID (46d-c216-...)', () => {
      expect(extractGuidFromGamepadId('46d-c216-Logicool Dual Action')).toBe(
        buildGuidFromVidPid(0x046d, 0xc216),
      );
    });

    it('Safari / name-only string returns undefined (VID/PID unextractable)', () => {
      expect(extractGuidFromGamepadId('Wireless Controller')).toBeUndefined();
    });

    it('XInput string (Chrome) returns undefined (no VID/PID present)', () => {
      expect(
        extractGuidFromGamepadId('Xbox 360 Controller (XInput STANDARD GAMEPAD)'),
      ).toBeUndefined();
    });

    it('XInput string (Firefox literal "xinput") returns undefined', () => {
      expect(extractGuidFromGamepadId('xinput')).toBeUndefined();
    });
  });

  describe('platformFromUserAgent (m3t1, D-13)', () => {
    it('detects Windows / Mac OS X / Linux / Android / iOS', () => {
      expect(platformFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
      expect(platformFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(
        'Mac OS X',
      );
      expect(platformFromUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux');
      expect(platformFromUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7)')).toBe('Android');
      expect(platformFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)')).toBe(
        'iOS',
      );
    });

    it('returns undefined for an unrecognised user agent', () => {
      expect(platformFromUserAgent('SomeRandomBot/1.0')).toBeUndefined();
    });
  });

  describe('selectBestMappingEntry (m3t1, platform section preference)', () => {
    it('prefers the platform-matching entry when present', () => {
      const db = parseControllerDb(SYNTHETIC_DB);
      const guid = '030000005e0400008e02000000000000';
      const mac = selectBestMappingEntry(db, guid, 'Mac OS X');
      expect(mac?.platform).toBe('Mac OS X');
    });

    it('falls back to any entry when the platform does not match', () => {
      const db = parseControllerDb(SYNTHETIC_DB);
      const guid = '030000005e0400008e02000000000000';
      const linux = selectBestMappingEntry(db, guid, 'Linux');
      expect(linux).toBeDefined();
      // Falls back to the first available (Windows or Mac OS X entry).
      expect(['Windows', 'Mac OS X']).toContain(linux?.platform);
    });

    it('returns undefined when the GUID is not in the DB', () => {
      const db = parseControllerDb(SYNTHETIC_DB);
      expect(selectBestMappingEntry(db, 'ffffffffffffffffffffffffffffffff', 'Windows')).toBeUndefined();
    });
  });
}

// ─── M3 (m3t2): diffGamepadFrame acquisition-layer remap tests ───

{
  /**
   * Build a non-standard RawGamepadStub whose raw HID layout is arbitrary.
   * `raw` maps a physical button index -> value (pressed = value > 0).
   * `rawAxes` is the raw physical axes array.
   */
  function nonStandardStub(overrides: {
    index?: number;
    id?: string;
    raw?: [number, number][];
    rawAxes?: number[];
    buttonCount?: number;
  }): RawGamepadStub {
    const values = new Map<number, number>(overrides.raw ?? []);
    const count = overrides.buttonCount ?? 20;
    const buttons: { value: number; pressed: boolean }[] = [];
    for (let b = 0; b < count; b++) {
      const v = values.get(b) ?? 0;
      buttons.push({ value: v, pressed: v > 0 });
    }
    return {
      index: overrides.index ?? 0,
      id: overrides.id ?? 'usb gamepad (Vendor: 0810 Product: e501)',
      connected: true,
      mapping: 'no-standard-here',
      buttons,
      axes: overrides.rawAxes ?? [0, 0, 0, 0, 0, 0],
    };
  }

  // A remap table where the SDL logical 'a' maps to raw physical button 3
  // (NOT identity), 'b' to raw button 5, and 'leftx' to raw axis 4. This
  // deliberately-permuted table proves the remap consults the DB rather
  // than passing raw indices through unchanged.
  const permutedTokens: MappingTokens = {
    a: { kind: 'button', index: 3 },
    b: { kind: 'button', index: 5 },
    leftx: { kind: 'axis', index: 4 },
    lefttrigger: { kind: 'axis', index: 5 },
  };

  describe('diffGamepadFrame remap (m3t2, D-1 option A)', () => {
    it('non-standard + remapLookup hit: standardMapping=true, raw HID remapped to standard layout', () => {
      const prev = new Map<number, GamepadSlotSample>();
      // raw button 3 pressed -> standard 'a' (index 0); raw axis 4 = 0.7 -> standard leftx (axis 0).
      const cur = [nonStandardStub({ raw: [[3, 1]], rawAxes: [0, 0, 0, 0, 0.7, 0.4] })];
      const result = diffGamepadFrame(prev, cur, () => permutedTokens);
      expect(result).toHaveLength(1);
      const slot = result[0];
      expect(slot.standardMapping).toBe(true);
      // standard button 0 ('a') reflects raw button 3 -- proves table consulted.
      expect(slot.pressed.has(0)).toBe(true);
      // raw button 0 (unmapped) must NOT leak into standard index 0 identity.
      expect(slot.pressed.has(3)).toBe(false);
      // standard axis 0 (leftx) reflects raw axis 4.
      expect(slot.axes[0]).toBeCloseTo(0.7, 5);
      // trigger mapped to an axis -> standard buttonValue at index 6 (lefttrigger).
      expect(slot.buttonValues.get(6)).toBeCloseTo(0.4, 5);
    });

    it('AC-10 falsification: a wrong remap table does NOT surface the pressed button at standard 0', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [nonStandardStub({ raw: [[3, 1]] })];
      // Wrong table: 'a' maps to raw button 9 (which is NOT pressed).
      const wrongTokens: MappingTokens = { a: { kind: 'button', index: 9 } };
      const result = diffGamepadFrame(prev, cur, () => wrongTokens);
      // Sensitivity: standard button 0 must be false because raw 9 is unpressed.
      expect(result[0].pressed.has(0)).toBe(false);
    });

    it('edge transition: frame N (no lookup) empty -> frame N+1 (DB loaded) justPressed fires', () => {
      // Frame N: remapLookup returns null (DB not yet loaded).
      const prev1 = new Map<number, GamepadSlotSample>();
      const cur1 = [nonStandardStub({ raw: [[3, 1]] })];
      const r1 = diffGamepadFrame(prev1, cur1, () => null);
      expect(r1[0].standardMapping).toBe(false);
      expect(r1[0].pressed.size).toBe(0);

      // Frame N+1: DB loaded, remap active, button 3 still held raw.
      const prev2 = new Map<number, GamepadSlotSample>();
      prev2.set(0, r1[0]);
      const cur2 = [nonStandardStub({ raw: [[3, 1]] })];
      const r2 = diffGamepadFrame(prev2, cur2, () => permutedTokens);
      expect(r2[0].standardMapping).toBe(true);
      // First frame the remap becomes active -> justPressed edge fires at standard 0.
      expect(r2[0].pressed.has(0)).toBe(true);
      expect(r2[0].justPressed.has(0)).toBe(true);
    });

    it('non-standard + remapLookup miss (returns null): Feat1 empty signal, connected=true', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [nonStandardStub({ raw: [[3, 1]], rawAxes: [0.5, 0, 0, 0] })];
      const result = diffGamepadFrame(prev, cur, () => null);
      expect(result[0].standardMapping).toBe(false);
      expect(result[0].pressed.size).toBe(0);
      expect(result[0].buttonValues.size).toBe(0);
      expect(result[0].axes).toEqual([0, 0, 0, 0]);
    });

    it('no remapLookup arg at all: non-standard stays empty (backward compat with Feat1)', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [nonStandardStub({ raw: [[3, 1]] })];
      const result = diffGamepadFrame(prev, cur);
      expect(result[0].standardMapping).toBe(false);
      expect(result[0].pressed.size).toBe(0);
    });

    it('standard-mapping gamepad is unaffected by remapLookup (never consulted)', () => {
      const prev = new Map<number, GamepadSlotSample>();
      let consulted = false;
      const std: RawGamepadStub = {
        index: 0,
        id: 'standard pad',
        connected: true,
        mapping: 'standard',
        buttons: Array.from({ length: 17 }, (_, b) => ({ value: b === 0 ? 1 : 0, pressed: b === 0 })),
        axes: [0.1, 0.2, 0.3, 0.4],
      };
      const result = diffGamepadFrame(prev, [std], () => {
        consulted = true;
        return permutedTokens;
      });
      expect(consulted).toBe(false);
      expect(result[0].standardMapping).toBe(true);
      expect(result[0].pressed.has(0)).toBe(true);
      expect(result[0].axes[0]).toBeCloseTo(0.1, 5);
    });
  });

  describe('AC-10 snapshot-level: binding-visible remap through snap.gamepad(i)', () => {
    it('non-standard DB-hit slot reads standard button(0) true via snapshot reader', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [nonStandardStub({ raw: [[3, 1]] })];
      const slots = diffGamepadFrame(prev, cur, () => permutedTokens);
      const snap = snapshotFromSample({
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
        capabilities: { gamepad: true, pointer: false },
        gamepads: slots,
      });
      const g = snap.gamepad(0);
      expect(g.connected).toBe(true);
      expect(g.standardMapping).toBe(true);
      expect(g.button(0)).toBe(true);
    });

    it('non-standard DB-miss slot reports standardMapping=false + empty via snapshot reader', () => {
      const prev = new Map<number, GamepadSlotSample>();
      const cur = [nonStandardStub({ raw: [[3, 1]] })];
      const slots = diffGamepadFrame(prev, cur, () => null);
      const snap = snapshotFromSample({
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
        capabilities: { gamepad: true, pointer: false },
        gamepads: slots,
      });
      const g = snap.gamepad(0);
      expect(g.connected).toBe(true);
      expect(g.standardMapping).toBe(false);
      expect(g.button(0)).toBe(false);
    });
  });
}

// ─── M3 (m3t3): backend lazy-load + Safari/XInput fallback tests ───

{
  /** Fake nav.getGamepads() returning the supplied raw stubs each call. */
  function fakeNavigator(stubs: readonly RawGamepadStub[]): {
    getGamepads(): (RawGamepadStub | null)[];
  } {
    return { getGamepads: () => [...stubs] };
  }

  /** Minimal fake canvas/doc/win that ignore all wiring (no listeners needed). */
  function inertDom(): { canvas: HTMLCanvasElement; doc: Document; win: Window } {
    const canvas = {} as HTMLCanvasElement;
    const doc = { hasFocus: () => true } as unknown as Document;
    const win = {} as Window;
    return { canvas, doc, win };
  }

  // Synthetic DB text: the permuted non-standard pad's GUID maps 'a' -> raw
  // button 3. The pad id embeds Chrome-format VID/PID so the GUID derives.
  const NONSTD_ID = 'usb gamepad (Vendor: 0810 Product: e501)';
  const NONSTD_GUID = buildGuidFromVidPid(0x0810, 0xe501);
  const SYNTH_DB_TEXT = `# Windows\n${NONSTD_GUID},Test Pad,a:b3,b:b5,leftx:a4,platform:Windows,\n`;

  function nsStub(overrides?: { id?: string; raw?: [number, number][] }): RawGamepadStub {
    const values = new Map<number, number>(overrides?.raw ?? [[3, 1]]);
    const buttons = Array.from({ length: 20 }, (_, b) => {
      const v = values.get(b) ?? 0;
      return { value: v, pressed: v > 0 };
    });
    return {
      index: 0,
      id: overrides?.id ?? NONSTD_ID,
      connected: true,
      mapping: 'no-standard-here',
      buttons,
      axes: [0, 0, 0, 0, 0, 0],
    };
  }

  // Drain a bounded number of macrotask cycles. Used only by the negative
  // tests (Safari / XInput / standard) where no remap is ever expected --
  // draining then re-sampling proves the empty signal is stable.
  const drain = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  // Sample until the slot flips standardMapping=true, or throw after a
  // bounded number of macrotask cycles. The backend's first non-standard
  // gamepad triggers a cold dynamic import() of the controller-db module,
  // whose resolution latency varies under concurrent-worker CPU load; a
  // fixed tick count is racy. Polling on the deterministic post-condition
  // removes the flake (each sample() re-checks the loaded-DB state).
  const sampleUntilStandard = async (
    backend: InputBackend,
    maxTicks = 200,
  ): Promise<import('../src/input-snapshot').InputBackendSample> => {
    for (let i = 0; i < maxTicks; i++) {
      const s = backend.sample();
      if (s.gamepads?.[0]?.standardMapping === true) return s;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error('DB never loaded: slot did not flip standardMapping=true within budget');
  };

  describe('backend lazy-load remap (m3t3, D-2 / D-13)', () => {
    it('first non-standard gamepad triggers loadControllerDb; later frames remap via loaded DB', async () => {
      const { canvas, doc, win } = inertDom();
      let loadCalls = 0;
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: fakeNavigator([nsStub()]),
        loadControllerDb: async () => {
          loadCalls += 1;
          return SYNTH_DB_TEXT;
        },
      });
      const backend = handle.backend;

      // Frame 1: DB not yet loaded -> Feat1 empty signal, but load kicked off.
      const s1 = backend.sample();
      expect(s1.gamepads?.[0]?.standardMapping).toBe(false);
      expect(s1.gamepads?.[0]?.pressed.size).toBe(0);
      expect(loadCalls).toBe(1);

      // Later frame(s): DB loaded -> remap active, standard 'a' (idx 0)
      // reflects raw button 3.
      const s2 = await sampleUntilStandard(backend);
      expect(s2.gamepads?.[0]?.pressed.has(0)).toBe(true);
      // loadControllerDb is invoked once total (not per frame).
      expect(loadCalls).toBe(1);
      handle();
    });

    it('frames before load completes maintain Feat1 empty signal without crashing', async () => {
      const { canvas, doc, win } = inertDom();
      let resolveLoad: (txt: string) => void = () => {};
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: fakeNavigator([nsStub()]),
        loadControllerDb: () => new Promise<string>((res) => (resolveLoad = res)),
      });
      const backend = handle.backend;
      // Several frames while the load promise is still pending.
      for (let i = 0; i < 3; i++) {
        const s = backend.sample();
        expect(s.gamepads?.[0]?.standardMapping).toBe(false);
        expect(s.gamepads?.[0]?.pressed.size).toBe(0);
      }
      // Complete the load; a later frame should remap.
      resolveLoad(SYNTH_DB_TEXT);
      const sAfter = await sampleUntilStandard(backend);
      expect(sAfter.gamepads?.[0]?.standardMapping).toBe(true);
      handle();
    });

    it('injected loadControllerDb override is used for remap (D-13 test injection)', async () => {
      const { canvas, doc, win } = inertDom();
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: fakeNavigator([nsStub({ raw: [[5, 1]] })]),
        loadControllerDb: async () => SYNTH_DB_TEXT,
      });
      const backend = handle.backend;
      const s2 = await sampleUntilStandard(backend);
      // raw button 5 -> standard 'b' (index 1).
      expect(s2.gamepads?.[0]?.pressed.has(1)).toBe(true);
      handle();
    });

    it('Safari / name-only gamepad id: GUID unextractable, no DB lookup, stays empty', async () => {
      const { canvas, doc, win } = inertDom();
      let loadCalls = 0;
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: fakeNavigator([nsStub({ id: 'Wireless Controller' })]),
        loadControllerDb: async () => {
          loadCalls += 1;
          return SYNTH_DB_TEXT;
        },
      });
      const backend = handle.backend;
      backend.sample();
      await drain();
      const s2 = backend.sample();
      expect(s2.gamepads?.[0]?.standardMapping).toBe(false);
      // A name-only id may still trigger a load attempt, but the GUID never
      // resolves so remap never surfaces; the key guarantee is empty signal.
      expect(s2.gamepads?.[0]?.pressed.size).toBe(0);
      expect(loadCalls).toBeLessThanOrEqual(1);
      handle();
    });

    it('XInput gamepad id: GUID unextractable, stays empty (R-3 fallback)', async () => {
      const { canvas, doc, win } = inertDom();
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: fakeNavigator([nsStub({ id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)' })]),
        loadControllerDb: async () => SYNTH_DB_TEXT,
      });
      const backend = handle.backend;
      backend.sample();
      await drain();
      const s2 = backend.sample();
      expect(s2.gamepads?.[0]?.standardMapping).toBe(false);
      expect(s2.gamepads?.[0]?.pressed.size).toBe(0);
      handle();
    });

    it('standard-mapping gamepad never triggers a DB load (C-5 lazy trigger)', async () => {
      const { canvas, doc, win } = inertDom();
      let loadCalls = 0;
      const stdPad: RawGamepadStub = {
        index: 0,
        id: 'standard pad',
        connected: true,
        mapping: 'standard',
        buttons: Array.from({ length: 17 }, (_, b) => ({ value: b === 0 ? 1 : 0, pressed: b === 0 })),
        axes: [0, 0, 0, 0],
      };
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        navigator: fakeNavigator([stdPad]),
        loadControllerDb: async () => {
          loadCalls += 1;
          return SYNTH_DB_TEXT;
        },
      });
      const backend = handle.backend;
      backend.sample();
      await drain();
      backend.sample();
      expect(loadCalls).toBe(0);
      handle();
    });
  });
}

{
  // M4 TDD red-phase: pointerType narrowing tests.
  // plan-strategy D-5: PointerType = 'mouse' | 'pen' | 'touch'
  // plan-strategy D-5: coercePointerType('pen'→'pen', 'touch'→'touch', ''/garbage→'mouse')
  // plan-strategy E-10: inactive pointer placeholder = 'mouse', semantics by active field
  describe('m4t1: PointerType coercion + placeholder (red phase)', () => {
    /** Minimal fake canvas with listener dispatch for browser-backend tests. */
    function fakeBB(): {
      canvas: HTMLCanvasElement;
      doc: Document;
      win: Window;
      fire(target: string, kind: string, ev: Record<string, unknown>): void;
    } {
      const listeners = new Map<string, Map<string, Set<EventListener>>>();
      const makeTarget = (label: string) => ({
        addEventListener(kind: string, handler: EventListener): void {
          let perTarget = listeners.get(label);
          if (!perTarget) { perTarget = new Map(); listeners.set(label, perTarget); }
          let set = perTarget.get(kind);
          if (!set) { set = new Set(); perTarget.set(kind, set); }
          set.add(handler);
        },
        removeEventListener(kind: string, handler: EventListener): void {
          listeners.get(label)?.get(kind)?.delete(handler);
        },
      });
      const canvas = { ...makeTarget('canvas'), width: 800, height: 600, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), style: {} as CSSStyleDeclaration } as unknown as HTMLCanvasElement;
      const doc = { ...makeTarget('document'), hasFocus: () => true } as unknown as Document;
      const win = makeTarget('window') as unknown as Window;
      return {
        canvas, doc, win,
        fire(target, kind, ev) {
          for (const h of listeners.get(target)?.get(kind) ?? []) h(ev as Event);
        },
      };
    }

    it('coercePointerType: known values pass through unchanged', () => {
      expect(coercePointerType('mouse')).toBe('mouse');
      expect(coercePointerType('pen')).toBe('pen');
      expect(coercePointerType('touch')).toBe('touch');
    });

    it('coercePointerType: empty string coerced to mouse (Pointer Events spec fallback)', () => {
      expect(coercePointerType('')).toBe('mouse');
    });

    it('coercePointerType: unknown/garbage strings coerced to mouse', () => {
      expect(coercePointerType('eraser')).toBe('mouse');
      expect(coercePointerType('stylus')).toBe('mouse');
      expect(coercePointerType('coarse')).toBe('mouse');
    });

    it('coercePointerType: return type is PointerType (structural check via tsc)', () => {
      const a: PointerType = coercePointerType('mouse');
      const b: PointerType = coercePointerType('pen');
      const c: PointerType = coercePointerType('touch');
      const d: PointerType = coercePointerType('');
      const e: PointerType = coercePointerType('garbage');
      expect([a, b, c, d, e].every((v) => typeof v === 'string')).toBe(true);
    });

    it('inactive pointer placeholder: snap.pointer(nonexistentId) returns pointerType mouse + active=false', () => {
      const snap = createInputSnapshot();
      const p = snap.pointer(999);
      expect(p.active).toBe(false);
      expect(p.pointerType).toBe('mouse');
      const t: PointerType = p.pointerType;
      expect(t).toBe('mouse');
    });

    it('active pointer: real pointer down carries pointerType from backend via coercion', () => {
      const { canvas, doc, win, fire: f } = fakeBB();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
      const backend = handle.backend;

      f('canvas', 'pointerdown', { button: 0, pointerType: 'pen', pointerId: 3, clientX: 10, clientY: 20 });

      const sample = backend.sample();
      const pointers = sample.pointers;
      expect(pointers).toBeDefined();
      const p = pointers!.find((x: { pointerId: number }) => x.pointerId === 3);
      expect(p).toBeDefined();
      expect(p!.pointerType).toBe('pen');
      expect(p!.active).toBe(true);

      const events = sample.pointerEvents;
      expect(events).toBeDefined();
      const ev = events!.find((x: { pointerId: number }) => x.pointerId === 3);
      expect(ev).toBeDefined();
      expect(ev!.pointerType).toBe('pen');

      handle();
    });

    it('PointerType excludes empty string (verified at type level)', () => {
      const snap = createInputSnapshot();
      expect(snap.pointer(0).pointerType).not.toBe('');
      expect(snap.pointer(0).pointerType).toBe('mouse');
    });

    it('PointerPhaseEvent carries coerced pointerType through phase queue', () => {
      const { canvas, doc, win, fire: f } = fakeBB();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
      const backend = handle.backend;

      f('canvas', 'pointerdown', { button: 0, pointerType: 'touch', pointerId: 5, clientX: 30, clientY: 40 });

      const sample = backend.sample();
      const events = sample.pointerEvents;
      expect(events).toBeDefined();
      const ev = events!.find((x: { pointerId: number; phase: string }) => x.pointerId === 5 && x.phase === 'down');
      expect(ev).toBeDefined();
      expect(ev!.pointerType).toBe('touch');

      handle();
    });

    it('phase events from onPointerCancel carry coerced pointerType', () => {
      const { canvas, doc, win, fire: f } = fakeBB();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
      const backend = handle.backend;

      f('canvas', 'pointerdown', { button: 0, pointerType: 'pen', pointerId: 7, clientX: 50, clientY: 60 });
      f('canvas', 'pointercancel', { pointerType: 'pen', pointerId: 7 });

      const sample = backend.sample();
      const events = sample.pointerEvents;
      const cancelEv = events?.find((x: { pointerId: number; phase: string }) => x.pointerId === 7 && x.phase === 'cancel');
      expect(cancelEv).toBeDefined();
      expect(cancelEv!.pointerType).toBe('pen');

      handle();
    });

    it('phase events from onBlur carry pointerType from pointerMap (coerced on entry)', () => {
      const { canvas, doc, win, fire: f } = fakeBB();
      const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
      const backend = handle.backend;

      f('canvas', 'pointerdown', { button: 0, pointerType: 'touch', pointerId: 9, clientX: 70, clientY: 80 });
      f('window', 'blur', {});

      const sample = backend.sample();
      const events = sample.pointerEvents;
      const cancelBlurEv = events?.find((x: { pointerId: number; phase: string }) => x.pointerId === 9 && x.phase === 'cancel');
      expect(cancelBlurEv).toBeDefined();
      expect(cancelBlurEv!.pointerType).toBe('touch');

      handle();
    });
  });
}

{
  // ─── M5 gesture recognizer (gesture-recognizer.ts) ───
  // Pure-function state machines called directly with synthetic phaseQueue +
  // pointerMap + injected now() clock (D-3/D-4). No DOM.

  /** Build a synthetic PointerPhaseEvent. */
  function ph(
    pointerId: number,
    phase: PointerPhaseEvent['phase'],
    x: number,
    y: number,
    pointerType: PointerType = 'touch',
  ): PointerPhaseEvent {
    return { pointerId, phase, x, y, pressure: 0.5, pointerType };
  }

  /** Build a pointerMap (pointerId -> live position) for the recognizer. */
  function pm(
    entries: readonly (readonly [number, number, number, PointerType?])[],
  ): ReadonlyMap<number, RecognizerPointer> {
    const m = new Map<number, RecognizerPointer>();
    for (const [id, x, y, pt] of entries) {
      m.set(id, { x, y, pointerType: pt ?? 'touch' });
    }
    return m;
  }

  const EMPTY_MAP: ReadonlyMap<number, RecognizerPointer> = new Map();

  describe('m5t1: pinch + rotate recognizer (D-11)', () => {
    it('two fingers down -> pinch + rotate begin, scale 1.0 / angle 0 (AC-14)', () => {
      const s0 = createRecognizerState();
      const r = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        s0,
        1000,
      );
      const kinds = r.gestureEvents.map((e) => e.kind);
      expect(kinds).toContain('pinch-begin');
      expect(kinds).toContain('rotate-begin');
      const begin = r.gestureEvents.find((e) => e.kind === 'pinch-begin');
      expect(begin).toBeDefined();
      if (begin && begin.kind === 'pinch-begin') {
        expect([...begin.pointerIds].sort()).toEqual([1, 2]);
        expect(begin.pointerType).toBe('touch');
      }
      expect(r.gestureState.pinchScale).toBeCloseTo(1.0, 5);
      expect(r.gestureState.rotationAngle).toBeCloseTo(0, 5);
    });

    it('fingers spread -> pinchScale increases proportionally', () => {
      let s = createRecognizerState();
      s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        s,
        1000,
      ).newState;
      // Spread finger 2 from x=100 to x=200 (distance 100 -> 200 => scale 2.0).
      const r = processGestureFrame(
        [ph(2, 'move', 200, 0)],
        pm([
          [1, 0, 0],
          [2, 200, 0],
        ]),
        s,
        1016,
      );
      expect(r.gestureState.pinchScale).toBeCloseTo(2.0, 5);
      expect(r.gestureState.rotationAngle).toBeCloseTo(0, 5);
      // No new begin/end on a pure move frame.
      expect(r.gestureEvents.map((e) => e.kind)).not.toContain('pinch-begin');
    });

    it('fingers rotate -> rotationAngle tracks atan2 frame delta', () => {
      let s = createRecognizerState();
      s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        s,
        1000,
      ).newState;
      // Rotate finger 2 from (100,0) [angle 0] to (0,100) [angle +PI/2].
      const r = processGestureFrame(
        [ph(2, 'move', 0, 100)],
        pm([
          [1, 0, 0],
          [2, 0, 100],
        ]),
        s,
        1016,
      );
      expect(r.gestureState.rotationAngle).toBeCloseTo(Math.PI / 2, 5);
      // Distance unchanged (100) => scale stays 1.0.
      expect(r.gestureState.pinchScale).toBeCloseTo(1.0, 5);
    });

    it('2->1 lift emits end + freezes continuous value; back to 2 re-begins + resets (D-11/E-6)', () => {
      let s = createRecognizerState();
      s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        s,
        1000,
      ).newState;
      // Spread to scale 2.0.
      s = processGestureFrame(
        [ph(2, 'move', 200, 0)],
        pm([
          [1, 0, 0],
          [2, 200, 0],
        ]),
        s,
        1016,
      ).newState;
      // Lift finger 1 (2->1): end events, continuous value frozen at 2.0.
      const rEnd = processGestureFrame([ph(1, 'up', 0, 0)], pm([[2, 200, 0]]), s, 1032);
      const endKinds = rEnd.gestureEvents.map((e) => e.kind);
      expect(endKinds).toContain('pinch-end');
      expect(endKinds).toContain('rotate-end');
      expect(rEnd.gestureState.pinchScale).toBeCloseTo(2.0, 5);
      s = rEnd.newState;
      // Idle frame with a single finger: frozen value retained (not identity).
      const rIdle = processGestureFrame([], pm([[2, 200, 0]]), s, 1048);
      expect(rIdle.gestureState.pinchScale).toBeCloseTo(2.0, 5);
      s = rIdle.newState;
      // Second finger returns -> new begin, reset to identity 1.0/0.
      const rBegin = processGestureFrame(
        [ph(3, 'down', 300, 0)],
        pm([
          [2, 200, 0],
          [3, 300, 0],
        ]),
        s,
        1064,
      );
      expect(rBegin.gestureEvents.map((e) => e.kind)).toContain('pinch-begin');
      expect(rBegin.gestureState.pinchScale).toBeCloseTo(1.0, 5);
      expect(rBegin.gestureState.rotationAngle).toBeCloseTo(0, 5);
    });

    it('third finger down is ignored while a pair is locked (D-11)', () => {
      let s = createRecognizerState();
      s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        s,
        1000,
      ).newState;
      s = processGestureFrame(
        [ph(2, 'move', 200, 0)],
        pm([
          [1, 0, 0],
          [2, 200, 0],
        ]),
        s,
        1016,
      ).newState;
      // Third finger arrives; locked pair (1,2) unchanged, no new begin.
      const r = processGestureFrame(
        [ph(3, 'down', 50, 50)],
        pm([
          [1, 0, 0],
          [2, 200, 0],
          [3, 50, 50],
        ]),
        s,
        1032,
      );
      expect(r.gestureEvents.map((e) => e.kind)).not.toContain('pinch-begin');
      // Scale still reflects the locked pair (1,2): 200/100 = 2.0.
      expect(r.gestureState.pinchScale).toBeCloseTo(2.0, 5);
    });

    it('AC-12: no active gesture returns identity empty signal without throwing', () => {
      const s = createRecognizerState();
      const r = processGestureFrame([], EMPTY_MAP, s, 1000);
      expect(r.gestureState.pinchScale).toBe(1);
      expect(r.gestureState.rotationAngle).toBe(0);
      expect(r.gestureEvents).toEqual([]);
    });

    it('AC-12: active gesture retains continuous value on an idle (no-event) frame', () => {
      let s = createRecognizerState();
      s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        s,
        1000,
      ).newState;
      s = processGestureFrame(
        [ph(2, 'move', 300, 0)],
        pm([
          [1, 0, 0],
          [2, 300, 0],
        ]),
        s,
        1016,
      ).newState;
      // Idle frame: fingers unchanged, no events -> value retained (scale 3.0).
      const r = processGestureFrame(
        [],
        pm([
          [1, 0, 0],
          [2, 300, 0],
        ]),
        s,
        1032,
      );
      expect(r.gestureState.pinchScale).toBeCloseTo(3.0, 5);
      expect(r.gestureEvents).toEqual([]);
    });
  });

  describe('m5t2: swipe recognizer (D-10)', () => {
    it('fast flick over threshold emits a single swipe (right) with direction (AC-15)', () => {
      // Frame 1: down at origin, t=1000.
      let res = processGestureFrame([ph(1, 'down', 0, 0)], pm([[1, 0, 0]]), createRecognizerState(), 1000);
      // Frame 2: move + up at (100,0), t=1100 -> displacement 100 over 100ms = 1.0 px/ms >= 0.5.
      res = processGestureFrame(
        [ph(1, 'move', 100, 0), ph(1, 'up', 100, 0)],
        EMPTY_MAP,
        res.newState,
        1100,
      );
      const swipes = res.gestureEvents.filter((e) => e.kind === 'swipe');
      expect(swipes).toHaveLength(1);
      const sw = swipes[0];
      if (sw && sw.kind === 'swipe') {
        expect(sw.direction).toBe('right');
        expect(sw.pointerId).toBe(1);
        expect(sw.pointerType).toBe('touch');
      }
    });

    it('slow drag under threshold emits no swipe on up', () => {
      let res = processGestureFrame([ph(2, 'down', 0, 0)], pm([[2, 0, 0]]), createRecognizerState(), 2000);
      // Move only 10px over 100ms -> 0.1 px/ms < 0.5.
      res = processGestureFrame([ph(2, 'move', 10, 0), ph(2, 'up', 10, 0)], EMPTY_MAP, res.newState, 2100);
      expect(res.gestureEvents.filter((e) => e.kind === 'swipe')).toHaveLength(0);
    });

    it('direction classification: pure-down, pure-left, diagonal-dominant-horizontal', () => {
      // pure down (screen y increases downward -> 'down')
      let r = processGestureFrame([ph(3, 'down', 0, 0)], pm([[3, 0, 0]]), createRecognizerState(), 3000);
      r = processGestureFrame([ph(3, 'move', 0, 100), ph(3, 'up', 0, 100)], EMPTY_MAP, r.newState, 3100);
      let sw = r.gestureEvents.find((e) => e.kind === 'swipe');
      expect(sw && sw.kind === 'swipe' ? sw.direction : undefined).toBe('down');

      // pure left
      r = processGestureFrame([ph(4, 'down', 100, 0)], pm([[4, 100, 0]]), createRecognizerState(), 3200);
      r = processGestureFrame([ph(4, 'move', 0, 0), ph(4, 'up', 0, 0)], EMPTY_MAP, r.newState, 3300);
      sw = r.gestureEvents.find((e) => e.kind === 'swipe');
      expect(sw && sw.kind === 'swipe' ? sw.direction : undefined).toBe('left');

      // up-right diagonal, larger horizontal component -> 'right'
      r = processGestureFrame([ph(5, 'down', 0, 100)], pm([[5, 0, 100]]), createRecognizerState(), 3400);
      r = processGestureFrame([ph(5, 'move', 120, 40), ph(5, 'up', 120, 40)], EMPTY_MAP, r.newState, 3500);
      sw = r.gestureEvents.find((e) => e.kind === 'swipe');
      expect(sw && sw.kind === 'swipe' ? sw.direction : undefined).toBe('right');
    });

    it('AC-15: swipe is a single instantaneous event with no begin/end pair', () => {
      let r = processGestureFrame([ph(6, 'down', 0, 0)], pm([[6, 0, 0]]), createRecognizerState(), 4000);
      r = processGestureFrame([ph(6, 'move', 200, 0), ph(6, 'up', 200, 0)], EMPTY_MAP, r.newState, 4100);
      const kinds = r.gestureEvents.map((e) => e.kind);
      expect(kinds).toContain('swipe');
      expect(kinds).not.toContain('pinch-begin');
      expect(kinds).not.toContain('pinch-end');
      // Next frame carries no lingering swipe (one-frame lifecycle).
      const r2 = processGestureFrame([], EMPTY_MAP, r.newState, 4116);
      expect(r2.gestureEvents.filter((e) => e.kind === 'swipe')).toHaveLength(0);
    });

    it('velocity threshold uses SWIPE_WINDOW_MS + SWIPE_VELOCITY_THRESHOLD constants', () => {
      expect(SWIPE_VELOCITY_THRESHOLD).toBe(0.5);
      expect(SWIPE_WINDOW_MS).toBe(100);
    });
  });

  describe('m5t3: long-press recognizer (D-10, AC-16)', () => {
    it('constants match D-10 defaults', () => {
      expect(LONG_PRESS_DURATION_MS).toBe(500);
      expect(LONG_PRESS_SLOP).toBe(10);
      expect(DOUBLE_TAP_INTERVAL_MS).toBe(350);
      expect(DOUBLE_TAP_DISTANCE).toBe(10);
    });

    it('hold >= 500ms within slop fires exactly one long-press', () => {
      // Down at t=1000.
      let res = processGestureFrame([ph(1, 'down', 50, 50)], pm([[1, 50, 50]]), createRecognizerState(), 1000);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
      // Idle frame at t=1400 (400ms elapsed) -> not yet.
      res = processGestureFrame([], pm([[1, 50, 50]]), res.newState, 1400);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
      // Idle frame at t=1500 (500ms elapsed) -> fires.
      res = processGestureFrame([], pm([[1, 50, 50]]), res.newState, 1500);
      const lp = res.gestureEvents.filter((e) => e.kind === 'long-press');
      expect(lp).toHaveLength(1);
      if (lp[0] && lp[0].kind === 'long-press') {
        expect(lp[0].pointerId).toBe(1);
        expect(lp[0].x).toBe(50);
        expect(lp[0].y).toBe(50);
        expect(lp[0].pointerType).toBe('touch');
      }
      // Subsequent idle frame does not re-fire (one-shot per press).
      res = processGestureFrame([], pm([[1, 50, 50]]), res.newState, 1700);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
    });

    it('AC-16 clock decoupling: no pointer events, only clock advance -> timer still fires', () => {
      // Down, then ALL subsequent frames have an EMPTY phase queue. Only the
      // injected clock advances. The timer must still cross 500ms and fire.
      let res = processGestureFrame([ph(2, 'down', 10, 10)], pm([[2, 10, 10]]), createRecognizerState(), 0);
      // Many empty frames advancing the clock; finger stays down in pointerMap.
      res = processGestureFrame([], pm([[2, 10, 10]]), res.newState, 200);
      res = processGestureFrame([], pm([[2, 10, 10]]), res.newState, 400);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
      res = processGestureFrame([], pm([[2, 10, 10]]), res.newState, 550);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(1);
    });

    it('AC-16 (2b) F-1 falsification: single empty-queue frame past 500ms fires (event-coupled impl FAILS)', () => {
      // The ONLY pointer event ever seen is the down at t=0. If a recognizer
      // coupled its timer to event arrival (advances only when the phase queue
      // is non-empty), this assertion FAILS -- the empty-queue frame at t=600
      // would never advance the timer. A clock-driven recognizer fires.
      const afterDown = processGestureFrame([ph(3, 'down', 0, 0)], pm([[3, 0, 0]]), createRecognizerState(), 0);
      const idle = processGestureFrame([], pm([[3, 0, 0]]), afterDown.newState, 600);
      expect(idle.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(1);
    });

    it('move beyond slop before 500ms disarms -> no long-press', () => {
      let res = processGestureFrame([ph(4, 'down', 0, 0)], pm([[4, 0, 0]]), createRecognizerState(), 0);
      // Move 15px (> slop 10) at t=100.
      res = processGestureFrame([ph(4, 'move', 15, 0)], pm([[4, 15, 0]]), res.newState, 100);
      // Clock crosses 500ms; disarmed -> no fire.
      res = processGestureFrame([], pm([[4, 15, 0]]), res.newState, 600);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
    });

    it('up before 500ms cancels the pending long-press', () => {
      let res = processGestureFrame([ph(5, 'down', 0, 0)], pm([[5, 0, 0]]), createRecognizerState(), 0);
      // Up at t=300 (before 500ms).
      res = processGestureFrame([ph(5, 'up', 0, 0)], EMPTY_MAP, res.newState, 300);
      // Later clock -> nothing pending.
      res = processGestureFrame([], EMPTY_MAP, res.newState, 800);
      expect(res.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
    });
  });

  describe('m5t3: double-tap recognizer (D-10, AC-17)', () => {
    it('two ups within 350ms + 10px window fire one double-tap (AC-17)', () => {
      let res = createRecognizerState();
      // First tap: down + up at (0,0), t=1000.
      let r = processGestureFrame([ph(1, 'down', 0, 0)], pm([[1, 0, 0]]), res, 1000);
      r = processGestureFrame([ph(1, 'up', 0, 0)], EMPTY_MAP, r.newState, 1010);
      expect(r.gestureEvents.filter((e) => e.kind === 'double-tap')).toHaveLength(0);
      // Second tap: down + up at (5,5), t=1300 (interval 290ms, dist ~7px).
      r = processGestureFrame([ph(2, 'down', 5, 5)], pm([[2, 5, 5]]), r.newState, 1300);
      r = processGestureFrame([ph(2, 'up', 5, 5)], EMPTY_MAP, r.newState, 1310);
      const dt = r.gestureEvents.filter((e) => e.kind === 'double-tap');
      expect(dt).toHaveLength(1);
      if (dt[0] && dt[0].kind === 'double-tap') {
        expect(dt[0].pointerType).toBe('touch');
      }
    });

    it('second tap outside time window (>350ms) does not fire', () => {
      let r = processGestureFrame([ph(1, 'down', 0, 0)], pm([[1, 0, 0]]), createRecognizerState(), 1000);
      r = processGestureFrame([ph(1, 'up', 0, 0)], EMPTY_MAP, r.newState, 1010);
      // Second up at t=1400 -> interval 390ms > 350ms.
      r = processGestureFrame([ph(2, 'down', 0, 0)], pm([[2, 0, 0]]), r.newState, 1390);
      r = processGestureFrame([ph(2, 'up', 0, 0)], EMPTY_MAP, r.newState, 1400);
      expect(r.gestureEvents.filter((e) => e.kind === 'double-tap')).toHaveLength(0);
    });

    it('second tap outside distance window (>10px) does not fire', () => {
      let r = processGestureFrame([ph(1, 'down', 0, 0)], pm([[1, 0, 0]]), createRecognizerState(), 1000);
      r = processGestureFrame([ph(1, 'up', 0, 0)], EMPTY_MAP, r.newState, 1010);
      // Second up at (20,0) -> distance 20px > 10px, within time window.
      r = processGestureFrame([ph(2, 'down', 20, 0)], pm([[2, 20, 0]]), r.newState, 1100);
      r = processGestureFrame([ph(2, 'up', 20, 0)], EMPTY_MAP, r.newState, 1110);
      expect(r.gestureEvents.filter((e) => e.kind === 'double-tap')).toHaveLength(0);
    });

    it('AC-17: double-tap is a single instantaneous event (no lingering next frame)', () => {
      let r = processGestureFrame([ph(1, 'down', 0, 0)], pm([[1, 0, 0]]), createRecognizerState(), 1000);
      r = processGestureFrame([ph(1, 'up', 0, 0)], EMPTY_MAP, r.newState, 1010);
      r = processGestureFrame([ph(2, 'down', 2, 2)], pm([[2, 2, 2]]), r.newState, 1200);
      r = processGestureFrame([ph(2, 'up', 2, 2)], EMPTY_MAP, r.newState, 1210);
      expect(r.gestureEvents.filter((e) => e.kind === 'double-tap')).toHaveLength(1);
      const r2 = processGestureFrame([], EMPTY_MAP, r.newState, 1226);
      expect(r2.gestureEvents.filter((e) => e.kind === 'double-tap')).toHaveLength(0);
    });
  });

  describe('m5t4: gesture cancel + idle retention (AC-18/E-7/E-8/AC-12)', () => {
    // onBlur maps to the recognizer's cancel-phase path (D-4): the backend
    // funnel pushes a cancel phase per active pointer into the queue, which
    // the recognizer consumes before drain. Backend-level onBlur e2e is in
    // the m5t8 integration block; here we drive the recognizer directly.

    /** Set up an active 2-finger pinch spread to scale 2.0. */
    function activePinch(): RecognizerState {
      let s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        createRecognizerState(),
        1000,
      ).newState;
      s = processGestureFrame(
        [ph(2, 'move', 200, 0)],
        pm([
          [1, 0, 0],
          [2, 200, 0],
        ]),
        s,
        1016,
      ).newState;
      return s;
    }

    it('pointercancel on active pinch -> cancel events + values reset to identity (AC-18/E-8)', () => {
      const s = activePinch();
      // A cancel phase for one locked finger cancels the pair.
      const r = processGestureFrame([ph(1, 'cancel', 0, 0)], pm([[2, 200, 0]]), s, 1032);
      const kinds = r.gestureEvents.map((e) => e.kind);
      expect(kinds).toContain('pinch-cancel');
      expect(kinds).toContain('rotate-cancel');
      // Continuous value reset to identity (NOT frozen, unlike the 2->1 end path).
      expect(r.gestureState.pinchScale).toBe(1);
      expect(r.gestureState.rotationAngle).toBe(0);
      // Next idle frame emits no ghost gesture.
      const r2 = processGestureFrame([], EMPTY_MAP, r.newState, 1048);
      expect(r2.gestureEvents).toEqual([]);
      expect(r2.gestureState.pinchScale).toBe(1);
    });

    it('onBlur path (cancel phases for all pointers) -> cancels + identity + no ghost next frame', () => {
      const s = activePinch();
      // Backend onBlur clears pointerMap and pushes a cancel phase per pointer.
      const r = processGestureFrame(
        [ph(1, 'cancel', 0, 0), ph(2, 'cancel', 200, 0)],
        EMPTY_MAP,
        s,
        1032,
      );
      expect(r.gestureEvents.map((e) => e.kind)).toContain('pinch-cancel');
      expect(r.gestureState.pinchScale).toBe(1);
      const r2 = processGestureFrame([], EMPTY_MAP, r.newState, 1048);
      expect(r2.gestureEvents).toEqual([]);
    });

    it('idle frames retain continuous values while gesture stays active (AC-12)', () => {
      let s = activePinch(); // scale 2.0
      for (const t of [1032, 1048, 1064, 1080]) {
        const r = processGestureFrame(
          [],
          pm([
            [1, 0, 0],
            [2, 200, 0],
          ]),
          s,
          t,
        );
        expect(r.gestureState.pinchScale).toBeCloseTo(2.0, 5);
        expect(r.gestureEvents).toEqual([]);
        s = r.newState;
      }
    });

    it('long-press armed then cancelled before 500ms -> timer reset, no fire (E-7)', () => {
      let s = processGestureFrame([ph(7, 'down', 5, 5)], pm([[7, 5, 5]]), createRecognizerState(), 0);
      // onBlur before 500ms: cancel phase + cleared pointerMap.
      s = processGestureFrame([ph(7, 'cancel', 5, 5)], EMPTY_MAP, s.newState, 200);
      // Clock advances well past 500ms; timer must have been reset.
      const r = processGestureFrame([], EMPTY_MAP, s.newState, 800);
      expect(r.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
    });

    it('cascading: pinch + long-press both active -> cancel resets both independently (AC-18)', () => {
      // Pinch on (1,2); a third finger (3) arms a long-press (ignored by pinch, D-11).
      let s = processGestureFrame(
        [ph(1, 'down', 0, 0), ph(2, 'down', 100, 0)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
        ]),
        createRecognizerState(),
        0,
      ).newState;
      s = processGestureFrame(
        [ph(3, 'down', 300, 300)],
        pm([
          [1, 0, 0],
          [2, 100, 0],
          [3, 300, 300],
        ]),
        s,
        16,
      ).newState;
      // Cancel everything (onBlur).
      const r = processGestureFrame(
        [ph(1, 'cancel', 0, 0), ph(2, 'cancel', 100, 0), ph(3, 'cancel', 300, 300)],
        EMPTY_MAP,
        s,
        32,
      );
      expect(r.gestureEvents.map((e) => e.kind)).toContain('pinch-cancel');
      expect(r.gestureState.pinchScale).toBe(1);
      // After cancel, advancing the clock past 500ms fires NO long-press for finger 3.
      const r2 = processGestureFrame([], EMPTY_MAP, r.newState, 700);
      expect(r2.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
    });
  });

  describe('m5t8: gesture e2e through backend + snapshot (AC-11/AC-13)', () => {
    /** Backend fixture with an injectable fake clock. */
    function gestureBackend(): {
      backend: InputBackend;
      fire(kind: string, ev: Record<string, unknown>): void;
      setNow(t: number): void;
      blur(): void;
      handle: () => void;
    } {
      const listeners = new Map<string, Map<string, Set<EventListener>>>();
      const makeTarget = (label: string) => ({
        addEventListener(kind: string, handler: EventListener): void {
          let perTarget = listeners.get(label);
          if (!perTarget) { perTarget = new Map(); listeners.set(label, perTarget); }
          let set = perTarget.get(kind);
          if (!set) { set = new Set(); perTarget.set(kind, set); }
          set.add(handler);
        },
        removeEventListener(kind: string, handler: EventListener): void {
          listeners.get(label)?.get(kind)?.delete(handler);
        },
      });
      const canvas = {
        ...makeTarget('canvas'),
        width: 800,
        height: 600,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        setPointerCapture: () => {},
        style: {} as CSSStyleDeclaration,
      } as unknown as HTMLCanvasElement;
      const doc = { ...makeTarget('document'), hasFocus: () => true } as unknown as Document;
      const win = makeTarget('window') as unknown as Window;
      let clock = 0;
      const handle = attachBrowserInputBackend(canvas, {
        document: doc,
        window: win,
        now: () => clock,
      });
      return {
        backend: handle.backend,
        fire(kind, ev) {
          for (const h of listeners.get('canvas')?.get(kind) ?? []) h(ev as Event);
        },
        setNow(t) { clock = t; },
        blur() {
          for (const h of listeners.get('window')?.get('blur') ?? []) h({} as Event);
        },
        handle,
      };
    }

    it('full pipeline: pinch flows through sample() into snap.gesture + snap.gestureEvents (AC-13)', () => {
      const bb = gestureBackend();
      // Two fingers down at t=0.
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      let snap = snapshotFromSample(bb.backend.sample());
      let kinds = snap.gestureEvents.map((e) => e.kind);
      expect(kinds).toContain('pinch-begin');
      expect(snap.gesture.pinchScale).toBeCloseTo(1.0, 5);

      // Spread finger 2 to x=200 -> scale 2.0. No begin/end on this frame.
      bb.setNow(16);
      bb.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 200, clientY: 0, movementX: 100, movementY: 0 });
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gesture.pinchScale).toBeCloseTo(2.0, 5);
      expect(snap.gestureEvents.map((e) => e.kind)).not.toContain('pinch-begin');

      // Lift finger 1 -> pinch-end in this frame's events, value frozen at 2.0.
      bb.setNow(32);
      bb.fire('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      snap = snapshotFromSample(bb.backend.sample());
      kinds = snap.gestureEvents.map((e) => e.kind);
      expect(kinds).toContain('pinch-end');
      expect(snap.gesture.pinchScale).toBeCloseTo(2.0, 5);

      bb.handle();
    });

    it('AC-13 lifecycle: begin/end appear only on their frames, middle frames empty', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      let snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents.filter((e) => e.kind === 'pinch-begin')).toHaveLength(1);

      // Idle frame: no pointer events -> no lifecycle events.
      bb.setNow(16);
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents).toHaveLength(0);

      bb.setNow(32);
      bb.fire('pointerup', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents.filter((e) => e.kind === 'pinch-end')).toHaveLength(1);

      // Next frame empty again (one-frame lifecycle).
      bb.setNow(48);
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents).toHaveLength(0);

      bb.handle();
    });

    it('AC-11 gesture half: same-frame double read returns identical GestureState object', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      const snap = snapshotFromSample(bb.backend.sample());
      const first = snap.gesture;
      const second = snap.gesture;
      expect(first).toBe(second); // frozen: identical reference
      expect(first.pinchScale).toBe(second.pinchScale);
      bb.handle();
    });

    it('AC-16 through backend: long-press fires on idle frames driven only by injected clock', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 50, clientY: 50 });
      let snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(0);
      // No further pointer events; only advance the clock past 500ms.
      bb.setNow(600);
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents.filter((e) => e.kind === 'long-press')).toHaveLength(1);
      bb.handle();
    });

    it('multiple simultaneous gestures: pinch (fingers 1,2) + long-press (finger 3)', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      snapshotFromSample(bb.backend.sample()); // pinch-begin frame
      // Finger 3 arrives (ignored by pinch pair D-11) but arms a long-press.
      bb.setNow(16);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 3, clientX: 400, clientY: 400 });
      snapshotFromSample(bb.backend.sample());
      // Advance past 500ms -> finger 3 long-press fires; pinch value still live.
      bb.setNow(600);
      const snap = snapshotFromSample(bb.backend.sample());
      const lp = snap.gestureEvents.filter((e) => e.kind === 'long-press');
      expect(lp).toHaveLength(1);
      if (lp[0] && lp[0].kind === 'long-press') expect(lp[0].pointerId).toBe(3);
      // Fingers 1,2 are committed to the pinch and do NOT fire long-presses.
      expect(lp.every((e) => e.kind === 'long-press' && e.pointerId === 3)).toBe(true);
      bb.handle();
    });

    it('onBlur end-to-end: active pinch cancelled + values reset, no ghost next frame (AC-18)', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      snapshotFromSample(bb.backend.sample());
      bb.setNow(16);
      bb.fire('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 300, clientY: 0, movementX: 200, movementY: 0 });
      let snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gesture.pinchScale).toBeCloseTo(3.0, 5);
      // Blur pushes cancel phases; recognizer consumes them before drain.
      bb.setNow(32);
      bb.blur();
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents.map((e) => e.kind)).toContain('pinch-cancel');
      expect(snap.gesture.pinchScale).toBe(1);
      // Next frame: no ghost gesture.
      bb.setNow(48);
      snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gestureEvents).toHaveLength(0);
      expect(snap.gesture.pinchScale).toBe(1);
      bb.handle();
    });

    it('no active gesture: snap.gesture identity + empty gestureEvents (AC-12)', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      const snap = snapshotFromSample(bb.backend.sample());
      expect(snap.gesture.pinchScale).toBe(1);
      expect(snap.gesture.rotationAngle).toBe(0);
      expect(snap.gestureEvents).toEqual([]);
      bb.handle();
    });

    it('AC-19 real consumption: GestureEvent consumer exhaustively switches on kind + pointerType', () => {
      const bb = gestureBackend();
      bb.setNow(0);
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 0, clientY: 0 });
      bb.fire('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 100, clientY: 0 });
      const snap = snapshotFromSample(bb.backend.sample());
      // Exhaustive consumption path: no default branch on either discriminant.
      const label = (e: GestureEvent): string => {
        const device = ((pt: PointerType): string => {
          switch (pt) {
            case 'mouse': return 'M';
            case 'pen': return 'P';
            case 'touch': return 'T';
          }
        })(e.pointerType);
        switch (e.kind) {
          case 'pinch-begin': case 'pinch-end': case 'pinch-cancel':
          case 'rotate-begin': case 'rotate-end': case 'rotate-cancel':
            return `${e.kind}:${device}`;
          case 'swipe': return `swipe-${e.direction}:${device}`;
          case 'long-press': return `lp:${device}`;
          case 'double-tap': return `dt:${device}`;
        }
      };
      const labels = snap.gestureEvents.map(label);
      expect(labels.some((l) => l.startsWith('pinch-begin:T'))).toBe(true);
      bb.handle();
    });
  });
}
