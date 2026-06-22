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
import {
  createInputSnapshot,
  INPUT_BACKEND_KEY,
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackend,
  InputFrameStartScan,
  type InputSnapshot,
} from '../src/index';

interface FakeListenerStore {
  fire(target: string, kind: string, ev: Partial<WheelEvent | KeyboardEvent | MouseEvent>): void;
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
      hasFocus(): boolean {
        return focused;
      },
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
      it('attaches keydown / keyup / mousedown / mouseup / mousemove / wheel listeners', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(store.count()).toBe(8);
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

      it('translates mouse events into the buttons tuple + accumulates movementX/Y', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        const backend = handle.backend;

        store.fire('canvas', 'mousedown', { button: 0 });
        store.fire('canvas', 'mousedown', { button: 2 });
        store.fire('canvas', 'mousemove', { movementX: 5, movementY: -3 });
        store.fire('canvas', 'mousemove', { movementX: 1, movementY: 1 });

        const sample1 = backend.sample();
        expect(sample1.buttons).toEqual([true, false, true]);
        expect(sample1.movementX).toBe(6);
        expect(sample1.movementY).toBe(-2);

        const sample2 = backend.sample();
        expect(sample2.movementX).toBe(0);
        expect(sample2.movementY).toBe(0);

        store.fire('canvas', 'mouseup', { button: 0 });
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

      it('detach removes every listener and is idempotent on second call', () => {
        const { canvas, doc, win, store } = buildBBFakes();
        const handle = attachBrowserInputBackend(canvas, { document: doc, window: win });
        expect(store.count()).toBe(8);
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
  });
}

{
  // ─── from frame-start-scan-system.test.ts ───

  function fixtureBackend(initial: {
    downKeys?: ReadonlySet<string>;
    upKeys?: ReadonlySet<string>;
    buttons?: readonly [boolean, boolean, boolean];
    movementX?: number;
    movementY?: number;
    wheelDelta?: number;
    focused?: boolean;
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
        };
      },
      detach() {},
      get sampleCalls() {
        return calls;
      },
    } as InputBackend & { sampleCalls: number };
  }

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