import {
  type CompiledRenderGraph,
  type GraphResourceResolver,
  RenderGraphBuilder,
} from '@forgeax/engine-render-graph';
import type {
  BindGroupLayout,
  CommandBuffer,
  RenderPipeline,
  RhiCommandEncoder,
  Texture,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type RenderError, RenderFeatureStageFailedError } from '../errors/render';
import {
  getRenderFeaturePlanExecutionProjection,
  type RenderFeaturePlanExecution,
} from '../features/host';
import { type RenderFeaturePlannedFrame, renderFeaturePlanSignature } from '../features/plan';
import { projectRenderFeaturePlans as projectPlanExecutions } from '../features/render-graph-contribution';
import type {
  RenderFeatureGraphBindingsResolution,
  RenderFeatureGraphTargetResolver,
} from '../features/render-graph-raster';
import { isRenderFeatureTargetHandle } from '../features/targets';
import type { PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { STANDARD_PIPELINE_ID } from '../pipeline/standard-profile';
import type { CameraSnapshot } from '../render-contract';
import type {
  RenderPipelineFeatureTarget,
  RenderPipelineFrame,
  RenderPipelineTopology,
} from '../render-pipeline';
import type { ExtractedLights } from '../render-system-extract';
import { buildPerFrameBindGroups } from './frame-lighting';
import type { RenderFrameState } from './frame-snapshot';
import type { PipelineState, RenderSystemInternals } from './render-context';
import { resolveSurfaceFormatPair } from './render-context';

export interface RenderFeatureGraphRuntimeState {
  plans: readonly RenderFeaturePlannedFrame[];
  fullscreenEffects: ReadonlyMap<
    string,
    import('../fullscreen-post-process-pass').PostProcessShaderEntry
  >;
}

/** A frame-local graph candidate that is committed only after compilation. */
export interface RenderFeatureGraphCandidate {
  readonly plans: readonly RenderFeaturePlannedFrame[];
  readonly fullscreenEffects: ReadonlyMap<
    string,
    import('../fullscreen-post-process-pass').PostProcessShaderEntry
  >;
  /**
   * Physical prepared resources are imported into the compiled graph. A new
   * prepared batch therefore needs a new graph even when the declarative plan
   * signature is unchanged; otherwise queue retirement can destroy the buffer
   * still referenced by the memoized graph.
   */
  readonly preparedResourceKey?: string;
  /** Release candidate-owned prepared resources when graph promotion fails. */
  readonly onRejected?: () => void;
}

const featureGraphStates = new WeakMap<RenderSystemInternals, RenderFeatureGraphRuntimeState>();

export function getRenderFeatureGraphState(
  internals: RenderSystemInternals,
): RenderFeatureGraphRuntimeState {
  const existing = featureGraphStates.get(internals);
  if (existing !== undefined) return existing;
  const created: RenderFeatureGraphRuntimeState = {
    plans: [],
    fullscreenEffects: new Map(),
  };
  featureGraphStates.set(internals, created);
  return created;
}

export function resetRenderFeatureGraphState(internals: RenderSystemInternals): void {
  const state = getRenderFeatureGraphState(internals);
  state.plans = [];
  state.fullscreenEffects = new Map();
}

export function reportRenderFeatureGraphError(
  internals: RenderSystemInternals,
  error: RenderError,
): void {
  if (internals.featureHost !== undefined && 'detail' in error) {
    const detail = error.detail;
    if (detail !== undefined && 'featureIdentity' in detail && 'order' in detail) {
      const owned = internals.featureHost.recordError(detail.featureIdentity, error);
      internals.errorRegistry.fire(owned);
      return;
    }
  }
  internals.errorRegistry.fire(error);
}

export function renderFeatureGraphPlanSignature(
  plans: readonly RenderFeaturePlannedFrame[],
): string {
  return JSON.stringify(
    plans.map((planned) => [planned.featureIdentity, planned.generation, planned.signature]),
  );
}

function validateRenderFeaturePlans(
  plans: readonly RenderFeaturePlannedFrame[],
): Result<readonly RenderFeaturePlanExecution[], RenderError> {
  const identities = new Set<string>();
  const projected: RenderFeaturePlanExecution[] = [];
  let previousOrder = -1;
  for (const [order, planned] of plans.entries()) {
    const execution = getRenderFeaturePlanExecutionProjection(planned);
    if (
      identities.has(planned.featureIdentity) ||
      planned.signature !== renderFeaturePlanSignature(planned.plan) ||
      execution === undefined ||
      execution.featureIdentity !== planned.featureIdentity ||
      execution.order <= previousOrder
    ) {
      return err(
        new RenderFeatureStageFailedError(planned.featureIdentity, order, 'plan', 'next-frame'),
      );
    }
    identities.add(planned.featureIdentity);
    previousOrder = execution.order;
    projected.push(execution);
  }
  return ok(Object.freeze(projected));
}

function commitFeatureCandidate(
  internals: RenderSystemInternals,
  candidate: RenderFeatureGraphCandidate,
): void {
  const state = getRenderFeatureGraphState(internals);
  state.plans = candidate.plans;
  state.fullscreenEffects = candidate.fullscreenEffects;
}

function topologyOf(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  camera: CameraSnapshot,
  lights: ExtractedLights,
  width: number,
  height: number,
  shadowMapSize: number | undefined,
  gpuDriven: PreparedGpuDrivenFrame | undefined,
  featureGraphCandidate: RenderFeatureGraphCandidate | undefined,
): RenderPipelineTopology {
  const cascadeCount = Math.max(1, Math.min(4, Math.round(lights.cascadeCount ?? 1))) as
    | 1
    | 2
    | 3
    | 4;
  const surfaceFormats = resolveSurfaceFormatPair(
    internals.device.caps.backendKind,
    pipelineState.format as GPUTextureFormat,
    pipelineState.colorAttachmentFormat as GPUTextureFormat,
  );
  const featurePostEffects = [
    ...(featureGraphCandidate?.fullscreenEffects ??
      getRenderFeatureGraphState(internals).fullscreenEffects),
  ].map(([id]) => id);
  const config =
    featurePostEffects.length === 0
      ? frameState.installedPipelineConfig
      : {
          ...(frameState.installedPipelineConfig ?? {}),
          postEffects: [
            ...new Set([
              ...(frameState.installedPipelineConfig?.postEffects ?? []),
              ...featurePostEffects,
            ]),
          ],
        };
  return {
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: internals.standardProfile,
    config,
    surface: {
      width,
      height,
      storageFormat: surfaceFormats.storage as TextureFormat,
      viewFormat: surfaceFormats.view as TextureFormat,
    },
    camera: {
      tonemap: camera.tonemap,
      antialias: camera.antialias,
      bloom: camera.bloom,
    },
    shadow: {
      mapSize: shadowMapSize ?? 1024,
      cascadeCount,
      pointCount: Math.min(4, lights.pointShadow.length),
      pointFaceSize: lights.pointShadow[0]?.mapSize ?? 512,
      spotCount: Math.min(
        4,
        lights.spot.filter(
          (light) => light.shadowAtlasTile >= 0 && light.lightViewProj !== undefined,
        ).length,
      ),
    },
    lane: {
      compute: internals.device.caps.compute,
      storageBuffer: internals.device.caps.storageBuffer,
      multisample: internals.device.caps.backendKind !== 'wgpu-webgl2',
      maxColorAttachments: internals.device.caps.maxColorAttachments,
    },
    featureTopologySignature: JSON.stringify({
      plans: renderFeatureGraphPlanSignature(
        featureGraphCandidate?.plans ?? getRenderFeatureGraphState(internals).plans,
      ),
      fullscreenEffects: featurePostEffects,
      preparedResourceKey: featureGraphCandidate?.preparedResourceKey ?? '',
    }),
    gpuDrivenTopologySignature: gpuDriven?.topologySignature ?? '',
  };
}

function targetResolver(
  targets: readonly RenderPipelineFeatureTarget[],
): RenderFeatureGraphTargetResolver {
  return (resource) => {
    if (!isRenderFeatureTargetHandle(resource)) return undefined;
    const target = targets.find(
      (candidate) =>
        candidate.kind === resource.kind &&
        candidate.format === resource.format &&
        candidate.sampleCount === resource.sampleCount,
    );
    return target === undefined
      ? undefined
      : {
          texture: target.texture,
          view: target.view,
          ...(target.resolveTarget === undefined ? {} : { resolveTarget: target.resolveTarget }),
        };
  };
}

function resolveTargetBindings(input: {
  readonly frame: RenderPipelineFrame;
  readonly binding: import('../prepare/prepared-graphics-resolver').PreparedGraphicsResolvedResource & {
    readonly kind: 'bindings';
  };
  readonly resources: GraphResourceResolver;
  readonly resolveTarget: RenderFeatureGraphTargetResolver;
}): RenderFeatureGraphBindingsResolution | undefined {
  const frame = input.frame as import('./render-context')._InternalRenderPipelineContext;
  const descriptor = input.binding.descriptor;
  const pipeline = input.binding.pipeline as
    | (RenderPipeline & { getBindGroupLayout?: (index: number) => BindGroupLayout })
    | undefined;
  const sceneDepth = descriptor?.values.sceneDepth;
  const sceneDepthBinding = descriptor?.values.sceneDepthBinding;
  if (pipeline === undefined) return undefined;
  if (sceneDepthBinding === 1) {
    const target = sceneDepth === undefined ? undefined : input.resolveTarget(sceneDepth);
    const depthView =
      target === undefined
        ? frame.pipelineState.shadowFallbackTextureView
        : (() => {
            const texture = input.resources.texture(target.texture);
            if (!texture.ok) throw texture.error;
            const created = frame.runtime.device.createTextureView(texture.value as Texture, {
              aspect: 'depth-only',
              dimension: '2d',
            });
            if (!created.ok) throw created.error;
            return created.value;
          })();
    const layout = pipeline.getBindGroupLayout?.(0);
    if (layout === undefined) return undefined;
    const created = frame.runtime.device.createBindGroup({
      layout,
      entries: [
        {
          binding: 0,
          resource: {
            kind: 'buffer',
            value: { buffer: frame.pipelineState.viewUniformBuffer },
          },
        },
        { binding: 1, resource: { kind: 'textureView', value: depthView } },
      ],
    });
    if (!created.ok) throw created.error;
    return created.value;
  }
  if (sceneDepth === undefined) {
    const viewBindGroup = buildPerFrameBindGroups(
      frame.runtime as RenderSystemInternals,
      frame.frameState,
      frame.pipelineState,
      frame.validated.length > 0,
      frame.bindGroupCounts,
      {
        directionalShadow: frame.frameState.currentDirectionalShadowView ?? undefined,
        spotShadow: frame.frameState.currentSpotShadowView ?? undefined,
      },
    ).viewBindGroup;
    return viewBindGroup === null ? undefined : { handle: viewBindGroup, dynamicOffsets: [0] };
  }
  const target = input.resolveTarget(sceneDepth);
  if (target === undefined) return undefined;
  const texture = input.resources.texture(target.texture);
  if (!texture.ok) throw texture.error;
  const depthView = frame.runtime.device.createTextureView(texture.value as Texture, {
    aspect: 'depth-only',
    dimension: '2d',
  });
  if (!depthView.ok) throw depthView.error;
  const group = descriptor?.values.group === 1 ? 1 : 0;
  const layout = pipeline.getBindGroupLayout?.(group);
  if (layout === undefined) return undefined;
  const created = frame.runtime.device.createBindGroup({
    layout,
    entries: [{ binding: 0, resource: { kind: 'textureView', value: depthView.value } }],
  });
  if (!created.ok) throw created.error;
  return created.value;
}

function retire(
  frameState: RenderFrameState,
  graph: CompiledRenderGraph<RenderPipelineFrame>,
): void {
  frameState.retiredCompiledFrameGraphs.add(graph);
  graph
    .retire()
    .finally(() => frameState.retiredCompiledFrameGraphs.delete(graph))
    .catch(() => undefined);
}

export function ensureCompiledFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  pipelineState: PipelineState,
  camera: CameraSnapshot,
  lights: ExtractedLights,
  width: number,
  height: number,
  shadowMapSize: number | undefined,
  gpuDriven?: PreparedGpuDrivenFrame,
  featureGraphCandidate?: RenderFeatureGraphCandidate,
): CompiledRenderGraph<RenderPipelineFrame> | null {
  const surfaceWidth = Math.max(1, width);
  const surfaceHeight = Math.max(1, height);
  const featurePlans = featureGraphCandidate?.plans ?? getRenderFeatureGraphState(internals).plans;
  const projectedFeaturePlans = validateRenderFeaturePlans(featurePlans);
  if (!projectedFeaturePlans.ok) {
    reportRenderFeatureGraphError(internals, projectedFeaturePlans.error);
    featureGraphCandidate?.onRejected?.();
    return frameState.compiledFrameGraph;
  }
  const topology = topologyOf(
    internals,
    frameState,
    pipelineState,
    camera,
    lights,
    surfaceWidth,
    surfaceHeight,
    shadowMapSize,
    gpuDriven,
    featureGraphCandidate,
  );
  const key = JSON.stringify(topology);
  if (frameState.compiledFrameGraph !== null && frameState.compiledFrameGraphTopologyKey === key) {
    if (featureGraphCandidate !== undefined) {
      commitFeatureCandidate(internals, featureGraphCandidate);
    }
    return frameState.compiledFrameGraph;
  }

  const builder = new RenderGraphBuilder<RenderPipelineFrame>();
  let projectedFeatures = false;
  let projectedGpuDriven = false;
  const built = frameState.activePipeline.build(
    {
      graph: builder,
      projectGpuDriven: (target) => {
        if (projectedGpuDriven || gpuDriven === undefined) return ok(undefined);
        projectedGpuDriven = true;
        return gpuDriven.project(builder, target.format, target.sampleCount);
      },
      contributeFeatures: (targets) => {
        if (projectedFeatures) return ok(undefined);
        projectedFeatures = true;
        if (projectedFeaturePlans.value.length === 0) return ok(undefined);
        const resolveTarget = targetResolver(targets);
        const projected = projectPlanExecutions(builder, projectedFeaturePlans.value, {
          resolveTarget,
          resolveBindings: resolveTargetBindings,
          reportError: (error) => reportRenderFeatureGraphError(internals, error),
        });
        return projected.ok ? ok(undefined) : projected;
      },
    },
    topology,
  );
  if (!built.ok) {
    internals.errorRegistry.fire(built.error);
    featureGraphCandidate?.onRejected?.();
    return frameState.compiledFrameGraph;
  }
  const compiled = builder.compile({
    device: internals.device,
    surfaceSize: { width: surfaceWidth, height: surfaceHeight },
  });
  if (!compiled.ok) {
    internals.errorRegistry.fire(compiled.error);
    featureGraphCandidate?.onRejected?.();
    return frameState.compiledFrameGraph;
  }
  const previous = frameState.compiledFrameGraph;
  frameState.compiledFrameGraph = compiled.value;
  frameState.compiledFrameGraphTopologyKey = key;
  gpuDriven?._commitResourceReplacement();
  if (featureGraphCandidate !== undefined) {
    commitFeatureCandidate(internals, featureGraphCandidate);
  }
  if (previous !== null) retire(frameState, previous);
  return compiled.value;
}

export function executeCompiledFrameGraph(
  internals: RenderSystemInternals,
  frameState: RenderFrameState,
  frame: RenderPipelineFrame,
  encoder: RhiCommandEncoder,
  runPass?: import('@forgeax/engine-render-graph').RenderGraphPassRunner,
): boolean {
  const graph = frameState.compiledFrameGraph;
  if (graph === null) return false;
  const executed = graph.execute(frame, runPass);
  if (!executed.ok) {
    internals.errorRegistry.fire(executed.error);
    return false;
  }
  const finished = encoder.finish();
  if (!finished.ok) {
    internals.errorRegistry.fire(finished.error);
    return false;
  }
  const command: CommandBuffer = finished.value;
  const submitted = internals.device.queue.submit([command]);
  if (!submitted.ok) {
    internals.errorRegistry.fire(submitted.error);
    return false;
  }
  return true;
}
