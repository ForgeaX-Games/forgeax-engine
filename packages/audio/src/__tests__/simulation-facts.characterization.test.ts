import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  type AudioIntent,
  AudioSource,
  audioTickSystem,
  createAudioIntentBackend,
  listenerPoseFromWorldMatrix,
} from '../index';

const PLAY_OPTIONS = {
  loop: true,
  volume: 0.75,
  spatialBlend: 0.25,
  bus: 'music' as const,
};

function makeClip(sourceKey = 'simulation-tone') {
  return { kind: 'audio' as const, sourceKey, bytes: new Uint8Array([1, 2, 3]) };
}

describe('M1 Audio ECS simulation facts characterization', () => {
  it('records play and stop edges, bus fields, and entity cleanup in order', () => {
    const world = new World();
    const clipHandle = world.allocSharedRef('AudioClipAsset', makeClip());
    const entity = world
      .spawn({
        component: AudioSource,
        data: { clip: clipHandle, playing: false, ...PLAY_OPTIONS },
      })
      .unwrap();
    const intents: AudioIntent[] = [];
    const backend = createAudioIntentBackend({ emit: (intent) => intents.push(intent) });

    audioTickSystem(world, backend);
    expect(intents).toEqual([]);

    world.set(entity, AudioSource, { playing: true }).unwrap();
    audioTickSystem(world, backend);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({
      kind: 'play',
      entityId: entity,
      sourceKey: 'simulation-tone',
      bytes: new Uint8Array([1, 2, 3]),
      options: PLAY_OPTIONS,
    });
    expect(intents[0]).not.toHaveProperty('audioContext');
    expect(intents[0]).not.toHaveProperty('audioBuffer');

    world.set(entity, AudioSource, { playing: false }).unwrap();
    audioTickSystem(world, backend);
    expect(intents.at(-1)).toEqual({ kind: 'stop', entityId: entity });

    world.set(entity, AudioSource, { playing: true }).unwrap();
    audioTickSystem(world, backend);
    world.despawn(entity).unwrap();
    audioTickSystem(world, backend);
    expect(intents.at(-2)).toMatchObject({ kind: 'play', entityId: entity });
    expect(intents.at(-1)).toEqual({ kind: 'stop', entityId: entity });
  });

  it('publishes source bytes once while later entity plays reuse sourceKey', () => {
    const intents: AudioIntent[] = [];
    const backend = createAudioIntentBackend({ emit: (intent) => intents.push(intent) });
    const clip = makeClip();

    backend.play(1, clip, PLAY_OPTIONS);
    backend.play(2, clip, PLAY_OPTIONS);

    expect(intents[0]).toHaveProperty('bytes', clip.bytes);
    expect(intents[1]).not.toHaveProperty('bytes');
    expect(intents[1]).toMatchObject({ kind: 'play', sourceKey: clip.sourceKey });
  });

  it('keeps listener pose as nine numeric POD scalars', () => {
    const pose = listenerPoseFromWorldMatrix(
      new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]),
    );

    expect(pose).toEqual({
      positionX: 5,
      positionY: 6,
      positionZ: 7,
      forwardX: -0,
      forwardY: -0,
      forwardZ: -1,
      upX: 0,
      upY: 1,
      upZ: 0,
    });
    expect(Object.keys(pose)).toHaveLength(9);
  });
});
