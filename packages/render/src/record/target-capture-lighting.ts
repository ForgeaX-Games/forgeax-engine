import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import { resetHdrpBuffers } from '../hdrp-buffers';
import { computeDirectionalCsm, type ExtractedLights } from '../render-system-extract';
import { resetSsaoResources } from '../ssao-buffers';
import type { RenderTarget } from '../targets/contracts';
import { prepareFrameLighting, writeHdrpClusterAndSsaoBuffers } from './frame-lighting';
import type { RenderFrameState } from './frame-snapshot';
import type { PipelineState, RenderSystemInternals } from './render-context';
import type { CubeCaptureGraphState, CubeCaptureGraphWork } from './target-capture-graph';
import { POINTS_LINES_VIEW_BUFFER_SIZE, VIEW_UNIFORM_BUFFER_SIZE } from './view-ubo';

interface CaptureLightingView {
  readonly runtime: RenderSystemInternals;
  state: RenderFrameState;
  readonly viewBuffer: import('@forgeax/engine-rhi').Buffer;
  readonly pointsLinesViewBuffer: import('@forgeax/engine-rhi').Buffer;
}
const views = new WeakMap<CubeCaptureGraphState, Map<RenderTarget, CaptureLightingView>>();

function retireView(view: CaptureLightingView): void {
  resetHdrpBuffers(view.runtime);
  resetSsaoResources(view.runtime);
  const device = view.runtime.device;
  const release = () => {
    device.destroyBuffer(view.viewBuffer);
    device.destroyBuffer(view.pointsLinesViewBuffer);
  };
  void device.queue.onSubmittedWorkDone().then(release, release);
}

export function disposeTargetCaptureLighting(owner: CubeCaptureGraphState): void {
  for (const view of views.get(owner)?.values() ?? []) retireView(view);
  views.delete(owner);
}

/** Recovery and final disposal retire the complete capture generation together. */
export function disposeTargetCaptures(owner: CubeCaptureGraphState): void {
  disposeTargetCaptureLighting(owner);
  owner.planar?.dispose();
  delete owner.planar;
  owner.work = [];
}

/** Cluster bounds, uniforms, membership and bindings belong to the captured camera. */
export function prepareTargetCaptureLighting(
  owner: CubeCaptureGraphState,
  work: CubeCaptureGraphWork,
  runtime: RenderSystemInternals,
  frameState: RenderFrameState,
  pipeline: PipelineState,
  lights: ExtractedLights,
) {
  let retained = views.get(owner);
  if (retained === undefined) {
    retained = new Map();
    views.set(owner, retained);
  }
  for (const [target, view] of retained) {
    if (view.runtime.device === runtime.device && owner.work.some((item) => item.target === target))
      continue;
    retireView(view);
    retained.delete(target);
  }
  let view = retained.get(work.target);
  if (view === undefined) {
    const device = runtime.device;
    const buffer = device.createBuffer({
      label: 'capture-view',
      size: VIEW_UNIFORM_BUFFER_SIZE,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!buffer.ok) throw buffer.error;
    const pointsLines = device.createBuffer({
      label: 'capture-points-lines',
      size: POINTS_LINES_VIEW_BUFFER_SIZE,
      usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!pointsLines.ok) {
      device.destroyBuffer(buffer.value);
      throw pointsLines.error;
    }
    view = {
      // Resource caches and their retirement keep the creation device even
      // when the parent renderer installs a replacement during recovery.
      runtime: Object.create(runtime, { device: { value: device } }) as RenderSystemInternals,
      state: { ...frameState },
      viewBuffer: buffer.value,
      pointsLinesViewBuffer: pointsLines.value,
    };
    retained.set(work.target, view);
  }
  view.state = { ...frameState, hdrpClusterMembership: view.state.hdrpClusterMembership };
  const csm =
    lights.directionalCsmConfig === undefined || lights.directionalCsmDirection === undefined
      ? null
      : computeDirectionalCsm(
          lights.directionalCsmDirection,
          lights.directionalCsmConfig,
          work.faceCamera,
        );
  const captureLights = csm === null ? lights : { ...lights, ...csm };
  const capturePipeline = {
    ...pipeline,
    viewUniformBuffer: view.viewBuffer,
    pointsLinesViewBuffer: view.pointsLinesViewBuffer,
  };
  const prepared = prepareFrameLighting(
    view.runtime,
    view.state,
    captureLights,
    work.faceCamera,
    capturePipeline,
  );
  if (!prepared.ok) throw prepared.error;
  const lighting = prepared.value.standard;
  if (lighting.kind === 'clustered') {
    const uploaded = writeHdrpClusterAndSsaoBuffers(
      view.runtime,
      view.state,
      work.faceCamera,
      lighting.prepared,
      lighting.transport,
      undefined,
      pipeline.hdrpClusterMembershipPipeline !== null,
      pipeline.hdrpClusterMembershipBindGroupLayout,
      undefined,
      pipeline,
    );
    if (!uploaded.ok) throw uploaded.error;
  }
  return {
    runtime: view.runtime,
    frameState: view.state,
    lighting,
    lights: captureLights,
    pipeline: capturePipeline,
    work,
  };
}
