// Unit tests for tape-format.ts — serialize/deserialize round-trip for all
// RhiCallEvent kinds, formatVersion reject, blob pool dedup, handle graph
// integrity validation.
//
// Test suites:
// (a) Each RhiCallEvent kind round-trip (serialize -> deserialize -> deep equality)
// (b) formatVersion mismatch reject
// (c) blob pool hash dedup
// (d) handle id graph broken detection
// (e) empty tape round-trip
// (f) full frame tape round-trip + pass offset computation

// biome-ignore-all lint/suspicious/noExplicitAny: tape format tests serialize/deserialize RHI event types whose serializable shapes require structural casts; GPUTextureFormat string literals and GPUBufferUsage integer constants are native WebGPU types unavailable at type level in unit context
// biome-ignore-all lint/style/noNonNullAssertion: test assertions on deserialized optional fields use non-null assertions because serialized data is always complete; safe at test compile time

import { describe, expect, it } from 'vitest';
import {
  computePassOffsets,
  deserializeTape,
  serializeTape,
  TAPE_FORMAT_VERSION,
} from '../tape-format';
import type { RhiCallEvent, RhiCallEventInitialData, Tape } from '../types';

// ============================================================================
// Helper: build a minimal Tape
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

function makeTapeWithEventsAndBlobs(
  events: RhiCallEvent[],
  blobs: Array<[string, Uint8Array]>,
): Tape {
  const b = makeEmptyTape();
  const pool = new Map<string, ArrayBuffer>();
  for (const [h, d] of blobs) {
    pool.set(h, d.buffer as ArrayBuffer);
  }
  return { ...b, events, blobPool: pool };
}

// ============================================================================
// (a) Each RhiCallEvent kind round-trip
// ============================================================================

describe('tape-format — event kind round-trip', () => {
  it('frameMark round-trip', () => {
    const tape = makeTapeWithEvents([{ kind: 'frameMark', frameIdx: 0 }]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.events).toHaveLength(1);
      expect(res.value.events[0]).toEqual({ kind: 'frameMark', frameIdx: 0 });
    }
  });

  it('createBuffer round-trip', () => {
    const tape = makeTapeWithEvents([
      {
        kind: 'createBuffer',
        handleId: 'buf-1',
        desc: { size: 128, usage: 16, mappedAtCreation: false },
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.events).toHaveLength(1);
      expect(res.value.events[0]!.kind).toBe('createBuffer');
    }
  });

  it('createTexture round-trip', () => {
    const tape = makeTapeWithEvents([
      {
        kind: 'createTexture',
        handleId: 'texture:1',
        desc: {
          size: { width: 512, height: 512, depthOrArrayLayers: 1 },
          format: 'rgba8unorm' as GPUTextureFormat,
          usage: 16,
        },
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.events[0]!.kind).toBe('createTexture');
    }
  });

  it('createTextureView round-trip', () => {
    const tape = makeTapeWithEvents([
      {
        kind: 'createTexture',
        handleId: 'texture:1',
        desc: {
          size: { width: 64, height: 64, depthOrArrayLayers: 1 },
          format: 'rgba8unorm' as GPUTextureFormat,
          usage: 4,
        },
      },
      {
        kind: 'createTextureView',
        sourceHandleId: 'texture:1',
        resultHandleId: 'textureView:1',
        desc: {},
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.events.some((e) => e.kind === 'createTextureView')).toBe(true);
    }
  });

  it('createSampler round-trip', () => {
    const tape = makeTapeWithEvents([{ kind: 'createSampler', handleId: 'sampler:1' }]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.events[0]!.kind).toBe('createSampler');
    }
  });

  it('createBindGroupLayout round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createBindGroupLayout', handleId: 'bgl:1', desc: { entries: [] } },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.events[0]!.kind).toBe('createBindGroupLayout');
    }
  });

  it('createBindGroup round-trip', () => {
    const tape = makeTapeWithEvents([
      {
        kind: 'createBindGroup',
        handleId: 'bg:1',
        layoutHandleId: 'bgl:1',
        entries: [{ binding: 0, resourceKind: 'buffer' }],
        resourceHandleIds: ['buf-1'],
      },
      { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 64, usage: 16 } },
      { kind: 'createBindGroupLayout', handleId: 'bgl:1', desc: { entries: [] } },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.events.some((e) => e.kind === 'createBindGroup')).toBe(true);
    }
  });

  it('createPipelineLayout round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createPipelineLayout', handleId: 'pl:1', bglHandleIds: ['bgl:1'] },
      { kind: 'createBindGroupLayout', handleId: 'bgl:1', desc: { entries: [] } },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('createRenderPipeline round-trip', () => {
    const tape = makeTapeWithEvents([
      {
        kind: 'createRenderPipeline',
        handleId: 'rp:1',
        desc: {
          vertex: { module: {} as any, entryPoint: 'main' },
          primitive: { topology: 'triangle-list' },
        },
        layoutHandleId: 'layout:auto',
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('createComputePipeline round-trip', () => {
    const tape = makeTapeWithEvents([
      {
        kind: 'createComputePipeline',
        handleId: 'cp:1',
        desc: { compute: { module: {} as any, entryPoint: 'main' } },
        layoutHandleId: 'layout:auto',
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('createShaderModule round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createShaderModule', handleId: 'sm:1', wgslCode: 'fn main() {}' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const ev = res.value.events[0];
      expect(ev!.kind).toBe('createShaderModule');
      if (ev!.kind === 'createShaderModule') {
        expect(ev!.wgslCode).toBe('fn main() {}');
      }
    }
  });

  it('createCommandEncoder round-trip', () => {
    const tape = makeTapeWithEvents([{ kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' }]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('writeBuffer round-trip', () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    const tape = makeTapeWithEventsAndBlobs(
      [
        { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 4, usage: 16 } },
        { kind: 'writeBuffer', handleId: 'buf-1', bufferOffset: 0, dataHash: 'a1b2c3', size: 4 },
      ],
      [['a1b2c3', buf]],
    );
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const wb = res.value.events.find((e) => e.kind === 'writeBuffer');
      expect(wb).toBeDefined();
      expect(res.value.blobPool.has('a1b2c3')).toBe(true);
    }
  });

  it('writeTexture round-trip', () => {
    const buf = new Uint8Array(16);
    const tape = makeTapeWithEventsAndBlobs(
      [
        {
          kind: 'createTexture',
          handleId: 'texture:1',
          desc: {
            size: { width: 4, height: 4, depthOrArrayLayers: 1 },
            format: 'rgba8unorm' as GPUTextureFormat,
            usage: 16,
          },
        },
        {
          kind: 'writeTexture',
          destination: { textureHandleId: 'texture:1' },
          dataHash: 'd1e2f3',
          dataLayout: { bytesPerRow: 16, rowsPerImage: 4 },
          size: { width: 4, height: 4, depthOrArrayLayers: 1 },
        },
      ],
      [['d1e2f3', buf]],
    );
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('copyExternalImageToTexture round-trip', () => {
    const tape = makeTapeWithEvents([
      {
        kind: 'createTexture',
        handleId: 'texture:1',
        desc: {
          size: { width: 64, height: 64, depthOrArrayLayers: 1 },
          format: 'rgba8unorm' as GPUTextureFormat,
          usage: 16,
        },
      },
      {
        kind: 'copyExternalImageToTexture',
        source: { flipY: true },
        destination: { textureHandleId: 'texture:1' },
        copySize: { width: 64, height: 64, depthOrArrayLayers: 1 },
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('submit round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      { kind: 'finish', cmdHandleId: 'cmd:1' },
      { kind: 'submit', cmdHandleIds: ['cmd:1'] },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('beginRenderPass + endRenderPass round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('beginComputePass + endComputePass round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      { kind: 'beginComputePass', cmdHandleId: 'cmd:1', passHandleId: 'pass:1' },
      { kind: 'endComputePass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('copyBufferToBuffer round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 64, usage: 16 } },
      { kind: 'createBuffer', handleId: 'buf-2', desc: { size: 64, usage: 8 } },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'copyBufferToBuffer',
        cmdHandleId: 'cmd:1',
        sourceHandleId: 'buf-1',
        sourceOffset: 0,
        destinationHandleId: 'buf-2',
        destinationOffset: 0,
        size: 64,
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('copyBufferToTexture round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 64, usage: 4 } },
      {
        kind: 'createTexture',
        handleId: 'texture:1',
        desc: {
          size: { width: 4, height: 4, depthOrArrayLayers: 1 },
          format: 'rgba8unorm' as GPUTextureFormat,
          usage: 8,
        },
      },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'copyBufferToTexture',
        cmdHandleId: 'cmd:1',
        source: { bufferHandleId: 'buf-1', bytesPerRow: 16, rowsPerImage: 4 },
        destination: { textureHandleId: 'texture:1', origin: { x: 0, y: 0, z: 0 } },
        copySize: { width: 4, height: 4, depthOrArrayLayers: 1 },
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('copyTextureToBuffer round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 64, usage: 8 } },
      {
        kind: 'createTexture',
        handleId: 'texture:1',
        desc: {
          size: { width: 4, height: 4, depthOrArrayLayers: 1 },
          format: 'rgba8unorm' as GPUTextureFormat,
          usage: 16,
        },
      },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'copyTextureToBuffer',
        cmdHandleId: 'cmd:1',
        source: { textureHandleId: 'texture:1', origin: { x: 0, y: 0, z: 0 } },
        destination: { bufferHandleId: 'buf-1', bytesPerRow: 16, rowsPerImage: 4 },
        copySize: { width: 4, height: 4, depthOrArrayLayers: 1 },
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('copyTextureToTexture round-trip', () => {
    const tape = makeTapeWithEvents([
      {
        kind: 'createTexture',
        handleId: 'texture:1',
        desc: {
          size: { width: 4, height: 4, depthOrArrayLayers: 1 },
          format: 'rgba8unorm' as GPUTextureFormat,
          usage: 16,
        },
      },
      {
        kind: 'createTexture',
        handleId: 'texture:2',
        desc: {
          size: { width: 4, height: 4, depthOrArrayLayers: 1 },
          format: 'rgba8unorm' as GPUTextureFormat,
          usage: 8,
        },
      },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'copyTextureToTexture',
        cmdHandleId: 'cmd:1',
        source: { textureHandleId: 'texture:1', origin: { x: 0, y: 0, z: 0 } },
        destination: { textureHandleId: 'texture:2', origin: { x: 0, y: 0, z: 0 } },
        copySize: { width: 4, height: 4, depthOrArrayLayers: 1 },
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('clearBuffer round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 64, usage: 16 } },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      { kind: 'clearBuffer', cmdHandleId: 'cmd:1', handleId: 'buf-1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('pushDebugGroup / popDebugGroup / insertDebugMarker round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      { kind: 'pushDebugGroup', cmdHandleId: 'cmd:1', groupLabel: 'draw-pass' },
      { kind: 'insertDebugMarker', cmdHandleId: 'cmd:1', markerLabel: 'skybox' },
      { kind: 'popDebugGroup', cmdHandleId: 'cmd:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('finish round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      { kind: 'finish', cmdHandleId: 'cmd:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('setPipeline round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'createRenderPipeline', handleId: 'rp:1', desc: {}, layoutHandleId: 'layout:auto' },
      { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'rp:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('setVertexBuffer round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 128, usage: 32 } },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'setVertexBuffer', passHandleId: 'pass:1', slot: 0, bufferHandleId: 'buf-1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('setIndexBuffer round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 128, usage: 32 } },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'setIndexBuffer',
        passHandleId: 'pass:1',
        bufferHandleId: 'buf-1',
        format: 'uint16',
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('setBindGroup round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createBindGroupLayout', handleId: 'bgl:1', desc: { entries: [] } },
      { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 64, usage: 16 } },
      {
        kind: 'createBindGroup',
        handleId: 'bg:1',
        layoutHandleId: 'bgl:1',
        entries: [{ binding: 0, resourceKind: 'buffer' }],
        resourceHandleIds: ['buf-1'],
      },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'setBindGroup', passHandleId: 'pass:1', index: 0, bindGroupHandleId: 'bg:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('draw round-trip', () => {
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
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('drawIndexed round-trip', () => {
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
        kind: 'drawIndexed',
        passHandleId: 'pass:1',
        indexCount: 36,
        instanceCount: 1,
        firstIndex: 0,
        baseVertex: 0,
        firstInstance: 0,
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('setViewport round-trip', () => {
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
        kind: 'setViewport',
        passHandleId: 'pass:1',
        x: 0,
        y: 0,
        w: 800,
        h: 600,
        minDepth: 0,
        maxDepth: 1,
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('setScissorRect round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'setScissorRect', passHandleId: 'pass:1', x: 0, y: 0, w: 800, h: 600 },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('setComputePipeline round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      { kind: 'beginComputePass', cmdHandleId: 'cmd:1', passHandleId: 'pass:1' },
      {
        kind: 'createComputePipeline',
        handleId: 'cp:1',
        desc: { compute: { module: {} as any, entryPoint: 'main' } },
        layoutHandleId: 'layout:auto',
      },
      { kind: 'setComputePipeline', passHandleId: 'pass:1', pipelineHandleId: 'cp:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('dispatchWorkgroups round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      { kind: 'beginComputePass', cmdHandleId: 'cmd:1', passHandleId: 'pass:1' },
      { kind: 'dispatchWorkgroups', passHandleId: 'pass:1', x: 16, y: 1, z: 1 },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('endRenderPass round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });

  it('endComputePass round-trip', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      { kind: 'beginComputePass', cmdHandleId: 'cmd:1', passHandleId: 'pass:1' },
      { kind: 'endComputePass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });
});

// ============================================================================
// (b) formatVersion mismatch reject
// ============================================================================

describe('tape-format — formatVersion reject', () => {
  it('formatVersion = 0 -> reject (expectedVersion=3)', () => {
    const b = makeEmptyTape();
    const badTape: Tape = { ...b, formatVersion: 0 };
    const { json, blob } = serializeTape(badTape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('tape-format-version-mismatch');
      const detail = res.error.detail;
      if (detail && 'expectedVersion' in detail) {
        expect(detail.expectedVersion).toBe(3);
      }
    }
  });

  it('formatVersion = 4 -> reject (v3 accepts {2,3} only)', () => {
    const b = makeEmptyTape();
    const badTape: Tape = { ...b, formatVersion: 4 };
    const { json, blob } = serializeTape(badTape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('tape-format-version-mismatch');
      const detail = res.error.detail;
      if (detail && 'tapeVersion' in detail) {
        expect(detail.tapeVersion).toBe(4);
        expect(detail.expectedVersion).toBe(3);
      }
    }
  });

  it('formatVersion = 3 (current) -> accepted (v3 supports {2,3})', () => {
    const b = makeEmptyTape();
    const v3Tape: Tape = { ...b, formatVersion: 3 };
    const { json, blob } = serializeTape(v3Tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.formatVersion).toBe(3);
    }
  });

  it('v1 tape (formatVersion=1) -> explicit reject with expectedVersion=3', () => {
    const b = makeEmptyTape();
    const v1Tape: Tape = { ...b, formatVersion: 1 };
    const { json, blob } = serializeTape(v1Tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('tape-format-version-mismatch');
      const detail = res.error.detail;
      if (detail && 'tapeVersion' in detail) {
        expect(detail.tapeVersion).toBe(1);
        expect(detail.expectedVersion).toBe(3);
      }
    }
  });

  it('malformed JSON -> reject', () => {
    const res = deserializeTape('not-json', new Uint8Array(0));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('tape-format-version-mismatch');
    }
  });

  it('JSON without header/events -> reject', () => {
    const res = deserializeTape('{}', new Uint8Array(0));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('tape-format-version-mismatch');
    }
  });
});

// ============================================================================
// (c) blob pool hash dedup
// ============================================================================

describe('tape-format — blob pool dedup', () => {
  it('same hash only stored once', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const tape = makeTapeWithEventsAndBlobs(
      [
        { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 5, usage: 16 } },
        { kind: 'writeBuffer', handleId: 'buf-1', bufferOffset: 0, dataHash: 'abc', size: 5 },
        { kind: 'writeBuffer', handleId: 'buf-1', bufferOffset: 0, dataHash: 'abc', size: 5 },
      ],
      [['abc', data]],
    );
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.blobPool.size).toBe(1);
      expect(res.value.blobPool.has('abc')).toBe(true);
    }
  });

  it('different hashes stored separately', () => {
    const d1 = new Uint8Array([1, 2, 3]);
    const d2 = new Uint8Array([4, 5, 6]);
    const tape = makeTapeWithEventsAndBlobs(
      [
        { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 64, usage: 16 } },
        { kind: 'writeBuffer', handleId: 'buf-1', bufferOffset: 0, dataHash: 'aaa', size: 3 },
        { kind: 'writeBuffer', handleId: 'buf-1', bufferOffset: 0, dataHash: 'bbb', size: 3 },
      ],
      [
        ['aaa', d1],
        ['bbb', d2],
      ],
    );
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.blobPool.size).toBe(2);
    }
  });

  it('deserialized blob data matches original', () => {
    const data = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const tape = makeTapeWithEventsAndBlobs(
      [
        { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 6, usage: 16 } },
        { kind: 'writeBuffer', handleId: 'buf-1', bufferOffset: 0, dataHash: 'def', size: 6 },
      ],
      [['def', data]],
    );
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const deserData = res.value.blobPool.get('def');
      expect(deserData).toBeDefined();
      expect(new Uint8Array(deserData!)).toEqual(data);
    }
  });
});

// ============================================================================
// (d) handle id graph broken detection
// ============================================================================

describe('tape-format — handle graph integrity', () => {
  it('dangling handleId in writeBuffer -> reject', () => {
    const tape = makeTapeWithEvents([
      {
        kind: 'writeBuffer',
        handleId: 'buffer:nonexistent',
        bufferOffset: 0,
        dataHash: 'x',
        size: 4,
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('tape-handle-graph-broken');
    }
  });

  it('dangling handleId in draw -> reject', () => {
    const tape = makeTapeWithEvents([
      {
        kind: 'draw',
        passHandleId: 'pass:nonexistent',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('tape-handle-graph-broken');
    }
  });

  it('dangling in setPipeline -> reject', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'rp:nonexistent' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('tape-handle-graph-broken');
    }
  });

  it('AC-11: deserialize side hint does NOT contain bootstrap marker (cross-hint distinctness)', () => {
    const tape = makeTapeWithEvents([
      {
        kind: 'writeBuffer',
        handleId: 'buffer:nonexistent',
        bufferOffset: 0,
        dataHash: 'x',
        size: 4,
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('tape-handle-graph-broken');
      // Deserialize side hint must NOT contain 'bootstrap' (finalize-side-only marker)
      expect(res.error.hint).not.toContain('bootstrap');
      // Deserialize side hint should contain tape damage / stale marker
      const hintContainsTapeIssue =
        res.error.hint.includes('tape') ||
        res.error.hint.includes('corrupt') ||
        res.error.hint.includes('declared') ||
        res.error.hint.includes('old');
      expect(hintContainsTapeIssue).toBe(true);
    }
  });

  it('AC-08: dangling hint contains recovery guidance for steady-frame tapes without bootstrap creates', () => {
    // Simulate a stale steady-frame tape: a writeBuffer references a buffer
    // handleId that was never declared by any create* event. This is the
    // signature of a tape captured before the bootstrap self-containment fix.
    // The deserialize-side hint must guide AI users to re-capture.
    const tape = makeTapeWithEvents([
      {
        kind: 'writeBuffer',
        handleId: 'buffer:nonexistent',
        bufferOffset: 0,
        dataHash: 'x',
        size: 4,
      },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('tape-handle-graph-broken');
      // AC-08: hint must contain recovery guidance
      const hintContainsRecovery =
        res.error.hint.includes('self-contained') ||
        res.error.hint.includes('steady-frame') ||
        res.error.hint.includes('re-capture');
      expect(hintContainsRecovery).toBe(true);
    }
  });

  it('all handles valid -> ok', () => {
    const tape = makeTapeWithEvents([
      { kind: 'createBuffer', handleId: 'buf-1', desc: { size: 64, usage: 16 } },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'writeBuffer', handleId: 'buf-1', bufferOffset: 0, dataHash: 'x', size: 4 },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
  });
});

// ============================================================================
// (e) empty tape round-trip
// ============================================================================

describe('tape-format — empty tape', () => {
  it('empty events, empty blobPool -> round-trip ok', () => {
    const tape = makeEmptyTape();
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.events).toHaveLength(0);
      expect(res.value.blobPool.size).toBe(0);
      expect(res.value.formatVersion).toBe(TAPE_FORMAT_VERSION);
    }
  });
});

// ============================================================================
// (f) full frame tape round-trip
// ============================================================================

describe('tape-format — full frame tape', () => {
  it('10+ events with frameMark -> full round-trip', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createBuffer', handleId: 'buffer:vbo', desc: { size: 256, usage: 32 } },
      { kind: 'createBuffer', handleId: 'buffer:ibo', desc: { size: 128, usage: 32 } },
      { kind: 'createBuffer', handleId: 'buffer:ubo', desc: { size: 64, usage: 16 } },
      {
        kind: 'createShaderModule',
        handleId: 'sm:vert',
        wgslCode: 'fn vs_main() -> @builtin(position) vec4f { return vec4f(0); }',
      },
      {
        kind: 'createShaderModule',
        handleId: 'sm:frag',
        wgslCode: 'fn fs_main() -> @location(0) vec4f { return vec4f(1,0,0,1); }',
      },
      { kind: 'createBindGroupLayout', handleId: 'bgl:1', desc: { entries: [] } },
      { kind: 'createPipelineLayout', handleId: 'pl:1', bglHandleIds: ['bgl:1'] },
      {
        kind: 'createRenderPipeline',
        handleId: 'rp:1',
        desc: { vertex: { module: {} as any, entryPoint: 'main' } },
        layoutHandleId: 'pl:1',
      },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'rp:1' },
      { kind: 'writeBuffer', handleId: 'buffer:ubo', bufferOffset: 0, dataHash: 'cafe', size: 64 },
      { kind: 'setVertexBuffer', passHandleId: 'pass:1', slot: 0, bufferHandleId: 'buffer:vbo' },
      {
        kind: 'setIndexBuffer',
        passHandleId: 'pass:1',
        bufferHandleId: 'buffer:ibo',
        format: 'uint16',
      },
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
      { kind: 'finish', cmdHandleId: 'cmd:1' },
      { kind: 'submit', cmdHandleIds: ['cmd:1'] },
      { kind: 'frameMark', frameIdx: 0 },
    ];
    const data = new Uint8Array(64);
    const tape = makeTapeWithEventsAndBlobs(events, [['cafe', data]]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.events.length).toBe(events.length);
      expect(res.value.blobPool.has('cafe')).toBe(true);
      expect(res.value.formatVersion).toBe(TAPE_FORMAT_VERSION);
      // Verify frameMark is present
      expect(res.value.events.some((e) => e.kind === 'frameMark')).toBe(true);
    }
  });

  it('formatVersion survives round-trip', () => {
    const tape = makeTapeWithEvents([{ kind: 'frameMark', frameIdx: 5 }]);
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.formatVersion).toBe(TAPE_FORMAT_VERSION);
    }
  });

  it('rhiCapsRecorded survives round-trip', () => {
    const caps = {
      canvasFormat: 'rgba8unorm' as GPUTextureFormat,
      rgba16floatRenderable: true,
      float32Filterable: true,
      textureCompression: false,
      storageBuffer: true,
      timestampQuery: true,
    };
    const tape: Tape = {
      formatVersion: TAPE_FORMAT_VERSION,
      rhiCapsRecorded: caps,
      events: [],
      blobPool: new Map(),
    };
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.rhiCapsRecorded.canvasFormat).toBe('rgba8unorm');
      expect(res.value.rhiCapsRecorded.float32Filterable).toBe(true);
    }
  });
});

// ============================================================================
// (g) computePassOffsets regression tests — render-only passes (M1 w1, red)
// ============================================================================

describe('computePassOffsets — render-only regression', () => {
  it('single render pass with one draw: produces one offset with correct triples', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
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
    const offsets = computePassOffsets(events);
    expect(offsets).toHaveLength(1);
    expect(offsets[0]!.passIdx).toBe(0);
    expect(offsets[0]!.startDrawIdx).toBe(0);
    expect(offsets[0]!.endDrawIdx).toBe(0);
  });

  it('single render pass with drawIndexed: correct triples', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'rp:1' },
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
    const offsets = computePassOffsets(events);
    expect(offsets).toHaveLength(1);
    expect(offsets[0]!.passIdx).toBe(0);
    expect(offsets[0]!.startDrawIdx).toBe(0);
    expect(offsets[0]!.endDrawIdx).toBe(0);
  });

  it('single render pass with multiple draws: contiguous draw indices', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
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
        vertexCount: 6,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      {
        kind: 'drawIndexed',
        passHandleId: 'pass:1',
        indexCount: 12,
        instanceCount: 1,
        firstIndex: 0,
        baseVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ];
    const offsets = computePassOffsets(events);
    expect(offsets).toHaveLength(1);
    expect(offsets[0]!.passIdx).toBe(0);
    expect(offsets[0]!.startDrawIdx).toBe(0);
    expect(offsets[0]!.endDrawIdx).toBe(2);
  });

  it('multiple render passes: each pass has correct passIdx and draw range', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:2',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'draw',
        passHandleId: 'pass:2',
        vertexCount: 6,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      {
        kind: 'drawIndexed',
        passHandleId: 'pass:2',
        indexCount: 12,
        instanceCount: 1,
        firstIndex: 0,
        baseVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:2' },
    ];
    const offsets = computePassOffsets(events);
    expect(offsets).toHaveLength(2);
    // Pass 0
    expect(offsets[0]!.passIdx).toBe(0);
    expect(offsets[0]!.startDrawIdx).toBe(0);
    expect(offsets[0]!.endDrawIdx).toBe(0);
    // Pass 1
    expect(offsets[1]!.passIdx).toBe(1);
    expect(offsets[1]!.startDrawIdx).toBe(1);
    expect(offsets[1]!.endDrawIdx).toBe(2);
  });

  it('empty render pass (no draws): produces empty range (endDrawIdx < startDrawIdx)', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ];
    const offsets = computePassOffsets(events);
    expect(offsets).toHaveLength(1);
    expect(offsets[0]!.passIdx).toBe(0);
    // Empty pass: no draws within, start > end (empty range)
    expect(offsets[0]!.startDrawIdx).toBe(0);
    expect(offsets[0]!.endDrawIdx).toBe(-1);
  });

  it('mixed draw and drawIndexed within single pass: draws counted in sequence', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'drawIndexed',
        passHandleId: 'pass:1',
        indexCount: 36,
        instanceCount: 1,
        firstIndex: 0,
        baseVertex: 0,
        firstInstance: 0,
      },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      {
        kind: 'drawIndexed',
        passHandleId: 'pass:1',
        indexCount: 6,
        instanceCount: 1,
        firstIndex: 0,
        baseVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ];
    const offsets = computePassOffsets(events);
    expect(offsets).toHaveLength(1);
    expect(offsets[0]!.passIdx).toBe(0);
    expect(offsets[0]!.startDrawIdx).toBe(0);
    expect(offsets[0]!.endDrawIdx).toBe(2);
  });

  it('events outside any pass do not affect offsets', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createBuffer', handleId: 'buf:1', desc: { size: 64, usage: 16 } },
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
      { kind: 'createBuffer', handleId: 'buf:2', desc: { size: 128, usage: 32 } },
    ];
    const offsets = computePassOffsets(events);
    expect(offsets).toHaveLength(1);
    expect(offsets[0]!.passIdx).toBe(0);
    expect(offsets[0]!.startDrawIdx).toBe(0);
    expect(offsets[0]!.endDrawIdx).toBe(0);
  });

  it('three render passes with interleaved events: correct sequential passIdx and draw ranges', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:2',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'draw',
        passHandleId: 'pass:2',
        vertexCount: 6,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      {
        kind: 'draw',
        passHandleId: 'pass:2',
        vertexCount: 12,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:2' },
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:3',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'drawIndexed',
        passHandleId: 'pass:3',
        indexCount: 36,
        instanceCount: 1,
        firstIndex: 0,
        baseVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:3' },
    ];
    const offsets = computePassOffsets(events);
    expect(offsets).toHaveLength(3);
    // Pass 0
    expect(offsets[0]!.passIdx).toBe(0);
    expect(offsets[0]!.startDrawIdx).toBe(0);
    expect(offsets[0]!.endDrawIdx).toBe(0);
    // Pass 1
    expect(offsets[1]!.passIdx).toBe(1);
    expect(offsets[1]!.startDrawIdx).toBe(1);
    expect(offsets[1]!.endDrawIdx).toBe(2);
    // Pass 2
    expect(offsets[2]!.passIdx).toBe(2);
    expect(offsets[2]!.startDrawIdx).toBe(3);
    expect(offsets[2]!.endDrawIdx).toBe(3);
  });
});

// ============================================================================
// (h) computePassOffsets compute fixture tests — mixed render+compute (M1 w2, red)
// ============================================================================

describe('computePassOffsets — compute fixture', () => {
  it('render pass then compute pass then render pass: three entries in correct order', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      // Pass 0: render
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
      // Pass 1: compute
      { kind: 'beginComputePass', cmdHandleId: 'cmd:1', passHandleId: 'pass:2' },
      { kind: 'setComputePipeline', passHandleId: 'pass:2', pipelineHandleId: 'cp:1' },
      {
        kind: 'dispatchWorkgroups',
        passHandleId: 'pass:2',
        x: 8,
        y: 8,
        z: 1,
      },
      { kind: 'endComputePass', passHandleId: 'pass:2' },
      // Pass 2: render
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:3',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'drawIndexed',
        passHandleId: 'pass:3',
        indexCount: 36,
        instanceCount: 1,
        firstIndex: 0,
        baseVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:3' },
    ];
    const offsets = computePassOffsets(events);
    expect(offsets).toHaveLength(3);
    // Pass 0: render
    expect(offsets[0]!.passIdx).toBe(0);
    expect(offsets[0]!.startDrawIdx).toBe(0);
    expect(offsets[0]!.endDrawIdx).toBe(0);
    // Pass 1: compute
    expect(offsets[1]!.passIdx).toBe(1);
    expect(offsets[1]!.startDrawIdx).toBe(1);
    expect(offsets[1]!.endDrawIdx).toBe(1);
    // Pass 2: render
    expect(offsets[2]!.passIdx).toBe(2);
    expect(offsets[2]!.startDrawIdx).toBe(2);
    expect(offsets[2]!.endDrawIdx).toBe(2);
  });

  it('compute-only pass with multiple dispatchWorkgroups: correct draw index range', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      { kind: 'beginComputePass', cmdHandleId: 'cmd:1', passHandleId: 'pass:1' },
      { kind: 'setComputePipeline', passHandleId: 'pass:1', pipelineHandleId: 'cp:1' },
      {
        kind: 'dispatchWorkgroups',
        passHandleId: 'pass:1',
        x: 4,
        y: 4,
        z: 1,
      },
      {
        kind: 'dispatchWorkgroups',
        passHandleId: 'pass:1',
        x: 8,
        y: 8,
        z: 1,
      },
      {
        kind: 'dispatchWorkgroups',
        passHandleId: 'pass:1',
        x: 2,
        y: 2,
        z: 2,
      },
      { kind: 'endComputePass', passHandleId: 'pass:1' },
    ];
    const offsets = computePassOffsets(events);
    expect(offsets).toHaveLength(1);
    expect(offsets[0]!.passIdx).toBe(0);
    expect(offsets[0]!.startDrawIdx).toBe(0);
    expect(offsets[0]!.endDrawIdx).toBe(2);
  });

  it('interleaved render and compute passes: all four passes with contiguous indices', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      // Pass 0: render
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
      // Pass 1: compute
      { kind: 'beginComputePass', cmdHandleId: 'cmd:1', passHandleId: 'pass:2' },
      {
        kind: 'dispatchWorkgroups',
        passHandleId: 'pass:2',
        x: 8,
        y: 8,
        z: 1,
      },
      { kind: 'endComputePass', passHandleId: 'pass:2' },
      // Pass 2: render
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'cmd:1',
        passHandleId: 'pass:3',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: [],
      },
      {
        kind: 'draw',
        passHandleId: 'pass:3',
        vertexCount: 6,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      {
        kind: 'drawIndexed',
        passHandleId: 'pass:3',
        indexCount: 12,
        instanceCount: 1,
        firstIndex: 0,
        baseVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:3' },
      // Pass 3: compute
      { kind: 'beginComputePass', cmdHandleId: 'cmd:1', passHandleId: 'pass:4' },
      {
        kind: 'dispatchWorkgroups',
        passHandleId: 'pass:4',
        x: 16,
        y: 16,
        z: 1,
      },
      {
        kind: 'dispatchWorkgroups',
        passHandleId: 'pass:4',
        x: 4,
        y: 4,
        z: 4,
      },
      { kind: 'endComputePass', passHandleId: 'pass:4' },
    ];
    const offsets = computePassOffsets(events);
    expect(offsets).toHaveLength(4);
    // Pass 0: render
    expect(offsets[0]!.passIdx).toBe(0);
    expect(offsets[0]!.startDrawIdx).toBe(0);
    expect(offsets[0]!.endDrawIdx).toBe(0);
    // Pass 1: compute
    expect(offsets[1]!.passIdx).toBe(1);
    expect(offsets[1]!.startDrawIdx).toBe(1);
    expect(offsets[1]!.endDrawIdx).toBe(1);
    // Pass 2: render
    expect(offsets[2]!.passIdx).toBe(2);
    expect(offsets[2]!.startDrawIdx).toBe(2);
    expect(offsets[2]!.endDrawIdx).toBe(3);
    // Pass 3: compute
    expect(offsets[3]!.passIdx).toBe(3);
    expect(offsets[3]!.startDrawIdx).toBe(4);
    expect(offsets[3]!.endDrawIdx).toBe(5);
  });

  it('compute pass with no dispatchWorkgroups: empty range (endDrawIdx < startDrawIdx)', () => {
    const events: RhiCallEvent[] = [
      { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
      { kind: 'beginComputePass', cmdHandleId: 'cmd:1', passHandleId: 'pass:1' },
      { kind: 'setComputePipeline', passHandleId: 'pass:1', pipelineHandleId: 'cp:1' },
      { kind: 'endComputePass', passHandleId: 'pass:1' },
    ];
    const offsets = computePassOffsets(events);
    expect(offsets).toHaveLength(1);
    expect(offsets[0]!.passIdx).toBe(0);
    // No dispatches: start > end (empty range)
    expect(offsets[0]!.startDrawIdx).toBe(0);
    expect(offsets[0]!.endDrawIdx).toBe(-1);
  });
});

// ============================================================================
// initialData round-trip (w4 — M1)
// ============================================================================

describe('tape-format — initialData round-trip', () => {
  it('initialData event round-trip (serialize -> deserialize)', () => {
    const initialDataEvent: RhiCallEventInitialData = {
      kind: 'initialData',
      handleId: 'buf:vbo',
      dataHash: 'deadbeef',
    };
    const tape = makeTapeWithEventsAndBlobs(
      [
        {
          kind: 'createBuffer' as const,
          handleId: 'buf:vbo',
          desc: { size: 72, usage: 0x01 | 0x10, mappedAtCreation: false },
        },
        initialDataEvent as RhiCallEvent,
      ],
      [['deadbeef', new Uint8Array([0, 1, 2, 3])]],
    );
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const events = res.value.events;
      expect(events).toHaveLength(2);
      // Verify createBuffer preserved
      expect(events[0]!.kind).toBe('createBuffer');
      // Verify initialData preserved
      const idEvent = events[1];
      expect(idEvent!.kind).toBe('initialData');
      const id = idEvent as { kind: 'initialData'; handleId: string; dataHash: string };
      expect(id.handleId).toBe('buf:vbo');
      expect(id.dataHash).toBe('deadbeef');
    }
  });

  it('multiple initialData events in bootstrap prefix round-trip', () => {
    const id1: RhiCallEventInitialData = {
      kind: 'initialData',
      handleId: 'buf:vbo',
      dataHash: 'aaa111',
    };
    const id2: RhiCallEventInitialData = {
      kind: 'initialData',
      handleId: 'buf:ibo',
      dataHash: 'bbb222',
    };
    const tape = makeTapeWithEventsAndBlobs(
      [
        {
          kind: 'createBuffer' as const,
          handleId: 'buf:vbo',
          desc: { size: 72, usage: 0x01 | 0x10, mappedAtCreation: false },
        },
        {
          kind: 'createBuffer' as const,
          handleId: 'buf:ibo',
          desc: { size: 36, usage: 0x01 | 0x10, mappedAtCreation: false },
        },
        id1 as RhiCallEvent,
        id2 as RhiCallEvent,
      ],
      [
        ['aaa111', new Uint8Array([10, 20, 30])],
        ['bbb222', new Uint8Array([40, 50])],
      ],
    );
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const events = res.value.events;
      expect(events).toHaveLength(4);
      expect(events[0]!.kind).toBe('createBuffer');
      expect(events[2]!.kind).toBe('initialData');
      expect(events[3]!.kind).toBe('initialData');
      const ev1 = events[2] as { kind: 'initialData'; handleId: string; dataHash: string };
      expect(ev1.handleId).toBe('buf:vbo');
      expect(ev1.dataHash).toBe('aaa111');
      const ev2 = events[3] as { kind: 'initialData'; handleId: string; dataHash: string };
      expect(ev2.handleId).toBe('buf:ibo');
      expect(ev2.dataHash).toBe('bbb222');
    }
  });

  it('v2 tape with initialData round-trip (formatVersion=2, passes when TAPE_FORMAT_VERSION=2)', () => {
    const v2InitialData: RhiCallEventInitialData = {
      kind: 'initialData',
      handleId: 'buf:1',
      dataHash: 'abc123',
    };
    const tape: Tape = {
      formatVersion: 2,
      rhiCapsRecorded: {
        canvasFormat: 'bgra8unorm' as GPUTextureFormat,
        rgba16floatRenderable: false,
        float32Filterable: false,
        textureCompression: false,
        storageBuffer: false,
        timestampQuery: false,
      },
      events: [
        {
          kind: 'createBuffer' as const,
          handleId: 'buf:1',
          desc: { size: 128, usage: 0x01 | 0x10, mappedAtCreation: false },
        },
        v2InitialData as RhiCallEvent,
      ],
      blobPool: new Map([['abc123', new Uint8Array([7, 8, 9]).buffer as ArrayBuffer]]),
    };
    // M2: TAPE_FORMAT_VERSION=2, so v2 tape deserializes successfully.
    const { json, blob } = serializeTape(tape);
    const res = deserializeTape(json, blob);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.formatVersion).toBe(2);
      expect(res.value.events).toHaveLength(2);
      const idEvent = res.value.events[1];
      expect(idEvent!.kind).toBe('initialData');
      const id = idEvent as { kind: 'initialData'; handleId: string; dataHash: string };
      expect(id.handleId).toBe('buf:1');
      expect(id.dataHash).toBe('abc123');
      expect(res.value.blobPool.has('abc123')).toBe(true);
    }
  });

  // ============================================================================
  // (i) initialData handle graph integrity (w10)
  // ============================================================================

  describe('tape-format — initialData handle graph', () => {
    it('initialData dangling handleId (handleId not in declared set) -> reject', () => {
      const idEvent: RhiCallEventInitialData = {
        kind: 'initialData',
        handleId: 'buf:nonexistent',
        dataHash: 'deadbeef',
      };
      const tape = makeTapeWithEventsAndBlobs(
        [idEvent as RhiCallEvent],
        [['deadbeef', new Uint8Array([0, 1, 2, 3])]],
      );
      const { json, blob } = serializeTape(tape);
      const res = deserializeTape(json, blob);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('tape-handle-graph-broken');
      }
    });

    it('initialData with declared handleId -> ok', () => {
      const idEvent: RhiCallEventInitialData = {
        kind: 'initialData',
        handleId: 'buf:vbo',
        dataHash: 'deadbeef',
      };
      const tape = makeTapeWithEventsAndBlobs(
        [
          {
            kind: 'createBuffer' as const,
            handleId: 'buf:vbo',
            desc: { size: 72, usage: 0x01 | 0x10, mappedAtCreation: false },
          },
          idEvent as RhiCallEvent,
        ],
        [['deadbeef', new Uint8Array([0, 1, 2, 3])]],
      );
      const { json, blob } = serializeTape(tape);
      const res = deserializeTape(json, blob);
      expect(res.ok).toBe(true);
    });
  });
});
