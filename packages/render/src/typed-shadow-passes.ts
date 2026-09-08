import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { PointShadowAtlasUninitializedError } from './errors/render';
import { GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING } from './gpu-texture-usage';
import type { _InternalRenderPipelineContext } from './record/render-context';
import {
  encodeDirectionalShadowPass,
  encodePointShadowPass,
  encodeSpotShadowPass,
} from './record/shadow-pass';
import type { RenderPipelineFrame, RenderPipelineTopology } from './render-pipeline';
import { createRenderPipelineTarget, type RenderPipelineTarget } from './render-pipeline';

export interface TypedShadowTargets {
  readonly directional: RenderPipelineTarget;
  readonly spot: RenderPipelineTarget;
  readonly point?: RenderPipelineTarget | undefined;
}

function recordShadowPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  name: string,
  target: RenderPipelineTarget,
  loadOp: 'clear' | 'load',
  encode: Parameters<RenderGraphBuilder<RenderPipelineFrame>['addRasterPass']>[1]['encode'],
  executeIf?: (frame: RenderPipelineFrame) => boolean,
): Result<void, RenderGraphError> {
  return graph.addRasterPass(name, {
    accesses: [{ resource: target.view, usage: 'depth-stencil-write' }],
    colorAttachments: [],
    depthStencilAttachment: {
      view: target.view,
      depthLoadOp: loadOp,
      depthStoreOp: 'store',
      ...(loadOp === 'clear' ? { depthClearValue: 1 } : {}),
    },
    ...(executeIf === undefined ? {} : { executeIf }),
    encode,
  });
}

export function addTypedShadowPasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): Result<TypedShadowTargets, RenderGraphError> {
  const tilesPerSide = Math.ceil(Math.sqrt(topology.shadow.cascadeCount));
  const directional = createRenderPipelineTarget(graph, 'directional-shadow-depth', {
    format: 'depth32float',
    size: {
      width: topology.shadow.mapSize * tilesPerSide,
      height: topology.shadow.mapSize * tilesPerSide,
    },
  });
  if (!directional.ok) return directional;
  for (let cascade = 0; cascade < topology.shadow.cascadeCount; cascade += 1) {
    const col = cascade % tilesPerSide;
    const row = Math.floor(cascade / tilesPerSide);
    const added = recordShadowPass(
      graph,
      `shadowCascade${cascade}`,
      directional.value,
      cascade === 0 ? 'clear' : 'load',
      ({ pass, frame }) =>
        encodeDirectionalShadowPass(frame as never, pass, cascade, {
          x: col * topology.shadow.mapSize,
          y: row * topology.shadow.mapSize,
          w: topology.shadow.mapSize,
          h: topology.shadow.mapSize,
        }),
      (frame) => !(frame as _InternalRenderPipelineContext).directionalShadowCacheReuse,
    );
    if (!added.ok) return added;
  }
  const observation = graph.addCopyPass('directional-shadow-observation', {
    accesses: [{ resource: directional.value.view, usage: 'copy-src' }],
    encode: ({ frame, resources }) => {
      const internal = frame as _InternalRenderPipelineContext;
      const texture = resources.texture(directional.value.texture);
      if (!texture.ok) throw texture.error;
      internal.pipelineState.perPassResources.shadowTexture = texture.value;
    },
  });
  if (!observation.ok) return observation;

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
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT_AND_TEXTURE_BINDING,
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
    for (let pointIndex = 0; pointIndex < topology.shadow.pointCount; pointIndex += 1) {
      for (let face = 0; face < 6; face += 1) {
        const faceView = graph.view(texture.value, {
          label: `point-shadow-${pointIndex}-${face}`,
          dimension: '2d',
          aspect: 'depth-only',
          baseArrayLayer: pointIndex * 6 + face,
          arrayLayerCount: 1,
        });
        if (!faceView.ok) return faceView;
        const added = recordShadowPass(
          graph,
          `point-shadow-${pointIndex}-${face}`,
          {
            texture: texture.value,
            view: faceView.value,
            format: 'depth32float',
            sampleCount: 1,
          },
          'clear',
          ({ pass, frame }) => encodePointShadowPass(frame as never, pass, pointIndex, face),
        );
        if (!added.ok) return added;
      }
    }
  }

  const spot = createRenderPipelineTarget(graph, 'spot-shadow-depth', {
    format: 'depth32float',
    size: { width: topology.shadow.mapSize * 2, height: topology.shadow.mapSize * 2 },
  });
  if (!spot.ok) return spot;
  for (let spotIndex = 0; spotIndex < Math.max(1, topology.shadow.spotCount); spotIndex += 1) {
    const added = recordShadowPass(
      graph,
      topology.shadow.spotCount === 0 ? 'spot-shadow' : `spot-shadow-${spotIndex}`,
      spot.value,
      spotIndex === 0 ? 'clear' : 'load',
      ({ pass, frame }) => encodeSpotShadowPass(frame as never, pass, spotIndex),
    );
    if (!added.ok) return added;
  }

  return ok({ directional: directional.value, spot: spot.value, point });
}
