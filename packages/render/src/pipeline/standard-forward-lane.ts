import type {
  GraphTextureDescriptor,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { addTypedDebugOverlayPass } from '../debug-draw-glue';
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
  addTypedTonemapPass,
} from '../typed-render-graph-primitives';
import { addTypedShadowPasses } from '../typed-shadow-passes';

function target(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(graph, label, descriptor);
}

function buildUrp(
  context: RenderPipelineBuildContext<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): ReturnType<RenderPipeline['build']> {
  const graph = context.graph;
  const surface = importRenderPipelineSurface(graph, topology);
  if (!surface.ok) return surface;

  const msaa = topology.camera.antialias === 'msaa' && topology.lane.multisample;
  const hdr = topology.camera.tonemap !== 'none';
  const fxaa = topology.camera.antialias === 'fxaa';
  const linearLdr = !hdr && topology.lane.storageBuffer;
  const sceneFormat = hdr || linearLdr ? 'rgba16float' : topology.surface.storageFormat;

  const depth = target(graph, 'scene-depth', {
    format: 'depth24plus-stencil8',
    size: 'surface',
    sampleCount: msaa ? 4 : 1,
  });
  if (!depth.ok) return depth;

  const sceneResolved =
    hdr || fxaa || linearLdr || msaa
      ? target(graph, 'scene-color', {
          format: sceneFormat,
          size: 'surface',
          sampleCount: 1,
          ...(sceneFormat === topology.surface.storageFormat &&
          topology.surface.storageFormat !== topology.surface.viewFormat
            ? { viewFormats: [topology.surface.viewFormat] }
            : {}),
        })
      : ok(surface.value.display);
  if (!sceneResolved.ok) return sceneResolved;
  const scene = msaa
    ? target(graph, 'scene-color-msaa', {
        format: sceneFormat,
        size: 'surface',
        sampleCount: 4,
        ...(sceneFormat === topology.surface.storageFormat &&
        topology.surface.storageFormat !== topology.surface.viewFormat
          ? { viewFormats: [topology.surface.viewFormat] }
          : {}),
      })
    : sceneResolved;
  if (!scene.ok) return scene;

  const shadows = addTypedShadowPasses(graph, topology);
  if (!shadows.ok) return shadows;

  const skybox = addTypedSkyboxPass(graph, scene.value);
  if (!skybox.ok) return skybox;
  const gpuDriven = context.projectGpuDriven({
    format: scene.value.format,
    sampleCount: scene.value.sampleCount,
  });
  if (!gpuDriven.ok) return gpuDriven;
  const main = addTypedScenePass(graph, {
    name: 'main',
    color: scene.value,
    depth: depth.value,
    ...(msaa ? { resolve: sceneResolved.value } : {}),
    sampled: [
      shadows.value.directional,
      shadows.value.spot,
      ...(shadows.value.point === undefined ? [] : [shadows.value.point]),
    ],
    directionalShadow: shadows.value.directional,
    spotShadow: shadows.value.spot,
    selector: { LightMode: ['Forward'] },
    colorLoadOp: 'load',
    ...(gpuDriven.value === undefined ? {} : { gpuDriven: gpuDriven.value }),
  });
  if (!main.ok) return main;

  const features = context.contributeFeatures([
    {
      kind: 'scene-color',
      texture: scene.value.texture,
      view: scene.value.view,
      ...(msaa ? { resolveTarget: sceneResolved.value.view } : {}),
      format: scene.value.format,
      sampleCount: scene.value.sampleCount,
    },
    {
      kind: 'scene-depth',
      texture: depth.value.texture,
      view: depth.value.view,
      format: depth.value.format,
      sampleCount: depth.value.sampleCount,
    },
  ]);
  if (!features.ok) return features;

  if (hdr || linearLdr) {
    const observation = addTypedFrameObservationPass(
      graph,
      sceneResolved.value,
      'forgeax::standard',
    );
    if (!observation.ok) return observation;
  }

  let postInput = sceneResolved.value;
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
      scene: sceneResolved.value,
      composited: composited.value,
      bright: bright.value,
      blurH: blurH.value,
      blurV: blurV.value,
    });
    if (!bloom.ok) return bloom;
    postInput = topology.camera.bloom === 'on' ? composited.value : sceneResolved.value;
  }

  if (hdr) {
    if (fxaa) {
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
    } else {
      const tonemap = addTypedTonemapPass(graph, postInput, surface.value.display);
      if (!tonemap.ok) return tonemap;
    }
  } else if (fxaa) {
    const aa = addTypedFullscreenPass(graph, {
      name: 'fxaa',
      shader: 'fxaa',
      input: sceneResolved.value,
      output: surface.value.storage,
    });
    if (!aa.ok) return aa;
  } else if (linearLdr) {
    const output = addTypedTonemapPass(graph, sceneResolved.value, surface.value.storage, true);
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

export const buildStandardForwardLane = buildUrp;
