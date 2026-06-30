// w5td - runtime public surface negative assertions (feat-20260516-console-dependency-inversion).
//
// Asserts the post-M5 dependency-inversion contract on the Renderer surface:
//   1. `Renderer` interface no longer exposes a `startConsole` method.
//   2. `StartConsoleOptions` / `ConsoleHandle` are not importable from
//      `@forgeax/engine-runtime` (host wires inspector via `new Registry()`
//      + `wireDefaultInspectors()` + `startConsoleServer()` from
//      `@forgeax/engine-remote`; plan-strategy section 2.8 one-shot cut).
//
// Source: requirements AC-11 (Renderer.startConsole literally absent) +
// plan-strategy section 5.3 key test points (type-level surface assertion).

import type { RhiError } from '@forgeax/engine-rhi';
import type {
  // @ts-expect-error - ConsoleHandle must not be exported from @forgeax/engine-runtime
  ConsoleHandle as _ConsoleHandleRemoved,
  // @ts-expect-error - StartConsoleOptions must not be exported from @forgeax/engine-runtime
  StartConsoleOptions as _StartConsoleOptionsRemoved,
} from '@forgeax/engine-runtime';
import { describe, expectTypeOf, it } from 'vitest';
import type { RuntimeError, SkyboxCubemapNotReadyError } from '../errors';
import type { PostProcessError } from '../post-process-errors';
import type { Renderer, RendererErrorListener } from '../renderer';

// Reference the imported aliases so TS does not strip them before reaching
// the @ts-expect-error attached to each import specifier.
type _UnusedSink = _StartConsoleOptionsRemoved | _ConsoleHandleRemoved;

describe('w5td runtime surface - Renderer.startConsole literally absent (AC-11)', () => {
  it('Renderer has no startConsole property (TS index access fails)', () => {
    // @ts-expect-error - 'startConsole' must not exist on Renderer
    type _StartConsoleAbsent = Renderer['startConsole'];
    // Sanity: known members still present (regression baseline).
    type RendererKey = keyof Renderer;
    expectTypeOf<'backend'>().toExtend<RendererKey>();
    expectTypeOf<'draw'>().toExtend<RendererKey>();
    expectTypeOf<'dispose'>().toExtend<RendererKey>();
    expectTypeOf<'onLost'>().toExtend<RendererKey>();
    expectTypeOf<'onError'>().toExtend<RendererKey>();
    expectTypeOf<'ready'>().toExtend<RendererKey>();
  });
});

describe('onError channel widened to RhiError | RuntimeError | PostProcessError (Round-2 [F-3])', () => {
  it('RendererErrorListener parameter is the RhiError | RuntimeError | PostProcessError union', () => {
    // The listener parameter must accept all three error families so the
    // 'skybox-cubemap-not-ready' RuntimeError + 'ssao-storage-buffer-unavailable'
    // PostProcessError fan out with no `as any` cast.
    expectTypeOf<RendererErrorListener>()
      .parameter(0)
      .toEqualTypeOf<RhiError | RuntimeError | PostProcessError>();
  });

  it('exhaustive switch narrows RuntimeError arms to the concrete class', () => {
    // AI-user view: switch (e.code) over the union narrows the runtime arms.
    const probe = (e: RhiError | RuntimeError): SkyboxCubemapNotReadyError | undefined => {
      switch (e.code) {
        case 'skybox-cubemap-not-ready':
          // e narrows to SkyboxCubemapNotReadyError; .detail.handle is a number.
          expectTypeOf(e.detail.handle).toEqualTypeOf<number>();
          return e;
        default:
          return undefined;
      }
    };
    expectTypeOf(probe).returns.toEqualTypeOf<SkyboxCubemapNotReadyError | undefined>();
  });

  it('RhiError arms remain reachable in the same switch (no regression)', () => {
    const probe = (e: RhiError | RuntimeError): string => {
      switch (e.code) {
        case 'limit-exceeded':
          // e narrows to RhiError; .code is a RhiErrorCode literal.
          expectTypeOf(e.code).toEqualTypeOf<'limit-exceeded'>();
          return e.code;
        case 'device-lost':
          return e.code;
        default:
          return 'other';
      }
    };
    expectTypeOf(probe).returns.toEqualTypeOf<string>();
  });
});

declare const __sink: _UnusedSink | undefined;
void __sink;
