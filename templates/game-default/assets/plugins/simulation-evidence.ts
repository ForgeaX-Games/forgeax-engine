import {
  simulationCompare,
  type SimulationRecordV1,
} from '@forgeax/engine-ecs';

export interface SimulationEvidenceObservations {
  readonly source: SimulationRecordV1;
  readonly target: SimulationRecordV1;
  readonly collision: { readonly sourceCount: number; readonly targetCount: number };
  readonly audio: { readonly sourceCount: number; readonly targetCount: number };
  readonly cleanup: { readonly danglingEntityRefs: number; readonly extraEvents: number };
}

/** Compare facts observed from the production source/target owners. */
export function compareSimulationEvidence(
  observations: SimulationEvidenceObservations,
): ReturnType<typeof simulationCompare> {
  const { source, target } = observations;
  return simulationCompare({
    facts: [
      {
        domain: 'world',
        path: 'fixed.tick',
        expected: source.clock.fixed.tick,
        actual: target.clock.fixed.tick,
        tolerance: 0,
      },
      {
        domain: 'world',
        path: 'entity.count',
        expected: source.world.entities.length,
        actual: target.world.entities.length,
        tolerance: 0,
      },
      {
        domain: 'collision',
        path: 'contact.count',
        expected: observations.collision.sourceCount,
        actual: observations.collision.targetCount,
        tolerance: 0,
      },
      {
        domain: 'audio',
        path: 'semantic-event.count',
        expected: observations.audio.sourceCount,
        actual: observations.audio.targetCount,
        tolerance: 0,
      },
      {
        domain: 'cleanup',
        path: 'danglingEntityRefs',
        expected: observations.cleanup.danglingEntityRefs,
        actual: observations.cleanup.danglingEntityRefs,
        tolerance: 0,
      },
      {
        domain: 'cleanup',
        path: 'extraEvents',
        expected: observations.cleanup.extraEvents,
        actual: observations.cleanup.extraEvents,
        tolerance: 0,
      },
      {
        domain: 'final-invariant',
        path: 'live-entity-count',
        expected: source.world.entities.length,
        actual: target.world.entities.length,
        tolerance: 0,
      },
    ],
  });
}
