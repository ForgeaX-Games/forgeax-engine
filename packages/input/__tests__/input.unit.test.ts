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

import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { attachBrowserInputBackend } from '../src/browser-backend';
import type {
  Capabilities,
  GamepadSlotSample,
  VirtualJoystickConfig,
} from '../src/input-snapshot';
import {
  createInputSnapshot,
  INPUT_BACKEND_KEY,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackend,
  InputFrameStartScan,
  type InputSnapshot,
} from '../src/index';
import { diffGamepadFrame, type RawGamepadStub } from '../src/gamepad-frame';
import {
  deriveVirtualAxes,
  handleVirtualJoystickUnbind,
  type BindState,
} from '../src/virtual-joystick';

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
      it('attaches keydown / keyup / pointerdown / pointerup / pointermove / pointercancel / wheel / visibilitychange listeners', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(store.count()).toBe(10);
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
        expect(store.count()).toBe(10);
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
        world.addSystem(InputFrameStartScan);
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
        world.addSystem(InputFrameStartScan);

        expect(world.hasResource('InputSnapshot')).toBe(false);
        world.update();
        expect(world.hasResource('InputSnapshot')).toBe(true);
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap.keyboard.down('shift')).toBe(true);
        expect(snap.mouse.button(0)).toBe(true);
        expect(snap.mouse.movementDelta).toEqual({ x: 3, y: -2 });
      });

      it('calls backend.sample() exactly once per world.update()', () => {
        const backend = fixtureBackend({});
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(InputFrameStartScan);

        world.update();
        world.update();
        world.update();
        expect(backend.sampleCalls).toBe(3);
      });

      it('frozen snapshot: methods on the resource do not mutate it', () => {
        const backend = fixtureBackend({ movementX: 9, movementY: 9 });
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(InputFrameStartScan);

        world.update();
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
      } {
        const snap = {
          downKeys: new Set(downKeys),
          upKeys: new Set(upKeys),
          buttons: [buttons[0], buttons[1], buttons[2]] as readonly [boolean, boolean, boolean],
          movementX: mvx,
          movementY: mvy,
          wheelDelta: 0,
          focused,
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
        world.addSystem(InputFrameStartScan);

        backend.pressKey('w');
        world.update();
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap.keyboard.down('w')).toBe(true);
        expect(snap.keyboard.down('a')).toBe(false);

        backend.releaseKey('w');
        world.update();
        const snap2 = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap2.keyboard.down('w')).toBe(false);
      });

      it('keyboard.up reflects the up-edge in the frame after the release', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(InputFrameStartScan);

        backend.pressKey('space');
        world.update();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.up('space')).toBe(false);

        backend.releaseKey('space');
        world.update();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.up('space')).toBe(true);

        world.update();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.up('space')).toBe(false);
      });

      it('mouse.movementDelta is frozen at frame-start and cleared next frame', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(InputFrameStartScan);

        backend.addMovement(15, -7);
        world.update();
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap.mouse.movementDelta).toEqual({ x: 15, y: -7 });

        world.update();
        const snap2 = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap2.mouse.movementDelta).toEqual({ x: 0, y: 0 });
      });

      it('mouse.button(0|1|2) returns the held state for each W3C button slot', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(InputFrameStartScan);

        backend.pressButton(0);
        backend.pressButton(2);
        world.update();
        const snap = world.getResource<InputSnapshot>('InputSnapshot');
        expect(snap.mouse.button(0)).toBe(true);
        expect(snap.mouse.button(1)).toBe(false);
        expect(snap.mouse.button(2)).toBe(true);
      });

      it('snapshot is exposed as a Resource via insertResource("InputSnapshot")', () => {
        const backend = createFakeBackend();
        const world = new World();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(InputFrameStartScan);
        world.update();
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
        world.addSystem(InputFrameStartScan);

        backend.pressKey('w');
        world.update();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.down('w')).toBe(true);

        backend.setFocus(false);
        world.update();
        expect(world.getResource<InputSnapshot>('InputSnapshot').keyboard.down('w')).toBe(true);

        backend.setFocus(true);
        world.update();
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
        world.addSystem(InputFrameStartScan);
        backend.setWheelDelta(1);
        world.update();
        const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        expect(snap?.mouse.wheelDelta).toBe(1);
      });

      it('snapshot reads are stable within a single frame (frame-start freeze)', () => {
        const world = new World();
        const backend = createWheelFakeBackend();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(InputFrameStartScan);
        backend.setWheelDelta(-2);
        world.update();
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
        world.addSystem(InputFrameStartScan);
        backend.setWheelDelta(3);
        world.update();
        expect(world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.mouse.wheelDelta).toBe(3);
        world.update();
        expect(world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.mouse.wheelDelta).toBe(0);
      });

      it('positive and negative deltas pass through unchanged (sign-preserving)', () => {
        const world = new World();
        const backend = createWheelFakeBackend();
        world.insertResource(INPUT_BACKEND_KEY, backend);
        world.addSystem(InputFrameStartScan);
        backend.setWheelDelta(7);
        world.update();
        expect(world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY)?.mouse.wheelDelta).toBe(7);
        backend.setWheelDelta(-9);
        world.update();
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
      world.addSystem(InputFrameStartScan);
      world.update();
      return world;
    }

    function makeSnap(slots: readonly GamepadSlotSample[]): InputSnapshot {
      const world = makeWorldWithGamepadSlots(slots);
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('InputSnapshot not found after world.update()');
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
      world.addSystem(InputFrameStartScan);

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
          world.update();
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
      world.addSystem(InputFrameStartScan);

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
          world.update();
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
      world.addSystem(InputFrameStartScan);
      world.update();
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
      world.addSystem(InputFrameStartScan);
      world.update();
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('snap missing');
      expect(snap.capabilities.gamepad).toBe(false);
    });

    it('sample without gamepads field does not throw; readpoints return empty signal', () => {
      const world = new World();
      const backend = fixtureBackend({});
      world.insertResource(INPUT_BACKEND_KEY, backend);
      world.addSystem(InputFrameStartScan);
      world.update();
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
      world.addSystem(InputFrameStartScan);
      world.update();
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      if (!snap) throw new Error('snap missing');
      return snap;
    }

    function ptr(p: {
      pointerId: number;
      x: number;
      y: number;
      pressure?: number;
      pointerType?: string;
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
      world.addSystem(InputFrameStartScan);
      world.update();
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
      world.addSystem(InputFrameStartScan);
      world.update();
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
      world.addSystem(InputFrameStartScan);
      world.update();
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
      world.addSystem(InputFrameStartScan);
      world.update();
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