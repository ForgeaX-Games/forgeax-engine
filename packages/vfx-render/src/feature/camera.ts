import type { World } from '@forgeax/engine-ecs';

export interface ParticleRenderCamera {
  readonly position: Float32Array;
  readonly right: Float32Array;
  readonly up: Float32Array;
  readonly viewProjection: Float32Array;
}

export interface ParticleRenderCameraSource {
  readonly read: (world: World) => ParticleRenderCamera | undefined;
}
