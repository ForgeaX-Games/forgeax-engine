import { describe, expect, it } from 'vitest';
import { DeviceScope } from '../device/device-scope';
import {
  createExtendedLightingResourceCandidate,
  inspectExtendedLightingResources,
} from '../prepare/extended-lighting/resources';
import {
  createExtendedLightingState,
  promoteExtendedLightingCandidate,
} from '../prepare/extended-lighting/state';

describe('extended lighting zero-feature integration', () => {
  it('keeps all extension allocations and graph work at exact zero', () => {
    const scope = DeviceScope.create(1, 'renderer');
    const state = createExtendedLightingState(1);
    const inspection = inspectExtendedLightingResources(scope);

    expect(state.enabled).toBe(false);
    expect(inspection).toEqual({
      topology: 'extendedLighting',
      generation: 1,
      status: 'empty',
      accepted: false,
      resourceCount: 0,
      descriptorBytes: 0,
      uploadCount: 0,
      blendInvalidations: 0,
      passCount: 0,
    });
    expect(promoteExtendedLightingCandidate(state, undefined)).toEqual(state);
  });

  it('retains accepted resources when a later candidate is rejected', async () => {
    const scope = DeviceScope.create(2, 'renderer');
    const state = createExtendedLightingState(2);
    const rejected = await createExtendedLightingResourceCandidate({
      device: undefined,
      scope,
      iesSliceCount: 33,
      cookieSliceCount: 0,
      cookieMatrices: 0,
    });

    expect(rejected.ok).toBe(false);
    expect(
      promoteExtendedLightingCandidate(state, rejected.ok ? rejected.value : undefined),
    ).toMatchObject({
      status: 'empty',
      accepted: undefined,
    });
  });
});
