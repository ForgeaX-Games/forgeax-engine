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

import type { AssetRuntimeError } from '@forgeax/engine-assets-runtime';
import type { RhiError } from '@forgeax/engine-rhi';
import type {
  // @ts-expect-error - ConsoleHandle must not be exported from @forgeax/engine-runtime
  ConsoleHandle as _ConsoleHandleRemoved,
  // @ts-expect-error - StartConsoleOptions must not be exported from @forgeax/engine-runtime
  StartConsoleOptions as _StartConsoleOptionsRemoved,
} from '@forgeax/engine-runtime';
import type { ImageError } from '@forgeax/engine-types';
import { describe, expectTypeOf, it } from 'vitest';
import type { EquirectProjectionFailedError, RenderError } from '../errors/render';
import type { SkinError } from '../errors/skin';
import type { PostProcessError } from '../post-process-errors';
import type { Renderer, RendererErrorListener } from '../renderer';

// feat-20260704-runtime-tier1-decomposition M2 / w12: the eliminated top-level
// RuntimeError aggregate union (D-3) reconstituted as a test-local alias so the
// onError-channel type assertions below stay byte-identical (AC-09). Equal to
// RenderError | AssetRuntimeError | SkinError (the 27-class fanned-out set); it
// doubles as a check that RendererError equals the pre-decomposition union.
type RuntimeLayerError = RenderError | AssetRuntimeError | SkinError;

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

describe('onError channel includes concrete image capability errors', () => {
  it('RendererErrorListener parameter is the RhiError | RuntimeError | PostProcessError union', () => {
    // The listener parameter must accept all three error families so the
    // 'equirect-projection-failed' RuntimeError
    // PostProcessError fan out with no `as any` cast.
    expectTypeOf<RendererErrorListener>()
      .parameter(0)
      .toEqualTypeOf<RhiError | ImageError | RuntimeLayerError | PostProcessError>();
  });

  it('exhaustive switch narrows RuntimeError arms to the concrete class', () => {
    // AI-user view: switch (e.code) over the union narrows the runtime arms.
    const probe = (e: RhiError | RuntimeLayerError): EquirectProjectionFailedError | undefined => {
      switch (e.code) {
        case 'equirect-projection-failed':
          // e narrows to EquirectProjectionFailedError; .detail.handle is a number.
          expectTypeOf(e.detail.handle).toEqualTypeOf<number>();
          return e;
        default:
          return undefined;
      }
    };
    expectTypeOf(probe).returns.toEqualTypeOf<EquirectProjectionFailedError | undefined>();
  });

  it('RhiError arms remain reachable in the same switch (no regression)', () => {
    const probe = (e: RhiError | RuntimeLayerError): string => {
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
