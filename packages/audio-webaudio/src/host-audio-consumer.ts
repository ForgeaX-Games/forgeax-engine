import {
  type AudioBackend,
  type AudioIntent,
  type AudioPlayOptions,
  type AudioState,
  createAudioIntentBackend,
  validAudioStream,
} from '@forgeax/engine-audio';
import { type AudioClipAsset, AudioError } from '@forgeax/engine-types';
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
  readonly kind: 'buffer';
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
  const sources = new Map<
    string,
    | DecodeEntry
    | {
        readonly kind: 'stream';
        readonly stream: NonNullable<AudioClipAsset['stream']>;
        readonly size: number;
      }
  >();
  const cachedBytes = () =>
    [...sources.values()].reduce(
      (bytes, source) =>
        bytes +
        (source.kind === 'stream' ? source.size : source.bytes.byteLength + source.decodedBytes),
      0,
    );
  engine.setStreamBudget(maxCachedBytes, cachedBytes);
  const pendingPlays = new Map<number, PendingPlay>();
  let lastError: { sourceKey: string; error: AudioError } | undefined;
  let disposed = false;
  // A pending play adopts every control intent that arrives before its decode settles.
  const patchPendingOptions = (entityId: number, patch: Partial<AudioPlayOptions>) => {
    const pending = pendingPlays.get(entityId);
    if (pending !== undefined) pending.options = { ...pending.options, ...patch };
  };
  const consumer: HostAudioConsumer = {
    engine,
    consume(intent): void {
      if (disposed && intent.kind !== 'destroy') return;
      switch (intent.kind) {
        case 'play': {
          pendingPlays.delete(intent.entityId);
          engine.stop(intent.entityId);
          const fail = (cause: unknown) => {
            lastError = {
              sourceKey: intent.sourceKey,
              error: decodeError(intent.sourceKey, cause),
            };
          };
          let entry = sources.get(intent.sourceKey);
          if (intent.stream) {
            if (!validAudioStream(intent.stream)) {
              lastError = {
                sourceKey: intent.sourceKey,
                error: new AudioError({
                  code: 'stream-failed',
                  expected: 'a bounded PCM16 stream manifest',
                  hint: 'load the verified stream through the audio asset owner',
                  detail: {
                    code: 'stream-failed',
                    reason: 'unsupported-format',
                    message: 'invalid stream publication',
                  },
                }),
              };
              return;
            }
            const size = JSON.stringify(intent.stream).length * 2;
            const oldSize = entry
              ? entry.kind === 'stream'
                ? entry.size
                : entry.bytes.byteLength + entry.decodedBytes
              : 0;
            if (
              (!entry && sources.size >= maxCachedSources) ||
              cachedBytes() - oldSize + size + engine.streamingBytes > maxCachedBytes
            ) {
              fail('audio stream publication exceeds the shared Host source/byte budget');
              return;
            }
            if (
              entry?.kind !== 'stream' ||
              JSON.stringify(entry.stream) !== JSON.stringify(intent.stream)
            ) {
              engine.invalidateAudioPublication(intent.sourceKey);
              entry = { kind: 'stream', stream: structuredClone(intent.stream), size };
              sources.set(intent.sourceKey, entry);
            }
          }
          if (intent.bytes === undefined && entry?.kind === 'stream') {
            engine.play(
              intent.entityId,
              {
                kind: 'audio',
                sourceKey: intent.sourceKey,
                mediaType: 'audio/wav',
                stream: entry.stream,
              },
              intent.options,
            );
            return;
          }
          if (
            intent.bytes !== undefined &&
            (entry === undefined ||
              entry.kind !== 'buffer' ||
              !sameBytes(entry.bytes, intent.bytes))
          ) {
            const replacedBytes =
              entry === undefined
                ? 0
                : entry.kind === 'stream'
                  ? entry.size
                  : entry.bytes.byteLength + entry.decodedBytes;
            if (
              (entry === undefined && sources.size >= maxCachedSources) ||
              cachedBytes() - replacedBytes + intent.bytes.byteLength + engine.streamingBytes >
                maxCachedBytes
            ) {
              pendingPlays.delete(intent.entityId);
              fail(
                'audio cache budget exceeded; reuse published clips or create a Host with a larger budget',
              );
              return;
            }
            engine.invalidateAudioPublication(intent.sourceKey);
            entry = {
              kind: 'buffer',
              bytes: intent.bytes.slice(),
              promise: undefined,
              decodedBytes: 0,
            };
            sources.set(intent.sourceKey, entry);
          }
          if (!pendingPlays.has(intent.entityId) && pendingPlays.size >= maxPendingPlays) {
            fail('maxPendingPlays reached; stop pending entities or increase the Host budget');
            return;
          }
          if (entry === undefined || entry.kind !== 'buffer') {
            pendingPlays.delete(intent.entityId);
            fail('sourceKey was not published');
            return;
          }
          const current = entry;
          const pending: PendingPlay = {
            options: {
              ...intent.options,
              ...(intent.options.sourcePose === undefined
                ? {}
                : { sourcePose: { ...intent.options.sourcePose } }),
            },
          };
          pendingPlays.set(intent.entityId, pending);
          if (current.promise === undefined) {
            // Decode is owned by the source publication, never by one entity.
            try {
              current.promise = engine.decode(current.bytes).then((buffer) => {
                if (sources.get(intent.sourceKey) !== current) return buffer;
                const bytes = (buffer.length ?? 0) * (buffer.numberOfChannels ?? 0) * 4;
                if (cachedBytes() + bytes + engine.streamingBytes > maxCachedBytes)
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
              if (pendingPlays.get(intent.entityId) === pending)
                pendingPlays.delete(intent.entityId);
            });
          return;
        }
        case 'stop':
          pendingPlays.delete(intent.entityId);
          engine.stop(intent.entityId);
          return;
        case 'set-volume':
          if (!Number.isFinite(intent.volume) || intent.volume < 0) return;
          patchPendingOptions(intent.entityId, { volume: intent.volume });
          engine.setVolume(intent.entityId, intent.volume);
          return;
        case 'set-playback-rate':
          if (!Number.isFinite(intent.playbackRate) || intent.playbackRate <= 0) return;
          patchPendingOptions(intent.entityId, { playbackRate: intent.playbackRate });
          engine.setPlaybackRate(intent.entityId, intent.playbackRate);
          return;
        case 'set-paused':
          patchPendingOptions(intent.entityId, { paused: intent.paused });
          engine.setPaused(intent.entityId, intent.paused);
          return;
        case 'seek':
          if (!Number.isFinite(intent.position) || intent.position < 0) return;
          patchPendingOptions(intent.entityId, { fromPosition: intent.position });
          engine.seek(intent.entityId, intent.position);
          return;
        case 'failure':
          lastError = { sourceKey: 'publication', error: new AudioError(intent.error) };
          return;
        case 'configure-buses':
          engine.configureBuses(intent.buses);
          return;
        case 'set-bus':
          patchPendingOptions(intent.entityId, { bus: intent.bus });
          engine.setBus(intent.entityId, intent.bus);
          return;
        case 'set-bus-volume':
          engine.setBusVolume(intent.bus, intent.volume);
          return;
        case 'set-bus-mute':
          engine.setBusMute(intent.bus, intent.muted);
          return;
        case 'set-source-pose':
          patchPendingOptions(intent.entityId, { sourcePose: { ...intent.pose } });
          engine.setSourcePose(intent.entityId, intent.pose);
          return;
        case 'set-listener-pose':
          engine.setListenerPose(intent.pose);
          return;
        case 'destroy':
          consumer.dispose();
          return;
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

export function createWebAudioBackend(engine = new WebAudioEngine()): AudioBackend {
  const consumer = createHostAudioConsumer(engine);
  const backend = createAudioIntentBackend({
    emit: (intent) => consumer.consume(intent),
    state: () => consumer.state(),
  });
  return backend;
}
