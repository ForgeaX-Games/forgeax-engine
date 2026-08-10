import {
  type AudioBackend,
  type AudioIntent,
  type AudioState,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import { AudioError } from '@forgeax/engine-types';
import { WebAudioEngine } from './web-audio-engine';

export interface HostAudioConsumer {
  consume(intent: AudioIntent): void;
  state(): AudioState;
  dispose(): void;
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

export function createHostAudioConsumer(engine = new WebAudioEngine()): HostAudioConsumer {
  const sources = new Map<string, Promise<AudioBuffer>>();
  const entityEpoch = new Map<number, number>();
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
        engine.stop(intent.entityId);
      } else if (intent.kind === 'set-volume') {
        engine.setVolume(intent.entityId, intent.volume);
      } else if (intent.kind === 'set-bus-volume') {
        engine.setBusVolume(intent.bus, intent.volume);
      } else if (intent.kind === 'set-bus-mute') {
        engine.setBusMute(intent.bus, intent.muted);
      } else if (intent.kind === 'set-listener-pose') {
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
      entityEpoch.clear();
      sources.clear();
      engine.destroy();
    },
  };
  return consumer;
}

export function createWebAudioBackend(): AudioBackend {
  const consumer = createHostAudioConsumer();
  return createAudioIntentBackend({
    emit: (intent) => consumer.consume(intent),
    state: () => consumer.state(),
  });
}
