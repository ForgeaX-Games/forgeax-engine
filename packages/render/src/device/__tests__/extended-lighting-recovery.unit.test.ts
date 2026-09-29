import { describe, expect, it } from 'vitest';
import {
  createExtendedLightingResourceCandidate,
  inspectExtendedLightingResources,
} from '../../prepare/extended-lighting/resources';
import { DeviceScope } from '../device-scope';

describe('extended lighting device recovery', () => {
  it('retires the old scope and rebuilds one accepted resource generation', async () => {
    const oldScope = DeviceScope.create(8, 'renderer');
    const oldResource = oldScope.ref('texture', { id: 'old' });
    const candidate = await createExtendedLightingResourceCandidate({
      device: undefined,
      scope: oldScope,
      iesSliceCount: 0,
      cookieSliceCount: 0,
      cookieMatrices: 0,
    });

    expect(candidate.ok).toBe(false);
    expect(oldResource.isCurrent(oldScope)).toBe(true);
    expect(inspectExtendedLightingResources(oldScope).generation).toBe(8);
  });
});
