import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  type AudioIntent,
  AudioSource,
  audioTickSystem,
  createAudioIntentBackend,
  createAudioSimulationParticipant,
  recordAudioIntent,
} from '../index';

const OPTIONS = {
  loop: true,
  volume: 0.5,
  spatialBlend: 0,
  bus: 'music' as const,
};

function clip() {
  return { kind: 'audio' as const, sourceKey: 'simulation-tone', bytes: Uint8Array.of(1, 2, 3) };
}

describe('Audio ECS simulation participant', () => {
  it('restores lifecycle edges and avoids a duplicate first-tick play', () => {
    const sourceWorld = new World();
    const sourceHandle = sourceWorld.allocSharedRef('AudioClipAsset', clip());
    const sourceEntity = sourceWorld
      .spawn({
        component: AudioSource,
        data: { clip: sourceHandle, playing: false, ...OPTIONS },
      })
      .unwrap();
    const sourceIntents: AudioIntent[] = [];
    const sourceBackend = createAudioIntentBackend({
      emit: (intent) => sourceIntents.push(intent),
    });
    const sourceParticipant = createAudioSimulationParticipant(sourceBackend);

    audioTickSystem(sourceWorld, sourceBackend);
    sourceWorld.set(sourceEntity, AudioSource, { playing: true }).unwrap();
    audioTickSystem(sourceWorld, sourceBackend);
    const record = sourceParticipant.recordState?.();
    expect(record?.ok).toBe(true);
    if (!record?.ok) return;

    const targetBackend = createAudioIntentBackend({ emit: () => undefined });
    const targetParticipant = createAudioSimulationParticipant(targetBackend);
    const prepared = targetParticipant.prepareRestore(record.value);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    targetParticipant.commitRestore(prepared.value);

    const targetWorld = new World();
    const targetHandle = targetWorld.allocSharedRef('AudioClipAsset', clip());
    const targetEntity = targetWorld
      .spawn({
        component: AudioSource,
        data: { clip: targetHandle, playing: true, ...OPTIONS },
      })
      .unwrap();
    expect(targetEntity).toBe(sourceEntity);
    audioTickSystem(targetWorld, targetBackend);
    expect(targetParticipant.recordState?.().ok).toBe(true);

    targetWorld.set(targetEntity, AudioSource, { playing: false }).unwrap();
    audioTickSystem(targetWorld, targetBackend);
    targetWorld.despawn(targetEntity).unwrap();
    audioTickSystem(targetWorld, targetBackend);
  });

  it('records listener and bus values as semantic data', () => {
    const backend = createAudioIntentBackend({ emit: () => undefined });
    const participant = createAudioSimulationParticipant(backend);
    const state = participant.recordState?.();
    expect(state?.ok).toBe(true);
    if (!state?.ok) return;
    expect(state.value).not.toHaveProperty('audioContext');
    expect(state.value).not.toHaveProperty('audioBuffer');
    expect(state.value).not.toHaveProperty('source');
    expect(state.value).toHaveProperty('bus');
    expect(state.value).toHaveProperty('listener');
  });

  it('remaps semantic entity references across fresh targets', () => {
    const sourceBackend = createAudioIntentBackend({ emit: () => undefined });
    recordAudioIntent(sourceBackend, {
      kind: 'play',
      entityId: 7,
      sourceKey: 'mapped-tone',
      bytes: Uint8Array.of(7),
      options: OPTIONS,
    });
    const sourceParticipant = createAudioSimulationParticipant(sourceBackend);
    const record = sourceParticipant.recordState?.({
      mapEntity: (entity) => (entity === 7 ? 0 : undefined),
    });
    expect(record?.ok).toBe(true);
    if (!record?.ok) return;

    const targetBackend = createAudioIntentBackend({ emit: () => undefined });
    const targetParticipant = createAudioSimulationParticipant(targetBackend);
    const prepared = targetParticipant.prepareRestore(record.value, { entityCount: 1 });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    targetParticipant.commitRestore(prepared.value, {
      entityCount: 1,
      entityMap: new Map([[0, 99]]),
    });

    const restored = targetParticipant.recordState?.();
    expect(restored?.ok).toBe(true);
    if (!restored?.ok) return;
    expect(restored.value.intents[0]).toMatchObject({ entityId: 99 });
    expect(restored.value.epochs).toEqual([[99, 1]]);
  });
});
