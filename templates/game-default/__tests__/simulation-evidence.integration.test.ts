import {
  FixedUpdate,
  World,
  defineComponent,
  type SimulationEvidenceReport,
} from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';

import {
  runSimulationEvidence,
  type SimulationEvidenceOptions,
} from '../assets/plugins/simulation-evidence';

const EvidencePosition = defineComponent('GameDefaultSimulationEvidencePosition', {
  value: 'f32',
});

function createWorld(withAuthoredEntity: boolean): World {
  const world = new World({
    time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 8, maxDeltaSeconds: 0.2 },
  });
  world.addSystem(FixedUpdate, {
    name: 'game-default-simulation-evidence-step',
    queries: [],
    fn: (_world) => {
      if (_world.inspect().entityCount === 0) return;
      const entity = _world.query({ read: [EvidencePosition] }).unwrap()[Symbol.iterator]().next()
        .value;
      if (entity === undefined) return;
      const value = _world.get(entity.entity, EvidencePosition).unwrap();
      _world.set(entity.entity, EvidencePosition, { value: value.value + 1 });
    },
  }).unwrap();
  if (withAuthoredEntity) {
    world.spawn({ component: EvidencePosition, data: { value: 0 } }).unwrap();
  }
  return world;
}

describe('game-default simulation evidence owner', () => {
  it('uses one authored factory for source/fresh target and two host groupings', () => {
    const options: SimulationEvidenceOptions = {
      createSource: () => createWorld(true),
      createFreshTarget: () => createWorld(false),
      hostGroupings: [
        [1 / 30, 1 / 30],
        [1 / 60, 1 / 60, 1 / 60, 1 / 60],
      ],
      inputForTick: (tick) => ({ authoredInput: tick }),
    };

    const result = runSimulationEvidence(options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.groupings).toHaveLength(2);
    for (const grouping of result.value.groupings) {
      expect(grouping.recordTick).toBe(0);
      expect(grouping.traceLength).toBe(4);
      expect(grouping.report.verdict).toBe('match');
      expect(grouping.report.entries.map((entry) => entry.domain)).toEqual(
        expect.arrayContaining(['world', 'collision', 'audio', 'cleanup', 'final-invariant']),
      );
      expect(grouping.cleanup.danglingEntityRefs).toBe(0);
      expect(grouping.cleanup.extraEvents).toBe(0);
    }
    const reports = result.value.groupings.map((grouping) => grouping.report);
    expect(reports[0]).toEqual(reports[1]);
  });

  it('keeps the evidence shape semantic and independent from render output', () => {
    const result = runSimulationEvidence({
      createSource: () => createWorld(true),
      createFreshTarget: () => createWorld(false),
      hostGroupings: [[1 / 60]],
      inputForTick: (tick) => tick,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const grouping = result.value.groupings[0];
    expect(grouping).toBeDefined();
    if (grouping === undefined) return;
    const report: SimulationEvidenceReport = grouping.report;
    expect(report).not.toHaveProperty('pixels');
    expect(report).not.toHaveProperty('canvas');
  });
});
