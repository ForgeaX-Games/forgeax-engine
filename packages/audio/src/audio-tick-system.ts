import type { World } from '@forgeax/engine-ecs';
import type { AudioClipAsset } from '@forgeax/engine-types';
import type { AudioBackend, AudioListenerPose, AudioPlayOptions, BusName } from './audio-backend';
import type { AudioIntent } from './audio-intent';
import { AudioSource } from './components';

export function listenerPoseFromWorldMatrix(world: Float32Array) {
  const forwardLength = Math.hypot(world[8] ?? 0, world[9] ?? 0, world[10] ?? 0) || 1;
  const upLength = Math.hypot(world[4] ?? 0, world[5] ?? 0, world[6] ?? 0) || 1;
  return {
    positionX: world[12] ?? 0,
    positionY: world[13] ?? 0,
    positionZ: world[14] ?? 0,
    forwardX: -(world[8] ?? 0) / forwardLength,
    forwardY: -(world[9] ?? 0) / forwardLength,
    forwardZ: -(world[10] ?? 0) / forwardLength,
    upX: (world[4] ?? 0) / upLength,
    upY: (world[5] ?? 0) / upLength,
    upZ: (world[6] ?? 0) / upLength,
  };
}

export type EdgeAction = 'none' | 'play-start' | 'play-stop';

export function detectEdge(previous: boolean, current: boolean): EdgeAction {
  if (!previous && current) return 'play-start';
  if (previous && !current) return 'play-stop';
  return 'none';
}

export function detectRemovedEntities(
  previous: readonly number[],
  current: readonly number[],
): number[] {
  const currentSet = new Set(current);
  return previous.filter((entity) => !currentSet.has(entity));
}

interface TickState {
  playing: Map<number, boolean>;
  previousEntities: Set<number>;
  volumes: Map<number, number>;
  intents: AudioIntent[];
  epochs: Map<number, number>;
  cleanup: number[];
  bus: Record<BusName, { volume: number; muted: boolean }>;
  listener: AudioListenerPose | null;
}

export interface AudioSimulationState {
  readonly version: 1;
  readonly playing: readonly [number, boolean][];
  readonly previousEntities: readonly number[];
  readonly intents: readonly AudioIntent[];
  readonly epochs: readonly [number, number][];
  readonly bus: Readonly<Record<BusName, { readonly volume: number; readonly muted: boolean }>>;
  readonly listener: AudioListenerPose | null;
  readonly cleanup: readonly number[];
}

const states = new WeakMap<AudioBackend, TickState>();

function stateFor(backend: AudioBackend): TickState {
  const existing = states.get(backend);
  if (existing !== undefined) return existing;
  const created: TickState = {
    playing: new Map(),
    previousEntities: new Set(),
    volumes: new Map(),
    intents: [],
    epochs: new Map(),
    cleanup: [],
    bus: {
      sfx: { volume: 1, muted: false },
      music: { volume: 1, muted: false },
    },
    listener: null,
  };
  states.set(backend, created);
  return created;
}

function copyIntent(intent: AudioIntent): AudioIntent {
  return intent.kind === 'play' && intent.bytes !== undefined
    ? { ...intent, bytes: intent.bytes.slice() }
    : intent;
}

function appendIntent(state: TickState, intent: AudioIntent): void {
  state.intents.push(copyIntent(intent));
  if (intent.kind === 'play' || intent.kind === 'stop') {
    state.epochs.set(intent.entityId, (state.epochs.get(intent.entityId) ?? 0) + 1);
  }
}

function copyMappedEntity(
  entity: number,
  entityMapper: ((entity: number) => number | undefined) | undefined,
): number {
  if (entityMapper === undefined) return entity;
  const mapped = entityMapper(entity);
  if (mapped === undefined) throw new Error('simulation entity mapping is missing');
  return mapped;
}

function copyIntentWithMapper(
  intent: AudioIntent,
  entityMapper: ((entity: number) => number | undefined) | undefined,
): AudioIntent {
  const copied = copyIntent(intent);
  if (copied.kind === 'play' || copied.kind === 'stop' || copied.kind === 'set-volume') {
    return {
      ...copied,
      entityId: copyMappedEntity(copied.entityId, entityMapper),
    };
  }
  return copied;
}

export function captureAudioSimulationState(
  backend: AudioBackend,
  entityMapper?: (entity: number) => number | undefined,
): AudioSimulationState {
  const state = stateFor(backend);
  return {
    version: 1,
    playing: [...state.playing.entries()].map(([entity, playing]) => [
      copyMappedEntity(entity, entityMapper),
      playing,
    ]),
    previousEntities: [...state.previousEntities].map((entity) =>
      copyMappedEntity(entity, entityMapper),
    ),
    intents: state.intents.map((intent) => copyIntentWithMapper(intent, entityMapper)),
    epochs: [...state.epochs.entries()].map(([entity, epoch]) => [
      copyMappedEntity(entity, entityMapper),
      epoch,
    ]),
    bus: {
      sfx: { ...state.bus.sfx },
      music: { ...state.bus.music },
    },
    listener: state.listener === null ? null : { ...state.listener },
    cleanup: state.cleanup.map((entity) => copyMappedEntity(entity, entityMapper)),
  };
}

export function restoreAudioSimulationState(
  backend: AudioBackend,
  value: AudioSimulationState,
  entityMap?: ReadonlyMap<number, number>,
): void {
  const state = stateFor(backend);
  const mapEntity = (entity: number): number => {
    if (entityMap === undefined) return entity;
    const mapped = entityMap.get(entity);
    if (mapped === undefined) throw new Error('simulation entity mapping is missing');
    return mapped;
  };
  state.playing = new Map(value.playing.map(([entity, playing]) => [mapEntity(entity), playing]));
  state.previousEntities = new Set(value.previousEntities.map(mapEntity));
  state.intents = value.intents.map((intent) => copyIntentWithMapper(intent, mapEntity));
  state.epochs = new Map(value.epochs.map(([entity, epoch]) => [mapEntity(entity), epoch]));
  state.cleanup = value.cleanup.map(mapEntity);
  state.bus = {
    sfx: { ...value.bus.sfx },
    music: { ...value.bus.music },
  };
  state.listener = value.listener === null ? null : { ...value.listener };
  state.volumes = new Map(
    state.intents
      .filter((intent): intent is Extract<AudioIntent, { kind: 'play' }> => intent.kind === 'play')
      .map((intent) => [intent.entityId, intent.options.volume]),
  );
}

export function recordAudioListenerPose(backend: AudioBackend, pose: AudioListenerPose): void {
  stateFor(backend).listener = { ...pose };
}

export function recordAudioBusVolume(backend: AudioBackend, bus: BusName, volume: number): void {
  stateFor(backend).bus[bus].volume = volume;
  stateFor(backend).bus[bus].muted = false;
}

export function recordAudioBusMute(backend: AudioBackend, bus: BusName, muted: boolean): void {
  stateFor(backend).bus[bus].muted = muted;
}

export function recordAudioIntent(backend: AudioBackend, intent: AudioIntent): void {
  appendIntent(stateFor(backend), intent);
}

export function createClipResolver(
  world: World,
): (clipHandle: number) => AudioClipAsset | undefined {
  return (clipHandle) => {
    const resolved = world.sharedRefs.resolve<string, AudioClipAsset>(
      clipHandle as unknown as Parameters<typeof world.sharedRefs.resolve>[0],
    );
    return resolved.ok && resolved.value.kind === 'audio' ? resolved.value : undefined;
  };
}

export function audioTickSystem(world: World, backend: AudioBackend): void {
  const state = stateFor(backend);
  const resolveClip = createClipResolver(world);
  const currentEntities: number[] = [];
  const query = world.query({ read: [AudioSource] });
  if (!query.ok) return;
  for (const queryRow of query.value) {
    const entity = queryRow.entity as number;
    const source = queryRow.get(AudioSource);
    const playing = source.playing === true;
    const previous = state.playing.get(entity) ?? false;
    const edge = detectEdge(previous, playing);
    if (edge === 'play-start') {
      const clip = resolveClip(source.clip as number);
      if (clip === undefined) {
        state.playing.set(entity, false);
      } else {
        const options: AudioPlayOptions = {
          loop: source.loop === true,
          volume: typeof source.volume === 'number' ? source.volume : 1,
          spatialBlend: typeof source.spatialBlend === 'number' ? source.spatialBlend : 0,
          bus: (typeof source.bus === 'string' ? source.bus : 'sfx') as BusName,
        };
        const intent: AudioIntent = {
          kind: 'play',
          entityId: entity,
          sourceKey: clip.sourceKey,
          bytes: clip.bytes,
          options,
        };
        backend.play(entity, clip, options);
        appendIntent(state, intent);
        state.playing.set(entity, true);
        state.volumes.set(entity, options.volume);
      }
    } else {
      state.playing.set(entity, playing);
      if (edge === 'play-stop') {
        backend.stop(entity);
        appendIntent(state, { kind: 'stop', entityId: entity });
      } else if (
        playing &&
        typeof source.volume === 'number' &&
        state.volumes.get(entity) !== source.volume
      ) {
        backend.setVolume(entity, source.volume);
        state.volumes.set(entity, source.volume);
      }
    }
    currentEntities.push(entity);
  }
  for (const entity of detectRemovedEntities([...state.previousEntities], currentEntities)) {
    if (state.playing.get(entity) === true) {
      backend.stop(entity);
      appendIntent(state, { kind: 'stop', entityId: entity });
      state.cleanup.push(entity);
    }
    state.playing.delete(entity);
    state.volumes.delete(entity);
  }
  state.previousEntities.clear();
  for (const entity of currentEntities) state.previousEntities.add(entity);
}
