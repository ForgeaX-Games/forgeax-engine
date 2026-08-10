import { RenderGraph, type ResourceDescriptor } from '@forgeax/engine-render-graph';
import { err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeaturePreparationFailedError } from '../errors/render';
import type { RenderFeatureGraphContribution } from '../features/graph-contribution';
import {
  composeRenderFeatureGraph,
  createRenderFeatureContributionStaging,
} from '../features/graph-contribution';
import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import { createRenderFeatureTarget } from '../features/targets';

const target: ResourceDescriptor = { kind: 'texture', lifetime: 'transient' };

const pass: RenderFeatureGraphicsPassDescriptor = {
  attachments: {
    colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
  },
  draws: [
    {
      kind: 'draw',
      pipeline: { kind: 'pipeline', generation: 2 } as RenderFeaturePreparedRef<'pipeline'>,
      bindings: [{ kind: 'bindings', generation: 2 }],
      vertexData: [{ slot: 0, resource: { kind: 'vertex-data', generation: 2 } }],
      command: { vertexCount: 3, instanceCount: 1 },
    },
  ],
};

describe('render feature graphics staging', () => {
  it('projects the latest resolved graphics snapshot after a topology-stable update', () => {
    const graphicsState: RenderFeaturePreparedGraphicsState = {
      capabilityAvailable: true,
      generation: 1,
      attachments: [],
      pipeline: pass.draws[0]?.pipeline,
      bindings: pass.draws[0]?.bindings ?? [],
      vertexData: pass.draws[0]?.vertexData.map((vertex) => vertex.resource) ?? [],
      indexData: [],
    };
    const contribution = (generation: number): RenderFeatureGraphContribution => ({
      featureIdentity: 'synthetic.graphics',
      order: 0,
      resources: [],
      passes: [
        {
          featureIdentity: 'synthetic.graphics',
          order: 0,
          name: 'synthetic.graphics::forward',
          descriptor: { reads: [], writes: [] },
          dependsOn: [],
          graphics: pass,
          graphicsState,
          resolvedGraphics: {
            generation,
            resolve: () => undefined,
          },
        },
      ],
      topologySignature: 'synthetic.graphics::forward',
    });
    const observed: number[] = [];
    const graph = new RenderGraph();
    const composed = composeRenderFeatureGraph(graph, [contribution(1)], (ctx, current) => {
      void ctx;
      observed.push(current.resolvedGraphics?.generation ?? -1);
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(graph.compile({ backendKind: 'null', caps: {} as never }).ok).toBe(true);
    graph.execute(undefined);
    expect(composed.value.update([contribution(2)]).topologyChanged).toBe(false);
    graph.execute(undefined);
    expect(observed).toEqual([1, 2]);
  });

  it('projects an accepted graphics pass into the active graph contribution', () => {
    const staging = createRenderFeatureContributionStaging('synthetic.graphics', 0);
    expect(staging.addResource('color', target).ok).toBe(true);
    expect(staging.addGraphicsPass('forward', pass).ok).toBe(true);

    const contribution = staging.commit();
    expect(contribution.ok).toBe(true);
    if (!contribution.ok) return;
    expect(contribution.value.passes).toHaveLength(1);
    expect(contribution.value.passes[0]).toMatchObject({
      name: 'synthetic.graphics::forward',
      graphics: pass,
    });

    const graph = new RenderGraph();
    const composed = composeRenderFeatureGraph(graph, [contribution.value]);
    expect(composed.ok).toBe(true);
    if (composed.ok) {
      expect(composed.value.passNames).toEqual(['synthetic.graphics::forward']);
      expect(composed.value.graph).toBe(graph);
    }
  });

  it('keeps the reserved swapchain attachment unqualified', () => {
    const staging = createRenderFeatureContributionStaging('synthetic.graphics', 0);
    const swapchainPass: RenderFeatureGraphicsPassDescriptor = {
      ...pass,
      attachments: {
        colors: [
          { resource: 'swapchain', format: 'rgba8unorm-srgb', loadOp: 'load', storeOp: 'store' },
        ],
      },
    };
    expect(staging.addGraphicsPass('overlay', swapchainPass).ok).toBe(true);
    const contribution = staging.commit();
    expect(contribution.ok).toBe(true);
    if (!contribution.ok) return;
    expect(contribution.value.passes[0]?.descriptor.writes).toEqual(['swapchain']);
  });

  it('uses render-pipeline target handles to order scene features before post-processing', () => {
    const colorTarget = createRenderFeatureTarget({
      kind: 'scene-color',
      resource: 'sceneColor',
      format: 'rgba16float',
      sampleCount: 1,
    });
    const depthTarget = createRenderFeatureTarget({
      kind: 'scene-depth',
      resource: 'depth',
      format: 'depth24plus-stencil8',
      sampleCount: 1,
    });
    const targetPass: RenderFeatureGraphicsPassDescriptor = {
      ...pass,
      attachments: {
        colors: [
          { resource: colorTarget, format: colorTarget.format, loadOp: 'load', storeOp: 'store' },
        ],
        depthStencil: {
          resource: depthTarget,
          format: depthTarget.format,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
        },
      },
    };
    const staging = createRenderFeatureContributionStaging('synthetic.scene', 0);
    expect(staging.addGraphicsPass('particles', targetPass).ok).toBe(true);
    const contribution = staging.commit();
    expect(contribution.ok).toBe(true);
    if (!contribution.ok) return;

    const graph = new RenderGraph();
    graph.addColorTarget('hdrColor', {
      format: 'rgba16float',
      size: 'swapchain',
      sample: 1,
      usage: 0x10,
    });
    graph.addColorTargetAlias('sceneColor', 'hdrColor');
    graph.addColorTarget('depth', {
      format: 'depth24plus-stencil8',
      size: 'swapchain',
      sample: 1,
      usage: 0x10,
    });
    const observed: string[] = [];
    graph.addPass('skybox', {
      reads: [],
      writes: ['hdrColor'],
      execute: () => observed.push('skybox'),
    });
    graph.addPass('main', {
      reads: ['hdrColor'],
      writes: ['sceneColor', 'depth'],
      execute: () => observed.push('main'),
    });
    graph.addPass('tonemap', {
      reads: ['sceneColor'],
      writes: ['swapchain'],
      execute: () => observed.push('tonemap'),
    });
    graph.addPass('debug-overlay', {
      reads: ['sceneColor'],
      writes: [],
      execute: () => observed.push('debug-overlay'),
    });
    expect(
      composeRenderFeatureGraph(graph, [contribution.value], (_ctx, _pass, _resolve, execute) => {
        execute(undefined as never);
        observed.push('synthetic.scene::particles');
      }).ok,
    ).toBe(true);

    expect(graph.compile({ backendKind: 'null', caps: {} as never }).ok).toBe(true);
    graph.execute(undefined);
    expect(observed).toEqual([
      'skybox',
      'main',
      'synthetic.scene::particles',
      'tonemap',
      'debug-overlay',
    ]);
    expect(contribution.value.passes[0]?.descriptor).toMatchObject({
      reads: ['depth'],
      writes: ['sceneColor'],
    });
  });

  it('keeps ordinary addPass graph-only and contributes no work for an empty draw list', () => {
    const staging = createRenderFeatureContributionStaging('synthetic.empty', 0);
    const empty: RenderFeatureGraphicsPassDescriptor = { ...pass, draws: [] };
    expect(staging.addGraphicsPass('empty', empty).ok).toBe(true);
    const contribution = staging.commit();
    expect(contribution.ok).toBe(true);
    if (contribution.ok) {
      expect(contribution.value.passes).toHaveLength(0);
      expect(contribution.value.resources).toHaveLength(0);
    }
  });

  it('treats asynchronous pipeline warm-up as an empty retryable frame', () => {
    const staging = createRenderFeatureContributionStaging('synthetic.warmup', 0, undefined, () =>
      err(
        new RenderFeaturePreparationFailedError(
          'synthetic.warmup',
          0,
          'resolve',
          'pipeline',
          'custom-material',
          'pipeline-pending',
          'next-frame',
        ),
      ),
    );

    expect(staging.addGraphicsPass('warmup', pass).ok).toBe(true);
    const contribution = staging.commit();
    expect(contribution.ok).toBe(true);
    if (contribution.ok) expect(contribution.value.passes).toHaveLength(0);
  });

  it('aborts graphics staging without creating a feature-private graph', () => {
    const staging = createRenderFeatureContributionStaging('synthetic.failed', 0);
    expect(staging.addResource('color', target).ok).toBe(true);
    expect(staging.addGraphicsPass('forward', pass).ok).toBe(true);
    staging.abort();
    expect(staging.resources).toEqual([]);
    expect(staging.passes).toEqual([]);
    expect(staging.commit().ok).toBe(false);
  });
});
