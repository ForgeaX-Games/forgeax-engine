import { World } from '@forgeax/engine-ecs';
import type {
  RenderFeature,
  RenderFeatureDrawRecord,
  RenderFeaturePreparedRef,
  RenderPipeline,
} from '@forgeax/engine-render';
import { Camera, RenderFeatureStageFailedError } from '@forgeax/engine-render';
import { RenderGraph } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
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

function world(): World {
  const value = new World();
  value.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
  );
  return value;
}

type MatrixCase = 'accepted' | 'mismatch' | 'empty' | 'multi-feature' | 'recovery';

interface MatrixResult {
  readonly case: MatrixCase;
  readonly drawCount: number;
  readonly featureStatuses: readonly string[];
  readonly errorCodes: readonly string[];
  readonly passNames: readonly string[];
}

interface FeatureState {
  pipeline: RenderFeaturePreparedRef<'pipeline'> | undefined;
  bindings: RenderFeaturePreparedRef<'bindings'> | undefined;
  vertices: RenderFeaturePreparedRef<'vertex-data'> | undefined;
  firstContribution: boolean;
}

function graphicsFeature(
  identity: string,
  state: FeatureState,
  mode: Exclude<MatrixCase, 'multi-feature'>,
): RenderFeature<{ readonly draw: boolean }> {
  return {
    identity,
    extract: () => ok({ draw: mode !== 'empty' }),
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
      const verticesResult = context.graphics.prepareVertexData('triangle', {
        layout: 'position',
        data: new Float32Array([0, 0, 0]),
      });
      if (!verticesResult.ok) return verticesResult;
      state.pipeline = pipelineResult.value;
      state.bindings = bindingsResult.value;
      state.vertices = verticesResult.value;
      return ok(undefined);
    },
    contribute: (data, context) => {
      if (!data.draw) return ok(undefined);
      const { pipeline: preparedPipeline, bindings, vertices } = state;
      if (preparedPipeline === undefined || bindings === undefined || vertices === undefined) {
        return err(new RenderFeatureStageFailedError(identity, 0, 'contribute', 'next-frame'));
      }
      const drawPipeline =
        mode === 'mismatch' || (mode === 'recovery' && state.firstContribution)
          ? { kind: 'pipeline' as const, generation: 99 }
          : preparedPipeline;
      state.firstContribution = false;
      context.staging.addResource('color', { kind: 'texture', lifetime: 'transient' });
      const draw: RenderFeatureDrawRecord = {
        kind: 'draw',
        pipeline: drawPipeline,
        bindings: [bindings],
        vertexData: [{ slot: 0, resource: vertices }],
        command: { vertexCount: 3, instanceCount: 1 },
      };
      return context.staging.addGraphicsPass('forward', {
        attachments: {
          colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
        },
        draws: [draw],
      });
    },
  };
}

async function rendererWith(
  features: readonly RenderFeature<{ readonly draw: boolean }>[],
): Promise<Awaited<ReturnType<typeof createRenderer>>> {
  const renderer = await createRenderer(
    canvas(),
    { rhi, features },
    { shaderManifestUrl: manifest },
  );
  renderer.registerPipeline('synthetic::regression', pipeline());
  expect(
    renderer.installPipeline({ kind: 'render-pipeline', pipelineId: 'synthetic::regression' }).ok,
  ).toBe(true);
  expect((await renderer.ready).ok).toBe(true);
  return renderer;
}

async function runCase(
  name: Exclude<MatrixCase, 'multi-feature'>,
  feature = graphicsFeature(
    `synthetic.${name}`,
    {
      pipeline: undefined,
      bindings: undefined,
      vertices: undefined,
      firstContribution: true,
    },
    name,
  ),
): Promise<MatrixResult> {
  const renderer = await rendererWith([feature]);
  const drawCount = observeDrawCalls(renderer.device);
  const result = renderer.draw([world()], { owner: 0 });
  const firstDiagnostics = renderer.renderFeatureDiagnostics();
  let featureStatuses = firstDiagnostics.map((diagnostic) => diagnostic.status);
  const first: MatrixResult = {
    case: name,
    drawCount: drawCount(),
    featureStatuses,
    errorCodes: firstDiagnostics.flatMap((diagnostic) =>
      diagnostic.latestError === undefined ? [] : [diagnostic.latestError.code],
    ),
    passNames: [...renderer.perFramePassNames],
  };
  expect(result.ok).toBe(true);
  if (name === 'recovery') {
    expect(renderer.draw([world()], { owner: 0 }).ok).toBe(true);
    featureStatuses = renderer.renderFeatureDiagnostics().map((diagnostic) => diagnostic.status);
  }
  renderer.dispose();
  return { ...first, featureStatuses };
}

describe('prepared graphics full-stack regression matrix', () => {
  it('emits machine-readable accepted, mismatch, empty, and recovery cases', async () => {
    const accepted = await runCase('accepted');
    const mismatch = await runCase('mismatch');
    const empty = await runCase('empty');
    const recovery = await runCase('recovery');

    expect([accepted, mismatch, empty, recovery]).toEqual([
      expect.objectContaining({
        case: 'accepted',
        featureStatuses: ['active'],
        errorCodes: [],
      }),
      expect.objectContaining({
        case: 'mismatch',
        featureStatuses: ['failed'],
        errorCodes: ['render-feature-stage-failed'],
        drawCount: 0,
      }),
      expect.objectContaining({
        case: 'empty',
        featureStatuses: ['active'],
        errorCodes: [],
        drawCount: 0,
      }),
      expect.objectContaining({
        case: 'recovery',
        featureStatuses: ['active'],
        errorCodes: ['render-feature-stage-failed'],
      }),
    ]);
  });

  it('isolates one failed feature while retaining another feature and the base graph', async () => {
    const healthyState: FeatureState = {
      pipeline: undefined,
      bindings: undefined,
      vertices: undefined,
      firstContribution: true,
    };
    const failingState: FeatureState = {
      pipeline: undefined,
      bindings: undefined,
      vertices: undefined,
      firstContribution: true,
    };
    const renderer = await rendererWith([
      graphicsFeature('synthetic.healthy', healthyState, 'accepted'),
      graphicsFeature('synthetic.failing', failingState, 'mismatch'),
    ]);
    const drawCount = observeDrawCalls(renderer.device);
    const result = renderer.draw([world()], { owner: 0 });
    const diagnostics = renderer.renderFeatureDiagnostics();

    expect(result.ok).toBe(true);
    expect(diagnostics.map((diagnostic) => diagnostic.status)).toEqual(['active', 'failed']);
    expect(diagnostics[1]?.latestError?.code).toBe('render-feature-stage-failed');
    expect(renderer.perFramePassNames).toContain('synthetic.healthy::forward');
    expect(renderer.perFramePassNames).not.toContain('synthetic.failing::forward');
    expect(drawCount()).toBe(1);
    renderer.dispose();
  });

  it('keeps an unregistered feature identical to the baseline renderer path', async () => {
    const renderer = await rendererWith([]);
    const drawCount = observeDrawCalls(renderer.device);
    let submits = 0;
    const submit = renderer.device.queue.submit.bind(renderer.device.queue);
    renderer.device.queue.submit = (buffers) => {
      submits += 1;
      return submit(buffers);
    };

    const result = renderer.draw([world()], { owner: 0 });

    expect(result.ok).toBe(true);
    expect(renderer.renderFeatureDiagnostics()).toEqual([]);
    expect(renderer.perFramePassNames).toEqual(['base']);
    expect(drawCount()).toBe(0);
    expect(submits).toBe(1);
    renderer.dispose();
  });
});
