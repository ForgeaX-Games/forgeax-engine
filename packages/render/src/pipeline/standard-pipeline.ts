import type {
  GraphAccess,
  GraphBuffer,
  GraphTextureDescriptor,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { addTypedDebugOverlayPass } from '../debug-draw-glue';
import { HdrpDeferredCapsInsufficientError } from '../errors/render';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import { getOrCreateHdrpBuffers, type HdrpBuffers } from '../hdrp-buffers';
import { DEFERRED_COLOR_FORMATS } from '../pipeline-spec';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import type {
  RenderPipeline,
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineTopology,
} from '../render-pipeline';
import {
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipelineTarget,
} from '../render-pipeline';
import {
  addTypedBloomPasses,
  addTypedCompositePostEffects,
  addTypedFrameObservationPass,
  addTypedFullscreenPass,
  addTypedScenePass,
  addTypedSkyboxPass,
  addTypedSsaoPasses,
  addTypedTonemapPass,
  typedFrameClearColor,
} from '../typed-render-graph-primitives';
import { addTypedShadowPasses } from '../typed-shadow-passes';

import { buildStandardForwardLane } from './standard-forward-lane';
import {
  CLUSTER_GRID_STRIDE_U32,
  DEFAULT_CLUSTER_GRID,
  DEFAULT_STANDARD_PROFILE,
  LIGHT_INDEX_LIST_CAPACITY,
  MAX_LIGHTS,
  resolveStandardLane,
  STANDARD_PIPELINE_ID,
  type StandardProfile,
} from './standard-profile';

/** WGSL owner for the Standard clustered membership producer. */
export const STANDARD_CLUSTER_MEMBERSHIP_WGSL = /* wgsl */ `
struct ClusterUniform {
  grid : vec4<u32>,
  near_far_log : vec4<f32>,
};

@group(0) @binding(0) var<storage, read> cluster_grid : array<u32>;
@group(0) @binding(1) var<storage, read_write> light_index_list : array<u32>;
@group(0) @binding(2) var<uniform> cluster_uniform : ClusterUniform;
@group(0) @binding(3) var<storage, read> light_bounds : array<i32>;

@compute @workgroup_size(64)
fn cs_cluster_membership(@builtin(global_invocation_id) global_id : vec3<u32>) {
  let cluster_index = global_id.x;
  let grid_x = cluster_uniform.grid.x;
  let grid_y = cluster_uniform.grid.y;
  let grid_z = cluster_uniform.grid.z;
  let cluster_count = grid_x * grid_y * grid_z;
  if (cluster_index >= cluster_count) {
    return;
  }

  let cluster_x = cluster_index % grid_x;
  let cluster_yz = cluster_index / grid_x;
  let cluster_y = cluster_yz % grid_y;
  let cluster_z = cluster_yz / grid_y;
  let grid_offset = cluster_index * 2u;
  let output_offset = cluster_grid[grid_offset];
  let output_count = cluster_grid[grid_offset + 1u];
  let cluster_x_i = i32(cluster_x);
  let cluster_y_i = i32(cluster_y);
  let cluster_z_i = i32(cluster_z);
  var output_index = output_offset;

  var light_index = 0u;
  loop {
    if (light_index >= cluster_uniform.grid.w || light_index >= 256u) {
      break;
    }
    let bounds_offset = light_index * 6u;
    let min_x = light_bounds[bounds_offset];
    if (min_x >= 0) {
      let min_y = light_bounds[bounds_offset + 1u];
      let min_z = light_bounds[bounds_offset + 2u];
      let max_x = light_bounds[bounds_offset + 3u];
      let max_y = light_bounds[bounds_offset + 4u];
      let max_z = light_bounds[bounds_offset + 5u];
      if (
        cluster_x_i >= min_x && cluster_x_i <= max_x &&
        cluster_y_i >= min_y && cluster_y_i <= max_y &&
        cluster_z_i >= min_z && cluster_z_i <= max_z
      ) {
        if (output_index < output_offset + output_count) {
          light_index_list[output_index] = light_index;
          output_index += 1u;
        }
      }
    }
    light_index += 1u;
  }
}
`;
export class HdrpInstallError extends Error {
  readonly code = 'hdrp-grid-invalid' as const;
  readonly expected = 'clusterGrid.{x,y,z} each integer in [1, 64]';
  readonly hint: string;
  readonly detail: { readonly x: number; readonly y: number; readonly z: number };

  constructor(x: number, y: number, z: number) {
    const hint = `clusterGrid {x:${x}, y:${y}, z:${z}} is invalid; set {x,y,z} to positive integers in [1, 64]`;
    super(`hdrp-grid-invalid: ${hint}`);
    this.name = 'HdrpInstallError';
    this.hint = hint;
    this.detail = { x, y, z };
  }
}

export function validateClusterGrid(grid: {
  x: number;
  y: number;
  z: number;
}): Result<{ x: number; y: number; z: number }, HdrpInstallError> {
  const { x, y, z } = grid;
  return Number.isInteger(x) &&
    Number.isInteger(y) &&
    Number.isInteger(z) &&
    x >= 1 &&
    x <= 64 &&
    y >= 1 &&
    y <= 64 &&
    z >= 1 &&
    z <= 64
    ? ok({ x, y, z })
    : err(new HdrpInstallError(x, y, z));
}

function target(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(graph, label, descriptor);
}

interface HdrpGraphBuffers {
  readonly lightData: GraphBuffer;
  readonly clusterGrid: GraphBuffer;
  readonly lightIndexList: GraphBuffer;
  readonly clusterUniform: GraphBuffer;
  readonly lightBounds: GraphBuffer;
}

function importBuffers(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): Result<HdrpGraphBuffers, RenderGraphError> {
  const grid = topology.config?.clusterGrid ?? DEFAULT_CLUSTER_GRID;
  const cells = grid.x * grid.y * grid.z;
  const storage = topology.lane.storageBuffer;
  const usage =
    (storage ? GPU_BUFFER_USAGE_STORAGE : GPU_BUFFER_USAGE_UNIFORM) | GPU_BUFFER_USAGE_COPY_DST;
  const resolve = (frame: RenderPipelineFrame): HdrpBuffers => {
    const internal = frame as _InternalRenderPipelineContext;
    const buffers = getOrCreateHdrpBuffers(internal.runtime, grid);
    if (buffers === null) throw new Error('HDRP persistent buffer allocation failed');
    return buffers;
  };
  const lightData = graph.importBuffer(
    'hdrp-light-data',
    { size: (storage ? MAX_LIGHTS : 128) * 64, usage },
    (frame) => resolve(frame).lightDataBuffer,
  );
  if (!lightData.ok) return lightData;
  const clusterGrid = graph.importBuffer(
    'hdrp-cluster-grid',
    { size: storage ? cells * CLUSTER_GRID_STRIDE_U32 * 4 : 32, usage },
    (frame) => resolve(frame).clusterGridBuffer,
  );
  if (!clusterGrid.ok) return clusterGrid;
  const lightIndexList = graph.importBuffer(
    'hdrp-light-index-list',
    { size: storage ? LIGHT_INDEX_LIST_CAPACITY * 4 : 32, usage },
    (frame) => resolve(frame).lightIndexListBuffer,
  );
  if (!lightIndexList.ok) return lightIndexList;
  const clusterUniform = graph.importBuffer(
    'hdrp-cluster-uniform',
    { size: 32, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST },
    (frame) => resolve(frame).clusterUniformBuffer,
  );
  if (!clusterUniform.ok) return clusterUniform;
  const lightBounds = graph.importBuffer(
    'hdrp-light-bounds',
    { size: MAX_LIGHTS * 6 * 4, usage },
    (frame) => resolve(frame).lightBoundsBuffer,
  );
  if (!lightBounds.ok) return lightBounds;
  return ok({
    lightData: lightData.value,
    clusterGrid: clusterGrid.value,
    lightIndexList: lightIndexList.value,
    clusterUniform: clusterUniform.value,
    lightBounds: lightBounds.value,
  });
}

function addMembershipPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  buffers: HdrpGraphBuffers,
): Result<void, RenderGraphError> {
  if (!topology.lane.compute || !topology.lane.storageBuffer) return ok(undefined);
  return graph.addComputePass('cluster-membership-producer', {
    accesses: [
      { resource: buffers.clusterGrid, usage: 'storage-read' },
      { resource: buffers.clusterUniform, usage: 'uniform-read' },
      { resource: buffers.lightBounds, usage: 'storage-read' },
      { resource: buffers.lightIndexList, usage: 'storage-write' },
    ],
    executeIf: (frame) => {
      const internal = frame as _InternalRenderPipelineContext;
      return (
        internal.pipelineState.hdrpClusterMembershipPipeline !== null &&
        internal.hdrpClusterMembershipBindGroup !== null
      );
    },
    encode: ({ pass, frame }) => {
      const internal = frame as _InternalRenderPipelineContext;
      const pipeline = internal.pipelineState.hdrpClusterMembershipPipeline;
      const bindings = internal.hdrpClusterMembershipBindGroup;
      if (pipeline === null || bindings === null) return;
      const grid = topology.config?.clusterGrid ?? DEFAULT_CLUSTER_GRID;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(Math.ceil((grid.x * grid.y * grid.z) / 64));
    },
  });
}

function buildHdrp(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): ReturnType<RenderPipeline['build']> {
  if (topology.lane.maxColorAttachments < 4) {
    return err(new HdrpDeferredCapsInsufficientError(topology.lane.maxColorAttachments));
  }
  const graph = context.graph;
  const surface = importRenderPipelineSurface(graph, topology);
  if (!surface.ok) return surface;
  const buffers = importBuffers(graph, topology);
  if (!buffers.ok) return buffers;
  const membership = addMembershipPass(graph, topology, buffers.value);
  if (!membership.ok) return membership;
  const shadows = addTypedShadowPasses(graph, topology);
  if (!shadows.ok) return shadows;

  const depth = target(graph, 'hdrp-depth', {
    format: 'depth24plus-stencil8',
    size: 'surface',
  });
  if (!depth.ok) return depth;
  const gbuffer0 = target(graph, 'gbuffer-normal-roughness', {
    format: DEFERRED_COLOR_FORMATS[0] ?? 'rgba16float',
    size: 'surface',
  });
  if (!gbuffer0.ok) return gbuffer0;
  const gbuffer1 = target(graph, 'gbuffer-albedo-metallic', {
    format: DEFERRED_COLOR_FORMATS[1] ?? 'rgba8unorm',
    size: 'surface',
  });
  if (!gbuffer1.ok) return gbuffer1;
  const gbuffer2 = target(graph, 'gbuffer-emissive-ao', {
    format: DEFERRED_COLOR_FORMATS[2] ?? 'rgba16float',
    size: 'surface',
  });
  if (!gbuffer2.ok) return gbuffer2;
  const scene = target(graph, 'hdrp-scene-color', { format: 'rgba16float', size: 'surface' });
  if (!scene.ok) return scene;

  const gbuffer = addTypedScenePass(graph, {
    name: 'g-buffer',
    color: gbuffer0.value,
    colorTargets: [gbuffer0.value, gbuffer1.value, gbuffer2.value],
    depth: depth.value,
    selector: { LightMode: ['Deferred'] },
    passKind: 'deferred',
    clearColor: [0, 0, 0, 0],
  });
  if (!gbuffer.ok) return gbuffer;

  let ssao: RenderPipelineTarget | undefined;
  if (topology.config?.ssao?.enabled === true) {
    const raw = target(graph, 'ssao-raw', { format: 'r8unorm', size: 'half-surface' });
    if (!raw.ok) return raw;
    const blurred = target(graph, 'ssao-blurred', { format: 'r8unorm', size: 'half-surface' });
    if (!blurred.ok) return blurred;
    const passes = addTypedSsaoPasses(graph, {
      normal: gbuffer0.value,
      depth: depth.value,
      raw: raw.value,
      blurred: blurred.value,
    });
    if (!passes.ok) return passes;
    ssao = blurred.value;
  }

  const lightingAccesses: GraphAccess[] = [
    { resource: gbuffer0.value.view, usage: 'sampled-read' },
    { resource: gbuffer1.value.view, usage: 'sampled-read' },
    { resource: gbuffer2.value.view, usage: 'sampled-read' },
    { resource: depth.value.view, usage: 'depth-stencil-read' },
    {
      resource: buffers.value.lightData,
      usage: topology.lane.storageBuffer ? 'storage-read' : 'uniform-read',
    },
    {
      resource: buffers.value.clusterGrid,
      usage: topology.lane.storageBuffer ? 'storage-read' : 'uniform-read',
    },
    {
      resource: buffers.value.lightIndexList,
      usage: topology.lane.storageBuffer ? 'storage-read' : 'uniform-read',
    },
    { resource: buffers.value.clusterUniform, usage: 'uniform-read' },
    ...(ssao === undefined
      ? []
      : ([{ resource: ssao.view, usage: 'sampled-read' }] satisfies GraphAccess[])),
    { resource: scene.value.view, usage: 'color-attachment' },
  ];
  const lighting = graph.addRasterPass('lighting', {
    accesses: lightingAccesses,
    colorAttachments: [
      {
        view: scene.value.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: typedFrameClearColor,
      },
    ],
    encode: () => undefined,
  });
  if (!lighting.ok) return lighting;

  const skybox = addTypedSkyboxPass(graph, scene.value);
  if (!skybox.ok) return skybox;

  const forward = addTypedScenePass(graph, {
    name: 'forward',
    color: scene.value,
    depth: depth.value,
    selector: { LightMode: ['Forward'] },
    colorLoadOp: 'load',
    depthLoadOp: 'clear',
    sampled: [
      gbuffer0.value,
      gbuffer1.value,
      gbuffer2.value,
      shadows.value.directional,
      shadows.value.spot,
      ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
      ...(ssao === undefined ? [] : [ssao]),
    ],
    directionalShadow: shadows.value.directional,
    spotShadow: shadows.value.spot,
    ...(ssao === undefined ? {} : { ssao }),
    passKind: 'forward',
    extraAccesses: [
      {
        resource: buffers.value.lightData,
        usage: topology.lane.storageBuffer ? 'storage-read' : 'uniform-read',
      },
      {
        resource: buffers.value.clusterGrid,
        usage: topology.lane.storageBuffer ? 'storage-read' : 'uniform-read',
      },
      {
        resource: buffers.value.lightIndexList,
        usage: topology.lane.storageBuffer ? 'storage-read' : 'uniform-read',
      },
      { resource: buffers.value.clusterUniform, usage: 'uniform-read' },
    ],
  });
  if (!forward.ok) return forward;

  const features = context.contributeFeatures([
    {
      kind: 'scene-color',
      texture: scene.value.texture,
      view: scene.value.view,
      format: scene.value.format,
      sampleCount: 1,
    },
    {
      kind: 'scene-depth',
      texture: depth.value.texture,
      view: depth.value.view,
      format: depth.value.format,
      sampleCount: 1,
    },
  ]);
  if (!features.ok) return features;
  const observation = addTypedFrameObservationPass(graph, scene.value, 'forgeax::standard');
  if (!observation.ok) return observation;

  const hdr = topology.camera.tonemap !== 'none';
  const fxaa = topology.camera.antialias === 'fxaa';
  let postInput = scene.value;
  if (hdr) {
    const composited = target(graph, 'bloom-composited', {
      format: 'rgba16float',
      size: 'surface',
    });
    if (!composited.ok) return composited;
    const bright = target(graph, 'bloom-bright', {
      format: 'rgba16float',
      size: 'half-surface',
    });
    if (!bright.ok) return bright;
    const blurH = target(graph, 'bloom-blur-h', {
      format: 'rgba16float',
      size: 'half-surface',
    });
    if (!blurH.ok) return blurH;
    const blurV = target(graph, 'bloom-blur-v', {
      format: 'rgba16float',
      size: 'half-surface',
    });
    if (!blurV.ok) return blurV;
    const bloom = addTypedBloomPasses(graph, {
      scene: scene.value,
      composited: composited.value,
      bright: bright.value,
      blurH: blurH.value,
      blurV: blurV.value,
    });
    if (!bloom.ok) return bloom;
    postInput = topology.camera.bloom === 'on' ? composited.value : scene.value;
  }

  if (hdr && fxaa) {
    const ldr = target(graph, 'ldr-color', {
      format: topology.surface.storageFormat,
      size: 'surface',
      ...(topology.surface.storageFormat === topology.surface.viewFormat
        ? {}
        : { viewFormats: [topology.surface.viewFormat] }),
    });
    if (!ldr.ok) return ldr;
    const tonemap = addTypedTonemapPass(graph, postInput, ldr.value);
    if (!tonemap.ok) return tonemap;
    const aa = addTypedFullscreenPass(graph, {
      name: 'fxaa',
      shader: 'fxaa',
      input: ldr.value,
      output: surface.value.storage,
    });
    if (!aa.ok) return aa;
  } else if (hdr) {
    const tonemap = addTypedTonemapPass(graph, postInput, surface.value.display);
    if (!tonemap.ok) return tonemap;
  } else if (fxaa) {
    const aa = addTypedFullscreenPass(graph, {
      name: 'fxaa',
      shader: 'fxaa',
      input: scene.value,
      output: surface.value.storage,
    });
    if (!aa.ok) return aa;
  } else {
    const output = addTypedTonemapPass(graph, scene.value, surface.value.storage, true);
    if (!output.ok) return output;
  }

  const postEffects = topology.config?.postEffects ?? [];
  if (topology.lane.storageBuffer && postEffects.length > 0) {
    const effects = addTypedCompositePostEffects(
      graph,
      postEffects,
      surface.value.display,
      surface.value.storage,
      depth.value,
      topology.surface,
    );
    if (!effects.ok) return effects;
  }
  const debug = addTypedDebugOverlayPass(graph, surface.value.display);
  if (!debug.ok) return debug;
  return ok(undefined);
}
const buildStandardClusteredLane = buildHdrp;

export interface StandardPipeline extends RenderPipeline {
  readonly identity: typeof STANDARD_PIPELINE_ID;
}

function profileFor(topology: RenderPipelineTopology): StandardProfile {
  return topology.standardProfile ?? DEFAULT_STANDARD_PROFILE;
}

function standardTopology(
  topology: RenderPipelineTopology,
  profile: StandardProfile,
): RenderPipelineTopology {
  const config = {
    ...(topology.config ?? {}),
    ssao: { enabled: profile.ssao },
  };
  return {
    ...topology,
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: profile,
    config,
  };
}

/**
 * The sole built-in pipeline entry point. Direct and clustered lighting are
 * execution lanes selected from the same profile and graph owner; callers do
 * not install a second topology or submit authority.
 */
function buildStandard(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): ReturnType<RenderPipeline['build']> {
  const profile = profileFor(topology);
  const lane = resolveStandardLane(profile, {
    compute: topology.lane.compute,
    storageBuffer: topology.lane.storageBuffer,
  });
  const effective = standardTopology(topology, profile);
  if (lane === 'clustered') return buildStandardClusteredLane(context, effective);
  return buildStandardForwardLane(context, effective);
}

export const standardPipeline: StandardPipeline = Object.freeze({
  identity: STANDARD_PIPELINE_ID,
  build: buildStandard,
});

export { DEFAULT_STANDARD_PROFILE, STANDARD_PIPELINE_ID } from './standard-profile';
