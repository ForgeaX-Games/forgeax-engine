import {
  type AudioBackend,
  type AudioIntent,
  type AudioPlayOptions,
  type AudioState,
  createAudioIntentBackend,
} from '@forgeax/engine-audio';
import { AudioError } from '@forgeax/engine-types';
import { WebAudioEngine } from './web-audio-engine';

interface PendingPlay {
  options: AudioPlayOptions;
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
  readonly bytes: Uint8Array;
  promise: Promise<AudioBuffer> | undefined;
  decodedBytes: number;
}

export interface HostAudioConsumerOptions {
  /** Encoded bytes plus decoded float samples retained by this consumer. */
  readonly maxCachedBytes?: number;
  readonly maxCachedSources?: number;
  readonly maxPendingPlays?: number;
}

export function createHostAudioConsumer(
  engine = new WebAudioEngine(),
  options: HostAudioConsumerOptions = {},
): HostAudioConsumer {
  const maxCachedBytes = options.maxCachedBytes ?? 64 * 1024 * 1024;
  const maxCachedSources = options.maxCachedSources ?? 256;
  const maxPendingPlays = options.maxPendingPlays ?? 1024;
  for (const limit of [maxCachedBytes, maxCachedSources, maxPendingPlays]) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('audio cache limits must be positive safe integers');
  }
  const sources = new Map<string, DecodeEntry>();
  const cachedBytes = () =>
    [...sources.values()].reduce(
      (bytes, source) => bytes + source.bytes.byteLength + source.decodedBytes,
      0,
    );
  const pendingPlays = new Map<number, PendingPlay>();
  let lastError: { sourceKey: string; error: AudioError } | undefined;
  let disposed = false;
  const consumer: HostAudioConsumer = {
    engine,
    consume(intent): void {
      if (disposed && intent.kind !== 'destroy') return;
      if (intent.kind === 'play') {
        const fail = (cause: unknown) => {
          lastError = { sourceKey: intent.sourceKey, error: decodeError(intent.sourceKey, cause) };
        };
        let entry = sources.get(intent.sourceKey);
        if (
          intent.bytes !== undefined &&
          (entry === undefined || !sameBytes(entry.bytes, intent.bytes))
        ) {
          const replacedBytes =
            entry === undefined ? 0 : entry.bytes.byteLength + entry.decodedBytes;
          if (
            (entry === undefined && sources.size >= maxCachedSources) ||
            cachedBytes() - replacedBytes + intent.bytes.byteLength > maxCachedBytes
          ) {
            pendingPlays.delete(intent.entityId);
            fail(
              'audio cache budget exceeded; reuse published clips or create a Host with a larger budget',
            );
            return;
          }
          entry = { bytes: intent.bytes.slice(), promise: undefined, decodedBytes: 0 };
          sources.set(intent.sourceKey, entry);
        }
        if (!pendingPlays.has(intent.entityId) && pendingPlays.size >= maxPendingPlays) {
          fail('maxPendingPlays reached; stop pending entities or increase the Host budget');
          return;
        }
        const pending: PendingPlay = { options: { ...intent.options } };
        pendingPlays.set(intent.entityId, pending);
        if (entry === undefined) {
          pendingPlays.delete(intent.entityId);
          fail('sourceKey was not published');
          return;
        }
        const current = entry;
        if (current.promise === undefined) {
          // Decode is owned by the source publication, never by one entity.
          try {
            current.promise = engine.decode(current.bytes).then((buffer) => {
              if (sources.get(intent.sourceKey) !== current) return buffer;
              const bytes = (buffer.length ?? 0) * (buffer.numberOfChannels ?? 0) * 4;
              if (cachedBytes() + bytes > maxCachedBytes)
                throw new Error('decoded audio exceeds maxCachedBytes');
              current.decodedBytes = bytes;
              if (lastError?.sourceKey === intent.sourceKey) lastError = undefined;
              return buffer;
            });
          } catch (cause) {
            pendingPlays.delete(intent.entityId);
            fail(cause);
            return;
          }
          void current.promise.catch((cause) => {
            if (sources.get(intent.sourceKey) !== current) return;
            current.promise = undefined;
            fail(cause);
          });
        }
        void current.promise
          .then((buffer) => {
            if (
              !disposed &&
              sources.get(intent.sourceKey) === current &&
              pendingPlays.get(intent.entityId) === pending
            ) {
              engine.play(intent.entityId, buffer, pending.options);
            }
          })
          .catch(() => {})
          .finally(() => {
            if (pendingPlays.get(intent.entityId) === pending) pendingPlays.delete(intent.entityId);
          });
      } else if (intent.kind === 'stop') {
        pendingPlays.delete(intent.entityId);
        engine.stop(intent.entityId);
      } else if (intent.kind === 'set-volume') {
        if (!Number.isFinite(intent.volume) || intent.volume < 0) return;
        const pending = pendingPlays.get(intent.entityId);
        if (pending !== undefined) pending.options = { ...pending.options, volume: intent.volume };
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
      const state = engine.getState();
      return { ...state, lastError: state.lastError ?? lastError?.error ?? null };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      pendingPlays.clear();
      sources.clear();
      lastError = undefined;
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
