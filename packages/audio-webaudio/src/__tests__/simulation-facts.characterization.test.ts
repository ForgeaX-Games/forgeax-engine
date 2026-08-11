import type { AudioIntent, AudioListenerPose, AudioPlayOptions } from '@forgeax/engine-audio';
import { describe, expect, it } from 'vitest';
import { createHostAudioConsumer } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';

const PLAY_OPTIONS: AudioPlayOptions = {
  loop: false,
  volume: 0.5,
  spatialBlend: 0,
  bus: 'sfx',
};

class DeferredDecodeEngine extends WebAudioEngine {
  readonly pendingDecodes: Array<(buffer: AudioBuffer) => void> = [];
  readonly plays: Array<{ entityId: number; buffer: AudioBuffer; options: AudioPlayOptions }> = [];
  readonly stops: number[] = [];
  readonly busChanges: Array<['volume' | 'mute', string, number | boolean]> = [];
  readonly listenerPoses: AudioListenerPose[] = [];
  destroyed = false;

  override decode(_bytes: Uint8Array): Promise<AudioBuffer> {
    return new Promise((resolve) => this.pendingDecodes.push(resolve));
  }

  override play(entityId: number, buffer: AudioBuffer, options: AudioPlayOptions): void {
    this.plays.push({ entityId, buffer, options });
  }

  override stop(entityId: number): void {
    this.stops.push(entityId);
  }

  override setBusVolume(bus: 'sfx' | 'music', volume: number): void {
    this.busChanges.push(['volume', bus, volume]);
  }

  override setBusMute(bus: 'sfx' | 'music', muted: boolean): void {
    this.busChanges.push(['mute', bus, muted]);
  }

  override setListenerPose(pose: AudioListenerPose): void {
    this.listenerPoses.push(pose);
  }

  override destroy(): void {
    this.destroyed = true;
    super.destroy();
  }

  resolveNextDecode(): void {
    this.pendingDecodes.shift()?.({} as AudioBuffer);
  }
}

function playIntent(entityId: number, sourceKey = `source-${entityId}`): AudioIntent {
  return {
    kind: 'play',
    entityId,
    sourceKey,
    bytes: new Uint8Array([1, 2, 3]),
    options: PLAY_OPTIONS,
  };
}

describe('M1 Host audio lifecycle simulation facts characterization', () => {
  it('drops stale decode completion after stop and dispose', async () => {
    const engine = new DeferredDecodeEngine();
    const consumer = createHostAudioConsumer(engine);

    consumer.consume(playIntent(7));
    consumer.consume({ kind: 'stop', entityId: 7 });
    engine.resolveNextDecode();
    await Promise.resolve();
    expect(engine.plays).toEqual([]);
    expect(engine.stops).toEqual([7]);

    consumer.consume(playIntent(8));
    consumer.dispose();
    engine.resolveNextDecode();
    await Promise.resolve();
    expect(engine.plays).toEqual([]);
    expect(engine.destroyed).toBe(true);
    expect(consumer.state().contextState).toBe('closed');
  });

  it('keeps bus and listener intents on the host owner boundary', () => {
    const engine = new DeferredDecodeEngine();
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

    consumer.consume({ kind: 'set-bus-volume', bus: 'music', volume: 0.25 });
    consumer.consume({ kind: 'set-bus-mute', bus: 'music', muted: true });
    consumer.consume({ kind: 'set-listener-pose', pose });

    expect(engine.busChanges).toEqual([
      ['volume', 'music', 0.25],
      ['mute', 'music', true],
    ]);
    expect(engine.listenerPoses).toEqual([pose]);
    consumer.dispose();
  });

  it('keeps native graph lifecycle owned by an idempotent consumer dispose', () => {
    const engine = new DeferredDecodeEngine();
    const consumer = createHostAudioConsumer(engine);

    expect(engine.getState()).toEqual({
      contextState: 'suspended',
      activeSourceCount: 0,
      lastError: null,
    });
    consumer.consume(playIntent(9));
    expect(engine.pendingDecodes).toHaveLength(1);
    consumer.dispose();
    consumer.dispose();
    engine.resolveNextDecode();

    expect(engine.destroyed).toBe(true);
    expect(consumer.state()).toEqual({
      contextState: 'closed',
      activeSourceCount: 0,
      lastError: null,
    });
    expect(engine.plays).toEqual([]);
  });
});
