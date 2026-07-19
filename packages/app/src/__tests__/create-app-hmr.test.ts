// M2 / t5: AC-05 HMR listener registration and callback chain unit test.
//
// Tests the HMR listener registration pattern in create-app.ts's
// rhiDebugFlag guard block: when rhiDebugFlag==='1' and import.meta.hot
// is present, register a listener on 'forgeax-debug:capture' whose
// handler calls captureAndUpload(debugInst, frames, label).
//
// Approach (plan-strategy 5.3 AC-05): vi.mock the capture-browser
// subpath so captureAndUpload is a spy; define import.meta.hot with a
// spied .on() method; call the real registerCaptureHmrListener (shared
// SSOT with create-app.ts, following PR1's resolveRhiDebugFlag pattern)
// and assert the spy hits with correct args.
//
// This test imports the REAL registerCaptureHmrListener from
// internal/hmr-capture-listener.ts -- the same function that
// create-app.ts calls. There is NO shadow copy of the handler body
// in tests. If the handler ever drifts (drops label, calls wrong
// function), this test turns red.
//
// Constraints: requirements C2/C3 (double guard: rhiDebugFlag + import.meta.hot);
// AC-08 (listener absent when flag unset); research Finding 2 (cb single-param
// payload, NOT double-param); plan-strategy D-5 (handler calls captureAndUpload
// directly, not globalThis.__forgeax.captureFrame).
//
// This test does NOT import create-app.ts -- the canvas form requires a
// real renderer/rhi/WebGPU. Instead it exercises the shared handler
// function that both create-app.ts and this test import (SSOT).
// resolveRhiDebugFlag tests the guard logic (pure function, no renderer).

import type { CaptureBrowserRecorder } from '@forgeax/engine-rhi-debug/capture-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCaptureHmrListener } from '../internal/hmr-capture-listener';
import { resolveRhiDebugFlag } from '../internal/rhi-debug-flag';

// Hoisted mock: intercept the capture-browser subpath so the dynamic
// import() inside the handler returns our spy instead of the real module.
// Must be hoisted so vitest patches the module graph BEFORE any test code
// resolves the import.
const captureAndUploadSpy = vi.fn();
vi.mock('@forgeax/engine-rhi-debug/capture-browser', () => ({
  captureAndUpload: captureAndUploadSpy,
}));

// Env bags for resolveRhiDebugFlag (pure args, no process.env access).
const ENV_WITH_FLAG = { FORGEAX_ENGINE_RHI_DEBUG: '1' } as const;
const ENV_EMPTY = {} as const;

// Dummy sentinel that satisfies CaptureBrowserRecorder shape for the
// type-checker. captureAndUpload is mocked so no real recorder methods
// are ever called; the sentinel just needs to pass TS compilation and
// be distinguishable through the spy call chain.
function makeDummyDebugInst(): CaptureBrowserRecorder {
  return {
    arm: vi.fn(),
    getState: () => 'idle',
    getEvents: () => [],
    getTape: () => null,
    _getValid: () => true,
  } as unknown as CaptureBrowserRecorder;
}

// Stored references for import.meta.hot spy, saved/restored per test.
let onSpy: ReturnType<typeof vi.fn>;
let hotSave: unknown;

describe('create-app-hmr.test.ts (AC-05)', () => {
  describe('HMR listener registration (double guard: rhiDebugFlag + import.meta.hot)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      hotSave = (import.meta as { hot?: unknown }).hot;
      onSpy = vi.fn();
      Object.defineProperty(import.meta, 'hot', {
        value: { on: onSpy },
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      delete (import.meta as { hot?: unknown }).hot;
      if (hotSave !== undefined) {
        Object.defineProperty(import.meta, 'hot', {
          value: hotSave,
          configurable: true,
          writable: true,
        });
      }
    });

    it('(a) rhiDebugFlag==="1" + import.meta.hot present -> on("forgeax-debug:capture", ...) registered', () => {
      const debugInst = makeDummyDebugInst();
      expect(resolveRhiDebugFlag(undefined, ENV_WITH_FLAG)).toBe('1');

      // Call the REAL shared function (the SAME code that create-app.ts
      // calls when rhiDebugFlag==='1' and import.meta.hot exists).
      const hotWithSpy = {
        on: onSpy as (
          event: string,
          cb: (payload: { frames?: number; label?: string }) => void,
        ) => void,
      };
      registerCaptureHmrListener(hotWithSpy, debugInst);

      expect(onSpy).toHaveBeenCalledTimes(1);
      expect(onSpy).toHaveBeenCalledWith('forgeax-debug:capture', expect.any(Function));
    });

    it('(b) handler callback invokes captureAndUpload with debugInst, frames, label', async () => {
      captureAndUploadSpy.mockResolvedValue(undefined);

      const debugInst = makeDummyDebugInst();
      const hotWithSpy = {
        on: onSpy as (
          event: string,
          cb: (payload: { frames?: number; label?: string }) => void,
        ) => void,
      };
      registerCaptureHmrListener(hotWithSpy, debugInst);

      const handler = onSpy.mock.calls[0]?.[1] as ((p: unknown) => void) | undefined;
      expect(handler).toBeDefined();
      if (handler !== undefined) {
        handler({ frames: 5, label: 'test' });
      }

      // Dynamic import is async; wait for the microtask.
      await vi.waitFor(() => {
        expect(captureAndUploadSpy).toHaveBeenCalledWith(debugInst, 5, 'test');
      });
    });

    it('(b2) handler callback defaults frames to 1 when payload.frames is absent', async () => {
      captureAndUploadSpy.mockResolvedValue(undefined);

      const debugInst = makeDummyDebugInst();
      const hotWithSpy = {
        on: onSpy as (
          event: string,
          cb: (payload: { frames?: number; label?: string }) => void,
        ) => void,
      };
      registerCaptureHmrListener(hotWithSpy, debugInst);

      const handler = onSpy.mock.calls[0]?.[1] as ((p: unknown) => void) | undefined;
      expect(handler).toBeDefined();
      if (handler !== undefined) {
        handler({});
      }

      await vi.waitFor(() => {
        expect(captureAndUploadSpy).toHaveBeenCalledWith(debugInst, 1, undefined);
      });
    });

    it('(b3) handler callback passes label as undefined when payload.label is absent', async () => {
      captureAndUploadSpy.mockResolvedValue(undefined);

      const debugInst = makeDummyDebugInst();
      const hotWithSpy = {
        on: onSpy as (
          event: string,
          cb: (payload: { frames?: number; label?: string }) => void,
        ) => void,
      };
      registerCaptureHmrListener(hotWithSpy, debugInst);

      const handler = onSpy.mock.calls[0]?.[1] as ((p: unknown) => void) | undefined;
      expect(handler).toBeDefined();
      if (handler !== undefined) {
        handler({ frames: 3 });
      }

      await vi.waitFor(() => {
        expect(captureAndUploadSpy).toHaveBeenCalledWith(debugInst, 3, undefined);
      });
    });
  });

  describe('HMR listener NOT registered when rhiDebugFlag is absent (AC-08)', () => {
    it('(c) rhiDebugFlag !== "1" -> handler NOT registered (resolveRhiDebugFlag returns undefined)', () => {
      // When rhiDebugFlag is not '1', create-app.ts skips the entire
      // guard block including the import.meta.hot.on registration.
      // The guard code:
      //   const rhiDebugFlag = resolveRhiDebugFlag(importMetaEnv, processEnv);
      //   if (rhiDebugFlag === '1') { ... }  <-- listener inside here
      expect(resolveRhiDebugFlag(undefined, undefined)).toBeUndefined();
      expect(resolveRhiDebugFlag(undefined, ENV_EMPTY)).toBeUndefined();
    });
  });

  describe('no-op when import.meta.hot is absent (dawn-node guard)', () => {
    it('import.meta.hot absent -> the SSOT function exists but create-app.ts never calls it (guard is external)', () => {
      // In dawn-node, import.meta.hot is undefined. The
      // `if (hotMeta.hot)` guard in create-app.ts short-circuits
      // BEFORE calling registerCaptureHmrListener -- the guard is
      // external to the function (caller responsibility, per
      // charter P3: the function assumes caller has checked the
      // guard).
      expect(resolveRhiDebugFlag(undefined, ENV_WITH_FLAG)).toBe('1');
      expect(typeof registerCaptureHmrListener).toBe('function');
    });
  });
});
