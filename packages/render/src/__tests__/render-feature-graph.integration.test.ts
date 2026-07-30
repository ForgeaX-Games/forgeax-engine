import { World } from '@forgeax/engine-ecs';
import { RenderGraph } from '@forgeax/engine-render-graph';
import { type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { constructRenderer } from '../construct-renderer';
import type { RenderFeature, RenderFeaturePassContext } from '../features/types';
import type { RenderPipeline } from '../render-pipeline';
import type { RenderPipelineContext } from '../render-pipeline-context';
import type { RendererError } from '../renderer';

const resource = { kind: 'texture' as const, lifetime: 'transient' as const };
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

function feature(
  identity: string,
  trace: string[],
  passNames: { current: readonly string[] },
  behavior: 'pass' | 'throw' = 'pass',
): RenderFeature<{ readonly identity: string }> {
  return {
    identity,
    extract: () => ok({ identity }),
    prepare: () => ok(undefined),
    contribute: (_data, context) => {
      for (const name of passNames.current) {
        context.staging.addResource(name, resource).unwrap();
        context.staging
          .addPass(name, {
            reads: [],
            writes: [name],
            execute: (passContext: RenderFeaturePassContext) => {
              expect(passContext.pass.name).toBe(`${identity}::${name}`);
              if (behavior === 'throw') throw new Error('synthetic pass failure');
              trace.push(`${identity}:${name}`);
            },
          })
          .unwrap();
      }
      return ok(undefined);
    },
  };
}

function pipeline(
  trace: string[],
  builds: { count: number; graph: RenderGraph<RenderPipelineContext> | undefined },
): RenderPipeline {
  return {
    buildGraph: (context) => {
      builds.count += 1;
      const graph = new RenderGraph<RenderPipelineContext>();
      graph.addResource('base', resource);
      graph.addPass('base', {
        reads: [],
        writes: ['base'],
        execute: () => trace.push('base'),
      });
      const compiled = graph.compile({
        backendKind: context.runtime.device.caps.backendKind,
        caps: context.runtime.device.caps,
        device: context.runtime.device,
      });
      expect(compiled.ok).toBe(true);
      builds.graph = graph;
      return graph;
    },
    execute: () => undefined,
  };
}

describe('render feature graph composition', () => {
  it('uses the active RenderSystem graph and one submit boundary', async () => {
    const trace: string[] = [];
    const builds = {
      count: 0,
      graph: undefined as RenderGraph<RenderPipelineContext> | undefined,
    };
    const alphaPasses = { current: ['alpha-a', 'alpha-b'] as readonly string[] };
    const betaPasses = { current: ['beta-a'] as readonly string[] };
    const renderer = await constructRenderer(
      canvas(),
      {
        rhi,
        features: [
          feature('synthetic.alpha', trace, alphaPasses),
          feature('synthetic.beta', trace, betaPasses),
        ],
      },
      { shaderManifestUrl: manifest },
    );
    expect((await renderer.ready).ok).toBe(true);

    renderer.registerPipeline('synthetic::pipeline', pipeline(trace, builds));
    expect(
      renderer.installPipeline({
        kind: 'render-pipeline',
        pipelineId: 'synthetic::pipeline',
      }).ok,
    ).toBe(true);

    const device = renderer.device as RhiNullDevice;
    const queue = device.queue as typeof device.queue & {
      submit: typeof device.queue.submit;
    };
    const submit = queue.submit.bind(queue);
    let submitCount = 0;
    queue.submit = (buffers) => {
      submitCount += 1;
      return submit(buffers);
    };

    const drawn = renderer.draw([new World()], { owner: 0 });

    expect(drawn.ok).toBe(true);
    expect(builds.graph).toBeDefined();
    expect(renderer.perFramePassNames).toEqual(builds.graph?.listPasses().map((pass) => pass.name));
    expect(renderer.perFramePassNames).toEqual([
      'base',
      'synthetic.alpha::alpha-a',
      'synthetic.alpha::alpha-b',
      'synthetic.beta::beta-a',
    ]);
    expect(trace).toEqual([
      'base',
      'synthetic.alpha:alpha-a',
      'synthetic.alpha:alpha-b',
      'synthetic.beta:beta-a',
    ]);
    expect(device.totalDrawCount).toBe(0);
    expect(submitCount).toBe(1);
    expect(builds.count).toBe(1);

    trace.length = 0;
    device.totalDrawCount = 0;
    submitCount = 0;
    expect(renderer.draw([new World()], { owner: 0 }).ok).toBe(true);
    expect(builds.count).toBe(1);
    expect(submitCount).toBe(1);
    expect(trace).toEqual([
      'base',
      'synthetic.alpha:alpha-a',
      'synthetic.alpha:alpha-b',
      'synthetic.beta:beta-a',
    ]);

    alphaPasses.current = ['alpha-rebuilt'];
    trace.length = 0;
    device.totalDrawCount = 0;
    submitCount = 0;
    expect(renderer.draw([new World()], { owner: 0 }).ok).toBe(true);
    expect(builds.count).toBe(2);
    expect(submitCount).toBe(1);
    expect(renderer.perFramePassNames).toContain('synthetic.alpha::alpha-rebuilt');
    expect(trace).toContain('synthetic.alpha:alpha-rebuilt');
  });

  it('attributes graph pass failures to the owning feature', async () => {
    const passErrors: Array<Extract<RendererError, { code: 'render-feature-stage-failed' }>> = [];
    const passRenderer = await constructRenderer(
      canvas(),
      {
        rhi,
        features: [feature('synthetic.pass-failure', [], { current: ['draw'] }, 'throw')],
      },
      { shaderManifestUrl: manifest },
    );
    passRenderer.onError((error) => {
      if (error.code === 'render-feature-stage-failed') passErrors.push(error);
    });
    expect((await passRenderer.ready).ok).toBe(true);
    passRenderer.registerPipeline(
      'synthetic::pipeline',
      pipeline([], { count: 0, graph: undefined }),
    );
    expect(
      passRenderer.installPipeline({
        kind: 'render-pipeline',
        pipelineId: 'synthetic::pipeline',
      }).ok,
    ).toBe(true);
    expect(passRenderer.draw([new World()], { owner: 0 }).ok).toBe(true);
    const passError = passErrors.find((error) => error.code === 'render-feature-stage-failed');
    expect(passError?.detail).toMatchObject({
      featureIdentity: 'synthetic.pass-failure',
      stage: 'contribute',
    });
    expect(passRenderer.renderFeatureDiagnostics()[0]?.latestError).toMatchObject({
      code: passError?.code,
      expected: passError?.expected,
      hint: passError?.hint,
      detail: passError?.detail,
    });
  });
});
