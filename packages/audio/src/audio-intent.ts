import { type AudioClipAsset, AudioError } from '@forgeax/engine-types';
import type {
  AudioBackend,
  AudioListenerPose,
  AudioPlayOptions,
  AudioSourcePose,
  AudioState,
  BusName,
} from './audio-backend';
import { type AudioBus, validateAudioBuses } from './audio-buses';
import { validAudioStream } from './audio-stream';

export type AudioIntent =
  | {
      readonly kind: 'play';
      readonly entityId: number;
      readonly sourceKey: string;
      readonly bytes?: Uint8Array;
      readonly stream?: AudioClipAsset['stream'];
      readonly options: AudioPlayOptions;
    }
  | {
      readonly kind: 'failure';
      readonly error: Pick<AudioError, 'code' | 'expected' | 'hint' | 'detail'>;
    }
  | { readonly kind: 'configure-buses'; readonly buses: readonly AudioBus[] }
  | { readonly kind: 'set-bus'; readonly entityId: number; readonly bus: BusName }
  | { readonly kind: 'stop'; readonly entityId: number }
  | { readonly kind: 'seek'; readonly entityId: number; readonly position: number }
  | { readonly kind: 'set-playback-rate'; readonly entityId: number; readonly playbackRate: number }
  | { readonly kind: 'set-paused'; readonly entityId: number; readonly paused: boolean }
  | { readonly kind: 'set-volume'; readonly entityId: number; readonly volume: number }
  | { readonly kind: 'set-bus-volume'; readonly bus: BusName; readonly volume: number }
  | { readonly kind: 'set-bus-mute'; readonly bus: BusName; readonly muted: boolean }
  | { readonly kind: 'set-source-pose'; readonly entityId: number; readonly pose: AudioSourcePose }
  | { readonly kind: 'set-listener-pose'; readonly pose: AudioListenerPose }
  | { readonly kind: 'destroy' };

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export interface AudioIntentBackendOptions {
  readonly emit: (intent: AudioIntent) => void;
  readonly maxPublishedBytes?: number;
  readonly maxPublishedSources?: number;
  readonly state?: () => AudioState;
}

const DISCONNECTED_AUDIO_STATE: AudioState = {
  contextState: 'suspended',
  activeSourceCount: 0,
  lastError: null,
};

export function createAudioIntentBackend(options: AudioIntentBackendOptions): AudioBackend {
  const publishedSources = new Map<
    string,
    { data: Uint8Array | NonNullable<AudioClipAsset['stream']>; size: number }
  >();
  const maxBytes = options.maxPublishedBytes ?? 64 * 1024 * 1024;
  const maxSources = options.maxPublishedSources ?? 256;
  for (const limit of [maxBytes, maxSources]) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('audio publication limits must be positive safe integers');
  }
  let publishedBytes = 0;
  let lastError: AudioError | null = null;
  let destroyed = false;
  const emit = (intent: AudioIntent): void => {
    if (!destroyed || intent.kind === 'destroy') options.emit(intent);
  };
  const fail = (error: AudioError): void => {
    lastError = error;
    emit({
      kind: 'failure',
      error: {
        code: error.code,
        expected: error.expected,
        hint: error.hint,
        ...(error.detail ? { detail: error.detail } : {}),
      },
    });
  };
  const backend: AudioBackend = {
    play(entityId: number, clip: AudioClipAsset, playOptions: AudioPlayOptions): void {
      if (clip.stream && !validAudioStream(clip.stream)) {
        fail(
          new AudioError({
            code: 'stream-failed',
            expected: 'a bounded PCM16 stream manifest',
            hint: 'load the verified stream through the audio asset owner',
            detail: {
              code: 'stream-failed',
              reason: 'unsupported-format',
              message: 'invalid stream publication',
            },
          }),
        );
        return;
      }
      const previous = publishedSources.get(clip.sourceKey);
      const data = clip.stream ?? clip.bytes;
      const size = clip.stream ? JSON.stringify(clip.stream).length * 2 : clip.bytes.byteLength;
      const same =
        previous &&
        (data instanceof Uint8Array && previous.data instanceof Uint8Array
          ? sameBytes(data, previous.data)
          : JSON.stringify(data) === JSON.stringify(previous.data));
      if (!same) {
        if (
          (!previous && publishedSources.size >= maxSources) ||
          publishedBytes - (previous?.size ?? 0) + size > maxBytes
        ) {
          fail(
            new AudioError({
              code: 'control-failed',
              expected: 'a bounded audio publication set',
              hint: 'reuse source keys or reduce source bytes; streaming sources publish only their bounded index',
              detail: {
                code: 'control-failed',
                reason: 'audio Worker publication budget exceeded',
              },
            }),
          );
          return;
        }
        publishedBytes += size - (previous?.size ?? 0);
        publishedSources.set(clip.sourceKey, { data: structuredClone(data), size });
      }
      emit({
        kind: 'play',
        entityId,
        sourceKey: clip.sourceKey,
        ...(!same ? (clip.stream ? { stream: clip.stream } : { bytes: clip.bytes }) : {}),
        options: playOptions,
      });
    },
    configureBuses(buses) {
      const checked = validateAudioBuses(buses);
      if (!checked.ok) fail(checked.error);
      else emit({ kind: 'configure-buses', buses });
    },
    setBus: (entityId, bus) => emit({ kind: 'set-bus', entityId, bus }),
    stop: (entityId) => emit({ kind: 'stop', entityId }),
    seek: (entityId, position) => emit({ kind: 'seek', entityId, position }),
    setVolume: (entityId, volume) => emit({ kind: 'set-volume', entityId, volume }),
    setPlaybackRate: (entityId, playbackRate) =>
      emit({ kind: 'set-playback-rate', entityId, playbackRate }),
    setPaused: (entityId, paused) => emit({ kind: 'set-paused', entityId, paused }),
    setBusVolume: (bus, volume) => {
      const intent = { kind: 'set-bus-volume', bus, volume } as const;
      emit(intent);
    },
    setBusMute: (bus, muted) => {
      const intent = { kind: 'set-bus-mute', bus, muted } as const;
      emit(intent);
    },
    setSourcePose: (entityId, pose) => emit({ kind: 'set-source-pose', entityId, pose }),
    setListenerPose: (pose) => {
      const intent = { kind: 'set-listener-pose', pose } as const;
      emit(intent);
    },
    getState: () => ({
      ...(options.state?.() ?? DISCONNECTED_AUDIO_STATE),
      ...(lastError ? { lastError } : {}),
    }),
    getActiveSourceCount: () => (options.state?.() ?? DISCONNECTED_AUDIO_STATE).activeSourceCount,
    destroy(): void {
      if (destroyed) return;
      const intent = { kind: 'destroy' } as const;
      emit(intent);
      destroyed = true;
      publishedSources.clear();
    },
  };
  return backend;
}

export function audioIntentErrorState(error: AudioError): AudioState {
  return { contextState: 'suspended', activeSourceCount: 0, lastError: error };
}
