import {
  type GraphAccess,
  type GraphTextureDescriptor,
  type GraphTextureView,
  type RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import { CLOUD_LAYER_FEATURE_IDENTITY } from '../cloud/feature';
import { ProjectedDecalInvalidError } from '../decals/component';
import { addProjectedDecalPasses } from '../decals/graph';
import { addDepthPyramidPasses } from '../depth-pyramid/graph';
import { addAtmosphereBackground } from '../environment/background';
import { SceneDataUnavailableError, StandardProfileInvalidError } from '../errors/render';
import type { FramePlan } from '../extract/environment';
import { BARREL_DISTORTION_FEATURE_IDENTITY } from '../features/barrel-distortion';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { DEFERRED_COLOR_FORMATS } from '../pipeline-spec';
import type {
  RenderPipeline,
  RenderPipelineBuildContext,
  RenderPipelineFrame,
  RenderPipelineSurfaceMediumPair,
  RenderPipelineTopology,
} from '../render-pipeline';
import {
  createRenderPipelineTarget,
  importRenderPipelineSurface,
  type RenderPipelineTarget,
  renderPipelineCloudHistoryTargets,
} from '../render-pipeline';
import { addSsrCompositionPass } from '../ssr/compose';
import { addSsrSpatialPasses } from '../ssr/graph';
import {
  addStandardSceneDataPass,
  aggregateTemporalDemand,
  createStandardSceneDataTarget,
  standardTemporalLaneAdmission,
} from '../temporal/standard-scene-data';
import { addTargetCoveragePass } from '../temporal/target-coverage-attachment';
import {
  addTransmissionBackdropPasses,
  addTransmissionBackdropTemporalPass,
  resolveTransmissionBackdropTopology,
  transmissionDemandForTopology,
} from '../transmission/backdrop';
import {
  addObservationCapturePass,
  addReflectionFallbackObservationPass,
  addTypedFrameObservationPass,
  addTypedScenePass,
  addTypedSkyboxPass,
  addTypedSsaoPasses,
} from '../typed-render-graph-primitives';
import { addTypedShadowPasses } from '../typed-shadow-passes';
import { addOpaqueFogPasses } from './analytic-fog-pass';
import { addGpuLateOcclusion, sceneViewImport } from './gpu-occlusion';
import { renderExtentSize } from './render-extent';
import {
  addSingleLayerMediumPasses,
  addSingleLayerMediumRawDepthProducer,
} from './single-layer-medium-passes';
import type { StandardPipelineBuildContext } from './standard-build-context';
import { addStandardDeferredLighting } from './standard-deferred-lighting';
import { buildStandardForwardLane } from './standard-forward-lane';
import {
  addStandardClusterMembershipPass,
  importStandardClusterBuffers,
  standardClusterReadAccesses,
} from './standard-lighting/graph';
import {
  deriveStandardTopologyInput,
  type StandardTopologyInputValue,
} from './standard-lighting/topology';
import { addStandardPost } from './standard-post';
import {
  DEFAULT_STANDARD_PROFILE,
  STANDARD_LIGHT_COUNTS,
  STANDARD_PIPELINE_ID,
  type StandardProfile,
} from './standard-profile';
import { addStandardTransparentPasses } from './standard-transparency';

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
export function validateClusterGrid(grid: {
  x: number;
  y: number;
  z: number;
}): Result<{ x: number; y: number; z: number }, StandardProfileInvalidError> {
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
    : err(
        new StandardProfileInvalidError(
          `clusterGrid {x:${x}, y:${y}, z:${z}} is invalid; set x, y, and z to positive integers in [1, 64]`,
          { field: 'clusterGrid', actual: { x, y, z } },
        ),
      );
}

function target(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(graph, label, descriptor);
}

function buildStandardDeferredLane(
  context: StandardPipelineBuildContext,
  topology: RenderPipelineTopology,
  lighting: StandardTopologyInputValue,
): ReturnType<RenderPipeline['build']> {
  const visibleSurfaceEnabled = topology.standardProfile?.visibleSurface === true;
  if (
    visibleSurfaceEnabled &&
    (topology.lane.primitiveIndex !== true ||
      topology.lane.maxColorAttachments < 6 ||
      (topology.lane.maxColorAttachmentBytesPerSample ?? 0) < 48 ||
      topology.camera.antialias === 'msaa')
  ) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected:
          'visible surfaces require primitive-index, six targets, 48 aligned attachment bytes and single sampling',
        hint: 'request these device features/limits before enabling visibleSurface',
        detail: {
          resourceLabel: 'visible-surface',
          field: 'capabilities',
          expected: 'primitive-index / 6 targets / 48 bytes / single sample',
          actual: JSON.stringify(topology.lane),
        },
      }),
    );
  }
  if (
    !topology.lane.storageBuffer ||
    topology.lane.maxColorAttachments < DEFERRED_COLOR_FORMATS.length
  ) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'Standard deferred requires storage buffers and five color attachments',
        hint: 'select a device with deferred capabilities or explicitly select the Forward profile',
        detail: {
          resourceLabel: 'forgeax::standard',
          field: 'renderPath',
          expected: 'storage buffers and five MRTs',
          actual: `storageBuffer=${topology.lane.storageBuffer}, maxColorAttachments=${topology.lane.maxColorAttachments}`,
        },
      }),
    );
  }
  const graph = context.graph;
  const surface = importRenderPipelineSurface(graph, topology);
  if (!surface.ok) return surface;
  const internalSize =
    topology.extent === undefined ? 'surface' : renderExtentSize(topology.extent, 'internal');
  const internalCopySize =
    topology.extent === undefined
      ? { width: topology.surface.width, height: topology.surface.height }
      : renderExtentSize(topology.extent, 'internal');
  const buffers = importStandardClusterBuffers(graph, lighting);
  if (!buffers.ok) return buffers;
  const membership =
    buffers.value === null
      ? ok(undefined)
      : addStandardClusterMembershipPass(graph, lighting, buffers.value);
  if (!membership.ok) return membership;
  const featureShadows = context.contributeShadowFeatures?.();
  if (featureShadows !== undefined && !featureShadows.ok) return featureShadows;
  const shadows = addTypedShadowPasses(
    graph,
    topology,
    context.projectGpuDrivenShadow,
    featureShadows?.value,
  );
  if (!shadows.ok) return shadows;

  const depth = target(graph, 'hdrp-depth', {
    format: 'depth32float-stencil8',
    size: internalSize,
  });
  if (!depth.ok) return depth;
  const depthSample = graph.view(depth.value.texture, {
    label: 'ssr-scene-depth',
    dimension: '2d',
    aspect: 'depth-only',
  });
  if (!depthSample.ok) return depthSample;
  const normalRoughness = target(graph, 'gbuffer-normal-roughness', {
    format: DEFERRED_COLOR_FORMATS[1],
    size: internalSize,
  });
  if (!normalRoughness.ok) return normalRoughness;
  const albedoMetallic = target(graph, 'gbuffer-albedo-metallic', {
    format: DEFERRED_COLOR_FORMATS[3],
    size: internalSize,
  });
  if (!albedoMetallic.ok) return albedoMetallic;
  const f0Occlusion = target(graph, 'gbuffer-f0-occlusion', {
    format: DEFERRED_COLOR_FORMATS[2],
    size: internalSize,
  });
  if (!f0Occlusion.ok) return f0Occlusion;
  const lightingContext = target(graph, 'gbuffer-lighting-context', {
    format: DEFERRED_COLOR_FORMATS[4],
    size: internalSize,
  });
  if (!lightingContext.ok) return lightingContext;
  const visibleSurface = visibleSurfaceEnabled
    ? target(graph, 'visible-surface', { format: 'rgba32uint', size: internalSize })
    : ok(undefined);
  if (!visibleSurface.ok) return visibleSurface;
  const scene = target(graph, 'hdrp-scene-color', {
    format: DEFERRED_COLOR_FORMATS[0],
    size: internalSize,
  });
  if (!scene.ok) return scene;
  const mediumTargets =
    topology.singleLayerMedium === true
      ? (() => {
          const nearestLayer = target(graph, 'single-layer-medium-nearest-layer', {
            format: scene.value.format,
            size: internalSize,
            // The color pass samples this target with a `texture_2d`; keep
            // it single-sample even when a future deferred path is MSAA.
            sampleCount: 1,
            domain: 'linear-ldr',
          });
          if (!nearestLayer.ok) return nearestLayer;
          const nearestDepth = target(graph, 'single-layer-medium-nearest-depth', {
            format: 'depth32float-stencil8',
            size: internalSize,
            sampleCount: 1,
          });
          if (!nearestDepth.ok) return nearestDepth;
          return ok({ nearestLayer: nearestLayer.value, nearestDepth: nearestDepth.value });
        })()
      : ok(undefined);
  if (!mediumTargets.ok) return mediumTargets;
  const reflectionFallback =
    topology.reflectionFallback?.enabled === true || topology.ssr?.status === 'admitted'
      ? target(graph, 'reflection-fallback-linear-hdr', {
          format: 'rgba16float',
          size: internalSize,
          domain: 'linear-hdr',
        })
      : ok(undefined);
  if (!reflectionFallback.ok) return reflectionFallback;
  const specularResponse =
    reflectionFallback.value === undefined
      ? ok(undefined)
      : target(graph, 'deferred-specular-response-ao', {
          format: 'rgba16float',
          size: internalSize,
        });
  if (!specularResponse.ok) return specularResponse;
  const temporalDemand = aggregateTemporalDemand({
    taa: topology.camera.antialias === 'taa',
    motionBlur: topology.temporal?.motionBlur === true,
    ssr: topology.ssr?.status === 'admitted',
    visibleSurface: visibleSurfaceEnabled,
  });
  const temporalLane = topology.lane.compute ? 'clustered' : 'cpu-webgl2';
  const temporalAdmission = standardTemporalLaneAdmission({
    lane: temporalLane,
    demand: temporalDemand,
    capabilities: {
      compute: topology.lane.compute,
      storageBuffer: topology.lane.storageBuffer,
      rgba16floatRenderable: context.capabilities?.rgba16floatRenderable ?? false,
    },
  });
  if (temporalAdmission.status === 'unavailable' && temporalAdmission.reason !== 'no-demand') {
    return err(
      new SceneDataUnavailableError({
        featureIdentity: 'forgeax::standard',
        schema: 'forgeax::scene-data::temporal-v1',
        lane: temporalLane,
        reason: temporalAdmission.reason,
        missingContributorIds: [],
        omittedMissingContributorCount: 0,
        recovery: 'enable-capability',
      }),
    );
  }
  const gpuDriven = context.projectGpuDriven({
    format: scene.value.format,
    sampleCount: scene.value.sampleCount,
    lateOcclusion: topology.config?.gpuOcclusion !== false,
    ...(reflectionFallback.value === undefined
      ? {}
      : {
          additionalColorFormats: [reflectionFallback.value.format],
        }),
  });
  if (!gpuDriven.ok) return gpuDriven;
  // Background must precede geometry now that geometry initializes SceneColor.
  const atmosphere =
    topology.atmosphere === true ? addAtmosphereBackground(graph, scene.value) : ok(undefined);
  if (!atmosphere.ok) return atmosphere;
  if (atmosphere.value === undefined) {
    const skybox = addTypedSkyboxPass(graph, scene.value);
    if (!skybox.ok) return skybox;
  }

  const gbuffer = addTypedScenePass(graph, {
    name: 'g-buffer',
    color: scene.value,
    colorTargets: [
      scene.value,
      normalRoughness.value,
      f0Occlusion.value,
      albedoMetallic.value,
      lightingContext.value,
      ...(visibleSurface.value === undefined ? [] : [visibleSurface.value]),
    ],
    colorLoadOp: [
      'load',
      'clear',
      'clear',
      'clear',
      'clear',
      ...(visibleSurfaceEnabled ? ['clear' as const] : []),
    ],
    ...(gpuDriven.value === undefined
      ? {}
      : { gpuDriven: gpuDriven.value, gpuDrivenFilter: 'deferred-opaque' as const }),
    depth: depth.value,
    selector: { LightMode: ['Deferred'] },
    // The G-buffer only admits opaque Standard materials. Medium Surface
    // programs have no Deferred entry and acquire raw depth in their later
    // paired color pass; filtering here also avoids assembling their bind
    // groups before that producer exists.
    recordMode: 'opaque',
    passKind: 'deferred',
    clearColor: [0, 0, 0, 0],
  });
  if (!gbuffer.ok) return gbuffer;
  const importSceneView = sceneViewImport(graph);
  const late = addGpuLateOcclusion(graph, {
    gpuDriven: gpuDriven.value,
    depth: depthSample.value,
    width: internalCopySize.width,
    height: internalCopySize.height,
    view: importSceneView,
  });
  if (!late.ok) return late;
  if (late.value && gpuDriven.value !== undefined) {
    const gbufferLate = addTypedScenePass(graph, {
      name: 'g-buffer-late',
      color: scene.value,
      colorTargets: [
        scene.value,
        normalRoughness.value,
        f0Occlusion.value,
        albedoMetallic.value,
        lightingContext.value,
        ...(visibleSurface.value === undefined ? [] : [visibleSurface.value]),
      ],
      colorLoadOp: [
        'load',
        'load',
        'load',
        'load',
        'load',
        ...(visibleSurfaceEnabled ? ['load' as const] : []),
      ],
      depthLoadOp: 'load',
      gpuDriven: gpuDriven.value,
      gpuDrivenFilter: 'deferred-opaque',
      gpuDrivenPhase: 'late',
      depth: depth.value,
      selector: { LightMode: ['Deferred'] },
      recordMode: 'opaque',
      passKind: 'deferred',
    });
    if (!gbufferLate.ok) return gbufferLate;
  }
  if (visibleSurface.value !== undefined) {
    const capture = addObservationCapturePass(graph, visibleSurface.value, 'visible-surface');
    if (!capture.ok) return capture;
  }
  const decals = addProjectedDecalPasses(graph, topology.projectedDecals ?? [], {
    depth: depthSample.value,
    normal: normalRoughness.value,
    albedo: albedoMetallic.value,
    f0: f0Occlusion.value,
    size: internalSize,
  });
  if (!decals.ok) return decals;

  let ssao: RenderPipelineTarget | undefined;
  if (topology.config?.ssao?.enabled === true) {
    const raw = target(graph, 'ssao-raw', { format: 'r8unorm', size: 'half-surface' });
    if (!raw.ok) return raw;
    const blurred = target(graph, 'ssao-blurred', { format: 'r8unorm', size: 'half-surface' });
    if (!blurred.ok) return blurred;
    const passes = addTypedSsaoPasses(graph, {
      normal: decals.value.normal,
      depth: depth.value,
      raw: raw.value,
      blurred: blurred.value,
    });
    if (!passes.ok) return passes;
    ssao = blurred.value;
  }

  const featureRasterWork =
    context.hasFeatureRasterWork?.(CLOUD_LAYER_FEATURE_IDENTITY, 'scene') === true;
  const cloudScene = featureRasterWork
    ? target(graph, 'cloud-layer-scene-color', {
        format: scene.value.format,
        size: internalSize,
        sampleCount: 1,
        domain: 'linear-hdr',
        usage:
          GPU_TEXTURE_USAGE_COPY_SRC |
          GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
          GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      })
    : ok(undefined);
  if (!cloudScene.ok) return cloudScene;
  const cloudShadow =
    featureRasterWork && context.cloudShadowResolution !== undefined
      ? target(graph, 'cloud-layer-shadow', {
          format: 'rgba16float',
          size: {
            width: context.cloudShadowResolution,
            height: context.cloudShadowResolution,
            depthOrArrayLayers: 1,
          },
          sampleCount: 1,
          domain: 'linear-hdr',
          usage:
            GPU_TEXTURE_USAGE_COPY_SRC |
            GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
            GPU_TEXTURE_USAGE_TEXTURE_BINDING,
        })
      : ok(undefined);
  if (!cloudShadow.ok) return cloudShadow;
  const targetCaptures = context.contributeCubeCaptures?.(atmosphere.value);
  if (targetCaptures !== undefined && !targetCaptures.ok) return targetCaptures;
  const featureTargets = [
    {
      name: 'linear-hdr',
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
    ...(cloudShadow.value === undefined
      ? []
      : [
          {
            name: 'cloud-shadow',
            kind: 'scene-color' as const,
            texture: cloudShadow.value.texture,
            view: cloudShadow.value.view,
            format: cloudShadow.value.format,
            sampleCount: 1 as const,
          },
        ]),
    ...(context.cloudHistory === undefined
      ? []
      : renderPipelineCloudHistoryTargets(context.cloudHistory)),
  ] as const;
  // Cloud density and its spatial shadow must be produced before the opaque
  // receiver pass. The composite is projected separately below, after the
  // receiver has populated the scene target; declaration order is execution
  // order for the typed graph.
  const shadowFeatures = context.contributeFeatures(
    featureTargets,
    [],
    cloudShadow.value === undefined ? {} : { 'cloud-shadow': cloudShadow.value },
    [],
    'scene',
    ['cloud-layer-density-cache', 'cloud-layer-shadow'],
  );
  if (!shadowFeatures.ok) return shadowFeatures;

  const lightingPass = addStandardDeferredLighting(graph, {
    color: scene.value,
    gbuffer: [decals.value.normal, decals.value.albedo, decals.value.f0, lightingContext.value],
    depth: depthSample.value,
    ...(reflectionFallback.value === undefined
      ? {}
      : { reflectionFallback: reflectionFallback.value }),
    ...(specularResponse.value === undefined ? {} : { response: specularResponse.value }),
    ...(ssao === undefined ? {} : { ssao }),
    ...(atmosphere.value === undefined ? {} : { environment: atmosphere.value }),
    ...(shadows.value.directional === undefined
      ? {}
      : { directionalShadow: shadows.value.directional }),
    spotShadow: shadows.value.spot,
    ...(cloudShadow.value === undefined ? {} : { cloudShadow: cloudShadow.value }),
    ...(shadows.value.point === undefined ? {} : { pointShadow: shadows.value.point }),
    cluster: buffers.value,
    extraAccesses: buffers.value === null ? [] : standardClusterReadAccesses(buffers.value),
    size: internalCopySize,
  });
  if (!lightingPass.ok) return lightingPass;

  // SSR consumes the same Standard temporal-v1 producer as TAA and motion
  // blur. Insert it before the spatial chain so the graph dependency order is
  // explicit and one producer serves every temporal consumer.
  const temporal =
    temporalDemand.targetCount === 1
      ? createStandardSceneDataTarget(graph, topology.extent)
      : ok(undefined);
  if (!temporal.ok) return temporal;
  if (temporal.value !== undefined) {
    const producer = addStandardSceneDataPass(
      graph,
      temporal.value.temporal,
      depth.value,
      gpuDriven.value,
    );
    if (!producer.ok) return producer;
  }
  if (
    context.contributeDiffuseGi !== undefined &&
    visibleSurface.value !== undefined &&
    temporal.value !== undefined
  ) {
    const diffuse = context.contributeDiffuseGi({
      scene: scene.value,
      depth: depthSample.value,
      normal: decals.value.normal,
      albedo: decals.value.albedo,
      f0: decals.value.f0,
      identity: visibleSurface.value,
      motion: temporal.value.temporal,
    });
    if (!diffuse.ok) return diffuse;
  }

  if (context.targetCoverage !== undefined) {
    const coverage = addTargetCoveragePass(graph, context.targetCoverage, gpuDriven.value);
    if (!coverage.ok) return coverage;
  }

  let sceneOutput: RenderPipelineTarget = scene.value;
  let secondaryReactivity: GraphTextureView | undefined;
  if (topology.ssr !== undefined) {
    const ssrView = topology.ssr.status === 'admitted' ? importSceneView() : ok(undefined);
    if (!ssrView.ok) return ssrView;
    // SSR is the pyramid's only consumer today, so its admission alone decides
    // whether the view builds one.
    const depthPyramid =
      topology.ssr.status === 'admitted'
        ? addDepthPyramidPasses(graph, {
            depth: depthSample.value,
            width: topology.surface.width,
            height: topology.surface.height,
            ...(ssrView.value === undefined ? {} : { view: ssrView.value }),
          })
        : ok(undefined);
    if (!depthPyramid.ok) return depthPyramid;
    const spatial = addSsrSpatialPasses(graph, {
      admission: topology.ssr,
      width: topology.surface.width,
      height: topology.surface.height,
      depth: depthSample.value,
      normal: decals.value.normal.view,
      scene: scene.value.view,
      ...(temporal.value === undefined ? {} : { currentTemporal: temporal.value.temporal.view }),
      ...(reflectionFallback.value === undefined
        ? {}
        : { fallback: reflectionFallback.value.view }),
      ...(temporal.value === undefined || context.ssrHistory === undefined
        ? {}
        : {
            temporal: {
              previousHistory: context.ssrHistory.previous.view,
              outputHistory: context.ssrHistory.output.view,
              previousSurface: context.ssrHistory.previousSurface.view,
              outputSurface: context.ssrHistory.outputSurface.view,
              params: context.ssrHistory.params,
            },
          }),
      ...(ssrView.value === undefined ? {} : { view: ssrView.value }),
      ...(depthPyramid.value === undefined ? {} : { depthPyramid: depthPyramid.value.pyramid }),
    });
    if (!spatial.ok) return spatial;
    if (
      spatial.value.resources !== undefined &&
      reflectionFallback.value !== undefined &&
      ssrView.value !== undefined &&
      specularResponse.value !== undefined
    ) {
      secondaryReactivity = spatial.value.resources.hitReactivity;
      const radiance =
        spatial.value.resources.radiancePyramid ?? spatial.value.resources.trace.view;
      const composed = addSsrCompositionPass(graph, {
        scene: scene.value,
        radiance,
        fallback: reflectionFallback.value.view,
        response: specularResponse.value.view,
        normal: decals.value.normal.view,
        view: ssrView.value,
      });
      if (!composed.ok) return composed;
    }
  }

  const transmissionDemand = transmissionDemandForTopology(topology);
  const backdropDemand = {
    activeCount: transmissionDemand.activeCount + (topology.singleLayerMedium === true ? 1 : 0),
    needsRoughMips: transmissionDemand.needsRoughMips,
  };
  const transmissionActive = resolveTransmissionBackdropTopology({
    demand: transmissionDemand,
    sourceSampleCount: scene.value.sampleCount,
  }).active;
  const backdropActive = resolveTransmissionBackdropTopology({
    demand: backdropDemand,
    sourceSampleCount: scene.value.sampleCount,
  }).active;
  const forwardExtraAccesses: GraphAccess[] =
    buffers.value === null ? [] : [...standardClusterReadAccesses(buffers.value)];

  const forward = addTypedScenePass(graph, {
    environment: atmosphere.value,
    name: 'forward',
    color: sceneOutput,
    depth: depth.value,
    selector: { LightMode: ['Forward'] },
    colorLoadOp: 'load',
    depthLoadOp: 'load',
    sampled: [
      ...(shadows.value.directional === undefined ? [] : [shadows.value.directional]),
      shadows.value.spot,
      ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
      ...(cloudShadow.value === undefined ? [] : [cloudShadow.value]),
      ...(ssao === undefined ? [] : [ssao]),
    ],
    ...(shadows.value.directional === undefined
      ? {}
      : { directionalShadow: shadows.value.directional }),
    spotShadow: shadows.value.spot,
    cloudShadow: cloudShadow.value,
    ...(ssao === undefined ? {} : { ssao }),
    ...(gpuDriven.value === undefined ? {} : { gpuDriven: gpuDriven.value }),
    passKind: 'forward',
    excludeSelector: { LightMode: ['Deferred'] },
    // Keep the deferred opaque lane separate from Surface medium passes.
    recordMode: 'opaque' as const,
    ...(gpuDriven.value === undefined ? {} : { gpuDrivenFilter: 'forward-only-opaque' as const }),
    ...(context.occlusion === undefined ? {} : { occlusion: context.occlusion }),
    extraAccesses: forwardExtraAccesses,
  });
  if (!forward.ok) return forward;

  if (cloudScene.value !== undefined) {
    const compositeFeatures = context.contributeFeatures(
      featureTargets,
      [],
      {
        'motion-input': scene.value,
        'motion-output': cloudScene.value,
        ...(cloudShadow.value === undefined ? {} : { 'cloud-shadow': cloudShadow.value }),
        ...(context.cloudHistory === undefined
          ? {}
          : {
              'cloud-history-radiance-current': context.cloudHistory.currentRadiance,
              'cloud-history-radiance-previous': context.cloudHistory.previousRadiance,
              'cloud-history-transmittance-current': context.cloudHistory.currentTransmittance,
              'cloud-history-transmittance-previous': context.cloudHistory.previousTransmittance,
              'cloud-history-depth-current': context.cloudHistory.currentDepth,
              'cloud-history-depth-previous': context.cloudHistory.previousDepth,
            }),
      },
      forwardExtraAccesses,
      'scene',
      // One half-resolution transport MRT produces radiance, transmittance and
      // representative depth; the full-resolution resolve consumes that same
      // frame and advances the ping-pong history on submit.
      ['cloud-layer-transport', 'cloud-layer-resolve'],
    );
    if (!compositeFeatures.ok) return compositeFeatures;
  }

  if (cloudScene.value !== undefined) sceneOutput = cloudScene.value;

  // Opaque analytic fog and the froxel volume composite onto the opaque scene
  // before transmission copies and translucent draws. Every translucent writer
  // then fogs itself at its own depth, so blending composes depth-correctly.
  const fogged = addOpaqueFogPasses(graph, {
    topology,
    color: sceneOutput,
    depth: depth.value,
    directionalShadow: shadows.value.directional?.view,
    spotShadow: shadows.value.spot.view,
    clusterBuffers: buffers.value,
    cloudShadow: cloudShadow.value?.view,
  });
  if (!fogged.ok) return fogged;

  const transmission = addTransmissionBackdropPasses({
    graph,
    source: sceneOutput,
    demand: backdropDemand,
    copySize: internalCopySize,
    encodeRoughMip: context.encodeTransmissionMip,
    includeConsumerPasses: false,
  });
  if (!transmission.ok) return transmission;
  if (topology.singleLayerMedium === true) {
    const nearestTargets = mediumTargets.value;
    const backdrop = transmission.value.backdrop?.view;
    if (nearestTargets === undefined || backdrop === undefined) {
      return err(
        new RenderGraphError({
          code: 'resource-descriptor-invalid',
          expected: 'single-layer medium graph has nearest targets and an opaque backdrop',
          hint: 'keep the shared transmission backdrop copy ahead of the Surface passes',
          detail: {
            resourceLabel: 'single-layer-medium',
            field: 'backdrop',
            expected: 'resolved graph texture view',
            actual: 'missing',
          },
        }),
      );
    }
    const rawDepth = addSingleLayerMediumRawDepthProducer({
      graph,
      sourceColor: sceneOutput,
      sourceDepth: depth.value,
      size: internalSize,
    });
    if (!rawDepth.ok) return rawDepth;
    // Standard owns this producer fact. Deferred depth is single-sample, so
    // the independent r32float copy is available to both medium passes.
    const surfacePair: RenderPipelineSurfaceMediumPair = {
      opaqueColor: backdrop,
      rawDepth: { status: 'available', view: rawDepth.value.view },
    };
    const mediumPasses = addSingleLayerMediumPasses({
      graph,
      size: internalSize,
      ...nearestTargets,
      color: sceneOutput,
      depth: depth.value,
      sampled: [
        ...(shadows.value.directional === undefined ? [] : [shadows.value.directional]),
        shadows.value.spot,
        ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
        ...(cloudShadow.value === undefined ? [] : [cloudShadow.value]),
        ...(ssao === undefined ? [] : [ssao]),
      ],
      directionalShadow: shadows.value.directional,
      spotShadow: shadows.value.spot,
      cloudShadow: cloudShadow.value,
      ssao,
      extraAccesses: [
        ...forwardExtraAccesses,
        ...(targetCaptures?.value === undefined
          ? []
          : [{ resource: targetCaptures.value, usage: 'sampled-read' as const }]),
      ],
      surfacePair,
      ...(gpuDriven.value === undefined ? {} : { gpuDriven: gpuDriven.value }),
    });
    if (!mediumPasses.ok) return mediumPasses;
  }
  if (backdropActive) {
    if (transmissionActive) {
      const transmissionPass = addTypedScenePass(graph, {
        environment: atmosphere.value,
        name: 'transmission-forward',
        color: sceneOutput,
        depth: depth.value,
        selector: { LightMode: ['Forward'] },
        colorLoadOp: 'load',
        depthLoadOp: 'load',
        sampled: [
          ...(shadows.value.directional === undefined ? [] : [shadows.value.directional]),
          shadows.value.spot,
          ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
          ...(ssao === undefined ? [] : [ssao]),
        ],
        directionalShadow: shadows.value.directional,
        spotShadow: shadows.value.spot,
        ...(ssao === undefined ? {} : { ssao }),
        passKind: 'forward',
        recordMode: 'transmission',
        // Inject the complete backdrop view so the Standard shader can select
        // the producer's optional roughness mip level. mipViews[0] is only the
        // copy destination view and intentionally exposes one level.
        transmissionBackdrop: transmission.value.backdrop?.view,
        extraAccesses: forwardExtraAccesses,
      });
      if (!transmissionPass.ok) return transmissionPass;
    }
    const transparentPass = addStandardTransparentPasses(graph, {
      color: sceneOutput,
      depth: depth.value,
      size: internalSize,
      transparency: topology.transparency,
      template: {
        environment: atmosphere.value,
        sampled: [
          ...(shadows.value.directional === undefined ? [] : [shadows.value.directional]),
          shadows.value.spot,
          ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
          ...(cloudShadow.value === undefined ? [] : [cloudShadow.value]),
          ...(ssao === undefined ? [] : [ssao]),
        ],
        directionalShadow: shadows.value.directional,
        spotShadow: shadows.value.spot,
        cloudShadow: cloudShadow.value,
        ...(ssao === undefined ? {} : { ssao }),
        passKind: 'forward',
        extraAccesses: forwardExtraAccesses,
      },
    });
    if (!transparentPass.ok) return transparentPass;
  }
  if (backdropActive) {
    const temporal = addTransmissionBackdropTemporalPass(graph, sceneOutput);
    if (!temporal.ok) return temporal;
  }
  if (!transmission.value.topology.active) {
    const transparentPass = addStandardTransparentPasses(graph, {
      color: sceneOutput,
      depth: depth.value,
      size: internalSize,
      transparency: topology.transparency,
      template: {
        environment: atmosphere.value,
        sampled: [
          ...(shadows.value.directional === undefined ? [] : [shadows.value.directional]),
          shadows.value.spot,
          ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
          ...(cloudShadow.value === undefined ? [] : [cloudShadow.value]),
          ...(ssao === undefined ? [] : [ssao]),
        ],
        directionalShadow: shadows.value.directional,
        spotShadow: shadows.value.spot,
        cloudShadow: cloudShadow.value,
        ...(ssao === undefined ? {} : { ssao }),
        passKind: 'forward',
        extraAccesses: forwardExtraAccesses,
      },
    });
    if (!transparentPass.ok) return transparentPass;
  }

  // Generic post features consume the final deferred scene target after cloud
  // and volume producers. Keep the same clustered, shadow, and SSAO reads that
  // the Standard receiver exposes to feature-owned lighting passes.
  const features = context.contributeFeatures(
    [
      {
        name: 'linear-hdr',
        kind: 'scene-color',
        texture: sceneOutput.texture,
        view: sceneOutput.view,
        format: sceneOutput.format,
        sampleCount: sceneOutput.sampleCount,
      },
      {
        kind: 'scene-depth',
        texture: depth.value.texture,
        view: depth.value.view,
        format: depth.value.format,
        sampleCount: depth.value.sampleCount,
      },
    ],
    [],
    {},
    [
      ...forwardExtraAccesses,
      ...[
        shadows.value.directional,
        shadows.value.spot,
        shadows.value.point,
        cloudShadow.value,
      ].flatMap((target) =>
        target === undefined ? [] : [{ resource: target.view, usage: 'sampled-read' as const }],
      ),
      ...(ssao === undefined ? [] : [{ resource: ssao.view, usage: 'sampled-read' as const }]),
    ],
    { exclude: [BARREL_DISTORTION_FEATURE_IDENTITY] },
  );
  if (!features.ok) return features;
  const observation = addTypedFrameObservationPass(graph, sceneOutput, 'forgeax::standard');
  if (!observation.ok) return observation;
  if (reflectionFallback.value?.sampleCount === 1) {
    const fallbackObservation = addReflectionFallbackObservationPass(
      graph,
      reflectionFallback.value,
    );
    if (!fallbackObservation.ok) return fallbackObservation;
  }
  const post = addStandardPost(
    context,
    topology,
    sceneOutput,
    depth.value,
    surface.value,
    temporal.value?.temporal,
    secondaryReactivity,
    context.targetCoverage?.coverage,
    context.targetCoverage?.depth,
  );
  if (!post.ok) return post;
  return ok(undefined);
}
export interface StandardPipeline extends RenderPipeline {
  readonly identity: typeof STANDARD_PIPELINE_ID;
}

export function standardProfileSupportsReflectionProbes(_profile: StandardProfile): boolean {
  return true;
}

/** Standard graph inputs are derived once from the immutable frame plan. */
export type StandardFramePlan = FramePlan;

function profileFor(topology: RenderPipelineTopology): StandardProfile {
  return topology.standardProfile ?? DEFAULT_STANDARD_PROFILE;
}

function resolveStandardTopologyInput(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
): Result<StandardTopologyInputValue, RenderGraphError> {
  const supplied = context.standardLighting;
  if (supplied !== undefined) {
    const derived = deriveStandardTopologyInput(supplied);
    if (derived.ok) return derived;
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'Forward/Deferred consume one prepared Standard topology input',
        hint: derived.error.hint,
        detail: {
          resourceLabel: 'forgeax::standard',
          field: `standardLighting.${derived.error.detail.field}`,
          expected: derived.error.expected,
          actual: 'invalid',
        },
      }),
    );
  }

  return err(
    new RenderGraphError({
      code: 'resource-descriptor-invalid',
      expected: 'RenderPipelineBuildContext.standardLighting from frame preparation',
      hint: 'prepare Standard lighting once, select a proven Cluster transport, and pass it to both lanes',
      detail: {
        resourceLabel: 'forgeax::standard',
        field: 'standardLighting',
        expected: 'prepared Standard lighting topology input',
        actual: 'invalid',
      },
    }),
  );
}

function standardTopology(
  topology: RenderPipelineTopology,
  profile: StandardProfile,
): RenderPipelineTopology {
  const config = {
    ...(topology.config ?? {}),
    ssao: {
      ...(topology.config?.ssao ?? {}),
      ...(typeof profile.ssao === 'object' ? profile.ssao : {}),
      enabled: profile.ssao !== false,
    },
  };
  return {
    ...topology,
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: profile,
    config,
  };
}

/**
 * The sole built-in pipeline entry point. All local lights use the same
 * prepared Cluster topology; the profile chooses only Forward or Deferred
 * graph shape and never a second lighting authority.
 */
function buildStandard(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): ReturnType<RenderPipeline['build']> {
  const standardContext = context as StandardPipelineBuildContext;
  const profile = profileFor(topology);
  if (!STANDARD_LIGHT_COUNTS.some((count) => count === profile.lightCount)) {
    return err(
      new RenderGraphError({
        code: 'resource-descriptor-invalid',
        expected: 'StandardProfile.lightCount is one of 1, 32, or 256',
        hint: 'set StandardProfile.lightCount to 1, 32, or 256',
        detail: {
          resourceLabel: 'forgeax::standard',
          field: 'lightCount',
          expected: '1 | 32 | 256',
          actual: profile.lightCount,
        },
      }),
    );
  }
  if (
    (topology.projectedDecals?.length ?? 0) > 0 &&
    (profile.renderPath !== 'deferred' || topology.camera.antialias === 'msaa')
  )
    throw new ProjectedDecalInvalidError(
      'renderPath',
      'Standard Deferred with single-sample depth',
    );
  const effective = standardTopology(topology, profile);
  const lighting = resolveStandardTopologyInput(context);
  if (!lighting.ok) return lighting;
  // A missing Camera is an intentional clear-only frame. Keep it on the
  // forward raster lane so clustered resources cannot introduce work.
  if (effective.clearOnly === true) {
    return buildStandardForwardLane(standardContext, effective, lighting.value);
  }
  return profile.renderPath === 'forward'
    ? buildStandardForwardLane(standardContext, effective, lighting.value)
    : buildStandardDeferredLane(standardContext, effective, lighting.value);
}

export const standardPipeline: StandardPipeline = Object.freeze({
  identity: STANDARD_PIPELINE_ID,
  build: buildStandard,
});

export { DEFAULT_STANDARD_PROFILE, STANDARD_PIPELINE_ID } from './standard-profile';
