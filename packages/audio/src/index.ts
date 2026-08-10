// @forgeax/engine-audio -- public barrel (feat-20260527-audio-system M1 / w10)
//
// Single-entry surface: AI users import `@forgeax/engine-audio` and discover
// the full audio subsystem surface in one go (charter P1 progressive disclosure).
//
// Re-exports from @forgeax/engine-types (error model SSOT):
//   AudioError, AudioErrorCode, AudioErrorDetail, AUDIO_ERROR_HINTS
//
// Package-internal exports:
//   AudioBackend interface, BusName, AudioPlayOptions, AudioState,
//   AUDIO_ENGINE_RESOURCE_KEY
//   AudioSource component, AudioListener component

export {
  AUDIO_ERROR_HINTS,
  type AudioClipAsset,
  AudioError,
  type AudioErrorCode,
  type AudioErrorDetail,
} from '@forgeax/engine-types';
export type { AudioListenerPose, AudioPlayOptions, AudioState } from './audio-backend';
export {
  ASSET_REGISTRY_RESOURCE_KEY,
  AUDIO_ENGINE_RESOURCE_KEY,
  type AudioBackend,
  type BusName,
} from './audio-backend';
export {
  type AudioIntent,
  type AudioIntentBackendOptions,
  audioIntentErrorState,
  createAudioIntentBackend,
} from './audio-intent';
export {
  audioTickSystem,
  createClipResolver,
  detectEdge,
  detectRemovedEntities,
  type EdgeAction,
  listenerPoseFromWorldMatrix,
} from './audio-tick-system';
export { AudioListener, AudioSource } from './components';
export { AUDIO_TICK_SYSTEM_NAME, audioPlugin } from './plugin-factory';
