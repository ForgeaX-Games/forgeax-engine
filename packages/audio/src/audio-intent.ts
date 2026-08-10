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
  const publishedSources = new Set<string>();
  let destroyed = false;
  const emit = (intent: AudioIntent): void => {
    if (!destroyed || intent.kind === 'destroy') options.emit(intent);
  };
  return {
    play(entityId: number, clip: AudioClipAsset, playOptions: AudioPlayOptions): void {
      const firstPublish = !publishedSources.has(clip.sourceKey);
      publishedSources.add(clip.sourceKey);
      emit({
        kind: 'play',
        entityId,
        sourceKey: clip.sourceKey,
        ...(firstPublish ? { bytes: clip.bytes } : {}),
        options: playOptions,
      });
    },
    stop: (entityId) => emit({ kind: 'stop', entityId }),
    setVolume: (entityId, volume) => emit({ kind: 'set-volume', entityId, volume }),
    setBusVolume: (bus, volume) => emit({ kind: 'set-bus-volume', bus, volume }),
    setBusMute: (bus, muted) => emit({ kind: 'set-bus-mute', bus, muted }),
    setListenerPose: (pose) => emit({ kind: 'set-listener-pose', pose }),
    getState: () => options.state?.() ?? DISCONNECTED_AUDIO_STATE,
    getActiveSourceCount: () => (options.state?.() ?? DISCONNECTED_AUDIO_STATE).activeSourceCount,
    destroy(): void {
      if (destroyed) return;
      emit({ kind: 'destroy' });
      destroyed = true;
      publishedSources.clear();
    },
  };
}

export function audioIntentErrorState(error: AudioError): AudioState {
  return { contextState: 'suspended', activeSourceCount: 0, lastError: error };
}
