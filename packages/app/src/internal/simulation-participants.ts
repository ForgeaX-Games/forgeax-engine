import {
  createSimulationError,
  FixedTime,
  SIMULATION_COMPARISON_DOMAINS,
  type SimulationError,
  type SimulationParticipant,
  type World,
} from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';

import {
  SIMULATION_INSPECTION_ERROR_FIELDS,
  SIMULATION_INSPECTION_MANIFEST_VERSION,
  SIMULATION_INSPECTION_RECORD_OWNER,
  SIMULATION_INSPECTION_SCHEMA_OWNER,
  type SimulationInspectionManifest,
  type SimulationInspectionManifestParticipant,
} from '../simulation-manifest';

export type SimulationParticipantInspection = SimulationInspectionManifestParticipant;
export type SimulationInspectionSummary = SimulationInspectionManifest;

export interface SimulationParticipantAssembly {
  readonly participants: readonly SimulationParticipant[];
  readonly dispose: () => void;
}

export function registerSimulationParticipants(
  world: World,
  participants: readonly SimulationParticipant[],
): Result<SimulationParticipantAssembly, SimulationError> {
  const registeredIds = new Set(world.simulationParticipants().map((entry) => entry.id));
  const incomingIds = new Set<string>();
  for (const participant of participants) {
    if (incomingIds.has(participant.id) || registeredIds.has(participant.id)) {
      return err(createSimulationError('simulation-participant-duplicate', { id: participant.id }));
    }
    incomingIds.add(participant.id);
    let ready = false;
    try {
      ready = participant.isReady();
    } catch {
      ready = false;
    }
    if (!ready) {
      return err(createSimulationError('simulation-participant-not-ready', { id: participant.id }));
    }
  }
  for (const participant of participants) {
    const registered = world.registerSimulationParticipant(participant);
    if (!registered.ok) return registered;
  }
  return ok({
    participants: world.simulationParticipants(),
    dispose: () => undefined,
  });
}

export function createSimulationInspection(
  world: World,
  assembly: SimulationParticipantAssembly,
): () => SimulationInspectionSummary {
  return () => {
    const fixed = world.getResource(FixedTime);
    const record = world.simulationRecord();
    let readinessError: SimulationError | undefined;
    const participants = assembly.participants.map((participant) => {
      let ready = false;
      try {
        ready = participant.isReady();
      } catch {
        ready = false;
      }
      if (!ready && readinessError === undefined) {
        readinessError = createSimulationError('simulation-participant-not-ready', {
          id: participant.id,
        });
      }
      return {
        id: participant.id,
        version: participant.version,
        schemaFingerprint: participant.schemaFingerprint,
        ready,
      };
    });
    const error = readinessError ?? (record.ok ? undefined : record.error);
    return {
      formatVersion: SIMULATION_INSPECTION_MANIFEST_VERSION,
      recordOwner: SIMULATION_INSPECTION_RECORD_OWNER,
      schemaOwner: SIMULATION_INSPECTION_SCHEMA_OWNER,
      baselineFingerprint: world.simulationFingerprint(),
      participants,
      errors: {
        codes: error === undefined ? [] : [error.code],
        fields: SIMULATION_INSPECTION_ERROR_FIELDS,
      },
      trace: {
        recordTick: record.ok ? record.value.recordTick : fixed.tick,
        sampleCount: record.ok ? record.value.trace.length : 0,
      },
      report: {
        verdict: error === undefined ? 'match' : 'mismatch',
        domains: SIMULATION_COMPARISON_DOMAINS,
        tolerance: {
          required: true,
          fields: {
            world: 0,
            collision: 0,
            audio: 0,
            cleanup: 0,
            'final-invariant': 0,
          },
        },
        entries: [],
      },
      ...(error === undefined
        ? {}
        : {
            error: {
              code: error.code,
              expected: error.expected,
              hint: error.hint,
              detail: error.detail,
            },
          }),
    };
  };
}
