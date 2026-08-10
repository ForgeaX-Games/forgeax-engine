/// <reference types="@webgpu/types" />

// biome-ignore-all lint/suspicious/noExplicitAny: the fake RHI boundary models opaque GPU handles.

import type { RhiDevice } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type LiveObservationLease, readbackLiveLinearHdr } from '../readback';

const descriptor = {
  texture: {} as any,
  format: 'rgba16float',
  size: { width: 2, height: 1 },
  usage: 0x10 | 0x04 | 0x01,
  frameId: 12,
  sample: 1,
};

function lease(overrides: Partial<LiveObservationLease> = {}): LiveObservationLease {
  return {
    descriptor,
    lifetime: { frameId: 12, state: 'active' },
    state: 'active',
    beginReadback: () =>
      ok({
        texture: descriptor.texture,
        descriptor,
        lifetime: { frameId: 12, state: 'active' },
      }),
    retire: () => undefined,
    ...overrides,
  };
}

function fakeDevice(options: { mapError?: boolean } = {}): RhiDevice {
  const mapped = {
    getMappedRange: () => ok(new ArrayBuffer(256)),
    unmap: () => undefined,
  };
  const buffer = {
    mapAsync: async () =>
      options.mapError
        ? err({ code: 'map-failed', expected: 'map', hint: 'map failed' } as any)
        : ok(mapped as any),
  };
  const encoder = {
    copyTextureToBuffer: () => undefined,
    finish: () => ok({}),
  };
  return {
    createBuffer: () => ok(buffer as any),
    createCommandEncoder: () => ok(encoder as any),
    destroyBuffer: () => undefined,
    queue: {
      submit: () => undefined,
      onSubmittedWorkDone: async () => undefined,
    },
  } as any;
}

describe('live rgba16float readback ticket', () => {
  it('returns native bytes, metadata, raw hash, and active lifetime', async () => {
    const result = await readbackLiveLinearHdr(fakeDevice(), lease());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bytes.byteLength).toBe(16);
    expect(result.value.format).toBe('rgba16float');
    expect(result.value.size).toEqual({ width: 2, height: 1 });
    expect(result.value.rawHash).toMatch(/[0-9a-f]+/);
    expect(result.value.frameId).toBe(12);
    expect(result.value.status).toBe('ready');
    expect(result.value.lifetime).toEqual({ frameId: 12, state: 'active' });
  });

  it('fails with snapshot-readback-failed for stale or map failures', async () => {
    const stale = await readbackLiveLinearHdr(
      fakeDevice(),
      lease({
        beginReadback: () =>
          err({
            code: 'observation-stale',
            expected: 'active lease',
            hint: 'stale lease',
          } as any),
      }),
    );
    const mapped = await readbackLiveLinearHdr(fakeDevice({ mapError: true }), lease());

    expect(stale.ok).toBe(false);
    expect(mapped.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('snapshot-readback-failed');
    if (!mapped.ok) expect(mapped.error.code).toBe('snapshot-readback-failed');
  });
});
