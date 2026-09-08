import type { AudioClipAsset, AudioError } from '@forgeax/engine-types';
import type {
  AudioBackend,
  AudioListenerPose,
  AudioPlayOptions,
  AudioState,
  BusName,
} from './audio-backend';

export type AudioIntent =
  | {
      readonly kind: 'play';
      readonly entityId: number;
      readonly sourceKey: string;
      readonly bytes?: Uint8Array;
      readonly options: AudioPlayOptions;
    }
  | { readonly kind: 'stop'; readonly entityId: number }
  | { readonly kind: 'set-volume'; readonly entityId: number; readonly volume: number }
  | { readonly kind: 'set-bus-volume'; readonly bus: BusName; readonly volume: number }
  | { readonly kind: 'set-bus-mute'; readonly bus: BusName; readonly muted: boolean }
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
  readonly state?: () => AudioState;
}

const DISCONNECTED_AUDIO_STATE: AudioState = {
  contextState: 'suspended',
  activeSourceCount: 0,
  lastError: null,
};

export function createAudioIntentBackend(options: AudioIntentBackendOptions): AudioBackend {
  const publishedSources = new Map<string, Uint8Array>();
  let destroyed = false;
  const emit = (intent: AudioIntent): void => {
    if (!destroyed || intent.kind === 'destroy') options.emit(intent);
  };
  const backend: AudioBackend = {
    play(entityId: number, clip: AudioClipAsset, playOptions: AudioPlayOptions): void {
      const publishedBytes = publishedSources.get(clip.sourceKey);
      const publishBytes = publishedBytes === undefined || !sameBytes(publishedBytes, clip.bytes);
      if (publishBytes) publishedSources.set(clip.sourceKey, clip.bytes.slice());
      emit({
        kind: 'play',
        entityId,
        sourceKey: clip.sourceKey,
        ...(publishBytes ? { bytes: clip.bytes } : {}),
        options: playOptions,
      });
    },
    stop: (entityId) => emit({ kind: 'stop', entityId }),
    setVolume: (entityId, volume) => emit({ kind: 'set-volume', entityId, volume }),
    setBusVolume: (bus, volume) => {
      const intent = { kind: 'set-bus-volume', bus, volume } as const;
      emit(intent);
    },
    setBusMute: (bus, muted) => {
      const intent = { kind: 'set-bus-mute', bus, muted } as const;
      emit(intent);
    },
    setListenerPose: (pose) => {
      const intent = { kind: 'set-listener-pose', pose } as const;
      emit(intent);
    },
    getState: () => options.state?.() ?? DISCONNECTED_AUDIO_STATE,
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
