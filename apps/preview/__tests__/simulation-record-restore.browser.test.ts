import { describe, expect, it } from 'vitest';

import { createPreviewInspection } from '../src/preview-inspection';

function appStub() {
  return {
    renderer: {
      health: () => ({ state: 'ready' }),
      recover: async () => ({ ok: true, value: undefined }),
    },
    simulationInspection: () => ({
      formatVersion: 1,
      recordOwner: '@forgeax/engine-ecs',
      schemaOwner: '@forgeax/engine-ecs',
      baselineFingerprint: 'simulation-v1:preview',
      participants: [],
      trace: { recordTick: 0, sampleCount: 0 },
      report: { verdict: 'match', entries: [] },
    }),
  };
}

describe('Preview simulation record/restore read-only consumer', () => {
  it('discovers and reads the simulation summary without exposing a restore action', async () => {
    const { inspection } = createPreviewInspection(appStub() as never, () => undefined);
    const listing = inspection.list();
    expect(listing.reads.map((entry) => entry.id)).toContain('simulation.inspect');
    expect(listing.actions.map((entry) => entry.id)).not.toContain('simulation.restore');
    expect(listing.actions.map((entry) => entry.id)).not.toContain('simulation.replay');

    const result = await inspection.read('simulation.inspect');
    expect(result).toMatchObject({
      ok: true,
      value: {
        formatVersion: 1,
        recordOwner: '@forgeax/engine-ecs',
        schemaOwner: '@forgeax/engine-ecs',
        baselineFingerprint: 'simulation-v1:preview',
      },
    });
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty('world');
    expect(result.value).not.toHaveProperty('native');
  });
});
