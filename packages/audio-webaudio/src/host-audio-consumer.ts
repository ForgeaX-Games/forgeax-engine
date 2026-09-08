import {
  type AudioBackend,
  type AudioIntent,
  type AudioPlayOptions,
  type AudioState,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import { AudioError } from '@forgeax/engine-types';
import { WebAudioEngine } from './web-audio-engine';

interface ActiveSource {
  readonly entityId: number;
  readonly sourceKey: string;
  readonly bytes?: Uint8Array;
  readonly options: AudioPlayOptions;
}

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
    hint: 'verify the audio media type and source bytes',
    detail: {
      code: 'decode-failed',
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

interface DecodeEntry {
  readonly promise: Promise<AudioBuffer>;
}

export function createHostAudioConsumer(engine = new WebAudioEngine()): HostAudioConsumer {
  const sources = new Map<string, DecodeEntry>();
  const sourceBytes = new Map<string, Uint8Array>();
  const activeSources = new Map<number, ActiveSource>();
  const entityEpoch = new Map<number, number>();
  const bus = {
    sfx: { volume: 1, muted: false },
    music: { volume: 1, muted: false },
  };
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
        if (intent.bytes !== undefined) {
          const incomingBytes = intent.bytes.slice();
          const publishedBytes = sourceBytes.get(intent.sourceKey);
          if (publishedBytes === undefined || !sameBytes(publishedBytes, incomingBytes)) {
            sourceBytes.set(intent.sourceKey, incomingBytes);
            sources.delete(intent.sourceKey);
          }
        }
        const bytes = sourceBytes.get(intent.sourceKey);
        activeSources.set(intent.entityId, {
          entityId: intent.entityId,
          sourceKey: intent.sourceKey,
          ...(bytes === undefined ? {} : { bytes: bytes.slice() }),
          options: intent.options,
        });
        let decoded = sources.get(intent.sourceKey);
        if (decoded === undefined && bytes !== undefined) {
          const entry: DecodeEntry = {
            promise: engine.decode(bytes),
          };
          decoded = entry;
          sources.set(intent.sourceKey, entry);
          void entry.promise.then(
            () => {
              if (sources.get(intent.sourceKey) === entry && lastError?.code === 'decode-failed') {
                lastError = null;
              }
            },
            (cause) => {
              if (sources.get(intent.sourceKey) !== entry) return;
              sources.delete(intent.sourceKey);
              lastError = decodeError(intent.sourceKey, cause);
            },
          );
        }
        if (decoded === undefined) {
          lastError = decodeError(intent.sourceKey, new Error('sourceKey was not published'));
          return;
        }
        const currentDecode = decoded;
        void currentDecode.promise
          .then((buffer) => {
            if (
              !disposed &&
              sources.get(intent.sourceKey) === currentDecode &&
              entityEpoch.get(intent.entityId) === epoch
            ) {
              engine.play(intent.entityId, buffer, intent.options);
            }
          })
          .catch(() => {});
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
      engine.destroy();
    },
  };
  return consumer;
}

export function createWebAudioBackend(): AudioBackend {
  const consumer = createHostAudioConsumer();
  const backend = createAudioIntentBackend({
    emit: (intent) => consumer.consume(intent),
    state: () => consumer.state(),
  });
  return backend;
}
