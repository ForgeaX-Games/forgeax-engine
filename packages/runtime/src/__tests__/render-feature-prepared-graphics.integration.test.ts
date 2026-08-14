import { World } from '@forgeax/engine-ecs';
import type {
  RenderFeature,
  RenderFeatureDrawRecord,
  RenderFeaturePreparedRef,
  RenderPipeline,
} from '@forgeax/engine-render';
import { RenderGraph } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderer } from '../createRenderer';

const manifest = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [
      { hash: 'pbr00000', wgsl: '/* pbr stub */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      { hash: 'tonemap0', wgsl: '/* tonemap stub */', glsl: '', bindings: '' },
    ],
    materialShaders: [
      {
        identifier: 'forgeax::default-standard-pbr',
        sourcePath: 'forgeax::default-standard-pbr.wgsl',
        composedWgsl: '/* stub */',
        paramSchema: '[]',
        variants: [],
      },
      {
        identifier: 'forgeax::default-unlit',
        sourcePath: 'forgeax::default-unlit.wgsl',
        composedWgsl: '/* stub */',
        paramSchema: '[]',
        variants: [],
      },
    ],
  }),
)}`;

function canvas(): HTMLCanvasElement {
  return {
    width: 64,
    height: 64,
    getContext: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
}

function observeDrawCalls(device: RhiDevice): () => number {
  let count = 0;
  const createCommandEncoder = device.createCommandEncoder.bind(device);
  device.createCommandEncoder = (descriptor) => {
    const result = createCommandEncoder(descriptor);
    if (!result.ok) return result;
    const encoder = result.value;
    const beginRenderPass = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = (passDescriptor) => {
      const pass = beginRenderPass(passDescriptor);
      const draw = pass.draw.bind(pass);
      const drawIndexed = pass.drawIndexed.bind(pass);
      pass.draw = (...args) => {
        count += 1;
        draw(...args);
      };
      pass.drawIndexed = (...args) => {
        count += 1;
        drawIndexed(...args);
      };
      return pass;
    };
    return result;
  };
  return () => count;
}

function pipeline(): RenderPipeline {
  return {
    buildGraph: (context) => {
      const graph = new RenderGraph<typeof context>();
      graph.addResource('base', { kind: 'texture', lifetime: 'transient' });
      graph.addPass('base', { reads: [], writes: ['base'], execute: () => undefined });
      return graph;
    },
    execute: () => undefined,
  };
}

function preparedFeature(
  identity: string,
  draws: readonly RenderFeatureDrawRecord[],
): RenderFeature<{ readonly draws: readonly RenderFeatureDrawRecord[] }> {
  let pipelineRef: RenderFeaturePreparedRef<'pipeline'> | undefined;
  let bindingsRef: RenderFeaturePreparedRef<'bindings'> | undefined;
  let verticesRef: RenderFeaturePreparedRef<'vertex-data'> | undefined;
  let indicesRef: RenderFeaturePreparedRef<'index-data'> | undefined;

  return {
    identity,
    extract: () => ok({ draws }),
    prepare: (_data, context) => {
      const pipelineResult = context.graphics.preparePipeline('forward', {
        shader: 'synthetic.unlit',
        vertexLayout: 'position',
        colorFormats: ['rgba8unorm'],
      });
      if (!pipelineResult.ok) return pipelineResult;
      const bindingsResult = context.graphics.prepareBindings('forward', {
        pipeline: pipelineResult.value,
        values: { opacity: 1 },
      });
      if (!bindingsResult.ok) return bindingsResult;
      const verticesResult = context.graphics.prepareVertexData('quad', {
        layout: 'position',
        data: new Float32Array([0, 0, 0]),
      });
      if (!verticesResult.ok) return verticesResult;
      const indicesResult = context.graphics.prepareIndexData('quad', {
        format: 'uint16',
        data: new Uint16Array([0, 1, 2]),
      });
      if (!indicesResult.ok) return indicesResult;
      pipelineRef = pipelineResult.value;
      bindingsRef = bindingsResult.value;
      verticesRef = verticesResult.value;
      indicesRef = indicesResult.value;
      return ok(undefined);
    },
    contribute: (data, context) => {
      if (data.draws.length === 0) return ok(undefined);
      if (
        pipelineRef === undefined ||
        bindingsRef === undefined ||
        verticesRef === undefined ||
        indicesRef === undefined
      ) {
        return err(new Error('prepared refs missing') as never);
      }
      const preparedPipeline = pipelineRef;
      const preparedBindings = bindingsRef;
      const preparedVertices = verticesRef;
      const preparedIndices = indicesRef;
      const normalized: RenderFeatureDrawRecord[] = data.draws.map((draw) => ({
        ...draw,
        pipeline: preparedPipeline,
        bindings: [preparedBindings],
        vertexData: [{ slot: 0, resource: preparedVertices }],
        ...(draw.kind === 'draw-indexed'
          ? { indexData: { resource: preparedIndices, format: 'uint16' as const } }
          : {}),
      }));
      context.staging.addResource('color', { kind: 'texture', lifetime: 'transient' });
      return context.staging.addGraphicsPass('forward', {
        attachments: {
          colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
        },
        draws: normalized,
      });
    },
  };
}

describe('prepared graphics null integration', () => {
  it('records vertex-only and indexed work through one graph and submit boundary', async () => {
    const vertex: RenderFeatureDrawRecord = {
      kind: 'draw',
      pipeline: { kind: 'pipeline', generation: 0 },
      bindings: [{ kind: 'bindings', generation: 0 }],
      vertexData: [{ slot: 0, resource: { kind: 'vertex-data', generation: 0 } }],
      command: { vertexCount: 3, instanceCount: 1 },
    };
    const indexed: RenderFeatureDrawRecord = {
      kind: 'draw-indexed',
      pipeline: vertex.pipeline,
      bindings: vertex.bindings,
      vertexData: vertex.vertexData,
      indexData: { resource: { kind: 'index-data', generation: 0 }, format: 'uint16' },
      command: { indexCount: 3, instanceCount: 1 },
    };
    const renderer = await createRenderer(
      canvas(),
      { rhi, features: [preparedFeature('synthetic.prepared', [vertex, indexed])] },
      { shaderManifestUrl: manifest },
    );
    renderer.registerPipeline('synthetic::prepared', pipeline());
    expect(
      renderer.installPipeline({ kind: 'render-pipeline', pipelineId: 'synthetic::prepared' }).ok,
    ).toBe(true);
    expect((await renderer.ready).ok).toBe(true);
    const drawCount = observeDrawCalls(renderer.device);
    const queue = renderer.device.queue;
    let submitCount = 0;
    const submit = queue.submit.bind(queue);
    queue.submit = (buffers) => {
      submitCount += 1;
      return submit(buffers);
    };

    const world = new World();
    const attachment = renderer.attachWorld(world);
    if (!attachment.ok) throw attachment.error;
    world.update().unwrap();
    const result = renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
    expect(result.ok).toBe(true);
    expect(renderer.perFramePassNames).toContain('synthetic.prepared::forward');
    expect(drawCount()).toBeGreaterThanOrEqual(2);
    expect(submitCount).toBe(1);
    renderer.dispose();
  });

  it('keeps empty prepared work out of the active graph', async () => {
    const renderer = await createRenderer(
      canvas(),
      { rhi, features: [preparedFeature('synthetic.empty', [])] },
      { shaderManifestUrl: manifest },
    );
    renderer.registerPipeline('synthetic::empty', pipeline());
    expect(
      renderer.installPipeline({ kind: 'render-pipeline', pipelineId: 'synthetic::empty' }).ok,
    ).toBe(true);
    expect((await renderer.ready).ok).toBe(true);
    const world = new World();
    const attachment = renderer.attachWorld(world);
    if (!attachment.ok) throw attachment.error;
    world.update().unwrap();
    expect(renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }).ok).toBe(true);
    expect(renderer.perFramePassNames).not.toContain('synthetic.empty::forward');
    renderer.dispose();
  });
});
