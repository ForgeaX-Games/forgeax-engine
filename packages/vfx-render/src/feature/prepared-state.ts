import {
  RENDER_FEATURE_VERTEX_LAYOUTS,
  type RenderFeatureDrawRecord,
  type RenderFeaturePrepareContext,
  type RenderFeaturePreparedRef,
  RenderFeatureStageFailedError,
} from '@forgeax/engine-render';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { ParticleOutputBatch } from '@forgeax/engine-vfx';
import {
  createParticleRenderError,
  type ParticleRenderDiagnostics,
  type ParticleRenderError,
} from '../errors.js';
import { collectParticleRenderBuckets, type ParticleRenderBucket } from './buckets.js';
import type {
  ParticleRenderFeature,
  ParticleRenderFeatureFrameData,
  ParticleRenderFeatureOptions,
} from './particle-render-feature.js';

export const PARTICLE_SHADER_IDENTIFIERS = Object.freeze({
  billboard: 'forgeax::vfx-render.particles.billboard',
  mesh: 'forgeax::vfx-render.particles.mesh',
});

const PARTICLE_MATERIAL_SHADERS = Object.freeze(Object.values(PARTICLE_SHADER_IDENTIFIERS));

interface ParticlePreparedRefs {
  readonly pipeline: RenderFeaturePreparedRef<'pipeline'>;
  readonly bindings: RenderFeaturePreparedRef<'bindings'>;
  readonly vertexData: RenderFeaturePreparedRef<'vertex-data'>;
  readonly indexData: RenderFeaturePreparedRef<'index-data'> | undefined;
  readonly kind: ParticleOutputBatch['kind'];
  readonly count: number;
}

export interface ParticlePreparedState {
  generation: number | undefined;
  draws: readonly RenderFeatureDrawRecord[];
  diagnostics: ParticleRenderDiagnostics;
}

export function createParticlePreparedState(): ParticlePreparedState {
  return {
    generation: undefined,
    draws: [],
    diagnostics: { readiness: 'empty', error: undefined, bucketCount: 0, generation: undefined },
  };
}

function setDiagnostics(
  state: ParticlePreparedState,
  readiness: ParticleRenderDiagnostics['readiness'],
  error: ParticleRenderError | undefined,
  bucketCount: number,
): void {
  state.diagnostics = Object.freeze({
    readiness,
    error,
    bucketCount,
    generation: state.generation,
  });
}

function projectPoint(
  matrix: Float32Array,
  x: number,
  y: number,
  z: number,
): readonly [number, number, number] {
  const value = (index: number): number => matrix[index] ?? 0;
  const clipX = value(0) * x + value(4) * y + value(8) * z + value(12);
  const clipY = value(1) * x + value(5) * y + value(9) * z + value(13);
  const clipZ = value(2) * x + value(6) * y + value(10) * z + value(14);
  const clipW = value(3) * x + value(7) * y + value(11) * z + value(15);
  const inverseW = Math.abs(clipW) > 1e-6 ? 1 / clipW : 1;
  return [clipX * inverseW, clipY * inverseW, clipZ * inverseW];
}

function projectedParticle(
  camera: ParticleRenderFeatureFrameData['camera'],
  position: readonly [number, number, number],
  right: readonly [number, number, number],
  up: readonly [number, number, number],
  color: Float32Array,
  colorOffset: number,
): readonly number[] {
  const center = projectPoint(camera.viewProjection, position[0], position[1], position[2]);
  const rightPoint = projectPoint(
    camera.viewProjection,
    position[0] + right[0],
    position[1] + right[1],
    position[2] + right[2],
  );
  const upPoint = projectPoint(
    camera.viewProjection,
    position[0] + up[0],
    position[1] + up[1],
    position[2] + up[2],
  );
  return [
    center[0],
    center[1],
    center[2],
    Math.abs(rightPoint[0] - center[0]),
    Math.abs(upPoint[1] - center[1]),
    color[colorOffset] ?? 1,
    color[colorOffset + 1] ?? 1,
    color[colorOffset + 2] ?? 1,
    color[colorOffset + 3] ?? 1,
  ];
}

function bucketData(
  bucket: ParticleRenderBucket,
  camera: ParticleRenderFeatureFrameData['camera'],
): Float32Array {
  const values: number[] = [];
  for (const batch of bucket.batches) {
    if (batch.kind === 'billboard') {
      for (let index = 0; index < batch.count; index += 1) {
        const positionOffset = index * 3;
        const sizeOffset = index * 2;
        values.push(
          ...projectedParticle(
            camera,
            [
              batch.attributes.position[positionOffset] ?? 0,
              batch.attributes.position[positionOffset + 1] ?? 0,
              batch.attributes.position[positionOffset + 2] ?? 0,
            ],
            [
              (camera.right[0] ?? 1) * (batch.attributes.size[sizeOffset] ?? 0),
              (camera.right[1] ?? 0) * (batch.attributes.size[sizeOffset] ?? 0),
              (camera.right[2] ?? 0) * (batch.attributes.size[sizeOffset] ?? 0),
            ],
            [
              (camera.up[0] ?? 0) * (batch.attributes.size[sizeOffset + 1] ?? 0),
              (camera.up[1] ?? 1) * (batch.attributes.size[sizeOffset + 1] ?? 0),
              (camera.up[2] ?? 0) * (batch.attributes.size[sizeOffset + 1] ?? 0),
            ],
            batch.attributes.color,
            index * 4,
          ),
        );
      }
    } else {
      for (let index = 0; index < batch.count; index += 1) {
        const transformOffset = index * 16;
        const transform = batch.attributes.transform;
        values.push(
          ...projectedParticle(
            camera,
            [
              transform[transformOffset + 12] ?? 0,
              transform[transformOffset + 13] ?? 0,
              transform[transformOffset + 14] ?? 0,
            ],
            [
              (transform[transformOffset] ?? 1) * 0.5,
              (transform[transformOffset + 1] ?? 0) * 0.5,
              (transform[transformOffset + 2] ?? 0) * 0.5,
            ],
            [
              (transform[transformOffset + 4] ?? 0) * 0.5,
              (transform[transformOffset + 5] ?? 1) * 0.5,
              (transform[transformOffset + 6] ?? 0) * 0.5,
            ],
            batch.attributes.color,
            index * 4,
          ),
        );
      }
    }
  }
  return new Float32Array(values);
}

function pipelineLayout(kind: ParticleOutputBatch['kind']): string {
  void kind;
  return RENDER_FEATURE_VERTEX_LAYOUTS.positionSizeColorInstance;
}

function failed(): Result<never, RenderFeatureStageFailedError> {
  return err(
    new RenderFeatureStageFailedError('forgeax.vfx-render.particles', -1, 'prepare', 'next-frame'),
  );
}

function assetNotReady(
  state: ParticlePreparedState,
  bucket: ParticleRenderBucket,
  kind: ParticleOutputBatch['kind'],
  bucketCount: number,
): Result<never, RenderFeatureStageFailedError> {
  const error =
    kind === 'mesh'
      ? createParticleRenderError('particle-render-mesh-not-ready', {
          assetGuid: String(bucket.key.mesh),
        })
      : createParticleRenderError('particle-render-material-not-ready', {
          assetGuid: String(bucket.key.material),
        });
  state.draws = [];
  setDiagnostics(state, 'preparing', error, bucketCount);
  return failed();
}

function prepareRefs(
  data: ParticleRenderFeatureFrameData,
  context: RenderFeaturePrepareContext,
  state: ParticlePreparedState,
): Result<void, RenderFeatureStageFailedError> {
  const batches = data.observations.flatMap((observation) => observation.batches.batches);
  const buckets = collectParticleRenderBuckets(data.world, batches);
  if (buckets.length === 0) {
    state.draws = [];
    state.generation = undefined;
    setDiagnostics(state, 'empty', undefined, 0);
    return ok(undefined);
  }
  setDiagnostics(state, 'preparing', undefined, buckets.length);

  const pipelines = new Map<ParticleOutputBatch['kind'], RenderFeaturePreparedRef<'pipeline'>>();
  const indexResult = context.graphics.prepareIndexData('particles.quad.index', {
    format: 'uint16',
    data: new Uint16Array([0, 1, 2, 0, 2, 3]),
  });
  if (!indexResult.ok) return failed();

  const refs: ParticlePreparedRefs[] = [];
  for (const [bucketIndex, bucket] of buckets.entries()) {
    const kind = bucket.key.kind;
    let pipeline = pipelines.get(kind);
    if (pipeline === undefined) {
      const pipelineResult = context.graphics.preparePipeline(`particles.${kind}.pipeline`, {
        shader: PARTICLE_SHADER_IDENTIFIERS[kind],
        vertexLayout: pipelineLayout(kind),
        colorFormats: ['rgba8unorm-srgb'],
      });
      if (!pipelineResult.ok) return assetNotReady(state, bucket, kind, buckets.length);
      pipeline = pipelineResult.value;
      pipelines.set(kind, pipeline);
      if (state.generation !== undefined && state.generation !== pipeline.generation) {
        state.draws = [];
      }
      state.generation = pipeline.generation;
    }

    const bindingResult = context.graphics.prepareBindings(
      `particles.${kind}.binding.${data.frameNumber}.${bucketIndex}`,
      {
        pipeline,
        values: {
          group: 0,
          material: bucket.key.material,
          mesh: bucket.key.mesh,
          camera: Array.from(data.camera.viewProjection),
        },
      },
    );
    if (!bindingResult.ok) return assetNotReady(state, bucket, kind, buckets.length);

    const vertexResult = context.graphics.prepareVertexData(
      `particles.${kind}.vertex.${data.frameNumber}.${bucketIndex}`,
      { layout: pipelineLayout(kind), data: bucketData(bucket, data.camera) },
    );
    if (!vertexResult.ok) return assetNotReady(state, bucket, kind, buckets.length);
    refs.push({
      pipeline,
      bindings: bindingResult.value,
      vertexData: vertexResult.value,
      indexData: kind === 'mesh' ? indexResult.value : undefined,
      kind,
      count: bucket.count,
    });
  }

  state.draws = refs.map((ref) =>
    ref.kind === 'billboard'
      ? {
          kind: 'draw',
          pipeline: ref.pipeline,
          bindings: [ref.bindings],
          vertexData: [{ slot: 0, resource: ref.vertexData }],
          command: { vertexCount: 6, instanceCount: ref.count },
        }
      : {
          kind: 'draw-indexed',
          pipeline: ref.pipeline,
          bindings: [ref.bindings],
          vertexData: [{ slot: 0, resource: ref.vertexData }],
          indexData: {
            resource: ref.indexData as RenderFeaturePreparedRef<'index-data'>,
            format: 'uint16',
          },
          command: { indexCount: 6, instanceCount: ref.count },
        },
  );
  setDiagnostics(state, 'preparing', undefined, refs.length);
  return ok(undefined);
}

function featureBase(
  options: ParticleRenderFeatureOptions,
  state: ParticlePreparedState,
): ParticleRenderFeature {
  const identity = 'forgeax.vfx-render.particles';
  return {
    identity,
    requiredMaterialShaders: PARTICLE_MATERIAL_SHADERS,
    diagnostics: () => state.diagnostics,
    extract: (context) => {
      const world = context.worlds[context.owner];
      if (!world) {
        state.draws = [];
        state.generation = undefined;
        setDiagnostics(
          state,
          'failed',
          createParticleRenderError('particle-render-feature-failed', { stage: 'extract' }),
          0,
        );
        return err(new RenderFeatureStageFailedError(identity, -1, 'extract', 'next-frame'));
      }
      const camera = options.camera.read(world);
      if (!camera) {
        state.draws = [];
        state.generation = undefined;
        setDiagnostics(
          state,
          'unavailable',
          createParticleRenderError('particle-render-camera-unavailable', { owner: context.owner }),
          0,
        );
        return err(new RenderFeatureStageFailedError(identity, -1, 'extract', 'next-frame'));
      }
      const visibility = context.visibilitySnapshots?.find(
        (entry) => entry.world === world,
      )?.snapshot;
      const observations = options.observations.read(world).filter((observation) => {
        if (visibility?.effective(observation.player) !== 'hidden') return true;
        context.reportHiddenEntity?.({ world, entity: observation.player });
        return false;
      });
      const bucketCount = observations.reduce(
        (total, observation) => total + observation.batches.batches.length,
        0,
      );
      setDiagnostics(state, bucketCount === 0 ? 'empty' : 'preparing', undefined, bucketCount);
      return ok({ world, camera, observations, frameNumber: context.frameNumber });
    },
    prepare: () => ok(undefined),
    contribute: () => ok(undefined),
    recover: () => ok(undefined),
    dispose: () => ok(undefined),
  };
}

export function particleRenderFeature(
  options: ParticleRenderFeatureOptions,
): ParticleRenderFeature {
  const state = createParticlePreparedState();
  const base = featureBase(options, state);
  return {
    ...base,
    prepare: (data, context) => prepareRefs(data, context, state),
    contribute: (_data, context) => {
      if (state.draws.length === 0) return ok(undefined);
      const pass = context.staging.addGraphicsPass('particles', {
        attachments: {
          colors: [
            { resource: 'swapchain', format: 'rgba8unorm-srgb', loadOp: 'load', storeOp: 'store' },
          ],
        },
        draws: state.draws,
      });
      if (pass.ok) setDiagnostics(state, 'ready', undefined, state.draws.length);
      return pass;
    },
    recover: () => {
      const generation = state.generation;
      state.draws = [];
      state.generation = undefined;
      setDiagnostics(
        state,
        'unavailable',
        generation === undefined
          ? undefined
          : createParticleRenderError('particle-render-device-lost', { generation }),
        0,
      );
      return ok(undefined);
    },
    dispose: () => {
      state.draws = [];
      state.generation = undefined;
      setDiagnostics(state, 'disabled', undefined, 0);
      return ok(undefined);
    },
  };
}
