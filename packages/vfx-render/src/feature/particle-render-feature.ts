import type { World } from '@forgeax/engine-ecs';
import type { RenderFeature, RenderFeaturePrepareContext } from '@forgeax/engine-render';
import type { ParticleSimulationObservation } from '@forgeax/engine-vfx';
import type { ParticleRenderDiagnostics } from '../errors.js';

export interface ParticleRenderCamera {
  readonly position: Float32Array;
  readonly right: Float32Array;
  readonly up: Float32Array;
  readonly viewProjection: Float32Array;
}

export interface ParticleRenderObservationSource {
  readonly read: (world: World) => readonly ParticleSimulationObservation[];
}

export interface ParticleRenderCameraSource {
  readonly read: (world: World) => ParticleRenderCamera | undefined;
}

export interface ParticleRenderFeatureOptions {
  readonly observations: ParticleRenderObservationSource;
  readonly camera: ParticleRenderCameraSource;
}

export interface ParticleRenderFeatureFrameData {
  readonly world: World;
  readonly camera: ParticleRenderCamera;
  readonly observations: readonly ParticleSimulationObservation[];
  readonly frameNumber: number;
}

export interface ParticleRenderFeature extends RenderFeature<ParticleRenderFeatureFrameData> {
  /** Material shader modules required by particle prepared graphics before the first draw. */
  readonly requiredMaterialShaders: readonly string[];
  diagnostics(): ParticleRenderDiagnostics;
  recover(
    context: RenderFeaturePrepareContext,
  ): ReturnType<NonNullable<RenderFeature<ParticleRenderFeatureFrameData>['recover']>>;
  dispose(
    context: RenderFeaturePrepareContext,
  ): ReturnType<NonNullable<RenderFeature<ParticleRenderFeatureFrameData>['dispose']>>;
}
