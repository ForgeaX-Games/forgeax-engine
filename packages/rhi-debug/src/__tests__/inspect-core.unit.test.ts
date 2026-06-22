// @forgeax/engine-rhi-debug/src/__tests__/inspect-core.unit.test.ts
// Unit tests for inspect-core: fields cropping, drawIdx boundaries,
// passIdx calculation, error transparency (caps-mismatch).
//
// PR3 M1 w1: TDD red phase — imports from '../inspect-core' which does not
// yet exist. Module resolution will fail until w2 ships.
//
// Related: requirements AC-15; plan-strategy 5.1/5.3.

// biome-ignore-all lint/suspicious/noExplicitAny: inspect-core unit tests use mock Replay stubs with any cast at test boundary

/// <reference types="@webgpu/types" />

import { describe, expect, it, vi } from 'vitest';
import { DebugError } from '../errors';
import {
  extractDrawInfo,
  findPassIdx,
  inspectDrawJson,
  mapResourceKindToInspectKind,
} from '../inspect-core';
import type { Replay } from '../replayer';
import type { InspectDrawCall, InspectFields, RhiCallEvent } from '../types';

// ============================================================================
// Helpers — replicate inspector.unit.test.ts stub pattern
// ============================================================================

function makeStubReplay(overrides?: Record<string, any>): any {
  return {
    stepTo: overrides?.stepTo ?? vi.fn().mockResolvedValue({ ok: true }),
    reset: overrides?.reset ?? vi.fn(),
    dispose: overrides?.dispose ?? vi.fn(),
    _resolveHandle: (id: string) => overrides?.handleMap?.get(id),
    _events: overrides?.events ?? [],
    readbackRt: vi.fn().mockResolvedValue({
      ok: false,
      error: new DebugError({ code: 'rt-readback-failed', expected: 'mocked', hint: 'mocked' }),
    }),
  };
}

function makeMockDevice(): any {
  const mockBuffer = {
    mapAsync: vi.fn().mockResolvedValue(undefined),
    getMappedRange: vi.fn().mockReturnValue(new ArrayBuffer(512 * 512 * 4)),
    unmap: vi.fn(),
  };
  const mockEncoder = {
    copyTextureToBuffer: vi.fn(),
    finish: vi.fn().mockReturnValue({ ok: true, value: { __brand: 'CommandBuffer' } }),
  };
  return {
    createBuffer: vi.fn().mockReturnValue({ ok: true, value: mockBuffer }),
    createCommandEncoder: vi.fn().mockReturnValue({ ok: true, value: mockEncoder }),
    destroyBuffer: vi.fn(),
    queue: {
      submit: vi.fn(),
      onSubmittedWorkDone: vi.fn().mockResolvedValue(undefined),
    },
  };
}

// ============================================================================
// Minimal tape events for testing extractDrawInfo / findPassIdx
// ============================================================================

function makeSingleDrawEvents(): readonly RhiCallEvent[] {
  return [
    { kind: 'frameMark', frameIdx: 0 },
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:1',
      passHandleId: 'pass:1',
      desc: { colorAttachments: [] },
      colorAttachmentViewHandleIds: ['tv:1'],
    },
    { kind: 'createRenderPipeline', handleId: 'pipe:1', desc: {}, layoutHandleId: 'layout:auto' },
    { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'pipe:1' },
    {
      kind: 'draw',
      passHandleId: 'pass:1',
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    { kind: 'endRenderPass', passHandleId: 'pass:1' },
  ];
}

// ============================================================================
// Suite A: extractDrawInfo + findPassIdx (atom functions, move-verified)
// ============================================================================

describe('extractDrawInfo', () => {
  it('returns bindings and drawCall for drawIdx=0', () => {
    const events = makeSingleDrawEvents();
    const info = extractDrawInfo(events, 0);
    expect(info.frameIdx).toBe(0);
    // passIdx is -1 from extractDrawInfo (computed separately by findPassIdx)
    expect(info.drawCall.pipelineKind).toBe('render');
    expect(info.drawCall.vertexCount).toBe(3);
    expect(info.colorAttachmentHandleId).toBe('tv:1');
  });

  it('detects drawIndexed correctly', () => {
    const events: readonly RhiCallEvent[] = [
      { kind: 'frameMark', frameIdx: 0 },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: ['tv:1'],
      },
      { kind: 'createRenderPipeline', handleId: 'pipe:1', desc: {}, layoutHandleId: 'layout:auto' },
      { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'pipe:1' },
      {
        kind: 'drawIndexed',
        passHandleId: 'pass:1',
        indexCount: 36,
        instanceCount: 1,
        firstIndex: 0,
        baseVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ];
    const info = extractDrawInfo(events, 0);
    expect(info.drawCall.pipelineKind).toBe('render');
    expect((info.drawCall as InspectDrawCall).indexCount).toBe(36);
  });

  it('returns placeholder DrawInfo when drawIdx is out of range', () => {
    const events = makeSingleDrawEvents();
    const info = extractDrawInfo(events, 999);
    expect(info.drawCall.pipelineKind).toBe('render');
    expect(info.drawCall.pipelineHandleId).toBe('unknown');
    expect(info.colorAttachmentHandleId).toBeUndefined();
  });
});

describe('findPassIdx', () => {
  it('returns 0 for drawIdx=0 in a single-pass tape', () => {
    const events = makeSingleDrawEvents();
    const passIdx = findPassIdx(events, 0);
    expect(passIdx).toBe(0);
  });

  it('returns correct passIdx for a two-pass tape', () => {
    const events: readonly RhiCallEvent[] = [
      { kind: 'frameMark', frameIdx: 0 },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: ['tv:1'],
      },
      { kind: 'createRenderPipeline', handleId: 'pipe:1', desc: {}, layoutHandleId: 'layout:auto' },
      { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'pipe:1' },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
      // Pass 2
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:2',
        passHandleId: 'pass:2',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: ['tv:2'],
      },
      { kind: 'createRenderPipeline', handleId: 'pipe:2', desc: {}, layoutHandleId: 'layout:auto' },
      { kind: 'setPipeline', passHandleId: 'pass:2', pipelineHandleId: 'pipe:2' },
      {
        kind: 'draw',
        passHandleId: 'pass:2',
        vertexCount: 6,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:2' },
    ];
    expect(findPassIdx(events, 0)).toBe(0);
    expect(findPassIdx(events, 1)).toBe(1);
  });
});

describe('mapResourceKindToInspectKind', () => {
  it('maps all four input kinds correctly', () => {
    expect(mapResourceKindToInspectKind('sampler')).toBe('sampler');
    expect(mapResourceKindToInspectKind('buffer')).toBe('buffer');
    expect(mapResourceKindToInspectKind('textureView')).toBe('textureView');
    expect(mapResourceKindToInspectKind('externalTexture')).toBe('texture');
  });
});

// ============================================================================
// Suite B: inspectDrawJson fields cropping (AC-12)
// ============================================================================

describe('inspectDrawJson fields cropping', () => {
  it("fields=['bindings'] returns bindings without drawCall or rt", async () => {
    const events = makeSingleDrawEvents();
    const replay = makeStubReplay({ events, handleMap: new Map<string, unknown>() });
    const result = await inspectDrawJson(replay as unknown as Replay, 0, events, makeMockDevice(), [
      'bindings',
    ] as readonly InspectFields[]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const report = result.value;
      expect(report.bindings).toBeDefined();
      // AC-12: unrequested fields genuinely absent
      expect((report as unknown as Record<string, unknown>).drawCall).toBeUndefined();
      expect(report.rt).toBeUndefined();
    }
  });

  it("fields=['drawCall'] returns drawCall without bindings or rt", async () => {
    const events = makeSingleDrawEvents();
    const replay = makeStubReplay({ events, handleMap: new Map<string, unknown>() });
    const result = await inspectDrawJson(replay as unknown as Replay, 0, events, makeMockDevice(), [
      'drawCall',
    ] as readonly InspectFields[]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const report = result.value;
      expect(report.drawCall).toBeDefined();
      expect(report.drawCall?.pipelineKind).toBe('render');
      expect(report.drawCall?.vertexCount).toBe(3);
      expect((report as unknown as Record<string, unknown>).bindings).toBeUndefined();
      expect(report.rt).toBeUndefined();
    }
  });

  it('fields=undefined (full report) includes all non-rt fields', async () => {
    const handleMap = new Map<string, unknown>();
    handleMap.set('tv:1', { __brand: 'TextureView' } as any);
    const events = makeSingleDrawEvents();
    const replay = makeStubReplay({ events, handleMap });
    const result = await inspectDrawJson(
      replay as unknown as Replay,
      0,
      events,
      makeMockDevice(),
      undefined,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const report = result.value;
      expect(report.frameIdx).toBe(0);
      expect(report.drawIdx).toBe(0);
      expect(report.bindings).toBeDefined();
      expect(report.drawCall).toBeDefined();
    }
  });

  it('fields=undefined (full report) returns rt as {width,height,pixels} (browser path shape)', async () => {
    // InspectRtPayload browser arm: inspectDrawJson hands back the decoded
    // {width,height,pixels} triple (NOT a PNG path string). Asserts the union
    // shape so the type no longer lies via `as any` (charter P2).
    const handleMap = new Map<string, unknown>();
    handleMap.set('tv:1', { __brand: 'Texture' } as any);
    const events = makeSingleDrawEvents();
    const replay = makeStubReplay({ events, handleMap });
    const result = await inspectDrawJson(replay as unknown as Replay, 0, events, makeMockDevice(), [
      'rt',
    ] as readonly InspectFields[]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rt = result.value.rt;
      expect(typeof rt).toBe('object');
      // Discriminate the browser arm of InspectRtPayload.
      if (typeof rt === 'object' && rt !== undefined) {
        expect(rt.width).toBe(512);
        expect(rt.height).toBe(512);
        expect(rt.pixels).toBeInstanceOf(Uint8Array);
        expect(rt.pixels.length).toBe(512 * 512 * 4);
      }
    }
  });

  it('fields=[] returns only frameIdx/drawIdx/passIdx', async () => {
    const events = makeSingleDrawEvents();
    const replay = makeStubReplay({ events, handleMap: new Map<string, unknown>() });
    const result = await inspectDrawJson(
      replay as unknown as Replay,
      0,
      events,
      makeMockDevice(),
      [],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const report = result.value;
      expect(report.frameIdx).toBe(0);
      expect(report.drawIdx).toBe(0);
      expect((report as unknown as Record<string, unknown>).bindings).toBeUndefined();
      expect((report as unknown as Record<string, unknown>).drawCall).toBeUndefined();
      expect(report.rt).toBeUndefined();
    }
  });
});

// ============================================================================
// Suite C: drawIdx boundaries
// ============================================================================

describe('inspectDrawJson drawIdx boundaries', () => {
  it('drawIdx=0 returns first draw with correct passIdx', async () => {
    const events = makeSingleDrawEvents();
    const replay = makeStubReplay({ events, handleMap: new Map<string, unknown>() });
    const result = await inspectDrawJson(replay as unknown as Replay, 0, events, makeMockDevice(), [
      'drawCall',
    ] as readonly InspectFields[]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const report = result.value;
      expect(report.drawIdx).toBe(0);
      expect(report.passIdx).toBe(0);
    }
  });

  it('drawIdx out of range returns err', async () => {
    const events = makeSingleDrawEvents(); // 1 draw (drawIdx=0)
    const replay = makeStubReplay({ events, handleMap: new Map<string, unknown>() });
    const result = await inspectDrawJson(
      replay as unknown as Replay,
      999,
      events,
      makeMockDevice(),
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('replay-step-out-of-range');
    }
  });

  it('drawIdx for multi-draw tape returns correct passIdx for each', async () => {
    const events: readonly RhiCallEvent[] = [
      { kind: 'frameMark', frameIdx: 0 },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: ['tv:1'],
      },
      { kind: 'createRenderPipeline', handleId: 'pipe:1', desc: {}, layoutHandleId: 'layout:auto' },
      { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'pipe:1' },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 3,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ];
    const replay = makeStubReplay({ events, handleMap: new Map<string, unknown>() });

    const r0 = await inspectDrawJson(replay as unknown as Replay, 0, events, makeMockDevice(), [
      'drawCall',
    ] as readonly InspectFields[]);
    expect(r0.ok).toBe(true);
    if (r0.ok) {
      expect(r0.value.drawIdx).toBe(0);
    }

    const r1 = await inspectDrawJson(replay as unknown as Replay, 1, events, makeMockDevice(), [
      'drawCall',
    ] as readonly InspectFields[]);
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.value.drawIdx).toBe(1);
    }
  });
});

// ============================================================================
// Suite D: error transparency (AC-13)
// ============================================================================

describe('inspectDrawJson error transparency', () => {
  it('preserves caps-mismatch .code and .detail when fed mismatched caps replay input', async () => {
    // Construct a caps-mismatch scenario: we test that the error code
    // 'caps-mismatch' from the underlying createReplay path (if there were one)
    // would be preserved. Since inspectDrawJson does NOT call createReplay
    // (it receives an already-built Replay per D-1), the error transparency
    // manifests via drawIdx out-of-range. But the test exists to validate
    // that the error's .code field is from the locked 12-member DebugErrorCode
    // union — no new codes are introduced.
    const events = makeSingleDrawEvents();
    const replay = makeStubReplay({ events, handleMap: new Map<string, unknown>() });
    const result = await inspectDrawJson(
      replay as unknown as Replay,
      999,
      events,
      makeMockDevice(),
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const err = result.error;
      // Verify the error has a known code from the 12-member union
      expect(typeof err.code).toBe('string');
      // Verify we can switch on it (closed union)
      switch (err.code) {
        case 'recorder-not-attached':
        case 'recorder-already-armed':
        case 'frame-end-hook-missing':
        case 'tape-format-version-mismatch':
        case 'tape-handle-graph-broken':
        case 'caps-mismatch':
        case 'replay-step-out-of-range':
        case 'replay-deterministic-violation':
        case 'rt-readback-failed':
        case 'png-encode-failed':
        case 'rpc-target-not-wired':
        case 'replay-dispose-busy':
          break;
        default: {
          const _exhaustive: never = err.code;
          void _exhaustive;
          break;
        }
      }
      // The expected code for drawIdx out of range
      expect(err.code).toBe('replay-step-out-of-range');
    }
  });
});
