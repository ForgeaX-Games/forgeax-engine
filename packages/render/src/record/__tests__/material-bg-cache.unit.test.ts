import type { BindGroup, BindGroupLayout, Buffer } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import type { MaterialSnapshot } from '../../render-system-extract';
import type { MaterialBgAssemblyCacheEntry } from '../frame-snapshot';
import { isMaterialBgAssemblyCacheHit } from '../main-pass-material';

describe('material bind-group assembly cache', () => {
  it('invalidates when material buffer capacity growth replaces the buffer', () => {
    const material = {} as MaterialSnapshot;
    const materialBgl = {} as BindGroupLayout;
    const oldBuffer = {} as Buffer;
    const newBuffer = {} as Buffer;
    const skylightResources = {
      irradianceView: {},
      irradianceSampler: {},
      prefilterView: {},
      prefilterSampler: {},
      brdfLutView: {},
      brdfLutSampler: {},
      intensityBuffer: {},
    } as MaterialBgAssemblyCacheEntry['skylightResources'];
    const cached: MaterialBgAssemblyCacheEntry = {
      material,
      materialResourceEpoch: 7,
      materialBgl,
      materialBuffer: oldBuffer,
      skylightResources,
      bindGroup: {} as BindGroup,
    };

    expect(
      isMaterialBgAssemblyCacheHit(cached, material, materialBgl, oldBuffer, skylightResources, 7),
    ).toBe(true);
    expect(
      isMaterialBgAssemblyCacheHit(cached, material, materialBgl, newBuffer, skylightResources, 7),
    ).toBe(false);
    expect(
      isMaterialBgAssemblyCacheHit(cached, material, materialBgl, oldBuffer, skylightResources, 8),
    ).toBe(false);
  });
});
