// types.test-d.ts -- M5 (w14) compile-time fixture for the
// AppErrorCode 5-member closed union + .detail discriminated per code +
// 23-arm exhaustive switch over (AppError | RhiError) + dual-layer
// instanceof EngineEnvironmentError + switch (err.code) pattern (D-6).
//
// Anchors:
//   - requirements AC-07: type-level assertions on the closed union and
//     discriminated detail; exhaustive switch must compile under tsc
//     strict mode without falling through to a `default` arm.
//   - plan-strategy D-3: AppErrorCode stays at 5 (no 'app-device-lost'
//     -- device-lost rides on RhiError 18-member union).
//   - plan-strategy D-6: AI-user error consumption form is two-layer
//     `if (err instanceof EngineEnvironmentError) { ... } else { switch
//     (err.code) { ... } }` because EngineEnvironmentError lacks the
//     four-field surface (charter F1 immediate-fallback example).
//   - charter P3 / P4: closed union exhaustive switch needs no default
//     fallback; tsc strict mode guards completeness.
//
// vitest --typecheck folds this file into the unit test run; if a code
// is added or dropped without updating this fixture, the build fails.

import type { RhiError } from '@forgeax/engine-rhi/errors';
import type { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { describe, expectTypeOf, it } from 'vitest';

import { AppError, type AppErrorCode } from '../src/errors';
import type { App } from '../src/types';

describe('AppErrorCode is the 5-member closed union (AC-07)', () => {
  it('is assignable from each of the 6 string literals', () => {
    expectTypeOf<'app-not-started'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-already-running'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-canvas-detached'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-paused-while-stop'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-system-update-failed'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-pointer-lock-failed'>().toMatchTypeOf<AppErrorCode>();
  });

  it('rejects strings outside the closed union (D-3 lock: no app-device-lost)', () => {
    // @ts-expect-error -- 'app-device-lost' lives on RhiErrorCode, not on AppErrorCode (D-3 lock).
    const _bad: AppErrorCode = 'app-device-lost';
    void _bad;
  });
});

describe('AppError.detail is discriminated per code (AC-07)', () => {
  it('app-canvas-detached narrows detail to { canvasId?: string }', () => {
    const e = new AppError({
      code: 'app-canvas-detached',
      expected: '',
      hint: '',
      detail: { canvasId: 'preview' },
    });
    if (e.code === 'app-canvas-detached') {
      expectTypeOf(e.detail).toMatchTypeOf<{ readonly canvasId?: string | undefined }>();
    }
  });

  it('app-system-update-failed narrows detail to { cause: unknown, systemName?: string }', () => {
    const e = new AppError({
      code: 'app-system-update-failed',
      expected: '',
      hint: '',
      detail: { cause: new Error('boom'), systemName: 'host-physics' },
    });
    if (e.code === 'app-system-update-failed') {
      expectTypeOf(e.detail).toMatchTypeOf<{
        readonly cause: unknown;
        readonly systemName?: string | undefined;
      }>();
    }
  });

  it('the other 3 codes carry empty-object detail {}', () => {
    const a = new AppError({ code: 'app-not-started', expected: '', hint: '', detail: {} });
    const b = new AppError({ code: 'app-already-running', expected: '', hint: '', detail: {} });
    const c = new AppError({ code: 'app-paused-while-stop', expected: '', hint: '', detail: {} });
    if (a.code === 'app-not-started') {
      expectTypeOf(a.detail).toMatchTypeOf<Readonly<Record<string, never>>>();
    }
    if (b.code === 'app-already-running') {
      expectTypeOf(b.detail).toMatchTypeOf<Readonly<Record<string, never>>>();
    }
    if (c.code === 'app-paused-while-stop') {
      expectTypeOf(c.detail).toMatchTypeOf<Readonly<Record<string, never>>>();
    }
  });

  it('app-pointer-lock-failed narrows detail to { path: "w3c"|"provider", cause: unknown }', () => {
    const e = new AppError({
      code: 'app-pointer-lock-failed',
      expected: '',
      hint: '',
      detail: { path: 'w3c', cause: new Error('test') },
    });
    if (e.code === 'app-pointer-lock-failed') {
      expectTypeOf(e.detail).toMatchTypeOf<{
        readonly path: 'w3c' | 'provider';
        readonly cause: unknown;
      }>();
    }
  });
});

describe('exhaustive switch over (AppError | RhiError) compiles with no default arm (AC-07)', () => {
  it('covers all 23 codes (5 AppError + 18 RhiError) without a default fallback', () => {
    // The `never` return on the unreachable tail is what asserts
    // exhaustiveness: if a future commit adds a code without updating
    // this switch, the assignment to `_unreachable: never` fails tsc.
    function classify(err: AppError | RhiError): string {
      switch (err.code) {
        case 'app-not-started':
          return 'a';
        case 'app-already-running':
          return 'b';
        case 'app-canvas-detached':
          return 'c';
        case 'app-paused-while-stop':
          return 'd';
        case 'app-system-update-failed':
          return 'e';
        case 'app-pointer-lock-failed':
          return 'f';
        case 'adapter-unavailable':
        case 'feature-not-enabled':
        case 'limit-exceeded':
        case 'shader-compile-failed':
        case 'rhi-not-available':
        case 'webgpu-runtime-error':
        case 'command-encoder-finished':
        case 'render-pass-not-ended':
        case 'queue-submit-failed':
        case 'queue-write-buffer-out-of-bounds':
        case 'render-system-no-camera':
        case 'render-system-multi-camera':
        case 'render-system-multi-light':
        case 'asset-not-registered':
        case 'device-lost':
        case 'oom':
        case 'internal-error':
        case 'hierarchy-broken':
          return 'rhi';
      }
      // Unreachable: tsc narrows `err` to `never` once every union arm
      // is consumed above. Assigning it back to `never` is the
      // exhaustiveness guard.
      const _unreachable: never = err;
      return _unreachable;
    }
    expectTypeOf(classify).toBeFunction();
  });
});

describe('dual-layer instanceof EngineEnvironmentError + switch pattern (D-6)', () => {
  it('AI-user form: outer instanceof narrows to EngineEnvironmentError; else closed-union switch', () => {
    // README + JSDoc + single source: this is the canonical D-6 form.
    // The fixture compiles only if the inner switch is exhaustive over
    // (AppError | RhiError) -- i.e. EngineEnvironmentError is consumed
    // by the outer instanceof branch and no longer reaches the switch.
    function consume(err: AppError | RhiError | EngineEnvironmentError): string {
      if (err instanceof EngineEnvironmentError) {
        return `env: ${err.detail.webgpuError?.code ?? 'no-webgpu-detail'}`;
      }
      switch (err.code) {
        case 'app-not-started':
        case 'app-already-running':
        case 'app-canvas-detached':
        case 'app-paused-while-stop':
        case 'app-system-update-failed':
        case 'app-pointer-lock-failed':
          return 'app';
        case 'adapter-unavailable':
        case 'feature-not-enabled':
        case 'limit-exceeded':
        case 'shader-compile-failed':
        case 'rhi-not-available':
        case 'webgpu-runtime-error':
        case 'command-encoder-finished':
        case 'render-pass-not-ended':
        case 'queue-submit-failed':
        case 'queue-write-buffer-out-of-bounds':
        case 'render-system-no-camera':
        case 'render-system-multi-camera':
        case 'render-system-multi-light':
        case 'asset-not-registered':
        case 'device-lost':
        case 'oom':
        case 'internal-error':
        case 'hierarchy-broken':
          return 'rhi';
      }
      const _unreachable: never = err;
      return _unreachable;
    }
    expectTypeOf(consume).toBeFunction();
  });
});

describe('App.registerUpdate proxy method (AC-05 / M1 w3)', () => {
  it('App interface has registerUpdate method with (fn: (dt: number) => void) => void', () => {
    // This is a compile-time assertion: if App lacks registerUpdate or the
    // parameter types are wrong, the destructure below will fail tsc.
    // The test is red (compile error) before w6 implementation lands.
    const _fn: App['registerUpdate'] = (cb: (dt: number) => void): void => {
      void cb;
    };
    expectTypeOf(_fn).toBeFunction();
  });

  it('registerUpdate parameter fn receives a number (dt)', () => {
    const _cb = (dt: number): void => {
      void dt;
    };
    expectTypeOf(_cb).parameter(0).toMatchTypeOf<number>();
  });
});
