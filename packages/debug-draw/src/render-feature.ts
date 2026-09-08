import type { RenderFeaturePlan } from '@forgeax/engine-render';
import type { TextureFormat } from '@forgeax/engine-rhi';

export interface DebugDrawRenderFeatureInput {
  readonly vertexCapacity: number;
  readonly vertexCount?: number;
  readonly target: string;
  readonly colorFormat?: TextureFormat;
  readonly viewProjection?: ArrayBufferView;
}

/** Describe bounded debug primitives without exposing submission ownership. */
export function createDebugDrawRenderFeaturePlan(
  input: DebugDrawRenderFeatureInput,
): RenderFeaturePlan {
  const program = 'debug-draw.program';
  const bindings = 'debug-draw.bindings';
  const vertices = 'debug-draw.vertices';
  const vertexData = 'debug-draw.vertex-data';
  return {
    resources: [
      {
        kind: 'graphics-program',
        name: program,
        program: {
          shader: 'forgeax::debug-draw.line',
          vertexLayout: 'debug-draw-line',
          colorFormats: [input.colorFormat ?? 'bgra8unorm'],
          topology: 'line-list',
        },
      },
      {
        kind: 'graphics-bindings',
        name: bindings,
        program,
        values: {
          viewProjection: input.viewProjection ?? 'debug-draw.view-projection',
        },
      },
      {
        kind: 'buffer',
        name: vertices,
        size: Math.max(1, input.vertexCapacity) * 16,
        usage: ['vertex'],
      },
      {
        kind: 'vertex-data',
        name: vertexData,
        layout: 'debug-draw-line',
        buffer: vertices,
      },
    ],
    passes: [
      {
        kind: 'raster',
        name: 'debug-draw.raster',
        colorAttachments: [{ target: input.target, loadOp: 'load', storeOp: 'store' }],
        draws: [
          {
            program,
            bindings: [bindings],
            vertexData: [{ slot: 0, resource: vertexData }],
            draw: {
              kind: 'draw',
              vertexCount: Math.max(0, input.vertexCount ?? input.vertexCapacity),
              instanceCount: 1,
            },
          },
        ],
      },
    ],
  };
}
