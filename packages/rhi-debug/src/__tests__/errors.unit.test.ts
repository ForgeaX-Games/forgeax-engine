// Unit — DebugError construction + 4-field surface for 14-member DebugErrorCode.
//
// Tests at least 7 of the 14 error codes (per m1-4 description), verifying
// .code / .expected / .hint / .detail exist and carry the right types.
// Includes caps-mismatch structured .detail.missingCaps assertion.

import { describe, expect, it } from 'vitest';
import type {
  CapsMismatchDetail,
  DebugErrorCode,
  DisposeBusyDetail,
  HandleGraphBrokenDetail,
  SnapshotReadbackFailedDetail,
  StepRangeDetail,
  TapeFormatVersionDetail,
} from '../errors';
import { DebugError } from '../errors';

describe('DebugError — construction surface', () => {
  it('recorder-not-attached: code + expected + hint exist', () => {
    const err = new DebugError({
      code: 'recorder-not-attached',
      expected: 'FORGEAX_ENGINE_RHI_DEBUG=1 must be set and wrap() called',
      hint: 'set FORGEAX_ENGINE_RHI_DEBUG=1 env var before createApp',
    });
    expect(err).toBeInstanceOf(DebugError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DebugError');
    expect(err.code).toBe('recorder-not-attached');
    expect(err.expected).toBe('FORGEAX_ENGINE_RHI_DEBUG=1 must be set and wrap() called');
    expect(err.hint).toBe('set FORGEAX_ENGINE_RHI_DEBUG=1 env var before createApp');
    expect(err.detail).toBeUndefined();
  });

  it('recorder-already-armed: duplicate arm surface', () => {
    const err = new DebugError({
      code: 'recorder-already-armed',
      expected: 'arm() must not be called while a capture is in progress',
      hint: 'wait for current capture to complete before re-arming',
    });
    expect(err.code).toBe('recorder-already-armed');
    expect(err.message).toContain('[DebugError recorder-already-armed]');
  });

  it('frame-end-hook-missing: sentinel for missing injection point', () => {
    const err = new DebugError({
      code: 'frame-end-hook-missing',
      expected: 'createRenderer._onFrameEnd injection point present',
      hint: 'the onFrameEnd hook is missing; check createRenderer setup',
    });
    expect(err.code).toBe('frame-end-hook-missing');
    expect(err.expected).toBeTruthy();
    expect(err.hint).toBeTruthy();
  });

  it('caps-mismatch: structured .detail.missingCaps', () => {
    const err = new DebugError({
      code: 'caps-mismatch',
      expected: 'target device has all recording device caps',
      hint: 'missing: float32Filterable, rgba16floatRenderable',
      detail: {
        missingCaps: ['float32Filterable', 'rgba16floatRenderable'],
      } satisfies CapsMismatchDetail,
    });
    expect(err.code).toBe('caps-mismatch');
    expect(err.detail).toBeDefined();
    const detail = err.detail as CapsMismatchDetail;
    expect(detail.missingCaps).toEqual(['float32Filterable', 'rgba16floatRenderable']);
  });

  it('replay-step-out-of-range: structured .detail fields', () => {
    const err = new DebugError({
      code: 'replay-step-out-of-range',
      expected: 'stepTo(N) where 0 <= N <= totalEvents',
      hint: 'requested 50, totalEvents=40',
      detail: {
        requestedStep: 50,
        currentStep: 30,
        totalEvents: 40,
      } satisfies StepRangeDetail,
    });
    expect(err.code).toBe('replay-step-out-of-range');
    const detail = err.detail as StepRangeDetail;
    expect(detail.requestedStep).toBe(50);
    expect(detail.totalEvents).toBe(40);
  });

  it('tape-format-version-mismatch: structured version detail', () => {
    const err = new DebugError({
      code: 'tape-format-version-mismatch',
      expected: 'tape formatVersion matches runtime',
      hint: 'tape v0, runtime v1',
      detail: {
        tapeVersion: 0,
        expectedVersion: 1,
      } satisfies TapeFormatVersionDetail,
    });
    expect(err.code).toBe('tape-format-version-mismatch');
    const detail = err.detail as TapeFormatVersionDetail;
    expect(detail.tapeVersion).toBe(0);
    expect(detail.expectedVersion).toBe(1);
  });

  it('tape-handle-graph-broken: structured dangling handle detail', () => {
    const err = new DebugError({
      code: 'tape-handle-graph-broken',
      expected: 'every handleId referenced in events is declared by a create* call',
      hint: 'handleId texture:7 referenced at event 42 but never created',
      detail: {
        danglingHandleId: 'texture:7',
        referencingEventIndex: 42,
      } satisfies HandleGraphBrokenDetail,
    });
    expect(err.code).toBe('tape-handle-graph-broken');
    const detail = err.detail as HandleGraphBrokenDetail;
    expect(detail.danglingHandleId).toBe('texture:7');
  });

  it('replay-dispose-busy: structured in-flight draw indices', () => {
    const err = new DebugError({
      code: 'replay-dispose-busy',
      expected: 'no in-flight inspect operations on the same tape',
      hint: 'in-flight drawIdx: [42, 55]',
      detail: {
        inFlightDrawIndices: [42, 55],
      } satisfies DisposeBusyDetail,
    });
    expect(err.code).toBe('replay-dispose-busy');
    const detail = err.detail as DisposeBusyDetail;
    expect(detail.inFlightDrawIndices).toEqual([42, 55]);
  });

  it('snapshot-readback-failed: structured stage detail', () => {
    const err = new DebugError({
      code: 'snapshot-readback-failed',
      expected: 'GPU byte readback to succeed',
      hint: 'copy stage failed for handleId buf:1',
      detail: {
        handleId: 'buf:1',
        stage: 'copy',
      } satisfies SnapshotReadbackFailedDetail,
    });
    expect(err.code).toBe('snapshot-readback-failed');
    const detail = err.detail as SnapshotReadbackFailedDetail;
    expect(detail.handleId).toBe('buf:1');
    expect(detail.stage).toBe('copy');
  });

  it('seed-initial-data-failed: code + expected + hint exist (detail undefined)', () => {
    const err = new DebugError({
      code: 'seed-initial-data-failed',
      expected: 'replayInitialData to seed resource bytes',
      hint: 'handleId missing from handleMap or dataHash missing from blobPool',
    });
    expect(err.code).toBe('seed-initial-data-failed');
    expect(err.expected).toBeTruthy();
    expect(err.hint).toBeTruthy();
    expect(err.detail).toBeUndefined();
  });
});

describe('DebugErrorCode completeness — all 14 members', () => {
  const allCodes: DebugErrorCode[] = [
    'recorder-not-attached',
    'recorder-already-armed',
    'frame-end-hook-missing',
    'tape-format-version-mismatch',
    'tape-handle-graph-broken',
    'caps-mismatch',
    'replay-step-out-of-range',
    'replay-deterministic-violation',
    'rt-readback-failed',
    'png-encode-failed',
    'snapshot-readback-failed',
    'seed-initial-data-failed',
    'rpc-target-not-wired',
    'replay-dispose-busy',
  ];

  it('has exactly 14 members', () => {
    expect(allCodes).toHaveLength(14);
  });

  it('every member constructs a DebugError with the right code', () => {
    for (const code of allCodes) {
      const err = new DebugError({
        code,
        expected: 'test-expected',
        hint: 'test-hint',
      });
      expect(err.code).toBe(code);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('no duplicate codes', () => {
    expect(new Set(allCodes).size).toBe(14);
  });
});
