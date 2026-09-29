import { describe, expect, it } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import {
  COOKIE_SLICE_CAPACITY,
  createExtendedLightingResourceCandidate,
  EXTENDED_LIGHTING_TOPOLOGY,
  IES_SLICE_CAPACITY,
  inspectExtendedLightingResources,
} from '../prepare/extended-lighting/resources';
import { createExtendedLightingState } from '../prepare/extended-lighting/state';

describe('extended lighting resource topology', () => {
  it('uses one closed topology and exact-zero state without authored extensions', () => {
    const state = createExtendedLightingState(3);

    expect(EXTENDED_LIGHTING_TOPOLOGY).toBe('extendedLighting');
    expect(state).toMatchObject({
      enabled: false,
      generation: 3,
      status: 'empty',
      resourceCount: 0,
      descriptorBytes: 0,
      uploadCount: 0,
      passCount: 0,
      bindGroupCount: 0,
    });
  });

  it('reserves the fixed 32-slice IES and Cookie capacities', () => {
    expect(IES_SLICE_CAPACITY).toBe(32);
    expect(COOKIE_SLICE_CAPACITY).toBe(32);
  });

  it('does not publish a candidate until every resource and upload succeeds', async () => {
    const scope = DeviceScope.create(4, 'renderer');
    const candidate = await createExtendedLightingResourceCandidate({
      device: undefined,
      scope,
      iesSliceCount: 1,
      cookieSliceCount: 1,
      cookieMatrices: 1,
    });

    expect(candidate.ok).toBe(false);
    expect(inspectExtendedLightingResources(scope)).toMatchObject({
      status: 'empty',
      accepted: false,
      resourceCount: 0,
    });
  });
});
