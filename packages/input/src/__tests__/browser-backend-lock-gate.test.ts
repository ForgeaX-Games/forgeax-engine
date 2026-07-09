// browser-backend-lock-gate.test.ts -- M1 w2: gate synthesis unit tests.
//
// Covers: gameGate x hostPredicate four-quadrant matrix,
// setPointerLockAllowed(false) immediate release on both paths.
//
// charter awareness:
//   F1 single-entry indexability -- all gate tests in one file
//   P3 explicit failure -- each assertion produces a clear diagnostic

import { describe, expect, it } from 'vitest';
import { attachBrowserInputBackend } from '../browser-backend';

// ---------------------------------------------------------------------------
// Helper: build fake env with shared document listeners.
// ---------------------------------------------------------------------------

function buildEnvForClickTest(opts?: {
  hostPredicate?: (() => boolean) | undefined;
  lockProvider?: { requestLock: () => void; exitLock: () => void } | undefined;
}): {
  backend: ReturnType<typeof attachBrowserInputBackend>['backend'];
  fireClick(): void;
  requestPointerLockCalls: { count: number };
  requestLockCalls: { count: number };
  exitLockCalls: { count: number };
  exitPointerLockCalls: { count: number };
  setPointerLockElement(el: Element | null): void;
  canvas: HTMLCanvasElement;
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

  let pointerLockEl: Element | null = null;
  const requestPointerLockCalls = { count: 0 };
  const exitPointerLockCalls = { count: 0 };
  const requestLockCalls = { count: 0 };
  const exitLockCalls = { count: 0 };

  const canvas = {
    ...makeTarget('canvas'),
    requestPointerLock() {
      requestPointerLockCalls.count += 1;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect,
    width: 800,
    height: 600,
    style: { touchAction: '' },
    setPointerCapture: () => {},
  } as unknown as HTMLCanvasElement;

  const doc = {
    ...makeTarget('document'),
    hasFocus() {
      return true;
    },
    visibilityState: 'visible',
    get pointerLockElement() {
      return pointerLockEl;
    },
    exitPointerLock() {
      exitPointerLockCalls.count += 1;
      pointerLockEl = null;
      const hs = listeners.get('document')?.get('pointerlockchange');
      if (hs) {
        const ev = new Event('pointerlockchange');
        for (const h of hs) h(ev as Event);
      }
    },
  } as unknown as Document & { exitPointerLock(): void };

  const win = makeTarget('window') as unknown as Window;

  // Build options with exactOptionalPropertyTypes-safe handling.
  const backendOpts: Record<string, unknown> = {
    document: doc,
    window: win,
  };
  if (opts?.hostPredicate !== undefined) {
    backendOpts.pointerLockAllowed = opts.hostPredicate;
  }
  if (opts?.lockProvider !== undefined) {
    backendOpts.lockProvider = opts.lockProvider;
  }

  const handle = attachBrowserInputBackend(
    canvas,
    backendOpts as Parameters<typeof attachBrowserInputBackend>[1],
  );

  return {
    backend: handle.backend,
    canvas,
    fireClick() {
      const handlers = listeners.get('canvas')?.get('click');
      if (handlers) {
        const ev = new Event('click');
        for (const h of handlers) h(ev as Event);
      }
    },
    requestPointerLockCalls,
    exitPointerLockCalls,
    requestLockCalls,
    exitLockCalls,
    setPointerLockElement(el) {
      pointerLockEl = el;
      const hs = listeners.get('document')?.get('pointerlockchange');
      if (hs) {
        const ev = new Event('pointerlockchange');
        for (const h of hs) h(ev as Event);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('browser-backend-lock-gate.test.ts (w2)', () => {
  describe('gate four-quadrant matrix', () => {
    it('gameGate=true (default), hostPredicate=true -> lock requested (W3C path)', () => {
      const env = buildEnvForClickTest({
        hostPredicate: () => true,
      });
      env.fireClick();
      expect(env.requestPointerLockCalls.count).toBe(1);
      expect(env.backend.sample().pointerLocked).toBe(false); // pointerlockchange not fired yet
    });

    it('gameGate=true (default), hostPredicate=false -> no lock', () => {
      const env = buildEnvForClickTest({
        hostPredicate: () => false,
      });
      env.fireClick();
      expect(env.requestPointerLockCalls.count).toBe(0);
      expect(env.backend.sample().pointerLocked).toBe(false);
    });

    it('gameGate=false (setPointerLockAllowed(false)), hostPredicate=true -> no lock', () => {
      const env = buildEnvForClickTest({
        hostPredicate: () => true,
      });
      env.backend.setPointerLockAllowed?.(false);
      env.fireClick();
      expect(env.requestPointerLockCalls.count).toBe(0);
      expect(env.backend.sample().pointerLocked).toBe(false);
    });

    it('gameGate=false, hostPredicate=false -> no lock', () => {
      const env = buildEnvForClickTest({
        hostPredicate: () => false,
      });
      env.backend.setPointerLockAllowed?.(false);
      env.fireClick();
      expect(env.requestPointerLockCalls.count).toBe(0);
      expect(env.backend.sample().pointerLocked).toBe(false);
    });

    it('gameGate reverts to true after setPointerLockAllowed(true)', () => {
      const env = buildEnvForClickTest({
        hostPredicate: () => true,
      });
      env.backend.setPointerLockAllowed?.(false);
      env.fireClick();
      expect(env.requestPointerLockCalls.count).toBe(0);

      env.backend.setPointerLockAllowed?.(true);
      env.fireClick();
      expect(env.requestPointerLockCalls.count).toBe(1);
    });
  });

  describe('gate with lockProvider path', () => {
    it('gate passes + lockProvider present -> requestLock called, not W3C', () => {
      const requestLockCalls = { count: 0 };
      const env = buildEnvForClickTest({
        hostPredicate: () => true,
        lockProvider: {
          requestLock() {
            requestLockCalls.count += 1;
          },
          exitLock() {},
        },
      });
      env.fireClick();
      expect(requestLockCalls.count).toBe(1);
      expect(env.requestPointerLockCalls.count).toBe(0);
      expect(env.backend.sample().pointerLocked).toBe(true); // D-7 optimistic
    });

    it('gate blocked + lockProvider present -> neither requestLock nor W3C called', () => {
      const requestLockCalls = { count: 0 };
      const env = buildEnvForClickTest({
        hostPredicate: () => false,
        lockProvider: {
          requestLock() {
            requestLockCalls.count += 1;
          },
          exitLock() {},
        },
      });
      env.fireClick();
      expect(requestLockCalls.count).toBe(0);
      expect(env.requestPointerLockCalls.count).toBe(0);
      expect(env.backend.sample().pointerLocked).toBe(false);
    });
  });

  describe('setPointerLockAllowed(false) immediate release', () => {
    it('W3C path: setPointerLockAllowed(false) while locked -> exitPointerLock called', () => {
      const env = buildEnvForClickTest({
        hostPredicate: () => true,
      });
      // Lock via W3C path: click + pointerlockchange simulation.
      env.fireClick();
      env.setPointerLockElement(env.canvas);
      expect(env.backend.sample().pointerLocked).toBe(true);

      // Now release.
      env.backend.setPointerLockAllowed?.(false);
      expect(env.exitPointerLockCalls.count).toBe(1);
      expect(env.backend.sample().pointerLocked).toBe(false);
    });

    it('provider path: setPointerLockAllowed(false) while locked -> exitLock called', () => {
      const exitLockCalls = { count: 0 };
      const env = buildEnvForClickTest({
        hostPredicate: () => true,
        lockProvider: {
          requestLock() {},
          exitLock() {
            exitLockCalls.count += 1;
          },
        },
      });
      env.fireClick();
      expect(env.backend.sample().pointerLocked).toBe(true);

      env.backend.setPointerLockAllowed?.(false);
      expect(exitLockCalls.count).toBe(1);
      expect(env.backend.sample().pointerLocked).toBe(false);
    });

    it('setPointerLockAllowed(false) when not locked -> no-op', () => {
      const env = buildEnvForClickTest();
      env.backend.setPointerLockAllowed?.(false);
      expect(env.exitPointerLockCalls.count).toBe(0);
    });
  });

  describe('hostPredicate is evaluated live per click', () => {
    it('predicate toggle mid-session switches gate behavior', () => {
      let gateAllowed = false;
      const env = buildEnvForClickTest({
        hostPredicate: () => gateAllowed,
      });

      env.fireClick();
      expect(env.requestPointerLockCalls.count).toBe(0);

      gateAllowed = true;
      env.fireClick();
      expect(env.requestPointerLockCalls.count).toBe(1);
    });
  });
});
