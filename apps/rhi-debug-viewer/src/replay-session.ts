// replay-session.ts — standalone WebGPU replay device management (zero React).
//
// Creates a fresh WebGPU device via rhi.requestAdapter + adapter.requestDevice,
// wraps it as an RhiDevice, imports standalone createShaderModule from
// @forgeax/engine-rhi-webgpu (AC-07), and calls createReplay once — reusing
// the same session across all draw selections (C7).
//
// Constraints:
//   AC-07: shader compilation via @forgeax/engine-rhi-webgpu standalone createShaderModule.
//   AC-15 / D-8: powerPreference on requestAdapter first param, NOT requestDevice.
//   C7: createReplay called once; subsequent calls return the cached session.
//   D-2: no device.createShaderModule (ghost API, removed in fix-f3).
//
// Related: plan-strategy D-2/D-8; requirements AC-07/AC-15/C1/C7; research Finding 3/Finding 4.

import type { RhiDevice } from '@forgeax/engine-rhi';
import type { Replay, Tape } from '@forgeax/engine-rhi-debug';
import { createReplay } from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import type { Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

// ============================================================================
// Error type
// ============================================================================

export interface ReplaySessionError {
  readonly kind: 'no-webgpu' | 'adapter-error' | 'device-error' | 'replay-error';
  readonly message: string;
}

// ============================================================================
// ReplaySession
// ============================================================================

/** A constructed replay session with the device and replay handle. */
export interface ReplaySession {
  readonly replay: Replay;
  readonly device: RhiDevice;
}

// ============================================================================
// Module-level cache
// ============================================================================

/** @internal Cached single replay session, reused across draw selections (C7). */
let _session: ReplaySession | null = null;

// ============================================================================
// ensureReplaySession
// ============================================================================

/**
 * Ensure a replay session exists for the given tape, creating one if needed.
 *
 * On first call: requests a high-performance WebGPU device via the RHI
 * two-step path (rhi.requestAdapter → adapter.requestDevice), then calls
 * createReplay(tape, device, createShaderModule) to build the replay.
 * On subsequent calls: returns the cached session (C7 reuse).
 *
 * @param tape - The deserialized tape to replay.
 * @returns Ok(ReplaySession) with the replay handle and device, or Err on failure.
 */
export async function ensureReplaySession(
  tape: Tape,
): Promise<Result<ReplaySession, ReplaySessionError>> {
  if (_session !== null) {
    return ok(_session);
  }

  // AC-09: check navigator.gpu before any GPU attempt
  if (typeof navigator === 'undefined' || navigator.gpu === undefined) {
    return err({
      kind: 'no-webgpu',
      message: 'WebGPU is not available in this browser',
    });
  }

  // D-8 / AC-15: powerPreference on requestAdapter first param
  const adapterResult = await rhi.requestAdapter({
    powerPreference: 'high-performance',
  });
  if (!adapterResult.ok) {
    return err({
      kind: 'adapter-error',
      message: `GPU adapter request failed: ${adapterResult.error.code}`,
    });
  }

  // Request device without requiredFeatures — same-machine replay naturally
  // satisfies the caps requirements (replayer.ts caps fail-fast at createReplay).
  const deviceResult = await adapterResult.value.requestDevice();
  if (!deviceResult.ok) {
    return err({
      kind: 'device-error',
      message: `GPU device request failed: ${deviceResult.error.code}`,
    });
  }

  const device = deviceResult.value;

  // AC-07 / D-2: standalone createShaderModule from @forgeax/engine-rhi-webgpu.
  // Falsification escape hatch: when window.__forgeaxFalsifyNoShaderModule is set,
  // pass undefined as createShaderModuleFn — replayer skips shader compilation,
  // pipeline is incomplete, RT renders all-black (plan-strategy §5.4 / w19).
  const falsify =
    typeof window !== 'undefined' &&
    (window as unknown as Record<string, unknown>).__forgeaxFalsifyNoShaderModule === true;
  const replayResult = createReplay(tape, device, falsify ? undefined : createShaderModule);
  if (!replayResult.ok) {
    return err({
      kind: 'replay-error',
      message: `createReplay failed: ${replayResult.error.code}`,
    });
  }

  _session = { replay: replayResult.value, device };
  return ok(_session);
}
