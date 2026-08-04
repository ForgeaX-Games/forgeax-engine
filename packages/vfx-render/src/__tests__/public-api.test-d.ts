import type { World } from '@forgeax/engine-ecs';
import type {
  RendererOptions,
  RenderFeature,
  RenderFeaturePreparedRef,
} from '@forgeax/engine-render';
import type { ParticleRenderBatch, ParticleSimulationObservation } from '@forgeax/engine-vfx';
import {
  createParticleRuntimeHost,
  type ParticleRenderCamera,
  type ParticleRenderFeatureFrameData,
  type ParticleRenderFeatureOptions,
  particleRenderFeature,
  particleSceneSpaceResolver,
} from '@forgeax/engine-vfx-render';
import { describe, expect, expectTypeOf, it } from 'vitest';

const camera: ParticleRenderCamera = {
  position: new Float32Array(3),
  right: new Float32Array(3),
  up: new Float32Array(3),
  viewProjection: new Float32Array(16),
};

const options = {
  observations: {
    read: (_world: World): readonly ParticleSimulationObservation[] => [],
  },
  camera: {
    read: (_world: World): ParticleRenderCamera => camera,
  },
} satisfies ParticleRenderFeatureOptions;

const feature = particleRenderFeature(options);
const runtimeHost = createParticleRuntimeHost({ camera: options.camera });
expectTypeOf(runtimeHost.feature).toMatchTypeOf<RenderFeature<unknown>>();
expectTypeOf(runtimeHost.attachWorld).toBeFunction();
expectTypeOf(runtimeHost.detachWorld).toBeFunction();
const featureAsRenderFeature = feature satisfies RenderFeature<ParticleRenderFeatureFrameData>;
const rendererOptions = { features: [featureAsRenderFeature] } satisfies RendererOptions;

expectTypeOf(featureAsRenderFeature.extract).toMatchTypeOf<
  RenderFeature<ParticleRenderFeatureFrameData>['extract']
>();
expectTypeOf(featureAsRenderFeature.prepare).toMatchTypeOf<
  RenderFeature<ParticleRenderFeatureFrameData>['prepare']
>();
expectTypeOf(featureAsRenderFeature.contribute).toMatchTypeOf<
  RenderFeature<ParticleRenderFeatureFrameData>['contribute']
>();
expectTypeOf(featureAsRenderFeature.recover).toMatchTypeOf<
  NonNullable<RenderFeature<ParticleRenderFeatureFrameData>['recover']>
>();
expectTypeOf(featureAsRenderFeature.dispose).toMatchTypeOf<
  NonNullable<RenderFeature<ParticleRenderFeatureFrameData>['dispose']>
>();

type FrameWorld = ParticleRenderFeatureFrameData['world'];
type FrameBatches = ParticleRenderFeatureFrameData['observations'][number]['batches'];
type FrameCamera = ParticleRenderFeatureFrameData['camera'];
type PreparedPipeline = RenderFeaturePreparedRef<'pipeline'>;
expectTypeOf<FrameWorld>().toEqualTypeOf<World>();
expectTypeOf<FrameBatches>().toEqualTypeOf<ParticleRenderBatch>();
expectTypeOf<FrameCamera>().toEqualTypeOf<ParticleRenderCamera>();
expectTypeOf<PreparedPipeline>().toMatchTypeOf<RenderFeaturePreparedRef<'pipeline'>>();
void rendererOptions;

function sceneResolverConsumer(world: World): void {
  const sceneResolver = particleSceneSpaceResolver({ world });
  void sceneResolver;
}

expectTypeOf(sceneResolverConsumer).toBeFunction();

// FrameData retains producer observations and does not grow a second batch
// shape or camera/material policy fields.
expectTypeOf<ParticleRenderFeatureFrameData['observations']>().toMatchTypeOf<
  readonly ParticleSimulationObservation[]
>();

describe('vfx-render public type surface', () => {
  it('keeps type assertions in the test project', () => {
    expect(true).toBe(true);
  });
});
