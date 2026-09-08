import { describe, expect, it } from 'vitest';
import { buildFrameModel, buildResourceLifecycle } from '../frame-model';
import { decodeTape, encodeTape } from '../protocol/codec';
import type { RhiCallEvent, Tape } from '../protocol/types';

const events: readonly RhiCallEvent[] = [
  { kind: 'createBuffer', handleId: 'buf:1', desc: { size: 64, usage: 4 } },
  {
    kind: 'createTexture',
    handleId: 'tex:1',
    desc: {
      size: { width: 4, height: 4, depthOrArrayLayers: 2 },
      format: 'rgba16float',
      mipLevelCount: 2,
      usage: 1,
    },
  },
  {
    kind: 'createTexture',
    handleId: 'depth:1',
    desc: { size: { width: 4, height: 4 }, format: 'depth24plus', usage: 4 },
  },
  { kind: 'createTextureView', sourceHandleId: 'tex:1', resultHandleId: 'view:1', desc: {} },
  { kind: 'destroyBuffer', handleId: 'buf:1' },
];

function makeTape(tapeEvents: readonly RhiCallEvent[] = events): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: tapeEvents.length, blobCount: 0 },
    bootstrap: [],
    events: tapeEvents,
    blobs: [],
  };
}

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
    const model = buildFrameModel(makeTape());
    expect(model.resourceLifecycle.counts.live).toBe(3);
    expect(model.resourceLifecycle.resources).toHaveLength(4);
  });

  it('round-trips destroy events in the v7 tape format', () => {
    const encoded = encodeTape(makeTape());
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeTape(encoded.value);
    expect(decoded.ok).toBe(true);
    if (decoded.ok)
      expect(decoded.value.events.at(-1)).toEqual({ kind: 'destroyBuffer', handleId: 'buf:1' });
  });

  it('keeps swapchain textures out of engine-owned attribution', () => {
    const report = buildResourceLifecycle([
      {
        kind: 'createTexture',
        handleId: 'swapchain:1',
        origin: 'swapchain',
        desc: {
          size: { width: 1280, height: 720, depthOrArrayLayers: 1 },
          format: 'bgra8unorm',
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
