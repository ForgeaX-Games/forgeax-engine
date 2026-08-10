/// <reference types="@webgpu/types" />

import type { RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type LiveObservationLease, readbackNamedLinearHdr } from '../readback';

const descriptor = {
  texture: {} as unknown,
  format: 'rgba16float',
  size: { width: 1, height: 1 },
  usage: 0x01,
  frameId: 7,
};

const lease: LiveObservationLease = {
  descriptor,
  lifetime: { frameId: 7, state: 'active' },
  state: 'active',
  beginReadback: () =>
    ok({
      texture: descriptor.texture,
      descriptor,
      lifetime: { frameId: 7, state: 'active' },
    }),
  retire: () => undefined,
};

function device(): RhiDevice {
  const buffer = {
    getMappedRange: () => ok(new ArrayBuffer(256)),
    mapAsync: async () => ok(buffer),
    unmap: () => undefined,
  };
  const encoder = {
    copyTextureToBuffer: () => undefined,
    finish: () => ok({}),
  };
  return {
    createBuffer: () => ok(buffer as unknown),
    createCommandEncoder: () => ok(encoder as unknown),
    destroyBuffer: () => undefined,
    queue: {
      submit: () => undefined,
      onSubmittedWorkDone: async () => undefined,
    },
  } as unknown as RhiDevice;
}

describe('named IBL raw attachment readback', () => {
  it('retains attachment name, layer, format, hash, capability, and LKG metadata', async () => {
    const result = await readbackNamedLinearHdr(device(), lease, {
      attachmentName: 'ibl.irradiance',
      layer: 2,
      capabilitySnapshot: { rgba16floatRenderable: true },
      fallbackArtifact: null,
      lastKnownGood: 'ibl.irradiance@rgba16float',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      attachmentName: 'ibl.irradiance',
      layer: 2,
      format: 'rgba16float',
      size: { width: 1, height: 1 },
      frameId: 7,
      capabilitySnapshot: { rgba16floatRenderable: true },
      fallbackArtifact: null,
      lastKnownGood: 'ibl.irradiance@rgba16float',
    });
    expect(result.value.rawHash).toMatch(/[0-9a-f]+/);
  });
});
