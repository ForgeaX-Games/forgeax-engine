import type { World } from '@forgeax/engine-ecs';
import { err, ok } from '@forgeax/engine-types';
import { RenderFeatureStageFailedError } from '../../errors/render';
import type { RenderFeature, RenderFeaturePlan } from '../types';

export const MORPH_MAX_TARGETS = 8;

export type MorphVec3 = readonly [number, number, number];

export interface MorphBounds {
  readonly min: MorphVec3;
  readonly max: MorphVec3;
}

export interface MorphTargetBounds {
  readonly min: MorphVec3;
  readonly max: MorphVec3;
}

export interface MorphCullInput {
  readonly weights?: ArrayLike<number>;
  readonly expectedWeightCount: number;
  readonly baseAabbIntersectsFrustum: boolean;
}

export type MorphCullDecision = 'draw' | 'cull';

function finiteVec3(value: MorphVec3): boolean {
  return value.every((component) => Number.isFinite(component));
}

function validWeights(weights: ArrayLike<number> | undefined, expected: number): boolean {
  if (weights === undefined || weights.length !== expected) return false;
  for (let index = 0; index < weights.length; index++) {
    if (!Number.isFinite(weights[index] ?? Number.NaN)) return false;
  }
  return true;
}

export function deriveMorphBounds(
  base: MorphBounds,
  targets: readonly MorphTargetBounds[],
  weights: ArrayLike<number>,
): MorphBounds {
  if (
    !finiteVec3(base.min) ||
    !finiteVec3(base.max) ||
    targets.length > MORPH_MAX_TARGETS ||
    !validWeights(weights, targets.length)
  ) {
    return base;
  }

  const min = [base.min[0], base.min[1], base.min[2]];
  const max = [base.max[0], base.max[1], base.max[2]];
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    const target = targets[targetIndex];
    const weight = weights[targetIndex] ?? 0;
    if (target === undefined || !finiteVec3(target.min) || !finiteVec3(target.max)) return base;
    for (let axis = 0; axis < 3; axis++) {
      const low = (weight >= 0 ? target.min[axis] : target.max[axis]) ?? 0;
      const high = (weight >= 0 ? target.max[axis] : target.min[axis]) ?? 0;
      min[axis] = (min[axis] ?? 0) + weight * low;
      max[axis] = (max[axis] ?? 0) + weight * high;
    }
  }
  return {
    min: [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0],
    max: [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0],
  };
}

export function morphCullDecision(input: MorphCullInput): MorphCullDecision {
  if (!Number.isInteger(input.expectedWeightCount) || input.expectedWeightCount < 0) return 'cull';
  if (!validWeights(input.weights, input.expectedWeightCount)) return 'cull';
  for (let index = 0; index < input.expectedWeightCount; index++) {
    if ((input.weights?.[index] ?? 0) !== 0) return 'draw';
  }
  return input.baseAabbIntersectsFrustum ? 'draw' : 'cull';
}

export interface MorphReentryState {
  seen: boolean;
  visible: boolean;
  generation: number;
  weights: Float32Array | undefined;
}

export interface MorphReentryInput {
  readonly frameNumber: number;
  readonly visible: boolean;
  readonly generation: number;
  readonly weights: ArrayLike<number>;
}

export interface MorphReentryResult {
  readonly frameNumber: number;
  readonly reentered: boolean;
  readonly clearStale: boolean;
  readonly weights: readonly number[];
}

export function createMorphReentryState(): MorphReentryState {
  return { seen: false, visible: false, generation: -1, weights: undefined };
}

export function stepMorphReentry(
  state: MorphReentryState,
  input: MorphReentryInput,
): MorphReentryResult {
  const reentered =
    state.seen && input.visible && (!state.visible || state.generation !== input.generation);
  const clearStale = reentered && state.weights !== undefined;
  const weights = Array.from(
    { length: input.weights.length },
    (_, index) => input.weights[index] ?? 0,
  );
  state.seen = true;
  state.visible = input.visible;
  state.generation = input.generation;
  state.weights = new Float32Array(weights);
  return { frameNumber: input.frameNumber, reentered, clearStale, weights };
}

const COMPUTE_STAGE = 0x4;
const MORPH_WEIGHTS_BYTES = MORPH_MAX_TARGETS * Float32Array.BYTES_PER_ELEMENT;
const MORPH_WORKGROUP_SIZE = 64;

export const MORPH_COMPUTE_WGSL = `
struct MorphWeights { values: array<f32, 8> };
@group(0) @binding(0) var<storage, read> source: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> output: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> weights: MorphWeights;

@compute @workgroup_size(${MORPH_WORKGROUP_SIZE})
fn morph_main(@builtin(global_invocation_id) id: vec3<u32>) {
  let vertex = id.x;
  let vertex_count = arrayLength(&output);
  if (vertex >= vertex_count) { return; }
  var position = source[vertex];
  for (var target_index = 0u; target_index < 8u; target_index = target_index + 1u) {
    position = position + source[(target_index + 1u) * vertex_count + vertex] * weights.values[target_index];
  }
  output[vertex] = position;
}
`;

export interface MorphFeatureRenderable {
  readonly identity: string;
  readonly vertexCount: number;
  readonly baseBounds: MorphBounds;
  readonly targetBounds: readonly MorphTargetBounds[];
  readonly weights: ArrayLike<number>;
  readonly baseAabbIntersectsFrustum: boolean;
  readonly basePositions?: ArrayLike<number>;
  readonly targetDeltas?: ArrayLike<number>;
}

export interface MorphFeatureCollectContext {
  readonly worlds: readonly World[];
  readonly frameNumber: number;
}

export interface MorphFeatureOptions {
  readonly collect: (context: MorphFeatureCollectContext) => readonly MorphFeatureRenderable[];
}

export interface MorphFeatureDraw {
  readonly identity: string;
  readonly vertexCount: number;
  readonly targetCount: number;
  readonly bounds: MorphBounds;
  readonly weights: Float32Array;
  readonly reentered: boolean;
  readonly clearStale: boolean;
  readonly source: Float32Array;
}

export interface MorphFeatureFrame {
  readonly frameNumber: number;
  readonly draws: readonly MorphFeatureDraw[];
  readonly culledCount: number;
  readonly zeroWeightCount: number;
  readonly reentryCount: number;
}

export interface MorphFeature extends RenderFeature<MorphFeatureFrame> {}

function stageFailure(stage: 'extract' | 'plan'): RenderFeatureStageFailedError {
  return new RenderFeatureStageFailedError('forgeax.morph', -1, stage, 'next-frame');
}

function copyWeights(input: ArrayLike<number>): Float32Array {
  const weights = new Float32Array(MORPH_MAX_TARGETS);
  for (let index = 0; index < Math.min(input.length, MORPH_MAX_TARGETS); index++) {
    weights[index] = input[index] ?? 0;
  }
  return weights;
}

function copySource(renderable: MorphFeatureRenderable, targetCount: number): Float32Array {
  const source = new Float32Array((MORPH_MAX_TARGETS + 1) * renderable.vertexCount * 4);
  const basePositions = renderable.basePositions;
  const targetDeltas = renderable.targetDeltas;
  for (let vertex = 0; vertex < renderable.vertexCount; vertex++) {
    const base = vertex * 4;
    source[base] = basePositions?.[vertex * 3] ?? 0;
    source[base + 1] = basePositions?.[vertex * 3 + 1] ?? 0;
    source[base + 2] = basePositions?.[vertex * 3 + 2] ?? 0;
    source[base + 3] = 1;
    for (let target = 0; target < targetCount; target++) {
      const sourceBase = (target + 1) * renderable.vertexCount * 4 + vertex * 4;
      const deltaBase = (target * renderable.vertexCount + vertex) * 3;
      source[sourceBase] = targetDeltas?.[deltaBase] ?? 0;
      source[sourceBase + 1] = targetDeltas?.[deltaBase + 1] ?? 0;
      source[sourceBase + 2] = targetDeltas?.[deltaBase + 2] ?? 0;
      source[sourceBase + 3] = 0;
    }
  }
  return source;
}

function validRenderable(renderable: MorphFeatureRenderable): boolean {
  return (
    renderable.identity.length > 0 &&
    Number.isInteger(renderable.vertexCount) &&
    renderable.vertexCount > 0 &&
    renderable.targetBounds.length > 0 &&
    renderable.targetBounds.length <= MORPH_MAX_TARGETS &&
    renderable.weights.length === renderable.targetBounds.length
  );
}

export function createBuiltinMorphFeature(options: MorphFeatureOptions): MorphFeature {
  const reentry = new Map<string, MorphReentryState>();

  const feature: MorphFeature = {
    identity: 'forgeax.morph',
    requiredCapabilities: ['compute', 'storageBuffer'],
    extract: ({ worlds, frameNumber }) => {
      const renderables = options.collect({ worlds, frameNumber });
      const draws: MorphFeatureDraw[] = [];
      let culledCount = 0;
      let zeroWeightCount = 0;
      let reentryCount = 0;
      for (const renderable of renderables) {
        if (!validRenderable(renderable)) return err(stageFailure('extract'));
        const weights = copyWeights(renderable.weights);
        const decision = morphCullDecision({
          weights: renderable.weights,
          expectedWeightCount: renderable.targetBounds.length,
          baseAabbIntersectsFrustum: renderable.baseAabbIntersectsFrustum,
        });
        const state = reentry.get(renderable.identity) ?? createMorphReentryState();
        reentry.set(renderable.identity, state);
        const transition = stepMorphReentry(state, {
          frameNumber,
          visible: decision === 'draw',
          generation: 0,
          weights,
        });
        if (decision === 'cull') {
          culledCount += 1;
          if (weights.every((weight) => weight === 0)) zeroWeightCount += 1;
          continue;
        }
        if (transition.reentered) reentryCount += 1;
        draws.push({
          identity: renderable.identity,
          vertexCount: renderable.vertexCount,
          targetCount: renderable.targetBounds.length,
          bounds: deriveMorphBounds(
            renderable.baseBounds,
            renderable.targetBounds,
            renderable.weights,
          ),
          weights,
          reentered: transition.reentered,
          clearStale: transition.clearStale,
          source: copySource(renderable, renderable.targetBounds.length),
        });
      }
      return ok({
        frameNumber,
        draws,
        culledCount,
        zeroWeightCount,
        reentryCount,
      });
    },
    plan: (data) => {
      if (data.draws.length === 0) return ok({ resources: [], passes: [] });
      const program = 'morph.compute-program';
      const resources: RenderFeaturePlan['resources'][number][] = [
        {
          kind: 'compute-program',
          name: program,
          program: {
            wgsl: MORPH_COMPUTE_WGSL,
            entryPoints: ['morph_main'],
            bindings: [
              {
                label: 'forgeax.morph.bindings',
                entries: [
                  { binding: 0, visibility: COMPUTE_STAGE, buffer: { type: 'read-only-storage' } },
                  { binding: 1, visibility: COMPUTE_STAGE, buffer: { type: 'storage' } },
                  { binding: 2, visibility: COMPUTE_STAGE, buffer: { type: 'uniform' } },
                ],
              },
            ],
          },
        },
      ];
      const passes: RenderFeaturePlan['passes'][number][] = [];
      for (const [index, draw] of data.draws.entries()) {
        const prefix = `morph.draw-${index}`;
        const source = `${prefix}.source`;
        const output = `${prefix}.output`;
        const weights = `${prefix}.weights`;
        const bindings = `${prefix}.bindings`;
        resources.push(
          {
            kind: 'buffer',
            name: source,
            size: draw.source.byteLength,
            usage: ['storage'],
            data: draw.source,
          },
          {
            kind: 'buffer',
            name: output,
            size: draw.vertexCount * 16,
            usage: ['storage', 'vertex', 'copy-src'],
          },
          {
            kind: 'buffer',
            name: weights,
            size: MORPH_WEIGHTS_BYTES,
            usage: ['uniform'],
            data: draw.weights,
          },
          {
            kind: 'compute-bindings',
            name: bindings,
            program,
            entries: [
              { binding: 0, resource: source },
              { binding: 1, resource: output },
              { binding: 2, resource: weights },
            ],
          },
          {
            kind: 'vertex-data',
            name: `${prefix}.vertex-data`,
            layout: 'morph-position',
            buffer: output,
          },
        );
        passes.push({
          kind: 'compute',
          name: `${prefix}.compute`,
          program,
          bindings,
          dispatches: [
            {
              kind: 'direct',
              entryPoint: 'morph_main',
              workgroups: [Math.max(1, Math.ceil(draw.vertexCount / MORPH_WORKGROUP_SIZE))],
            },
          ],
        });
      }
      return ok<RenderFeaturePlan>({ resources, passes });
    },
  };
  return feature;
}
