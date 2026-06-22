// @forgeax/engine-rhi-debug/src/rpc-bridge -- wireDebugRhiInspector function-injection adapter.
//
// Registers 3 RPC methods (debug.captureFrame / debug.inspectAt / debug.replayDispose)
// on a Registry instance. Designed for the function-injection pattern used by
// wireDefaultInspectors: host imports wireDebugRhiInspector and passes it as the
// debugRhi field of WireDefaultInspectorsInjectors. console never value-imports
// @forgeax/engine-rhi-debug (per AC-17 grep gate).
//
// The adapter owns a module-level Recorder reference (set by attachRecorder) and
// InspectorCache instance. All 3 methods operate on this shared instance.
//
// Related: requirements IS-6 / AC-17 / AC-18 / AC-19 / AC-20; m7-1.

import type { Registry } from '@forgeax/engine-types';

/**
 * Recorder handle -- the shape that createApp sets up via FORGEAX_ENGINE_RHI_DEBUG=1.
 * Exposed as a minimal interface so the rpc-bridge does not depend on the
 * full recorder module surface.
 */
export interface DebugRhiAdapter {
  /** Arm the recorder for N frames of capture. Returns the run metadata after finalize. */
  captureFrames(
    frames: number,
    label?: string,
  ): Promise<{
    readonly tapes: Array<{
      readonly frameIdx: number;
      readonly runId: string;
      readonly tapePath: string;
      readonly reportPath: string;
    }>;
  }>;
  /** Inspect a specific draw index within a tape. */
  inspectAt(
    tapePath: string,
    drawIdx: number,
    fields?: readonly ('bindings' | 'drawCall' | 'rt')[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<Record<string, unknown>>;
  /** Dispose a replay session for the given tape. */
  replayDispose(tapePath: string): Promise<{ readonly ok: boolean }>;
}

/**
 * Wire the 3 debug.* RPC methods onto a Registry instance.
 *
 * After a successful invocation the Registry carries:
 *   methods: debug.captureFrame / debug.inspectAt / debug.replayDispose
 *
 * All three methods route through the supplied DebugRhiAdapter, which
 * is created by createApp during FORGEAX_ENGINE_RHI_DEBUG=1 bootstrap. When the
 * adapter is not set (FORGEAX_ENGINE_RHI_DEBUG !== '1'), calls to debug.* methods
 * return an InspectorError with code 'rpc-target-not-wired'.
 *
 * @param reg - The Registry instance to register methods on.
 * @param adapter - The DebugRhiAdapter created during FORGEAX_ENGINE_RHI_DEBUG=1 bootstrap.
 */
export function wireDebugRhiInspector(
  reg: Registry,
  adapter: DebugRhiAdapter,
):
  | { ok: true; value: void }
  | { ok: false; error: { code: string; expected: string; hint: string } } {
  const r1 = reg.registerMethod('debug.captureFrame', async (params: unknown) => {
    const p = params as { frames?: number; label?: string } | undefined;
    const frames = p?.frames ?? 1;
    const label = p?.label;
    const result = await adapter.captureFrames(frames, label);
    return result;
  });
  if (!r1.ok) return r1;

  const r2 = reg.registerMethod('debug.inspectAt', async (params: unknown) => {
    const p = params as {
      tapePath: string;
      drawIdx: number;
      fields?: ('bindings' | 'drawCall' | 'rt')[];
    };
    const result = await adapter.inspectAt(p.tapePath, p.drawIdx, p.fields);
    return result;
  });
  if (!r2.ok) return r2;

  const r3 = reg.registerMethod('debug.replayDispose', async (params: unknown) => {
    const p = params as { tapePath: string };
    const result = await adapter.replayDispose(p.tapePath);
    return result;
  });
  if (!r3.ok) return r3;

  return { ok: true, value: undefined };
}
