import { err, ok, type Result } from '@forgeax/engine-types';
import { createSimulationError } from '../errors/simulation-errors';
import { simulationCompare } from './compare';
import { replaySimulationTrace, validateSimulationTrace } from './trace';
import type {
  SimulationComparisonInput,
  SimulationComparisonReport,
  SimulationError,
  SimulationParticipant,
  SimulationParticipantRecord,
  SimulationParticipantStage,
  SimulationRecordV1,
  SimulationRestoreContext,
} from './types';

function participantRecordsById(
  records: readonly SimulationParticipantRecord[],
): Result<Map<string, SimulationParticipantRecord>, SimulationError> {
  const byId = new Map<string, SimulationParticipantRecord>();
  for (const record of records) {
    if (byId.has(record.id)) {
      return err(createSimulationError('simulation-participant-duplicate', { id: record.id }));
    }
    byId.set(record.id, record);
  }
  return ok(byId);
}

/** Registry for versioned participant owners; it never transports raw native state. */
export class SimulationParticipantRegistry {
  private readonly participants = new Map<string, SimulationParticipant>();

  register(participant: SimulationParticipant): Result<void, SimulationError> {
    if (this.participants.has(participant.id)) {
      return err(createSimulationError('simulation-participant-duplicate', { id: participant.id }));
    }
    this.participants.set(participant.id, participant);
    return ok(undefined);
  }

  entries(): readonly SimulationParticipant[] {
    return [...this.participants.values()];
  }

  preflight(record: SimulationRecordV1): Result<void, SimulationError> {
    const traceValidation = validateSimulationTrace({
      recordTick: record.recordTick,
      samples: record.trace,
    });
    if (!traceValidation.ok) {
      return err(
        createSimulationError('simulation-trace-invalid', {
          ...traceValidation.error.detail,
          path: traceValidation.error.detail.path.replace(/^samples/, 'trace'),
        }),
      );
    }

    const records = participantRecordsById(record.participants);
    if (!records.ok) return records;

    for (const participant of this.participants.values()) {
      const participantRecord = records.value.get(participant.id);
      if (participantRecord === undefined) {
        return err(
          createSimulationError('simulation-participant-missing', {
            id: participant.id,
            expectedVersion: participant.version,
            expectedSchemaFingerprint: participant.schemaFingerprint,
          }),
        );
      }
      if (participantRecord.version !== participant.version) {
        return err(
          createSimulationError('simulation-participant-version-mismatch', {
            id: participant.id,
            expectedVersion: participant.version,
            actualVersion: participantRecord.version,
          }),
        );
      }
      if (participantRecord.schemaFingerprint !== participant.schemaFingerprint) {
        return err(
          createSimulationError('simulation-participant-schema-mismatch', {
            id: participant.id,
            expectedSchemaFingerprint: participant.schemaFingerprint,
            actualSchemaFingerprint: participantRecord.schemaFingerprint,
          }),
        );
      }
      if (!participant.isReady()) {
        return err(
          createSimulationError('simulation-participant-not-ready', { id: participant.id }),
        );
      }
    }

    for (const participantRecord of record.participants) {
      if (!this.participants.has(participantRecord.id)) {
        return err(
          createSimulationError('simulation-participant-missing', {
            id: participantRecord.id,
            expectedVersion: participantRecord.version,
            expectedSchemaFingerprint: participantRecord.schemaFingerprint,
          }),
        );
      }
    }
    return ok(undefined);
  }

  prepare(
    record: SimulationRecordV1,
  ): Result<readonly SimulationParticipantStage[], SimulationError> {
    const validation = this.preflight(record);
    if (!validation.ok) return validation;

    const records = new Map(record.participants.map((entry) => [entry.id, entry]));
    const stages: SimulationParticipantStage[] = [];
    const context: SimulationRestoreContext = { entityCount: record.world.entities.length };
    for (const participant of this.participants.values()) {
      const participantRecord = records.get(participant.id);
      if (participantRecord === undefined) continue;
      const prepared = participant.prepareRestore(participantRecord.state, context);
      if (!prepared.ok) {
        for (let index = stages.length - 1; index >= 0; index -= 1) {
          const previous = stages[index];
          const owner = [...this.participants.values()][index];
          if (previous !== undefined && owner !== undefined) owner.disposeRestore(previous);
        }
        return err(
          createSimulationError('simulation-participant-prepare-failed', {
            id: participant.id,
            path:
              prepared.error.detail && 'path' in prepared.error.detail
                ? prepared.error.detail.path
                : 'state',
          }),
        );
      }
      stages.push(prepared.value);
    }
    return ok(stages);
  }

  commit(stages: readonly SimulationParticipantStage[], context?: SimulationRestoreContext): void {
    let index = 0;
    for (const participant of this.participants.values()) {
      const stage = stages[index];
      if (stage !== undefined) participant.commitRestore(stage, context);
      index += 1;
    }
  }

  dispose(stages: readonly SimulationParticipantStage[]): void {
    let index = 0;
    for (const participant of this.participants.values()) {
      const stage = stages[index];
      if (stage !== undefined) participant.disposeRestore(stage);
      index += 1;
    }
  }

  replay(
    record: SimulationRecordV1,
    consume: (sample: SimulationRecordV1['trace'][number]) => void,
  ): Result<void, SimulationError> {
    return replaySimulationTrace({ recordTick: record.recordTick, samples: record.trace }, consume);
  }

  compare(input: SimulationComparisonInput): Result<SimulationComparisonReport, SimulationError> {
    return simulationCompare(input);
  }
}

export { simulationCompare } from './compare';
export type {
  SimulationError,
  SimulationParticipant,
  SimulationParticipantRecord,
  SimulationParticipantStage,
} from './types';
export { createSimulationError };
