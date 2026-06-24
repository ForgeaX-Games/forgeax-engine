// @forgeax/engine-rhi-debug/src/recorder-core -- node-free capture primitives.
//
// Purpose: carrier of finalizeToMemory / generateRunId / waitForRecorderIdle /
// assembleReport -- all four operate with zero `node:*` static imports and are
// therefore importable from both browser (capture-browser) and Node (recorder,
// adapter) contexts.
//
// Split-file design (plan-strategy D-2):
//   recorder-core.ts  -- this file, zero node deps
//   recorder.ts       -- finalize() = finalizeToMemory + fs tail (Node-only)
//
// Related: requirements AC-01/AC-02/AC-03; plan-strategy D-2/D-3/D-7/D-9.

import { err, ok } from '@forgeax/engine-types';
import { DebugError } from './errors';
import type { PassOffset } from './tape-format';
import { computePassOffsets, serializeTape } from './tape-format';

// Re-export PassOffset for consumers that import from recorder-core
export type { PassOffset } from './tape-format';

export { TAPE_FORMAT_VERSION } from './tape-format';

// ============================================================================
// generateRunId -- dual-source (globalThis.crypto || Math.random fallback)
// ============================================================================

/**
 * Generate a runId in the format YYYY-MM-DDTHH-mm-ss-xxxx.
 *
 * Dual-source strategy (research F-2):
 * - Primary: globalThis.crypto.getRandomValues (browsers, Node 19+)
 * - Fallback: Math.random (last-resort for environments without crypto)
 *
 * The nonce segment (xxxx) is 2 random bytes rendered as 4 hex characters.
 * Zero node:* static import.
 */
export function generateRunId(): string {
  const pad2 = (n: number) => n.toString(16).padStart(2, '0');
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    const nonceBytes = new Uint8Array(2);
    globalThis.crypto.getRandomValues(nonceBytes);
    const nonce = pad2(nonceBytes[0] ?? 0) + pad2(nonceBytes[1] ?? 0);
    return `${iso}-${nonce}`;
  }
  // Fallback for environments without globalThis.crypto
  const nonce = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `${iso}-${nonce}`;
}

// ============================================================================
// waitForRecorderIdle -- pure setTimeout poll, zero node deps
// ============================================================================

/**
 * Poll recorder state until idle (recording finished) or timeout.
 *
 * Polls every 16ms (one rAF tick). Moved from adapter.ts:236-268
 * (plan-strategy D-7) so both adapter.ts and capture-browser.ts
 * import the same SSOT function.
 */
export function waitForRecorderIdle(
  debugInst: { getState(): string; getEvents(): readonly unknown[] },
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const state = debugInst.getState();
      if (state === 'idle' && debugInst.getEvents().length > 0) {
        resolve();
        return;
      }
      if (state === 'error') {
        reject(
          new DebugError({
            code: 'recorder-not-attached',
            expected: 'recorder transitions back to idle within timeout',
            hint: 'recorder entered error state during capture; call disposeError() and retry',
          }),
        );
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(
          new DebugError({
            code: 'frame-end-hook-missing',
            expected: `host rAF loop drives onFrameEnd within ${String(timeoutMs)} ms`,
            hint: 'recorder did not return to idle; verify createRenderer._onFrameEnd is wired and the rAF loop is running',
          }),
        );
        return;
      }
      setTimeout(tick, 16);
    };
    tick();
  });
}

// ============================================================================
// assembleReport -- single-writer report assembly (plan-strategy D-3)
// ============================================================================

export interface AssembledReport {
  readonly header: unknown;
  readonly events: unknown;
  readonly passOffsets: readonly PassOffset[];
  readonly valid: boolean;
}

/**
 * Assemble a tape report from already-serialized json and computed pass offsets.
 *
 * Single-writer pattern (plan-strategy D-3): both Node finalize() and the
 * HTTP /__forgeax-debug/tape endpoint call this one function, guaranteeing
 * byte-identical report shape on both paths (derive-don't-duplicate).
 */
export function assembleReport(args: {
  readonly json: string;
  readonly passOffsets: readonly PassOffset[];
  readonly valid: boolean;
}): AssembledReport {
  const parsed = JSON.parse(args.json) as { header: unknown; events: unknown };
  return {
    header: parsed.header,
    events: parsed.events,
    passOffsets: args.passOffsets,
    valid: args.valid,
  };
}

// ============================================================================
// finalizeToMemory -- node-free tape finalization
// ============================================================================

export interface FinalizeToMemoryValue {
  readonly runId: string;
  readonly json: string;
  readonly blob: Uint8Array;
  readonly passOffsets: readonly PassOffset[];
  readonly valid: boolean;
}

/**
 * Finalize a tape capture entirely in-memory (zero fs).
 *
 * Composes getTape() + serializeTape + computePassOffsets + generateRunId.
 * Returns the full serialized tape data without touching the filesystem.
 *
 * The caller is responsible for writing json/blob to disk or uploading via HTTP.
 */
export function finalizeToMemory(debugInst: {
  // biome-ignore lint/suspicious/noExplicitAny: structural interface avoids importing recorder.ts (node:* deps)
  getTape(): any;
  _getValid(): boolean;
}):
  | { readonly ok: true; readonly value: FinalizeToMemoryValue }
  | { readonly ok: false; readonly error: DebugError } {
  const tapeOrErr = debugInst.getTape();
  if (!tapeOrErr) {
    return err(
      new DebugError({
        code: 'frame-end-hook-missing',
        expected: 'tape data available for finalize',
        hint: 'no recorded events to finalize; call arm() and onFrameEnd() first',
      }),
    );
  }
  // Duck-type DebugError: the capture-browser subpath bundles its own
  // DebugError class and getTape() runs in a different bundle (barrel),
  // so instanceof spuriously fails cross-bundle. Check .code instead.
  if (tapeOrErr !== null && typeof tapeOrErr === 'object' && 'code' in tapeOrErr) {
    return err(tapeOrErr as DebugError);
  }
  const tape = tapeOrErr;

  const runId = generateRunId();
  const { json, blob } = serializeTape(tape);
  const passOffsets = computePassOffsets(tape.events);
  const valid = debugInst._getValid();

  return ok({ runId, json, blob, passOffsets, valid });
}
