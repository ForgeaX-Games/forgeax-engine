// @forgeax/engine-runtime -- environment cluster error class.
//
// feat-20260704-runtime-tier1-decomposition M2 / w8 (D-3): the fifth cluster.
// EngineEnvironmentError is thrown at construction time (createRenderer
// rejects) and is intentionally NEVER fanned out through onError, so it was
// never a member of the eliminated RuntimeError class union. It carries no
// `.code` field (it predates the closed-union error model), so this cluster
// has no *ErrorCode code union -- the class itself is the whole cluster
// (research Finding C2: four-domain division left it dangling; D-3 gives it a
// dedicated home). Class + detail shape preserved byte-for-byte (OOS-4).

import type { RhiError } from '@forgeax/engine-rhi';

/**
 * Structured signal carrier for the `EngineEnvironmentError.detail` field.
 *
 * When the WebGPU probe fails via an RHI Result.err, the original `RhiError`
 * structured object is preserved directly as `webgpuError` — AI consumers can
 * read `.code` / `.expected` / `.hint` by property access.
 *
 * w20 / M4: at least one field (webgpuError or wgpuError) is always populated
 * when an EngineEnvironmentError is thrown. The detail object is never empty.
 * AI users can safely do `switch (e.detail.webgpuError?.code)` knowing that
 * at least one branch will match.
 */
export interface EngineEnvironmentErrorDetail {
  /** WebGPU-path RhiError structured object (with .code / .expected / .hint / .detail); falls back to a plain Error on non-RHI paths. */
  readonly webgpuError?: RhiError | Error | undefined;
  /**
   * Channel 3 fallback error (rhi-wgpu dynamic import + wasm load failure).
   * Populated when Channel 2 fails AND the Channel 3 retry also fails.
   * AI users exhaustively `switch (e.detail.wgpuError?.code)` to understand
   * why both channels are unavailable.
   */
  readonly wgpuError?: RhiError | Error | undefined;
}

/**
 * Thrown by `createRenderer` when no usable rendering backend can be acquired.
 * The probe failure is recorded so callers can surface it for diagnostics.
 *
 * AI consumers access `.detail.webgpuError.code` etc. by property (charter
 * proposition 4 explicit failure + proposition 5 consistent abstraction).
 */
export class EngineEnvironmentError extends Error {
  /** Brief reason describing why no backend was usable. */
  readonly reason: string;
  /** WebGPU-side probe error: `RhiError` (three fields + closed union) or plain `Error`. */
  readonly webgpuError?: RhiError | Error | undefined;
  /**
   * Channel 3 (rhi-wgpu) fallback error.
   * Populated when both Channel 2 and the Channel 3 retry fail.
   */
  readonly wgpuError?: RhiError | Error | undefined;
  /** Structured detail container: AI consumers access `.detail.webgpuError?.code` for safe chained access. */
  readonly detail: EngineEnvironmentErrorDetail;

  constructor(reason: string, detail?: EngineEnvironmentErrorDetail) {
    super(`forgeax-engine: no usable backend (${reason})`);
    this.name = 'EngineEnvironmentError';
    this.reason = reason;
    const webgpuError = detail?.webgpuError;
    if (webgpuError !== undefined) {
      this.webgpuError = webgpuError;
    }
    const wgpuError = detail?.wgpuError;
    if (wgpuError !== undefined) {
      this.wgpuError = wgpuError;
    }
    this.detail = {
      ...(webgpuError !== undefined ? { webgpuError } : {}),
      ...(wgpuError !== undefined ? { wgpuError } : {}),
    };
  }
}
