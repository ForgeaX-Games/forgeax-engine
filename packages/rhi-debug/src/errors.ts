// @forgeax/engine-rhi-debug/src/errors — DebugError + closed DebugErrorCode union.
//
// Shape:
// - DebugErrorCode = closed union 12 members, independent from RhiErrorCode (per Q&A q8).
// - DebugError class has readonly .code / .expected / .hint / .detail four-field surface,
//   same shape as RhiError (AGENTS.md "Errors are structured").
// - .detail is a discriminated union narrowed on .code via switch exhaustive.
// - Requirements §7 error model complete list (12 members, closed union).
//
// Related: requirements §7 / AC-23 / AC-24; plan-strategy §3.1 errors.ts module.

/// <reference types="@webgpu/types" />

import type { RhiCapsRecorded } from './types';

/**
 * RhiCapsRecorded key alias — produced via `keyof` so the closed union
 * stays in lockstep with the recorded caps fields. AI users can pattern
 * `switch (k) { case 'storageBuffer': ... }` exhaustively.
 *
 * Used by `CapsMismatchDetail.missingCaps` to give consumers a typed
 * key set rather than a free-form `string[]` (AC-11).
 */
export type RhiCapsRecordedKey = keyof RhiCapsRecorded;

/**
 * Closed DebugErrorCode union. 12 members, completely independent from
 * RhiErrorCode (no overlap per Q&A q8). `switch` exhaustive checks need
 * no default fallback — tsc strict mode guards union completeness.
 *
 * | code | trigger |
 * |:--|:--|
 * | `'recorder-not-attached'` | (a) RPC received captureFrame but `wrap` was never called during bootstrap; (b) `arm()` invoked while the recorder is still in the error state — caller must `disposeError()` to clear before re-arming. |
 * | `'recorder-already-armed'` | Duplicate arm() while previous capture is still in progress (recorder in `armed` / `recording` / `finalizing`). |
 * | `'frame-end-hook-missing'` | createRenderer internal onFrameEnd injection point is absent (theoretically unreachable; fail-fast guard). |
 * | `'tape-format-version-mismatch'` | Cross-version tape: integer formatVersion does not match. |
 * | `'tape-handle-graph-broken'` | Event references a handleId that was never declared by any create* call in the tape. |
 * | `'caps-mismatch'` | target.caps does not contain tape.rhiCapsRecorded; replay blocked. |
 * | `'replay-step-out-of-range'` | stepTo(N) where N > totalEvents or N < currentEventIdx. |
 * | `'replay-deterministic-violation'` | After submit + onSubmittedWorkDone, RT pixels differ from original (test-only). |
 * | `'rt-readback-failed'` | copyTextureToBuffer / mapAsync chain failed. |
 * | `'png-encode-failed'` | PNG encoding **or** disk write of RT readback / tape / report data failed. The `.hint` field discriminates: `'failed to ...'` describes the specific I/O step (PNG encode vs `mkdirSync` vs `writeFileSync`). The 12-member union stays locked (AC-23) by widening this code's semantic to cover the writeFileSync / mkdirSync paths — adding a 13th `disk-write-failed` member would break the requirements §7 12-member commitment. |
 * | `'rpc-target-not-wired'` | wireDefaultInspectors was called without a debugRhi injector. |
 * | `'replay-dispose-busy'` | dispose() called while in-flight inspect is still running. |
 */
export type DebugErrorCode =
  | 'recorder-not-attached'
  | 'recorder-already-armed'
  | 'frame-end-hook-missing'
  | 'tape-format-version-mismatch'
  | 'tape-handle-graph-broken'
  | 'caps-mismatch'
  | 'replay-step-out-of-range'
  | 'replay-deterministic-violation'
  | 'rt-readback-failed'
  | 'png-encode-failed'
  | 'rpc-target-not-wired'
  | 'replay-dispose-busy';

/**
 * Detail type exclusive to the 'caps-mismatch' path.
 *
 * `missingCaps` carries the list of RhiCapsRecorded keys that the target
 * device lacked compared to the recording device. The element type is
 * `RhiCapsRecordedKey` (= `keyof RhiCapsRecorded`) — AI users can
 * `switch` exhaustively without parsing free-form strings (AC-11 +
 * charter P3 structured channel).
 *
 * The human-readable label (e.g. `'storage-buffer'` for
 * `'storageBuffer'`) lives on `.hint`, not in this typed slot —
 * structured detail is for narrowing, prose is for messaging.
 */
export interface CapsMismatchDetail {
  readonly missingCaps: readonly RhiCapsRecordedKey[];
}

/**
 * Detail type exclusive to the 'tape-format-version-mismatch' path.
 *
 * `tapeVersion` is the formatVersion found in the tape file.
 * `expectedVersion` is the formatVersion this runtime expects.
 */
export interface TapeFormatVersionDetail {
  readonly tapeVersion: number;
  readonly expectedVersion: number;
}

/**
 * Detail type exclusive to the 'replay-step-out-of-range' path.
 *
 * `requestedStep` is the N passed to stepTo(N).
 * `currentStep` is the current event index.
 * `totalEvents` is the total number of events in the tape.
 */
export interface StepRangeDetail {
  readonly requestedStep: number;
  readonly currentStep: number;
  readonly totalEvents: number;
}

/**
 * Detail type exclusive to the 'replay-dispose-busy' path.
 *
 * `inFlightDrawIndices` lists the drawIdx values currently being inspected
 * (in-flight). The caller should await these before retrying dispose.
 */
export interface DisposeBusyDetail {
  readonly inFlightDrawIndices: readonly number[];
}

/**
 * Detail type exclusive to the 'tape-handle-graph-broken' path.
 *
 * `danglingHandleId` is the first handleId found to be unreferenced.
 * `referencingEventIndex` is the event index where the dangling reference appears.
 */
export interface HandleGraphBrokenDetail {
  readonly danglingHandleId: string;
  readonly referencingEventIndex: number;
}

/**
 * Detail type exclusive to the 'replay-deterministic-violation' path.
 *
 * `actualDelta` is the computed pixelDeltaAbsMean between baseline and replay pixels.
 * `expectedDelta` is the acceptance threshold (0.01 per AC-14).
 * `drawIdx` is the optional draw call index where the violation was detected.
 *
 * Added in round 2 (m5b-2) to give consumers a structured comparison
 * signal rather than free-form string interpolation (charter P3).
 */
export interface DeterministicViolationDetail {
  readonly actualDelta: number;
  readonly expectedDelta: number;
  readonly drawIdx?: number | undefined;
}

/**
 * Tagged union of `.detail` shapes carried by DebugError.
 *
 * Each variant is exclusively associated with one DebugErrorCode:
 *   - `CapsMismatchDetail` -> 'caps-mismatch'
 *   - `TapeFormatVersionDetail` -> 'tape-format-version-mismatch'
 *   - `StepRangeDetail` -> 'replay-step-out-of-range'
 *   - `DisposeBusyDetail` -> 'replay-dispose-busy'
 *   - `HandleGraphBrokenDetail` -> 'tape-handle-graph-broken'
 *   - `DeterministicViolationDetail` -> 'replay-deterministic-violation'
 *
 * The other 6 paths leave `.detail = undefined`.
 */
export type DebugErrorDetail =
  | CapsMismatchDetail
  | TapeFormatVersionDetail
  | StepRangeDetail
  | DisposeBusyDetail
  | HandleGraphBrokenDetail
  | DeterministicViolationDetail;

/**
 * Structured debug error.
 *
 * Four readonly fields aligned with RhiError shape (AGENTS.md):
 * - `.code` — closed union member (L1 key signal).
 * - `.expected` — expected-state description (L2 detail).
 * - `.hint` — actionable recovery guidance (L2 detail; human-readable).
 * - `.detail` — discriminated union narrowed on `.code`.
 */
export class DebugError extends Error {
  readonly code: DebugErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: DebugErrorDetail | undefined;

  constructor(args: {
    code: DebugErrorCode;
    expected: string;
    hint: string;
    detail?: DebugErrorDetail | undefined;
  }) {
    super(`[DebugError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'DebugError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

// Result / ok / err re-exports from @forgeax/engine-types will be added in M-2
// when the recorder module needs them. For M-1, the errors module is self-contained.
