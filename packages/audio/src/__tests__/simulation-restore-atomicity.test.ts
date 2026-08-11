import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  AudioSource,
  audioTickSystem,
  createAudioIntentBackend,
  createAudioSimulationParticipant,
} from '../index';

function makeClip() {
  return { kind: 'audio' as const, sourceKey: 'atomic-tone', bytes: Uint8Array.of(4, 5, 6) };
}

describe('Audio ECS simulation restore atomicity', () => {
  it('disposes invalid staging without changing the target and allows a fresh retry', () => {
    const sourceWorld = new World();
    const sourceHandle = sourceWorld.allocSharedRef('AudioClipAsset', makeClip());
    const sourceEntity = sourceWorld
      .spawn({ component: AudioSource, data: { clip: sourceHandle, playing: true } })
      .unwrap();
    const sourceBackend = createAudioIntentBackend({ emit: () => undefined });
    audioTickSystem(sourceWorld, sourceBackend);
    const sourceParticipant = createAudioSimulationParticipant(sourceBackend);
    const record = sourceParticipant.recordState?.();
    expect(record?.ok).toBe(true);
    if (!record?.ok) return;

    const targetBackend = createAudioIntentBackend({ emit: () => undefined });
    const targetParticipant = createAudioSimulationParticipant(targetBackend);
    const targetWorld = new World();
    const targetHandle = targetWorld.allocSharedRef('AudioClipAsset', makeClip());
    targetWorld
      .spawn({ component: AudioSource, data: { clip: targetHandle, playing: false } })
      .unwrap();
    const before = targetParticipant.recordState?.();

    const invalid = targetParticipant.prepareRestore({ ...record.value, playing: 'invalid' });
    expect(invalid.ok).toBe(false);
    expect(targetParticipant.recordState?.()).toEqual(before);

    const retryBackend = createAudioIntentBackend({ emit: () => undefined });
    const retryParticipant = createAudioSimulationParticipant(retryBackend);
    const prepared = retryParticipant.prepareRestore(record.value);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    retryParticipant.commitRestore(prepared.value);
    expect(retryParticipant.recordState?.().ok).toBe(true);
    expect(sourceEntity).toBe(0);
  });
});
