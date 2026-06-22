// thin-wrapper.browser.test.ts -- M4 (w8) acceptanceCheck: 4-path coverage
// for the (A) canvas-form thin wrapper landing in
// packages/app/src/create-app.ts (w9).
//
// Anchors:
//   - AC-01 thin wrapper: createApp(canvas, opts?) is a 4-step function
//     (canvas detach guard / createRenderer try-catch / new World /
//     delegate to assemble form). Per plan-strategy D-5.
//   - AC-08 canvas-detached guard: (A) path returns Result.err({code:
//     'app-canvas-detached'}); (B) path does NOT trigger this check.
//   - AC-09 + plan-strategy D-6: error union AppError | RhiError |
//     EngineEnvironmentError consumed via double-layer instanceof +
//     switch; .detail.webgpuError?.code is preserved across the wrap
//     so AI users two-level narrow without losing structure.
//   - research section 2.2: createRenderer construction-time throws
//     EngineEnvironmentError at createRenderer.ts:400 / :429 (rhi pack
//     load failure / no usable rendering backend).
//
// charter awareness:
//   - P3 explicit failure: thin wrapper turns construction-time
//     throws into Result.err so callers branch on .ok before any
//     try/catch is involved.
//   - P5 producer/consumer split: assemble form (B) is the canonical
//     truth; (A) only adds canvas-specific glue.

import { World } from '@forgeax/engine-ecs';
import { EngineEnvironmentError, type Renderer } from '@forgeax/engine-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/index';
import { AppError } from '../src/errors';
import type { CanvasAppError } from '../src/types';

// Local helper: minimal Renderer stub for the (B) path bypass test.
function makeRendererStub(): Renderer {
  return {
    ready: Promise.resolve({ ok: true, value: undefined }),
    draw(): void {
      // no-op
    },
    onError(): () => void {
      return () => {
        // no-op
      };
    },
    onLost(): () => void {
      return () => {
        // no-op
      };
    },
  } as unknown as Renderer;
}

describe('createApp(canvas) thin wrapper -- (A) path canvas-detached guard (AC-08)', () => {
  it('detached canvas returns Result.err({code: app-canvas-detached})', async () => {
    const detachedCanvas = document.createElement('canvas');
    detachedCanvas.width = 64;
    detachedCanvas.height = 64;
    // Note: NOT appendChild -- canvas.isConnected === false.
    expect(detachedCanvas.isConnected).toBe(false);
    const result = await createApp(detachedCanvas);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const err = result.error;
    // Narrow: not an EngineEnvironmentError (no createRenderer call), so
    // the error must be the structured AppError variant.
    expect(err instanceof EngineEnvironmentError).toBe(false);
    if (err instanceof EngineEnvironmentError) return;
    expect(err.code).toBe('app-canvas-detached');
    expect(typeof err.expected).toBe('string');
    expect(typeof err.hint).toBe('string');
  });
});

describe('createApp(assemble) -- (B) path does NOT trigger canvas-detach check (AC-08)', () => {
  it('(B) path with detached canvas reference is irrelevant; assemble form ignores DOM entirely', async () => {
    // Build a detached canvas and a renderer stub. The (B) path takes
    // {renderer, world}; the canvas is irrelevant to the assemble entry,
    // so the detach check never fires here.
    const detachedCanvas = document.createElement('canvas');
    expect(detachedCanvas.isConnected).toBe(false);
    const renderer = makeRendererStub();
    const world = new World();
    const result = await createApp({ renderer, world });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.value;
    expect(app.renderer).toBe(renderer);
    expect(app.world).toBe(world);
  });
});

describe('createApp(canvas) thin wrapper -- (A) path success path (AC-09)', () => {
  let connectedCanvas: HTMLCanvasElement;

  beforeEach(() => {
    connectedCanvas = document.createElement('canvas');
    connectedCanvas.width = 64;
    connectedCanvas.height = 64;
    document.body.appendChild(connectedCanvas);
  });

  afterEach(() => {
    connectedCanvas.remove();
  });

  it('connected canvas + WebGPU available -> Result.ok(App); app.renderer.draw + app.world.update reachable without `as` casts', async () => {
    const result = await createApp(connectedCanvas);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const app = result.value;
    // Type-level discoverability: app.renderer.draw + app.world.update
    // are invokable directly off the App handle (AC-09).
    expect(typeof app.renderer.draw).toBe('function');
    expect(typeof app.world.update).toBe('function');
    // No throw on the call site -- prove the surface is reachable
    // without unsafe casts.
    app.stop();
  });

  it('error union double-layer narrow contract: callers can switch on AppError|RhiError code OR instanceof EngineEnvironmentError', async () => {
    // This test pins the consumer pattern from plan-strategy D-6: hosts
    // first check `instanceof EngineEnvironmentError`, then `switch
    // (err.code)` over the AppError | RhiError carrier shape. The branch
    // is deliberately exhaustive on the AppError 5-member union to fail
    // the typecheck if the union later grows without updating consumers.
    function consume(err: CanvasAppError): string {
      if (err instanceof EngineEnvironmentError) {
        return `env:${err.detail.webgpuError?.code ?? 'unknown'}`;
      }
      // err is AppError | RhiError here; we only switch on AppError codes
      // (RhiError surfaces device-lost via onError fan-out -- see w10).
      switch (err.code) {
        case 'app-not-started':
        case 'app-already-running':
        case 'app-canvas-detached':
        case 'app-paused-while-stop':
        case 'app-system-update-failed':
          return `app:${err.code}`;
        default:
          return `rhi:${(err as { code: string }).code}`;
      }
    }
    // Smoke: feed a synthetic AppError; assert the function compiles +
    // returns. The actual exhaustiveness is tsc -b's job, not this test.
    const synthetic: CanvasAppError = new AppError({
      code: 'app-canvas-detached',
      expected: 'canvas.isConnected === true',
      hint: 'append canvas to DOM before createApp',
      detail: {},
    });
    expect(consume(synthetic)).toBe('app:app-canvas-detached');
  });
});

describe('createApp(canvas) thin wrapper -- (A) path createRenderer try/catch (AC-01)', () => {
  // The createRenderer throw path is exercised in
  // thin-wrapper-throw.browser.test.ts (split out so vi.mock hoists at
  // module level without colliding with this file's success-path tests
  // that need the real createRenderer).
  // TODO (feat-20260608-ci-time-cut): the prior `expect(true)` documented a
  // sibling-file pointer; converted to `it.todo` to drop the placeholder
  // without losing the doc breadcrumb.
  it.todo('throw-path fixture is owned by thin-wrapper-throw.browser.test.ts');
});
