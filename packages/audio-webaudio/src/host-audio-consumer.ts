import {
  type AudioBackend,
  type AudioIntent,
  type AudioListenerPose,
  type AudioPlayOptions,
  type AudioState,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import {
  createSimulationError,
  type SimulationError,
  type SimulationParticipantStage,
  type SimulationRestoreContext,
} from '@forgeax/engine-ecs';
import { AudioError, ok, type Result } from '@forgeax/engine-types';
import { createHostAudioSimulationParticipant } from './simulation-participant';
import { WebAudioEngine } from './web-audio-engine';

export interface HostAudioSimulationSource {
  readonly entityId: number;
  readonly sourceKey: string;
  readonly bytes?: Uint8Array;
  readonly options: AudioPlayOptions;
}

export interface HostAudioSimulationState {
  readonly version: 1;
  readonly entityEpoch: readonly [number, number][];
  readonly activeSources: readonly HostAudioSimulationSource[];
  readonly bus: Readonly<
    Record<'sfx' | 'music', { readonly volume: number; readonly muted: boolean }>
  >;
  readonly listener: AudioListenerPose | null;
  readonly cleanup: readonly number[];
}

export interface HostAudioConsumer {
  consume(intent: AudioIntent): void;
  state(): AudioState;
  dispose(): void;
  captureSimulationState(
    entityMapper?: (entity: number) => number | undefined,
  ): HostAudioSimulationState;
  prepareSimulationRestore(
    state: unknown,
    context?: SimulationRestoreContext,
  ): Result<SimulationParticipantStage, SimulationError>;
  commitSimulationRestore(
    stage: SimulationParticipantStage,
    context?: SimulationRestoreContext,
  ): void;
  disposeSimulationRestore(stage: SimulationParticipantStage): void;
  readonly engine: WebAudioEngine;
}

function decodeError(sourceKey: string, cause: unknown): AudioError {
  return new AudioError({
    code: 'decode-failed',
    expected: `browser-decodable audio bytes for sourceKey ${sourceKey}`,
    hint: 'verify the audio media type and source bytes; simulation may continue without this source',
    detail: {
      code: 'decode-failed',
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
}

function isHostAudioSimulationState(value: unknown): value is HostAudioSimulationState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<HostAudioSimulationState>;
  return (
    state.version === 1 &&
    Array.isArray(state.entityEpoch) &&
    Array.isArray(state.activeSources) &&
    typeof state.bus === 'object' &&
    state.bus !== null &&
    Array.isArray(state.cleanup)
  );
}

export function createHostAudioConsumer(engine = new WebAudioEngine()): HostAudioConsumer {
  const sources = new Map<string, Promise<AudioBuffer>>();
  const sourceBytes = new Map<string, Uint8Array>();
  const activeSources = new Map<number, HostAudioSimulationSource>();
  const entityEpoch = new Map<number, number>();
  const bus = {
    sfx: { volume: 1, muted: false },
    music: { volume: 1, muted: false },
  };
  let listener: AudioListenerPose | null = null;
  const cleanup: number[] = [];
  let lastError: AudioError | null = null;
  let disposed = false;
  const nextEpoch = (entityId: number): number => {
    const epoch = (entityEpoch.get(entityId) ?? 0) + 1;
    entityEpoch.set(entityId, epoch);
    return epoch;
  };
  const consumer: HostAudioConsumer = {
    engine,
    consume(intent): void {
      if (disposed && intent.kind !== 'destroy') return;
      if (intent.kind === 'play') {
        const epoch = nextEpoch(intent.entityId);
        if (intent.bytes !== undefined) sourceBytes.set(intent.sourceKey, intent.bytes.slice());
        const bytes = sourceBytes.get(intent.sourceKey);
        activeSources.set(intent.entityId, {
          entityId: intent.entityId,
          sourceKey: intent.sourceKey,
          ...(bytes === undefined ? {} : { bytes: bytes.slice() }),
          options: intent.options,
        });
        let decoded = sources.get(intent.sourceKey);
        if (decoded === undefined && intent.bytes !== undefined) {
          decoded = engine.decode(intent.bytes);
          sources.set(intent.sourceKey, decoded);
        }
        if (decoded === undefined) {
          lastError = decodeError(intent.sourceKey, new Error('sourceKey was not published'));
          return;
        }
        void decoded
          .then((buffer) => {
            if (!disposed && entityEpoch.get(intent.entityId) === epoch) {
              engine.play(intent.entityId, buffer, intent.options);
            }
          })
          .catch((cause) => {
            sources.delete(intent.sourceKey);
            lastError = decodeError(intent.sourceKey, cause);
          });
      } else if (intent.kind === 'stop') {
        nextEpoch(intent.entityId);
        if (activeSources.delete(intent.entityId)) {
          cleanup.push(intent.entityId);
          engine.stop(intent.entityId);
        }
      } else if (intent.kind === 'set-volume') {
        engine.setVolume(intent.entityId, intent.volume);
      } else if (intent.kind === 'set-bus-volume') {
        bus[intent.bus].volume = intent.volume;
        bus[intent.bus].muted = false;
        engine.setBusVolume(intent.bus, intent.volume);
      } else if (intent.kind === 'set-bus-mute') {
        bus[intent.bus].muted = intent.muted;
        engine.setBusMute(intent.bus, intent.muted);
      } else if (intent.kind === 'set-listener-pose') {
        listener = { ...intent.pose };
        engine.setListenerPose(intent.pose);
      } else {
        consumer.dispose();
      }
    },
    state(): AudioState {
      return { ...engine.getState(), lastError };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      activeSources.clear();
      entityEpoch.clear();
      sources.clear();
      sourceBytes.clear();
      cleanup.length = 0;
      listener = null;
      engine.destroy();
    },
    captureSimulationState(
      entityMapper?: (entity: number) => number | undefined,
    ): HostAudioSimulationState {
      const mapEntity = (entity: number): number => {
        if (entityMapper === undefined) return entity;
        const mapped = entityMapper(entity);
        if (mapped === undefined) throw new Error('simulation entity mapping is missing');
        return mapped;
      };
      return {
        version: 1,
        entityEpoch: [...entityEpoch.entries()].map(([entityId, epoch]) => [
          mapEntity(entityId),
          epoch,
        ]),
        activeSources: [...activeSources.values()].map((source) => ({
          ...source,
          entityId: mapEntity(source.entityId),
          ...(source.bytes === undefined ? {} : { bytes: source.bytes.slice() }),
        })),
        bus: {
          sfx: { ...bus.sfx },
          music: { ...bus.music },
        },
        listener: listener === null ? null : { ...listener },
        cleanup: cleanup.map(mapEntity),
      };
    },
    prepareSimulationRestore(state: unknown, context?: SimulationRestoreContext) {
      if (!isHostAudioSimulationState(state)) {
        return {
          ok: false,
          error: createSimulationError('simulation-state-unsupported', { path: 'state' }),
        } as Result<never, SimulationError>;
      }
      for (const source of state.activeSources) {
        if (source.bytes === undefined) {
          return {
            ok: false,
            error: createSimulationError('simulation-state-unsupported', {
              path: `activeSources.${source.entityId}.bytes`,
            }),
          } as Result<never, SimulationError>;
        }
      }
      if (context !== undefined) {
        const valid = (entity: unknown) =>
          typeof entity === 'number' &&
          Number.isInteger(entity) &&
          entity >= 0 &&
          entity < context.entityCount;
        if (
          !state.entityEpoch.every(([entity]) => valid(entity)) ||
          !state.activeSources.every((source) => valid(source.entityId)) ||
          !state.cleanup.every(valid)
        ) {
          return {
            ok: false,
            error: createSimulationError('simulation-state-unsupported', { path: 'entity' }),
          } as Result<never, SimulationError>;
        }
      }
      return ok({ state } satisfies SimulationParticipantStage);
    },
    commitSimulationRestore(
      stage: SimulationParticipantStage,
      context?: SimulationRestoreContext,
    ): void {
      const state = stage.state as HostAudioSimulationState;
      const mapEntity = (entity: number): number => {
        if (context?.entityMap === undefined) return entity;
        const mapped = context.entityMap.get(entity);
        if (mapped === undefined) throw new Error('simulation entity mapping is missing');
        return mapped;
      };
      const mappedState: HostAudioSimulationState = {
        ...state,
        entityEpoch: state.entityEpoch.map(([entityId, epoch]) => [mapEntity(entityId), epoch]),
        activeSources: state.activeSources.map((source) => ({
          ...source,
          entityId: mapEntity(source.entityId),
          ...(source.bytes === undefined ? {} : { bytes: source.bytes.slice() }),
        })),
        cleanup: state.cleanup.map(mapEntity),
      };
      activeSources.clear();
      entityEpoch.clear();
      cleanup.length = 0;
      sources.clear();
      sourceBytes.clear();
      for (const [entityId, epoch] of mappedState.entityEpoch)
        entityEpoch.set(entityId, Math.max(0, epoch - 1));
      for (const [busName, values] of Object.entries(mappedState.bus) as Array<
        ['sfx' | 'music', { readonly volume: number; readonly muted: boolean }]
      >) {
        consumer.consume({ kind: 'set-bus-volume', bus: busName, volume: values.volume });
        consumer.consume({ kind: 'set-bus-mute', bus: busName, muted: values.muted });
      }
      if (mappedState.listener !== null)
        consumer.consume({ kind: 'set-listener-pose', pose: mappedState.listener });
      for (const source of mappedState.activeSources) {
        const playIntent: AudioIntent = {
          kind: 'play',
          entityId: source.entityId,
          sourceKey: source.sourceKey,
          options: source.options,
          ...(source.bytes === undefined ? {} : { bytes: source.bytes }),
        };
        consumer.consume(playIntent);
      }
      entityEpoch.clear();
      for (const [entityId, epoch] of mappedState.entityEpoch) entityEpoch.set(entityId, epoch);
      activeSources.clear();
      for (const source of mappedState.activeSources) activeSources.set(source.entityId, source);
      cleanup.push(...mappedState.cleanup);
    },
    disposeSimulationRestore(_stage: SimulationParticipantStage): void {},
  };
  return consumer;
}

export function createWebAudioBackend(): AudioBackend {
  const consumer = createHostAudioConsumer();
  const backend = createAudioIntentBackend({
    emit: (intent) => consumer.consume(intent),
    state: () => consumer.state(),
  });
  return {
    ...backend,
    simulationParticipant: createHostAudioSimulationParticipant(consumer),
  };
}
