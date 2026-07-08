// Unit test: v2 tape backward-compat deserialize — v2 tapes with initialData events
// must deserialize without version-mismatch error after deserialize is relaxed to
// accept formatVersion ∈ {2, 3} (w7).
//
// The test creates a v2 tape fixture with initialData events, serializes it,
// deserializes it, and asserts:
//   (a) no 'tape-format-version-mismatch' error is thrown
//   (b) the deserialized Tape has correct structure (formatVersion, events, blobPool)
//   (c) buildViewModel-compatible fields (passOffsets, draw events) are computable
//   (d) new-event kinds (setBlendConstant, drawIndirect, etc.) are naturally absent
//       — D-9: v2 missing new events produce natural empty state
//
// Related: requirements AC-09; plan-strategy D-2, D-9; task w6.

// biome-ignore-all lint/suspicious/noExplicitAny: tape format tests serialize RHI event types
// biome-ignore-all lint/style/noNonNullAssertion: test assertions use non-null on deserialized complete data

import { describe, expect, it } from 'vitest';
import { computePassOffsets, deserializeTape, serializeTape } from '../tape-format';
import type { RhiCallEvent, RhiCallEventInitialData, Tape } from '../types';

// ============================================================================
// Build a v2 tape fixture (formatVersion=2)
// ============================================================================

function makeV2TapeFixture(): Tape {
  const v2IdBuf: RhiCallEventInitialData = {
    kind: 'initialData',
    handleId: 'buf:vbo',
    dataHash: 'abc001',
  };
  const v2IdTex: RhiCallEventInitialData = {
    kind: 'initialData',
    handleId: 'texture:atlas',
    dataHash: 'abc002',
  };
  return {
    formatVersion: 2,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm' as GPUTextureFormat,
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      storageBuffer: false,
      timestampQuery: false,
    },
    events: [
      // Bootstrap creates
      {
        kind: 'createBuffer',
        handleId: 'buf:vbo',
        desc: { size: 72, usage: 0x01 | 0x10, mappedAtCreation: false },
      } as RhiCallEvent,
      {
        kind: 'createTexture',
        handleId: 'texture:atlas',
        desc: {
          size: { width: 64, height: 64, depthOrArrayLayers: 1 },
          format: 'rgba8unorm' as GPUTextureFormat,
          usage: 16,
        },
      } as RhiCallEvent,
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      { kind: 'createSampler', handleId: 'sampler:1' },
      // initialData events (v2 feature)
      v2IdBuf as RhiCallEvent,
      v2IdTex as RhiCallEvent,
      // render pass with draws
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      } as RhiCallEvent,
      {
        kind: 'setViewport',
        passHandleId: 'pass:1',
        x: 0,
        y: 0,
        w: 640,
        h: 480,
        minDepth: 0,
        maxDepth: 1,
      } as RhiCallEvent,
      {
        kind: 'setScissorRect',
        passHandleId: 'pass:1',
        x: 0,
        y: 0,
        w: 640,
        h: 480,
      } as RhiCallEvent,
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      } as RhiCallEvent,
      { kind: 'endRenderPass', passHandleId: 'pass:1' } as RhiCallEvent,
      { kind: 'frameMark', frameIdx: 0 } as RhiCallEvent,
    ],
    blobPool: new Map<string, ArrayBuffer>([
      ['abc001', new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer],
      ['abc002', new Uint8Array([5, 6, 7, 8]).buffer as ArrayBuffer],
    ]),
  };
}

// ============================================================================
// w6: v2 tape backward-compat deserialize
// ============================================================================

describe('tape-format — v2 tape backward-compat deserialize', () => {
  it('v2 tape with initialData deserializes without version-mismatch error (AC-09)', () => {
    const tape = makeV2TapeFixture();
    expect(tape.formatVersion).toBe(2);

    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);

    // AC-09: v2 tape must be readable — no version-mismatch error
    expect(res.ok).toBe(true);
  });

  it('deserialized v2 tape preserves formatVersion=2', () => {
    const tape = makeV2TapeFixture();
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.formatVersion).toBe(2);
    }
  });

  it('deserialized v2 tape preserves all events', () => {
    const tape = makeV2TapeFixture();
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.events).toHaveLength(tape.events.length);

      // Verify createBuffer preserved
      const createBuf = res.value.events.find((e) => e.kind === 'createBuffer');
      expect(createBuf).toBeDefined();
      if (createBuf?.kind === 'createBuffer') {
        expect(createBuf.handleId).toBe('buf:vbo');
      }

      // Verify initialData events preserved
      const idEvents = res.value.events.filter((e) => e.kind === 'initialData') as {
        kind: 'initialData';
        handleId: string;
        dataHash: string;
      }[];
      expect(idEvents).toHaveLength(2);
      expect(idEvents[0]!.handleId).toBe('buf:vbo');
      expect(idEvents[0]!.dataHash).toBe('abc001');
      expect(idEvents[1]!.handleId).toBe('texture:atlas');
      expect(idEvents[1]!.dataHash).toBe('abc002');

      // Verify draw events preserved
      const draw = res.value.events.find((e) => e.kind === 'draw');
      expect(draw).toBeDefined();

      // Verify frameMark preserved
      const fm = res.value.events.find((e) => e.kind === 'frameMark');
      expect(fm).toBeDefined();
    }
  });

  it('deserialized v2 tape preserves blobPool', () => {
    const tape = makeV2TapeFixture();
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.blobPool.has('abc001')).toBe(true);
      expect(res.value.blobPool.has('abc002')).toBe(true);
      expect(res.value.blobPool.size).toBe(2);
    }
  });

  it('v2 tape computePassOffsets works correctly (ViewModel-compatible)', () => {
    const tape = makeV2TapeFixture();
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const offsets = computePassOffsets(res.value.events);
      expect(offsets).toHaveLength(1);
      expect(offsets[0]!.kind).toBe('render');
      expect(offsets[0]!.passIdx).toBe(0);
      expect(offsets[0]!.startDrawIdx).toBe(0);
      expect(offsets[0]!.endDrawIdx).toBe(0);
    }
  });

  it('deserialized v2 tape has no new event kinds (D-9 natural empty state)', () => {
    // D-9: v2 missing new events must produce natural empty state —
    // commands lacking new kinds, no setBlendConstant/drawIndirect etc.
    const tape = makeV2TapeFixture();
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const kinds = new Set(res.value.events.map((e) => e.kind));
      expect(kinds.has('setBlendConstant')).toBe(false);
      expect(kinds.has('drawIndirect')).toBe(false);
      expect(kinds.has('drawIndexedIndirect')).toBe(false);
      expect(kinds.has('passPushDebugGroup')).toBe(false);
      expect(kinds.has('passPopDebugGroup')).toBe(false);
      expect(kinds.has('passInsertDebugMarker')).toBe(false);

      // D-9: ViewModel blendConstant would be undefined (no setBlendConstant event)
      const blendEvents = res.value.events.filter((e) => e.kind === 'setBlendConstant');
      expect(blendEvents).toHaveLength(0);
    }
  });

  it('v2 tape preserves v2-only features (initialData) intact', () => {
    // Regression: ensure v2-specific field (initialData) round-trips correctly
    const tape = makeV2TapeFixture();
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const idEvent = res.value.events.find((e) => e.kind === 'initialData');
      expect(idEvent).toBeDefined();
      const id = idEvent as { kind: 'initialData'; handleId: string; dataHash: string };
      expect(id.handleId).toBe('buf:vbo');
      expect(id.dataHash).toBe('abc001');
    }
  });
});
