import type { Texture } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import {
  type FrameObservationReadback,
  type FrameObservationSource,
  observeCurrentFrame,
} from '../record/frame-observation.js';

const texture = {} as Texture;
const usage = 0x10 | 0x04 | 0x01;

function source(overrides: Partial<FrameObservationSource> = {}): FrameObservationSource {
  return {
    texture,
    descriptor: {
      texture,
      format: 'rgba16float',
      size: { width: 4, height: 2 },
      usage,
      sample: 1,
    },
    frameId: 12,
    pipelineId: 'forgeax::urp',
    backendId: 'webgpu',
    ...overrides,
  };
}

describe('render current-frame observation producer contract', () => {
  it('observes only the producer-owned linear HDR target', async () => {
    const readback: FrameObservationReadback = vi.fn(async (lease) => {
      expect(lease.descriptor.format).toBe('rgba16float');
      return ok(new Uint8Array(4 * 2 * 8));
    });

    const result = await observeCurrentFrame({ semantic: 'linear-hdr', readback }, source(), 12);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bytes.byteLength).toBe(64);
    expect(result.value.metadata).toMatchObject({
      format: 'rgba16float',
      size: { width: 4, height: 2 },
      frameId: 12,
      pipelineId: 'forgeax::urp',
      backendId: 'webgpu',
    });
    expect(readback).toHaveBeenCalledTimes(1);
  });

  it('fails closed for stale, missing, malformed, or final-canvas sources', async () => {
    const readback: FrameObservationReadback = vi.fn(async () => ok(new Uint8Array(64)));
    const cases: Array<[FrameObservationSource | undefined, string]> = [
      [undefined, 'observation-unavailable'],
      [source({ frameId: 11 }), 'observation-unavailable'],
      [
        source({ descriptor: { ...source().descriptor, format: 'bgra8unorm' } }),
        'observation-unavailable',
      ],
      [
        source({ descriptor: { ...source().descriptor, usage: 0x10 | 0x04 } }),
        'observation-unavailable',
      ],
    ];

    for (const [candidate, code] of cases) {
      const result = await observeCurrentFrame({ semantic: 'linear-hdr', readback }, candidate, 12);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(code);
    }
    expect(readback).not.toHaveBeenCalled();
  });

  it('preserves URP and HDRP producer identity without backend policy', async () => {
    const readback: FrameObservationReadback = vi.fn(async () => ok(new Uint8Array(64)));
    const urp = await observeCurrentFrame(
      { semantic: 'linear-hdr', readback },
      source({ pipelineId: 'forgeax::urp' }),
      12,
    );
    const hdrp = await observeCurrentFrame(
      { semantic: 'linear-hdr', readback },
      source({ pipelineId: 'forgeax::hdrp' }),
      12,
    );

    expect(urp.ok && hdrp.ok).toBe(true);
    if (urp.ok && hdrp.ok) {
      expect(urp.value.metadata.pipelineId).toBe('forgeax::urp');
      expect(hdrp.value.metadata.pipelineId).toBe('forgeax::hdrp');
      expect(urp.value.metadata.backendId).toBe(hdrp.value.metadata.backendId);
    }
  });

  it('does not treat a final-canvas readback as a linear attachment', async () => {
    const readback: FrameObservationReadback = vi.fn(async () => ok(new Uint8Array(4)));
    const result = await observeCurrentFrame({ semantic: 'linear-hdr', readback }, undefined, 12);

    expect(result.ok).toBe(false);
    expect(readback).not.toHaveBeenCalled();
  });
});
