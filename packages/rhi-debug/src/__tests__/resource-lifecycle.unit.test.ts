import { describe, expect, it } from 'vitest';
import { buildFrameModel } from '../frame-model';
import { buildResourceLifecycle } from '../resource-lifecycle';
import { deserializeTape, serializeTape, TAPE_FORMAT_VERSION } from '../tape-format';
import type { RhiCallEvent, Tape } from '../types';

function makeTape(events: readonly RhiCallEvent[]): Tape {
  return {
    formatVersion: TAPE_FORMAT_VERSION,
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
    events,
    blobPool: new Map(),
  };
}

const events: readonly RhiCallEvent[] = [
  { kind: 'createBuffer', handleId: 'buf:1', desc: { size: 64, usage: 4 } },
  {
    kind: 'createTexture',
    handleId: 'tex:1',
    desc: {
      size: { width: 4, height: 4, depthOrArrayLayers: 2 },
      format: 'rgba16float' as GPUTextureFormat,
      mipLevelCount: 2,
      usage: 1,
    },
  },
  {
    kind: 'createTexture',
    handleId: 'depth:1',
    desc: { size: { width: 4, height: 4 }, format: 'depth24plus' as GPUTextureFormat, usage: 4 },
  },
  { kind: 'createTextureView', sourceHandleId: 'tex:1', resultHandleId: 'view:1', desc: {} },
  { kind: 'destroyBuffer', handleId: 'buf:1' },
];

describe('resource lifecycle attribution', () => {
  it('joins create/destroy events and keeps unavailable bytes explicit', () => {
    const report = buildResourceLifecycle(events);

    expect(report.scope).toBe('captured-tape-resource-closure');
    expect(report.counts).toEqual({
      created: 4,
      destroyed: 1,
      live: 3,
      destroyEvents: 1,
      unknownDestroyEvents: 0,
    });
    expect(report.bytes).toEqual({
      knownCreated: 384,
      knownDestroyed: 64,
      knownLive: 320,
      unavailableCreated: 2,
      unavailableDestroyed: 0,
      unavailableLive: 2,
    });
    expect(report.availability).toEqual({
      destroy: 'observed-buffer-texture',
      retire: 'unavailable',
      driverAllocation: 'unavailable',
    });
    expect(report.resources.find((resource) => resource.handleId === 'buf:1')).toMatchObject({
      kind: 'buffer',
      state: 'destroyed',
      byteEstimate: { status: 'known', bytes: 64, basis: 'buffer-descriptor' },
    });
    expect(
      report.resources.find((resource) => resource.handleId === 'depth:1')?.byteEstimate,
    ).toEqual({
      status: 'unavailable',
      reason: 'unsupported-texture-format',
    });
  });

  it('is part of the same FrameModel used by the public summary', () => {
    const model = buildFrameModel(makeTape(events));
    const texture = model.resources.get('tex:1');
    expect(texture?.kind).toBe('createTexture');
    if (texture?.kind === 'createTexture') expect(texture.size).toEqual([4, 4, 2]);
    expect(model.resourceLifecycle.counts.live).toBe(3);
    expect(model.resourceLifecycle.resources).toHaveLength(4);
  });

  it('round-trips destroy events in the tape format', () => {
    const serialized = serializeTape(makeTape(events));
    const result = deserializeTape(serialized.json, serialized.blob);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events.at(-1)).toEqual({ kind: 'destroyBuffer', handleId: 'buf:1' });
    }
  });

  it('keeps swapchain textures out of engine-owned attribution', () => {
    const report = buildResourceLifecycle([
      {
        kind: 'createTexture',
        handleId: 'swapchain:1',
        origin: 'swapchain',
        desc: {
          size: { width: 1280, height: 720, depthOrArrayLayers: 1 },
          format: 'bgra8unorm' as GPUTextureFormat,
          usage: 1,
        },
      },
      {
        kind: 'createTextureView',
        sourceHandleId: 'swapchain:1',
        resultHandleId: 'view:1',
        desc: {},
      },
    ]);

    expect(report.originBreakdown.engine.created).toBe(0);
    expect(report.originBreakdown.swapchain.created).toBe(2);
    expect(report.resources.every((resource) => resource.origin === 'swapchain')).toBe(true);
  });
});
