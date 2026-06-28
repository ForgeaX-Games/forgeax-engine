// Unit test: tape v3 round-trip — all 6 new RhiCallEvent kinds serialize/deserialize losslessly.
//
// Constructs a tape containing all 6 new event types (setBlendConstant, drawIndirect,
// drawIndexedIndirect, passPushDebugGroup, passPopDebugGroup, passInsertDebugMarker) plus
// existing event types, serializes to binary, deserializes back, and asserts field-by-field
// equality for each new event kind.
//
// Related: requirements AC-08; plan-strategy D-2; task w5.

// biome-ignore-all lint/suspicious/noExplicitAny: tape format tests serialize RHI event types whose shapes require structural casts
// biome-ignore-all lint/style/noNonNullAssertion: test assertions on deserialized fields use non-null assertions because serialized data is always complete

import { describe, expect, it } from 'vitest';
import { deserializeTape, serializeTape, TAPE_FORMAT_VERSION } from '../tape-format';
import type { RhiCallEvent, Tape } from '../types';

// ============================================================================
// Helpers
// ============================================================================

function makeEmptyTape(): Tape {
  return {
    formatVersion: TAPE_FORMAT_VERSION,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm' as GPUTextureFormat,
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompression: false,
      storageBuffer: false,
      timestampQuery: false,
    },
    events: [],
    blobPool: new Map(),
  };
}

function makeTapeWithEvents(events: RhiCallEvent[]): Tape {
  const b = makeEmptyTape();
  return { ...b, events };
}

// ============================================================================
// w5: v3 tape round-trip — each new event kind
// ============================================================================

describe('tape-format — v3 new event kind round-trip', () => {
  it('setBlendConstant round-trip (AC-08)', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'setBlendConstant',
        passHandleId: 'pass:1',
        color: { r: 0.1, g: 0.2, b: 0.3, a: 0.4 } as GPUColor,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const setBlend = res.value.events.find((e) => e.kind === 'setBlendConstant');
      expect(setBlend).toBeDefined();
      expect(setBlend!.kind).toBe('setBlendConstant');
      if (setBlend!.kind === 'setBlendConstant') {
        expect(setBlend!.passHandleId).toBe('pass:1');
        const c = setBlend!.color as unknown as { r: number; g: number; b: number; a: number };
        expect(c.r).toBe(0.1);
        expect(c.g).toBe(0.2);
        expect(c.b).toBe(0.3);
        expect(c.a).toBe(0.4);
      }
    }
  });

  it('drawIndirect round-trip (AC-08)', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createBuffer', handleId: 'buf:indirect', desc: { size: 20, usage: 256 } },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'drawIndirect',
        passHandleId: 'pass:1',
        indirectBufferHandleId: 'buf:indirect',
        indirectOffset: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const event = res.value.events.find((e) => e.kind === 'drawIndirect');
      expect(event).toBeDefined();
      expect(event!.kind).toBe('drawIndirect');
      if (event!.kind === 'drawIndirect') {
        expect(event!.passHandleId).toBe('pass:1');
        expect(event!.indirectBufferHandleId).toBe('buf:indirect');
        expect(event!.indirectOffset).toBe(0);
      }
    }
  });

  it('drawIndexedIndirect round-trip (AC-08)', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createBuffer', handleId: 'buf:indirect', desc: { size: 20, usage: 256 } },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'drawIndexedIndirect',
        passHandleId: 'pass:1',
        indirectBufferHandleId: 'buf:indirect',
        indirectOffset: 16,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const event = res.value.events.find((e) => e.kind === 'drawIndexedIndirect');
      expect(event).toBeDefined();
      expect(event!.kind).toBe('drawIndexedIndirect');
      if (event!.kind === 'drawIndexedIndirect') {
        expect(event!.passHandleId).toBe('pass:1');
        expect(event!.indirectBufferHandleId).toBe('buf:indirect');
        expect(event!.indirectOffset).toBe(16);
      }
    }
  });

  it('passPushDebugGroup round-trip (AC-08)', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'passPushDebugGroup', passHandleId: 'pass:1', groupLabel: 'skybox-draw' },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const event = res.value.events.find((e) => e.kind === 'passPushDebugGroup');
      expect(event).toBeDefined();
      expect(event!.kind).toBe('passPushDebugGroup');
      if (event!.kind === 'passPushDebugGroup') {
        expect(event!.passHandleId).toBe('pass:1');
        expect(event!.groupLabel).toBe('skybox-draw');
      }
    }
  });

  it('passPopDebugGroup round-trip (AC-08)', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'passPopDebugGroup', passHandleId: 'pass:1' },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const event = res.value.events.find((e) => e.kind === 'passPopDebugGroup');
      expect(event).toBeDefined();
      expect(event!.kind).toBe('passPopDebugGroup');
      if (event!.kind === 'passPopDebugGroup') {
        expect(event!.passHandleId).toBe('pass:1');
      }
    }
  });

  it('passInsertDebugMarker round-trip (AC-08)', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'passInsertDebugMarker', passHandleId: 'pass:1', markerLabel: 'after-skybox' },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const event = res.value.events.find((e) => e.kind === 'passInsertDebugMarker');
      expect(event).toBeDefined();
      expect(event!.kind).toBe('passInsertDebugMarker');
      if (event!.kind === 'passInsertDebugMarker') {
        expect(event!.passHandleId).toBe('pass:1');
        expect(event!.markerLabel).toBe('after-skybox');
      }
    }
  });

  it('all 6 new events round-trip in one tape (AC-08)', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      { kind: 'createBuffer', handleId: 'buf:ind', desc: { size: 20, usage: 256 } },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'setBlendConstant',
        passHandleId: 'pass:1',
        color: { r: 0.5, g: 0.5, b: 0.5, a: 1.0 } as GPUColor,
      },
      { kind: 'passPushDebugGroup', passHandleId: 'pass:1', groupLabel: 'group-1' },
      { kind: 'passInsertDebugMarker', passHandleId: 'pass:1', markerLabel: 'mark-1' },
      {
        kind: 'drawIndirect',
        passHandleId: 'pass:1',
        indirectBufferHandleId: 'buf:ind',
        indirectOffset: 0,
      },
      {
        kind: 'drawIndexedIndirect',
        passHandleId: 'pass:1',
        indirectBufferHandleId: 'buf:ind',
        indirectOffset: 8,
      },
      { kind: 'passPopDebugGroup', passHandleId: 'pass:1' },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const events = res.value.events;
      expect(events).toHaveLength(10);

      // Verify each new kind is present with correct fields
      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain('setBlendConstant');
      expect(kinds).toContain('drawIndirect');
      expect(kinds).toContain('drawIndexedIndirect');
      expect(kinds).toContain('passPushDebugGroup');
      expect(kinds).toContain('passPopDebugGroup');
      expect(kinds).toContain('passInsertDebugMarker');

      // Spot-check field integrity on the full multi-event tape
      const blend = events.find((e) => e.kind === 'setBlendConstant');
      if (blend?.kind === 'setBlendConstant') {
        const bc = blend.color as unknown as { r: number; a: number };
        expect(bc.r).toBe(0.5);
        expect(bc.a).toBe(1.0);
      }
      const dd = events.find((e) => e.kind === 'drawIndirect');
      if (dd?.kind === 'drawIndirect') {
        expect(dd.indirectBufferHandleId).toBe('buf:ind');
      }
      const di = events.find((e) => e.kind === 'drawIndexedIndirect');
      if (di?.kind === 'drawIndexedIndirect') {
        expect(di.indirectOffset).toBe(8);
      }
    }
  });

  it('new events round-trip alongside existing event types (AC-08)', () => {
    // Construct a realistic tape with old and new events mixed
    const tape = makeTapeWithEvents([
      // Old: create resources
      { kind: 'createBuffer', handleId: 'buf:vbo', desc: { size: 256, usage: 32 } },
      { kind: 'createShaderModule', handleId: 'sm:1', wgslCode: 'fn main() {}' },
      {
        kind: 'createRenderPipeline',
        handleId: 'rp:1',
        desc: { vertex: { module: {} as any, entryPoint: 'main' } },
        layoutHandleId: 'layout:auto',
      },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      // Old: begin render pass
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      // New: setBlendConstant
      {
        kind: 'setBlendConstant',
        passHandleId: 'pass:1',
        color: { r: 0.2, g: 0.4, b: 0.6, a: 0.8 } as GPUColor,
      },
      // New: pass-level debug group
      { kind: 'passPushDebugGroup', passHandleId: 'pass:1', groupLabel: 'main-draw' },
      // Old: setPipeline + setVertexBuffer
      { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'rp:1' },
      { kind: 'setVertexBuffer', passHandleId: 'pass:1', slot: 0, bufferHandleId: 'buf:vbo' },
      // Old: draw
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      // New: pass-level debug marker
      { kind: 'passInsertDebugMarker', passHandleId: 'pass:1', markerLabel: 'draw-done' },
      // New: passPopDebugGroup
      { kind: 'passPopDebugGroup', passHandleId: 'pass:1' },
      // Old: end pass
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.events).toHaveLength(tape.events.length);
      expect(res.value.formatVersion).toBe(TAPE_FORMAT_VERSION);

      // Verify old events still round-trip correctly
      const draw = res.value.events.find((e) => e.kind === 'draw');
      expect(draw).toBeDefined();
      if (draw?.kind === 'draw') {
        expect(draw.vertexCount).toBe(3);
      }

      // Verify new events are all present
      const newKinds = res.value.events
        .map((e) => e.kind)
        .filter(
          (k) =>
            k === 'setBlendConstant' ||
            k === 'drawIndirect' ||
            k === 'drawIndexedIndirect' ||
            k === 'passPushDebugGroup' ||
            k === 'passPopDebugGroup' ||
            k === 'passInsertDebugMarker',
        );
      expect(newKinds).toHaveLength(4); // setBlendConstant + passPushDebugGroup + passInsertDebugMarker + passPopDebugGroup
    }
  });
});
