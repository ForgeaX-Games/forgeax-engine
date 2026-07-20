// @forgeax/engine-rhi-null/src/canvas-context - headless canvas context (R-1).
//
// The headless backend has no real canvas. RhiNullCanvasContext satisfies the
// RhiCanvasContext interface as no-ops: configure returns ok (a headless
// configure is vacuously successful), unconfigure is void, getConfiguration
// returns undefined (no real configuration).
//
// getCurrentTexture returns a legal Texture brand so the swap-chain
// acquisition path succeeds — without this the entire render-frame path fails
// at the first swap-chain access, blocking all dogfood testing of
// render-graph-to-RhiNull command-flow. The returned Texture carries no real
// pixels; it is opaque-handle syntactically valid and structurally sound for
// CI structural unit tests.
//
// acquireCanvasContext (mounted on the rhi singleton, R-1) accepts any
// canvas / null / undefined and returns ok(canvasContext) so the facade
// never crashes and canvas-dependent paths exercise through to the
// render-graph level.
//
// Related: requirements AC-11 (canvas ctx structured behaviour) — the
// context itself succeeds; AC-11 verify tests confirm the getCurrentTexture
// brand is a valid opaque handle and downstream consumption doesn't crash.
// Research Finding A4 (acquireCanvasContext on singleton) + A3
// (rhi-not-available legal); plan-strategy §4 R-1; charter P3.

import type {
  CanvasConfiguration,
  Result,
  RhiCanvasContext,
  RhiError as RhiErrorType,
  Texture,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';

/**
 * Headless canvas context. configure succeeds vacuously; getCurrentTexture
 * mints a legal opaque-handle Texture brand so the swap-chain acquisition path
 * never blocks frame rendering in headless CI.
 */
export class RhiNullCanvasContext implements RhiCanvasContext {
  configure(_desc: CanvasConfiguration): Result<void, RhiErrorType> {
    return ok(undefined);
  }

  unconfigure(): void {}

  getConfiguration(): CanvasConfiguration | undefined {
    return undefined;
  }

  getCurrentTexture(): Result<Texture, RhiErrorType> {
    // A brand is a compile-time unique symbol with no runtime field, so a plain
    // object cast is a structurally valid Texture (research Finding A6). No real
    // pixels; the command-stream path only needs a legal handle to thread on.
    return ok({} as unknown as Texture);
  }
}

/**
 * Acquire a canvas context. The headless backend returns ok(context) so the
 * createRenderer context-acquisition step succeeds. The context's
 * getCurrentTexture mints a legal Texture brand once a bookkeeper is attached.
 *
 * R-1: this is mounted on the rhi singleton so Channel 1's facade never
 * crashes on a missing acquireCanvasContext.
 */
export function acquireCanvasContext(
  _canvas?: HTMLCanvasElement | OffscreenCanvas | null | undefined,
): Result<RhiCanvasContext, RhiErrorType> {
  return ok(new RhiNullCanvasContext());
}
