import type {
  GraphAccess,
  GraphResourceResolver,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import { PointShadowAtlasUninitializedError } from './errors/render';
import type { RenderFeatureShadowDraws } from './features/render-graph-raster';
import {
  type ShadowDirtyRect,
  type ShadowViewIdentity,
  type ShadowViewProjection,
  shadowViewRasterAccesses,
} from './gpu-driven/shadow-views';

type ProjectGpuDrivenShadow = (
  identity: ShadowViewIdentity,
) => Result<ShadowViewProjection | undefined, RenderGraphError>;

import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
} from './gpu-texture-usage';
import type { ShadowViewInvalidationReason } from './inspection-types';
import type { _InternalRenderPipelineContext } from './record/render-context';
import {
  encodeDirectionalShadowPass,
  encodePointShadowPass,
  encodeSpotShadowPass,
  encodeStaticShadowPass,
} from './record/shadow-pass';
import type { RenderPipelineFrame, RenderPipelineTopology } from './render-pipeline';
import { createRenderPipelineTarget, type RenderPipelineTarget } from './render-pipeline';

export interface TypedShadowTargets {
  readonly directional?: RenderPipelineTarget | undefined;
  readonly spot: RenderPipelineTarget;
  readonly point?: RenderPipelineTarget | undefined;
}

/**
 * A cache miss is a per-view fact. With a GPU view pool, the pool owns every
 * view's decision; without one only the directional producer cache can prove
 * a retained layer, so point and spot views re-raster.
 */
function shadowViewCacheMiss(
  frame: RenderPipelineFrame,
  identity: ShadowViewIdentity,
): ShadowViewInvalidationReason | undefined {
  const context = frame as _InternalRenderPipelineContext;
  const gpuShadowViews = context.gpuDrivenShadowViews;
  if (gpuShadowViews !== undefined) return gpuShadowViews.invalidationReason(identity);
  return identity.kind === 'directional' ? context.directionalShadowCacheMiss : 'uncached';
}

interface ShadowViewRaster {
  readonly executeIf: (frame: RenderPipelineFrame) => boolean;
  /**
   * Regions a static-layer content miss re-rasters over its retained depth;
   * undefined on a hit or a miss that clears the layer.
   */
  readonly dirtyRects: () => readonly ShadowDirtyRect[] | undefined;
  readonly encode: (
    frame: RenderPipelineFrame,
    pass: RhiRenderPassEncoder,
    encode: (pass: RhiRenderPassEncoder) => void,
  ) => void;
}

/**
 * A freshly compiled graph owns a newly allocated target, so its first
 * execution rasters the layer even when the view cache hits. Later frames
 * raster only a missed view or a feature-drawn view the pool cannot prove.
 * Every decision and its draw count land in the frame's shadow raster ledger;
 * `identity === undefined` marks the empty spot target, which is no view.
 */
function shadowViewRaster(
  identity: ShadowViewIdentity | undefined,
  shadowFeatures: RenderFeatureShadowDraws<RenderPipelineFrame> | undefined,
): ShadowViewRaster {
  let graphCompiled = true;
  let slot = -1;
  let dirtyRects: readonly ShadowDirtyRect[] | undefined;
  return {
    dirtyRects: () => dirtyRects,
    executeIf: (frame) => {
      const reason: ShadowViewInvalidationReason | undefined = graphCompiled
        ? 'graph-compiled'
        : identity === undefined
          ? undefined
          : shadowFeatures !== undefined
            ? 'feature-draws'
            : shadowViewCacheMiss(frame, identity);
      graphCompiled = false;
      const context = frame as _InternalRenderPipelineContext;
      // A fresh graph target holds no retained depth to redraw over.
      dirtyRects =
        identity === undefined || reason === undefined || reason === 'graph-compiled'
          ? undefined
          : context.gpuDrivenShadowViews?.dirtyRects(identity);
      slot =
        identity === undefined
          ? -1
          : context.frameState.shadowRaster.evaluate(
              identity,
              reason,
              context.gpuDrivenShadowViews?.texelCulled(identity),
              dirtyRects?.length,
            );
      return reason !== undefined;
    },
    encode: (frame, pass, encode) => {
      if (slot < 0) {
        encode(pass);
        return;
      }
      (frame as _InternalRenderPipelineContext).frameState.shadowRaster.encode(slot, pass, encode);
    },
  };
}

/**
 * wgpu's GL backend maps a one-layer texture to TEXTURE_2D, which cannot be
 * sampled as `texture_depth_2d_array`; layered shadow maps keep two or more.
 */
const MIN_SHADOW_ARRAY_LAYERS = 2;
const SPOT_SHADOW_LAYERS = 4;

function createShadowArrayTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  size: number,
  layers: number,
): Result<RenderPipelineTarget, RenderGraphError> {
  return createRenderPipelineTarget(
    graph,
    label,
    {
      format: 'depth32float',
      size: { width: size, height: size, depthOrArrayLayers: layers },
    },
    { dimension: '2d-array', aspect: 'depth-only', arrayLayerCount: layers },
  );
}

function shadowLayerTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  target: RenderPipelineTarget,
  label: string,
  layer: number,
): Result<RenderPipelineTarget, RenderGraphError> {
  const view = graph.view(target.texture, {
    label,
    dimension: '2d',
    aspect: 'depth-only',
    baseArrayLayer: layer,
    arrayLayerCount: 1,
  });
  if (!view.ok) return view;
  return ok({ texture: target.texture, view: view.value, format: target.format, sampleCount: 1 });
}

/**
 * Every shadow view owns one array layer and clears it when it rasters, so a
 * miss never erases a neighbouring view retained by a cache hit.
 */
function recordShadowPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  name: string,
  target: RenderPipelineTarget,
  raster: Pick<ShadowViewRaster, 'executeIf' | 'encode'>,
  encode: (
    pass: RhiRenderPassEncoder,
    frame: RenderPipelineFrame,
    resources: GraphResourceResolver,
  ) => void,
  extraAccesses: readonly GraphAccess[] = [],
  depthLoadOp: 'clear' | 'load' = 'clear',
): Result<void, RenderGraphError> {
  return graph.addRasterPass(name, {
    accesses: [{ resource: target.view, usage: 'depth-stencil-write' }, ...extraAccesses],
    colorAttachments: [],
    depthStencilAttachment: {
      view: target.view,
      depthLoadOp,
      depthStoreOp: 'store',
      depthClearValue: 0,
    },
    executeIf: raster.executeIf,
    encode: ({ pass, frame, resources }) =>
      raster.encode(frame, pass, (counted) => encode(counted, frame, resources)),
  });
}

function projectionAccesses(
  projection: Result<ShadowViewProjection | undefined, RenderGraphError> | undefined,
): readonly GraphAccess[] {
  return projection?.ok === true && projection.value?.graphResources !== undefined
    ? shadowViewRasterAccesses(projection.value.graphResources)
    : [];
}

/**
 * A view with a static layer rasters its settled casters into a retained
 * static array layer only when that layer misses. Whenever the final layer
 * rasters, it first copies the static layer and then loads it to add dynamic,
 * residual, and feature casters.
 */
function recordStaticLayeredShadowPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  projectGpuDrivenShadow: ProjectGpuDrivenShadow,
  identity: ShadowViewIdentity,
  name: string,
  target: RenderPipelineTarget,
  staticArray: RenderPipelineTarget,
  layer: number,
  size: number,
  raster: ShadowViewRaster,
  encode: (
    pass: RhiRenderPassEncoder,
    frame: RenderPipelineFrame,
    resources: GraphResourceResolver,
  ) => void,
  extraAccesses: readonly GraphAccess[],
): Result<void, RenderGraphError> {
  const staticIdentity: ShadowViewIdentity = Object.freeze({ ...identity, layer: 'static' });
  const staticProjection = projectGpuDrivenShadow(staticIdentity);
  if (!staticProjection.ok) return staticProjection;
  const staticLayer = shadowLayerTarget(graph, staticArray, `${name}-static-layer`, layer);
  if (!staticLayer.ok) return staticLayer;
  const staticRaster = shadowViewRaster(staticIdentity, undefined);
  // A pool-proven content miss re-rasters only its dirty regions over the
  // retained layer; any other miss clears it.
  const staticAdded = recordShadowPass(
    graph,
    `${name}.static`,
    staticLayer.value,
    {
      executeIf: (frame) =>
        staticRaster.executeIf(frame) && staticRaster.dirtyRects() === undefined,
      encode: staticRaster.encode,
    },
    (pass, frame) => encodeStaticShadowPass(frame as never, pass, identity),
    projectionAccesses(staticProjection),
  );
  if (!staticAdded.ok) return staticAdded;
  const partialAdded = recordShadowPass(
    graph,
    `${name}.static-partial`,
    staticLayer.value,
    { executeIf: () => staticRaster.dirtyRects() !== undefined, encode: staticRaster.encode },
    (pass, frame) =>
      encodeStaticShadowPass(frame as never, pass, identity, {
        rects: staticRaster.dirtyRects() ?? [],
        size,
      }),
    projectionAccesses(staticProjection),
    'load',
  );
  if (!partialAdded.ok) return partialAdded;
  let rasterFinal = false;
  const copied = graph.addCopyPass(`${name}.static-copy`, {
    accesses: [
      { resource: staticLayer.value.view, usage: 'copy-src' },
      { resource: target.view, usage: 'copy-dst' },
    ],
    executeIf: (frame) => {
      rasterFinal = raster.executeIf(frame);
      return rasterFinal;
    },
    encode: ({ encoder, resources }) => {
      const source = resources.texture(staticArray.texture);
      if (!source.ok) throw source.error;
      const destination = resources.texture(target.texture);
      if (!destination.ok) throw destination.error;
      encoder.copyTextureToTexture(
        { texture: source.value as never, mipLevel: 0, origin: { x: 0, y: 0, z: layer } },
        { texture: destination.value as never, mipLevel: 0, origin: { x: 0, y: 0, z: layer } },
        { width: size, height: size, depthOrArrayLayers: 1 },
      );
    },
  });
  if (!copied.ok) return copied;
  return recordShadowPass(
    graph,
    name,
    target,
    { executeIf: () => rasterFinal, encode: raster.encode },
    encode,
    extraAccesses,
    'load',
  );
}

export function addTypedShadowPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
  projectGpuDrivenShadowOrFeatures?:
    | ProjectGpuDrivenShadow
    | RenderFeatureShadowDraws<RenderPipelineFrame>,
  features?: RenderFeatureShadowDraws<RenderPipelineFrame>,
): Result<TypedShadowTargets, RenderGraphError> {
  const projectGpuDrivenShadow =
    typeof projectGpuDrivenShadowOrFeatures === 'function'
      ? projectGpuDrivenShadowOrFeatures
      : undefined;
  const shadowFeatures =
    typeof projectGpuDrivenShadowOrFeatures === 'function'
      ? features
      : (projectGpuDrivenShadowOrFeatures ?? features);
  let directional: RenderPipelineTarget | undefined;
  if (topology.shadow.directional !== 'disabled') {
    const { mapSize, cascadeCount } = topology.shadow.directional;
    const target = createShadowArrayTarget(
      graph,
      'directional-shadow-depth',
      mapSize,
      Math.max(MIN_SHADOW_ARRAY_LAYERS, cascadeCount),
    );
    if (!target.ok) return target;
    const directionalTarget = target.value;
    directional = directionalTarget;
    let directionalStatic: RenderPipelineTarget | undefined;
    if (projectGpuDrivenShadow !== undefined) {
      const staticTarget = createShadowArrayTarget(
        graph,
        'directional-shadow-static',
        mapSize,
        Math.max(MIN_SHADOW_ARRAY_LAYERS, cascadeCount),
      );
      if (!staticTarget.ok) return staticTarget;
      directionalStatic = staticTarget.value;
    }
    for (let cascade = 0; cascade < cascadeCount; cascade += 1) {
      const identity = Object.freeze({ kind: 'directional' as const, index: cascade });
      const shadowProjection = projectGpuDrivenShadow?.(identity);
      if (shadowProjection !== undefined && !shadowProjection.ok) return shadowProjection;
      const layer = shadowLayerTarget(
        graph,
        directionalTarget,
        `directional-shadow-cascade-${cascade}`,
        cascade,
      );
      if (!layer.ok) return layer;
      const raster = shadowViewRaster(identity, shadowFeatures);
      const encode = (
        pass: RhiRenderPassEncoder,
        frame: RenderPipelineFrame,
        resources: GraphResourceResolver,
      ) =>
        encodeDirectionalShadowPass(
          frame as never,
          pass,
          cascade,
          shadowFeatures === undefined
            ? undefined
            : (view) => shadowFeatures.encode(pass, frame, resources, view),
        );
      const accesses = [
        ...projectionAccesses(shadowProjection),
        ...(shadowFeatures?.accesses ?? []),
      ];
      const added =
        projectGpuDrivenShadow !== undefined && directionalStatic !== undefined
          ? recordStaticLayeredShadowPass(
              graph,
              projectGpuDrivenShadow,
              identity,
              `shadowCascade${cascade}`,
              layer.value,
              directionalStatic,
              cascade,
              mapSize,
              raster,
              encode,
              accesses,
            )
          : recordShadowPass(
              graph,
              `shadowCascade${cascade}`,
              layer.value,
              raster,
              encode,
              accesses,
            );
      if (!added.ok) return added;
    }
    const observation = graph.addCopyPass('directional-shadow-observation', {
      accesses: [{ resource: directionalTarget.view, usage: 'copy-src' }],
      encode: ({ frame, resources }) => {
        const internal = frame as _InternalRenderPipelineContext;
        const texture = resources.texture(directionalTarget.texture);
        if (!texture.ok) throw texture.error;
        internal.pipelineState.perPassResources.shadowTexture = texture.value;
      },
    });
    if (!observation.ok) return observation;
  }

  let point: RenderPipelineTarget | undefined;
  if (topology.shadow.pointCount > 0) {
    const texture = graph.importTexture(
      'point-shadow-atlas',
      {
        format: 'depth32float',
        size: {
          width: topology.shadow.pointFaceSize,
          height: topology.shadow.pointFaceSize,
          depthOrArrayLayers: 24,
        },
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST,
      },
      (frame) => {
        const internal = frame as _InternalRenderPipelineContext;
        const atlas = internal.frameState.pointShadowAtlas?.getTexture();
        if (atlas === null || atlas === undefined) {
          throw new PointShadowAtlasUninitializedError();
        }
        return atlas;
      },
    );
    if (!texture.ok) return texture;
    const cube = graph.view(texture.value, {
      label: 'point-shadow-atlas.cube-array',
      dimension: 'cube-array',
      aspect: 'depth-only',
      arrayLayerCount: 24,
    });
    if (!cube.ok) return cube;
    point = {
      texture: texture.value,
      view: cube.value,
      format: 'depth32float',
      sampleCount: 1,
    };
    let pointStatic: RenderPipelineTarget | undefined;
    if (projectGpuDrivenShadow !== undefined) {
      const staticTarget = createShadowArrayTarget(
        graph,
        'point-shadow-static',
        topology.shadow.pointFaceSize,
        topology.shadow.pointCount * 6,
      );
      if (!staticTarget.ok) return staticTarget;
      pointStatic = staticTarget.value;
    }
    for (let pointIndex = 0; pointIndex < topology.shadow.pointCount; pointIndex += 1) {
      for (let face = 0; face < 6; face += 1) {
        const shadowProjection = projectGpuDrivenShadow?.({
          kind: 'point',
          index: pointIndex,
          face,
        });
        if (shadowProjection !== undefined && !shadowProjection.ok) return shadowProjection;
        const identity = Object.freeze({ kind: 'point' as const, index: pointIndex, face });
        const faceView = graph.view(texture.value, {
          label: `point-shadow-${pointIndex}-${face}`,
          dimension: '2d',
          aspect: 'depth-only',
          baseArrayLayer: pointIndex * 6 + face,
          arrayLayerCount: 1,
        });
        if (!faceView.ok) return faceView;
        const faceTarget: RenderPipelineTarget = {
          texture: texture.value,
          view: faceView.value,
          format: 'depth32float',
          sampleCount: 1,
        };
        const raster = shadowViewRaster(identity, shadowFeatures);
        const encode = (
          pass: RhiRenderPassEncoder,
          frame: RenderPipelineFrame,
          resources: GraphResourceResolver,
        ) =>
          encodePointShadowPass(
            frame as never,
            pass,
            pointIndex,
            face,
            shadowFeatures === undefined
              ? undefined
              : (view) => shadowFeatures.encode(pass, frame, resources, view),
          );
        const accesses = [
          ...projectionAccesses(shadowProjection),
          ...(shadowFeatures?.accesses ?? []),
        ];
        const name = `point-shadow-${pointIndex}-${face}`;
        const added =
          projectGpuDrivenShadow !== undefined && pointStatic !== undefined
            ? recordStaticLayeredShadowPass(
                graph,
                projectGpuDrivenShadow,
                identity,
                name,
                faceTarget,
                pointStatic,
                pointIndex * 6 + face,
                topology.shadow.pointFaceSize,
                raster,
                encode,
                accesses,
              )
            : recordShadowPass(graph, name, faceTarget, raster, encode, accesses);
        if (!added.ok) return added;
      }
    }
  }

  const spot = createShadowArrayTarget(
    graph,
    'spot-shadow-depth',
    topology.shadow.spotMapSize,
    SPOT_SHADOW_LAYERS,
  );
  if (!spot.ok) return spot;
  let spotStatic: RenderPipelineTarget | undefined;
  if (projectGpuDrivenShadow !== undefined && topology.shadow.spotCount > 0) {
    const staticTarget = createShadowArrayTarget(
      graph,
      'spot-shadow-static',
      topology.shadow.spotMapSize,
      SPOT_SHADOW_LAYERS,
    );
    if (!staticTarget.ok) return staticTarget;
    spotStatic = staticTarget.value;
  }
  // Spot shadow tiles are assigned in snapshot order, so pass index i writes
  // the layer the receiver samples through `shadowAtlasTile == i`.
  for (let spotIndex = 0; spotIndex < Math.max(1, topology.shadow.spotCount); spotIndex += 1) {
    const identity = Object.freeze({ kind: 'spot' as const, index: spotIndex });
    const shadowProjection = projectGpuDrivenShadow?.(identity);
    if (shadowProjection !== undefined && !shadowProjection.ok) return shadowProjection;
    const layer = shadowLayerTarget(graph, spot.value, `spot-shadow-layer-${spotIndex}`, spotIndex);
    if (!layer.ok) return layer;
    const name = topology.shadow.spotCount === 0 ? 'spot-shadow' : `spot-shadow-${spotIndex}`;
    // The empty target only supplies the initialized no-shadow binding.
    // A light-count change rebuilds this graph and initializes a new one.
    const raster = shadowViewRaster(
      topology.shadow.spotCount > 0 ? identity : undefined,
      shadowFeatures,
    );
    const encode = (
      pass: RhiRenderPassEncoder,
      frame: RenderPipelineFrame,
      resources: GraphResourceResolver,
    ) =>
      encodeSpotShadowPass(
        frame as never,
        pass,
        spotIndex,
        shadowFeatures === undefined
          ? undefined
          : (view) => shadowFeatures.encode(pass, frame, resources, view),
      );
    const accesses = [...projectionAccesses(shadowProjection), ...(shadowFeatures?.accesses ?? [])];
    const added =
      projectGpuDrivenShadow !== undefined && spotStatic !== undefined
        ? recordStaticLayeredShadowPass(
            graph,
            projectGpuDrivenShadow,
            identity,
            name,
            layer.value,
            spotStatic,
            spotIndex,
            topology.shadow.spotMapSize,
            raster,
            encode,
            accesses,
          )
        : recordShadowPass(graph, name, layer.value, raster, encode, accesses);
    if (!added.ok) return added;
  }

  return ok({ directional, spot: spot.value, point });
}
