import type { World } from '@forgeax/engine-ecs';
import type {
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeaturePlanView,
} from '@forgeax/engine-render';
import { ok } from '@forgeax/engine-types';
import { VFX_GPU_RUNTIME_RESOURCE_KEY } from '@forgeax/engine-vfx';
import { freezeRenderFeaturePlan } from '../../../render/src/features/plan';
import { gpuParticleRenderFeature as createFeature } from '../feature/gpu-particle-feature';

/** Drive the same source-extract / render-plan / source-ack sequence as the feature host. */
export function gpuParticleRenderFeature(
  options: Parameters<typeof createFeature>[0],
): ReturnType<typeof createFeature> {
  const cameras = new Map<World, NonNullable<ReturnType<typeof options.camera.read>>>();
  return withVfxFrameSubmission(
    createFeature({
      ...options,
      camera: { read: (world) => cameras.get(world) ?? options.camera.read(world) },
    }),
    cameras,
  );
}

export function withVfxFrameSubmission(
  feature: ReturnType<typeof createFeature>,
  cameras = new Map<
    World,
    Parameters<ReturnType<typeof createFeature>['plan']>[0]['worlds'][number]['camera']
  >(),
): ReturnType<typeof createFeature> {
  type Feature = ReturnType<typeof createFeature>;
  type Frame = Parameters<Feature['plan']>[0];
  type Source = {
    world: World;
    runtime: object;
    camera: Frame['worlds'][number]['camera'];
    intents: unknown[];
  };
  const sources = new WeakMap<object, { current: Source; runtime: object }>();
  const frames = new Map<number, { data: Frame; feedback: unknown }>();
  const extract = feature.extract.bind(feature);
  feature.extract = (context) =>
    extract({ ...context, views: context.views ?? [{ identity: 'main', render: true }] });
  const plan = feature.plan.bind(feature);
  const submitted = feature.onFrameSubmitted?.bind(feature);
  const aborted = feature.onFrameAborted?.bind(feature);
  feature.plan = (input, context) => {
    let data = input;
    if (input.worlds.some((row) => 'world' in row)) {
      const legacy = input as unknown as { frameNumber: number; worlds: Source[] };
      cameras.clear();
      for (const row of legacy.worlds) {
        let source = sources.get(row.runtime);
        if (source === undefined) {
          source = { current: row, runtime: {} };
          const state = source;
          source.runtime = new Proxy(row.runtime, {
            get(target, key) {
              if (key === 'snapshot') return () => state.current.intents;
              const value = Reflect.get(target, key);
              if (value !== undefined)
                return typeof value === 'function' ? value.bind(target) : value;
              if (key === 'renderGeneration') return 0;
              if (key === 'forEachEmitterSource') return () => {};
              if (key === 'lastCommittedEmitter') return () => undefined;
              return value;
            },
          });
          sources.set(row.runtime, source);
        }
        source.current = row;
        cameras.set(row.world, row.camera);
        row.world.insertResource(VFX_GPU_RUNTIME_RESOURCE_KEY, source.runtime);
      }
      data = feature
        .extract({
          worlds: legacy.worlds.map((row) => row.world),
          owner: 0,
          frameNumber: legacy.frameNumber,
          views: [{ identity: 'main', render: true }],
        })
        .unwrap();
    }
    const result = plan(structuredClone(data), singleViewContext(context));
    if (result.ok) frames.set(data.frameNumber, { data, feedback: result.value.sourceFeedback });
    return result;
  };
  feature.onFrameSubmitted = (frame, submission) => {
    submitted?.(frame, submission);
    const candidate = frames.get(frame.frameNumber);
    frames.delete(frame.frameNumber);
    if (candidate !== undefined)
      feature.onSourceFrameSubmitted?.(candidate.data, structuredClone(candidate.feedback));
  };
  feature.onFrameAborted = (frame) => {
    frames.delete(frame.frameNumber);
    aborted?.(frame);
  };
  return feature;
}

/** Keep fixture setup concise while exercising the canonical scoped feature contract. */
export function singleViewContext(
  context: Omit<RenderFeaturePlanContext, 'views'> &
    Partial<RenderFeaturePlanView> & { readonly views?: RenderFeaturePlanContext['views'] },
): RenderFeaturePlanContext {
  return {
    ...context,
    views: context.views ?? [
      {
        identity: 'main',
        render: true,
        frame: context.frame,
        targets: context.targets ?? [],
        sceneData: context.sceneData ?? ({} as never),
        ...(context.selectedView === undefined ? {} : { selectedView: context.selectedView }),
      },
    ],
  };
}

export const planResources = (plan: RenderFeaturePlan) =>
  plan.work.flatMap((work) => work.resources);
export const planPasses = (plan: RenderFeaturePlan) => plan.work.flatMap((work) => work.passes);

export function freezeVfxPlan(
  identity: string,
  plan: RenderFeaturePlan,
  targets: RenderFeaturePlanView['targets'],
) {
  const shared = plan.work.find((work) => work.scope === 'frame');
  for (const work of plan.work) {
    const closure =
      work.scope === 'frame'
        ? work
        : {
            resources: [...(shared?.resources ?? []), ...work.resources],
            passes: [...(shared?.passes ?? []), ...work.passes],
          };
    const result = freezeRenderFeaturePlan(identity, closure, targets);
    if (!result.ok) return result;
  }
  return ok(plan);
}
