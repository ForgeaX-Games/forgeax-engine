import {
  createSimulationError,
  type SimulationError,
  type SimulationParticipantStage,
  type SimulationRecordContext,
  type SimulationRestoreContext,
} from '@forgeax/engine-ecs';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { AudioBackend } from './audio-backend';
import {
  type AudioSimulationState,
  captureAudioSimulationState,
  restoreAudioSimulationState,
} from './audio-tick-system';

export interface AudioSimulationParticipantOptions {
  readonly isReady?: () => boolean;
  readonly version?: string;
  readonly schemaFingerprint?: string;
}

function unsupported(path: string): Result<never, SimulationError> {
  return err(createSimulationError('simulation-state-unsupported', { path }));
}

function isAudioSimulationState(value: unknown): value is AudioSimulationState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<AudioSimulationState>;
  return (
    state.version === 1 &&
    Array.isArray(state.playing) &&
    Array.isArray(state.previousEntities) &&
    Array.isArray(state.intents) &&
    Array.isArray(state.epochs) &&
    typeof state.bus === 'object' &&
    state.bus !== null &&
    ('sfx' in state.bus || 'music' in state.bus) &&
    Array.isArray(state.cleanup)
  );
}

function validateEntityReferences(
  state: AudioSimulationState,
  context: SimulationRestoreContext | undefined,
): boolean {
  if (context === undefined) return true;
  const valid = (entity: unknown) =>
    typeof entity === 'number' &&
    Number.isInteger(entity) &&
    entity >= 0 &&
    entity < context.entityCount;
  return (
    state.playing.every(([entity]) => valid(entity)) &&
    state.previousEntities.every(valid) &&
    state.epochs.every(([entity]) => valid(entity)) &&
    state.cleanup.every(valid) &&
    state.intents.every((intent) =>
      intent.kind === 'play' || intent.kind === 'stop' || intent.kind === 'set-volume'
        ? valid(intent.entityId)
        : true,
    )
  );
}

/** Adapt ECS audio intent state without exposing a Web Audio object or source node. */
export function createAudioSimulationParticipant(
  backend: AudioBackend,
  options: AudioSimulationParticipantOptions = {},
) {
  const id = 'forgeax.audio.ecs';
  const version = options.version ?? '1';
  const schemaFingerprint = options.schemaFingerprint ?? 'audio-ecs-simulation-v1';
  const isReady = options.isReady ?? (() => true);
  return {
    id,
    version,
    schemaFingerprint,
    isReady,
    recordState: (context?: SimulationRecordContext) => {
      if (!isReady()) return err(createSimulationError('simulation-participant-not-ready', { id }));
      try {
        return ok(captureAudioSimulationState(backend, context?.mapEntity));
      } catch {
        return unsupported('entity');
      }
    },
    prepareRestore: (value: unknown, context?: SimulationRestoreContext) => {
      if (!isReady()) return err(createSimulationError('simulation-participant-not-ready', { id }));
      if (!isAudioSimulationState(value)) return unsupported('state');
      if (!validateEntityReferences(value, context)) return unsupported('entity');
      return ok({ state: value } satisfies SimulationParticipantStage);
    },
    commitRestore: (stage: SimulationParticipantStage, context?: SimulationRestoreContext) => {
      restoreAudioSimulationState(backend, stage.state as AudioSimulationState, context?.entityMap);
    },
    disposeRestore: (_stage: SimulationParticipantStage) => undefined,
  };
}
