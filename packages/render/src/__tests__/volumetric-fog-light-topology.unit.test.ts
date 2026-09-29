import { describe, expect, it } from 'vitest';
import { volumetricFogTopology } from '../volume/passes';

describe('volumetric fog selected-light topology', () => {
  it('publishes selected light kind and identity without changing the four-pass budget', () => {
    const topology = volumetricFogTopology(true, {
      lightKind: 'spot',
      lightEntity: 17,
      lightRevision: 4,
    });

    expect(topology.lightKind).toBe('spot');
    expect(topology.lightEntity).toBe(17);
    expect(topology.lightRevision).toBe(4);
    expect(topology.passes).toHaveLength(4);
  });

  it('keeps selected light facts out of disabled topology', () => {
    expect(volumetricFogTopology(false)).toMatchObject({ passes: [], resources: [] });
  });
});
