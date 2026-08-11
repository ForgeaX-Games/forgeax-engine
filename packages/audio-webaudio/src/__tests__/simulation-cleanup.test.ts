import type { AudioPlayOptions } from '@forgeax/engine-audio';
import { describe, expect, it } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { createHostAudioSimulationParticipant } from '../simulation-participant';
import { WebAudioEngine } from '../web-audio-engine';

const OPTIONS: AudioPlayOptions = {
  loop: false,
  volume: 1,
  spatialBlend: 0,
  bus: 'sfx',
};

class CleanupEngine extends WebAudioEngine {
  readonly pending: Array<(buffer: AudioBuffer) => void> = [];
  readonly plays: number[] = [];
  readonly stops: number[] = [];
  destroyCount = 0;

  override decode(_bytes: Uint8Array): Promise<AudioBuffer> {
    return new Promise((resolve) => this.pending.push(resolve));
  }

  override play(entityId: number): void {
    this.plays.push(entityId);
  }

  override stop(entityId: number): void {
    this.stops.push(entityId);
  }

  override destroy(): void {
    this.destroyCount += 1;
    super.destroy();
  }

  resolveNext(): void {
    this.pending.shift()?.({} as AudioBuffer);
  }
}

describe('Host audio simulation cleanup', () => {
  it('fences stale completion and performs stop/destroy cleanup once', async () => {
    const engine = new CleanupEngine();
    const consumer = createHostAudioConsumer(engine);
    consumer.consume({
      kind: 'play',
      entityId: 4,
      sourceKey: 'cleanup-tone',
      bytes: Uint8Array.of(1),
      options: OPTIONS,
    });
    consumer.consume({ kind: 'stop', entityId: 4 });
    consumer.consume({ kind: 'stop', entityId: 4 });
    engine.resolveNext();
    await Promise.resolve();

    expect(engine.plays).toEqual([]);
    expect(engine.stops).toEqual([4]);

    const participant = createHostAudioSimulationParticipant(consumer);
    const state = participant.recordState?.();
    expect(state?.ok).toBe(true);
    if (state?.ok) {
      expect(state.value).not.toHaveProperty('audioContext');
      expect(state.value).not.toHaveProperty('audioNode');
      expect(state.value).toHaveProperty('cleanup');
    }

    consumer.dispose();
    consumer.dispose();
    expect(engine.destroyCount).toBe(1);
  });
});
