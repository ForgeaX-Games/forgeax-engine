// types.test-d.ts -- compile-time fixture for the
// AppErrorCode 12-member closed union + .detail discriminated per code +
// 30-arm exhaustive switch over (AppError | RhiError) + dual-layer
// instanceof EngineEnvironmentError + switch (err.code) pattern (D-6).
//
// Anchors:
//   - requirements AC-07: type-level assertions on the closed union and
//     discriminated detail; exhaustive switch must compile under tsc
//     strict mode without falling through to a `default` arm.
//   - plan-strategy D-3: AppErrorCode excludes 'app-device-lost'
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

import {
  AppError,
  type AppDetailCanvasDetached,
  type AppDetailExecutionBootstrapFailed,
  type AppDetailExecutionDeadlineExceeded,
  type AppDetailExecutionKernelFailed,
  type AppDetailExecutionRebuildFailed,
  type AppDetailExecutionStaleWorld,
  type AppDetailExecutionTierUnavailable,
  type AppDetailEmpty,
  type AppDetailPointerLockFailed,
  type AppDetailSystemUpdateFailed,
  type AppErrorCode,
  type AppErrorDetail,
} from '../src/errors';
import type {
  LoadGameDetailImportFailed,
  LoadGameDetailInvalidFormat,
  LoadGameDetailModuleNotFound,
  LoadGameErrorDetail,
} from '../src/load-game-errors';
import type { App } from '../src/types';

describe('AppErrorCode is the 12-member closed union (AC-07)', () => {
  it('matches the exact twelve-code owner', () => {
    expectTypeOf<AppErrorCode>().toEqualTypeOf<
      | 'app-not-started'
      | 'app-already-running'
      | 'app-canvas-detached'
      | 'app-paused-while-stop'
      | 'app-system-update-failed'
      | 'app-pointer-lock-failed'
      | 'app-execution-tier-unavailable'
      | 'app-execution-bootstrap-failed'
      | 'app-execution-deadline-exceeded'
      | 'app-execution-kernel-failed'
      | 'app-execution-stale-world'
      | 'app-execution-rebuild-failed'
    >();
  });

  it('is assignable from each current string literal', () => {
    expectTypeOf<'app-not-started'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-already-running'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-canvas-detached'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-paused-while-stop'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-system-update-failed'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-pointer-lock-failed'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-execution-tier-unavailable'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-execution-bootstrap-failed'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-execution-deadline-exceeded'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-execution-kernel-failed'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-execution-stale-world'>().toMatchTypeOf<AppErrorCode>();
    expectTypeOf<'app-execution-rebuild-failed'>().toMatchTypeOf<AppErrorCode>();
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

  it('execution variants preserve constructor inference and detail narrowing', () => {
    const unavailable = new AppError({
      code: 'app-execution-tier-unavailable',
      expected: '',
      hint: '',
      detail: {
        requestedTier: 'shared',
        missingCapabilities: ['sharedArrayBuffer'],
        sharedEvidencePassed: true,
      },
    });
    const bootstrap = new AppError({
      code: 'app-execution-bootstrap-failed',
      expected: '',
      hint: '',
      detail: { phase: 'bootstrap', moduleUrl: 'bootstrap.mjs', cause: new Error('boom') },
    });
    const deadline = new AppError({
      code: 'app-execution-deadline-exceeded',
      expected: '',
      hint: '',
      detail: { phase: 'frame', timeoutMs: 100 },
    });
    const kernel = new AppError({
      code: 'app-execution-kernel-failed',
      expected: '',
      hint: '',
      detail: {
        kernelName: 'sum',
        worldIdentity: 'world-1',
        cause: new Error('partial'),
        partialWrite: true,
        retryable: false,
      },
    });
    const stale = new AppError({
      code: 'app-execution-stale-world',
      expected: '',
      hint: '',
      detail: { expectedIdentity: 'world-2', receivedIdentity: 'world-1', messageKind: 'ready' },
    });
    const rebuild = new AppError({
      code: 'app-execution-rebuild-failed',
      expected: '',
      hint: '',
      detail: { worldIdentity: null, cause: new Error('rebuild') },
    });
    if (unavailable.code === 'app-execution-tier-unavailable') {
      expectTypeOf(unavailable.detail).toEqualTypeOf<AppDetailExecutionTierUnavailable>();
    }
    if (bootstrap.code === 'app-execution-bootstrap-failed') {
      expectTypeOf(bootstrap.detail).toEqualTypeOf<AppDetailExecutionBootstrapFailed>();
    }
    if (deadline.code === 'app-execution-deadline-exceeded') {
      expectTypeOf(deadline.detail).toEqualTypeOf<AppDetailExecutionDeadlineExceeded>();
    }
    if (kernel.code === 'app-execution-kernel-failed') {
      expectTypeOf(kernel.detail).toEqualTypeOf<AppDetailExecutionKernelFailed>();
    }
    if (stale.code === 'app-execution-stale-world') {
      expectTypeOf(stale.detail).toEqualTypeOf<AppDetailExecutionStaleWorld>();
    }
    if (rebuild.code === 'app-execution-rebuild-failed') {
      expectTypeOf(rebuild.detail).toEqualTypeOf<AppDetailExecutionRebuildFailed>();
    }
  });
});

describe('error detail unions derive from their code resolvers', () => {
  it('preserves the complete AppError detail union', () => {
    expectTypeOf<AppErrorDetail>().toEqualTypeOf<
      | AppDetailEmpty
      | AppDetailCanvasDetached
      | AppDetailSystemUpdateFailed
      | AppDetailPointerLockFailed
      | AppDetailExecutionTierUnavailable
      | AppDetailExecutionBootstrapFailed
      | AppDetailExecutionDeadlineExceeded
      | AppDetailExecutionKernelFailed
      | AppDetailExecutionStaleWorld
      | AppDetailExecutionRebuildFailed
    >();
  });

  it('preserves the complete LoadGameError detail union', () => {
    expectTypeOf<LoadGameErrorDetail>().toEqualTypeOf<
      | LoadGameDetailModuleNotFound
      | LoadGameDetailInvalidFormat
      | LoadGameDetailImportFailed
    >();
  });
});

describe('exhaustive switch over (AppError | RhiError) compiles with no default arm (AC-07)', () => {
  it('covers all 30 codes (12 AppError + 18 RhiError) without a default fallback', () => {
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
        case 'app-execution-tier-unavailable':
        case 'app-execution-bootstrap-failed':
        case 'app-execution-deadline-exceeded':
        case 'app-execution-kernel-failed':
        case 'app-execution-stale-world':
        case 'app-execution-rebuild-failed':
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
        case 'app-execution-tier-unavailable':
        case 'app-execution-bootstrap-failed':
        case 'app-execution-deadline-exceeded':
        case 'app-execution-kernel-failed':
        case 'app-execution-stale-world':
        case 'app-execution-rebuild-failed':
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
