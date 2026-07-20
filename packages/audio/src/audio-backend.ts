// @forgeax/engine-audio -- AudioBackend protocol interface (feat-20260527-audio-system M1 / w8)
//
// Decision anchors:
// - plan-strategy D-1 (dual-package split: interface in engine-audio, impl in engine-audio-webaudio)
// - plan-strategy D-5 (fixed two-bus topology: SFX + Music -> Master; bus name literal union)
// - requirements S-5 (dual bus mixing hierarchy) + S-9 (AudioEngine Resource)
// - requirements S-7 (entity despawn cleanup: stop + disconnect)
// - charter P4 (consistent abstraction: structurally parallel to InputBackend)

export type BusName = 'sfx' | 'music';

export const AUDIO_ENGINE_RESOURCE_KEY = 'AudioEngine' as const;
export const ASSET_REGISTRY_RESOURCE_KEY = 'AssetRegistry' as const;

export interface AudioPlayOptions {
  readonly loop: boolean;
  readonly volume: number;
  readonly spatialBlend: number;
  readonly bus: BusName;
}

export interface AudioState {
  readonly contextState: 'running' | 'suspended' | 'closed';
  readonly activeSourceCount: number;
}

export interface AudioBackend {
  play(entityId: number, clipBuffer: AudioBuffer, opts: AudioPlayOptions): void;
  stop(entityId: number): void;
  setVolume(entityId: number, volume: number): void;
  setBusVolume(busName: BusName, volume: number): void;
  setBusMute(busName: BusName, muted: boolean): void;
  getState(): AudioState;
  getActiveSourceCount(): number;
  destroy(): void;
}
