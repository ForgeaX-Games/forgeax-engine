import type { AudioIntent, AudioListenerPose, AudioPlayOptions } from '@forgeax/engine-audio';
import { describe, expect, it } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { createHostAudioSimulationParticipant } from '../simulation-participant';
import { WebAudioEngine } from '../web-audio-engine';

const OPTIONS: AudioPlayOptions = {
  loop: true,
  volume: 0.5,
  spatialBlend: 0,
  bus: 'music',
};

class DeferredEngine extends WebAudioEngine {
  readonly pending: Array<(buffer: AudioBuffer) => void> = [];
  readonly plays: number[] = [];
  readonly stops: number[] = [];

  override decode(_bytes: Uint8Array): Promise<AudioBuffer> {
    return new Promise((resolve) => this.pending.push(resolve));
  }

  override play(entityId: number): void {
    this.plays.push(entityId);
  }

  override stop(entityId: number): void {
    this.stops.push(entityId);
  }

  override setBusVolume(): void {}

  override setBusMute(): void {}

  override setListenerPose(): void {}

  resolveNext(): void {
    this.pending.shift()?.({} as AudioBuffer);
  }
}

function playIntent(entityId: number): AudioIntent {
  return {
    kind: 'play',
    entityId,
    sourceKey: 'host-tone',
    bytes: Uint8Array.of(1, 2, 3),
    options: OPTIONS,
  };
}

describe('Host audio simulation participant', () => {
  it('records semantic epochs and cold-rebuilds active sources without native fields', async () => {
    const sourceEngine = new DeferredEngine();
    const sourceConsumer = createHostAudioConsumer(sourceEngine);
    sourceConsumer.consume(playIntent(7));
    const sourceParticipant = createHostAudioSimulationParticipant(sourceConsumer);
    const record = sourceParticipant.recordState?.({
      mapEntity: (entity) => (entity === 7 ? 0 : undefined),
    });
    expect(record?.ok).toBe(true);
    if (!record?.ok) return;
    expect(record.value).toHaveProperty('entityEpoch');
    expect(record.value).toHaveProperty('activeSources');
    expect(record.value).not.toHaveProperty('audioContext');
    expect(record.value).not.toHaveProperty('audioBuffer');
    expect(record.value).not.toHaveProperty('audioNode');

    const targetEngine = new DeferredEngine();
    const targetConsumer = createHostAudioConsumer(targetEngine);
    const targetParticipant = createHostAudioSimulationParticipant(targetConsumer);
    const prepared = targetParticipant.prepareRestore(record.value, { entityCount: 1 });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    targetParticipant.commitRestore(prepared.value, {
      entityCount: 1,
      entityMap: new Map([[0, 99]]),
    });
    targetEngine.resolveNext();
    await Promise.resolve();
    expect(targetEngine.plays).toEqual([99]);
  });

  it('drops stale async completion and exposes bus/listener/cleanup semantics', async () => {
    const engine = new DeferredEngine();
    const consumer = createHostAudioConsumer(engine);
    const pose: AudioListenerPose = {
      positionX: 1,
      positionY: 2,
      positionZ: 3,
      forwardX: 0,
      forwardY: 0,
      forwardZ: -1,
      upX: 0,
      upY: 1,
      upZ: 0,
    };
    consumer.consume(playIntent(3));
    consumer.consume({ kind: 'stop', entityId: 3 });
    engine.resolveNext();
    await Promise.resolve();
    expect(engine.plays).toEqual([]);

    consumer.consume({ kind: 'set-bus-volume', bus: 'music', volume: 0.25 });
    consumer.consume({ kind: 'set-listener-pose', pose });
    const participant = createHostAudioSimulationParticipant(consumer);
    const record = participant.recordState?.();
    expect(record?.ok).toBe(true);
    if (!record?.ok) return;
    expect(record.value).toMatchObject({ listener: pose });
    expect(record.value).toHaveProperty('bus');
    expect(record.value).toHaveProperty('cleanup');
  });
});
