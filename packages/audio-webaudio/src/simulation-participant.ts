import {
  createSimulationError,
  type SimulationError,
  type SimulationParticipant,
  type SimulationParticipantStage,
  type SimulationRecordContext,
  type SimulationRestoreContext,
} from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { HostAudioConsumer, HostAudioSimulationState } from './host-audio-consumer';

export interface HostAudioSimulationParticipantOptions {
  readonly isReady?: () => boolean;
  readonly version?: string;
  readonly schemaFingerprint?: string;
}

/** Bridge host audio facts as POD; AudioContext, buffers, and nodes remain host-owned. */
export function createHostAudioSimulationParticipant(
  consumer: HostAudioConsumer,
  options: HostAudioSimulationParticipantOptions = {},
): SimulationParticipant {
  const id = 'forgeax.audio.host-webaudio';
  const version = options.version ?? '1';
  const schemaFingerprint = options.schemaFingerprint ?? 'audio-host-simulation-v1';
  const isReady = options.isReady ?? (() => true);
  return {
    id,
    version,
    schemaFingerprint,
    isReady,
    recordState: (context?: SimulationRecordContext) => {
      if (!isReady()) return err(createSimulationError('simulation-participant-not-ready', { id }));
      try {
        return ok(consumer.captureSimulationState(context?.mapEntity));
      } catch {
        return err(createSimulationError('simulation-state-unsupported', { path: 'entity' }));
      }
    },
    prepareRestore: (state: unknown, context?: SimulationRestoreContext) => {
      if (!isReady()) return err(createSimulationError('simulation-participant-not-ready', { id }));
      const prepared = consumer.prepareSimulationRestore(state, context);
      if (!prepared.ok) return prepared;
      return ok(prepared.value) satisfies Result<SimulationParticipantStage, SimulationError>;
    },
    commitRestore: (stage: SimulationParticipantStage, context?: SimulationRestoreContext) =>
      consumer.commitSimulationRestore(stage, context),
    disposeRestore: (stage: SimulationParticipantStage) => consumer.disposeSimulationRestore(stage),
  };
}

export type { HostAudioSimulationState };
