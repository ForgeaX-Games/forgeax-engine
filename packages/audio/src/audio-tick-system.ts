import type { World } from '@forgeax/engine-ecs';
import type { AudioClipAsset } from '@forgeax/engine-types';
import type { AudioBackend, AudioPlayOptions, BusName } from './audio-backend';
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
  readonly playing: Map<number, boolean>;
  readonly previousEntities: Set<number>;
}

const states = new WeakMap<AudioBackend, TickState>();

function stateFor(backend: AudioBackend): TickState {
  const existing = states.get(backend);
  if (existing !== undefined) return existing;
  const created = { playing: new Map<number, boolean>(), previousEntities: new Set<number>() };
  states.set(backend, created);
  return created;
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
        backend.play(entity, clip, options);
        state.playing.set(entity, true);
      }
    } else {
      state.playing.set(entity, playing);
      if (edge === 'play-stop') backend.stop(entity);
      else if (playing && typeof source.volume === 'number') {
        backend.setVolume(entity, source.volume);
      }
    }
    currentEntities.push(entity);
  }
  for (const entity of detectRemovedEntities([...state.previousEntities], currentEntities)) {
    backend.stop(entity);
    state.playing.delete(entity);
  }
  state.previousEntities.clear();
  for (const entity of currentEntities) state.previousEntities.add(entity);
}
