import { ok } from '@forgeax/engine-types';
import type {
  PreparedKind,
  RenderFeature,
  RenderFeatureDrawRecord,
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedRef,
} from '../index';

interface Frame {
  readonly vertexCount: number;
  readonly indexCount: number;
}

const feature = {
  identity: 'prepared.graphics.positive',
  extract: () => ok<Frame>({ vertexCount: 6, indexCount: 6 }),
  prepare(data, context) {
    const pipeline = context.graphics.preparePipeline('forward', {
      shader: 'unlit',
      vertexLayout: 'position',
      colorFormats: ['rgba8unorm'],
    });
    if (!pipeline.ok) return pipeline;

    const bindings = context.graphics.prepareBindings('forward', {
      pipeline: pipeline.value,
      values: { opacity: 1 },
    });
    if (!bindings.ok) return bindings;

    const vertices = context.graphics.prepareVertexData('quad', {
      layout: 'position',
      data: new Float32Array(data.vertexCount),
    });
    if (!vertices.ok) return vertices;

    const indices = context.graphics.prepareIndexData('quad', {
      format: 'uint16',
      data: new Uint16Array(data.indexCount),
    });
    if (!indices.ok) return indices;

    const refs: readonly RenderFeaturePreparedRef<PreparedKind>[] = [
      pipeline.value,
      bindings.value,
      vertices.value,
      indices.value,
    ];
    void refs;
    return ok(undefined);
  },
  contribute(data, context) {
    const pipeline: RenderFeaturePreparedRef<'pipeline'> = {
      kind: 'pipeline',
      generation: 1,
    };
    const bindings: RenderFeaturePreparedRef<'bindings'> = {
      kind: 'bindings',
      generation: 1,
    };
    const vertices: RenderFeaturePreparedRef<'vertex-data'> = {
      kind: 'vertex-data',
      generation: 1,
    };
    const indices: RenderFeaturePreparedRef<'index-data'> = {
      kind: 'index-data',
      generation: 1,
    };

    const vertexOnly: RenderFeatureDrawRecord = {
      kind: 'draw',
      pipeline,
      bindings: [bindings],
      vertexData: [{ slot: 0, resource: vertices }],
      command: { vertexCount: data.vertexCount, instanceCount: 1 },
    };
    const indexed: RenderFeatureDrawRecord = {
      kind: 'draw-indexed',
      pipeline,
      bindings: [bindings],
      vertexData: [{ slot: 0, resource: vertices }],
      indexData: { resource: indices, format: 'uint16' },
      command: { indexCount: data.indexCount, instanceCount: 1 },
    };
    const pass: RenderFeatureGraphicsPassDescriptor = {
      attachments: {
        colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
      },
      draws: [vertexOnly, indexed],
    };
    return context.staging.addGraphicsPass('forward', pass);
  },
} satisfies RenderFeature<Frame>;

void feature;
