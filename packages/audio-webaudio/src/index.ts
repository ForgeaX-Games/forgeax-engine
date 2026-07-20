// @forgeax/engine-audio-webaudio -- public barrel (feat-20260527-audio-system M2 / w17+w19)
//
// Single-entry surface: AI users import `@forgeax/engine-audio-webaudio` for
// the Web Audio API backend (charter P1 progressive disclosure).
//
// Exports:
//   - createWebAudioBackend() factory (w17)
//   - WebAudioEngine class (w16)
//
// Placeholder exports (M3 impl):
//   - audioTickSystem (M3)
//   - audioListenerSyncSystem (M3)
//
// Re-exports from @forgeax/engine-audio:
//   - AudioBackend, AUDIO_ENGINE_RESOURCE_KEY

// Re-exports from engine-audio for convenience
export { AUDIO_ENGINE_RESOURCE_KEY, type AudioBackend } from '@forgeax/engine-audio';
export type { WorldMatrixData } from './audio-listener-sync-system';
// audio listener sync system (Transform.world mat4 -> Web Audio listener)
export {
  audioListenerSyncSystem,
  syncListenerFromWorldMatrix,
} from './audio-listener-sync-system';
// M3: audio tick system (edge detection + node lifecycle + property sync)
export { audioTickSystem, detectEdge, type TickStateEntry } from './audio-tick-system';
// M3: AudioClipAsset loader (fetch + decodeAudioData)
export { loadAudioClipByGuid } from './clip-loader';
// M2 (feat-20260623-plugin-system-unify): audioPlugin factory (w9)
export { AUDIO_TICK_SYSTEM_NAME, audioPlugin } from './plugin-factory';
// Public factory + class (M2)
export { createWebAudioBackend, WebAudioEngine } from './web-audio-engine';
