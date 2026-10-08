import { RenderGraphBuilder, type RenderGraphFrame } from '@forgeax/engine-render-graph';
import * as nullRhi from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import { createRayPathTracer } from '../../raytracing/path-tracer';
import { prepareRayRecordingFixture } from './path-tracer.commands';
import { plane, settings } from './path-tracer.fixture';

it('records 16 deep MASK samples with the graph usage boundaries and every dispatch intact', async () => {
  const fixture = await prepareRayRecordingFixture();
  const material = fixture.material;
  const device = (await (await nullRhi.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  if (!(device instanceof nullRhi.RhiNullDevice)) throw new Error('expected structural backend');
  const textureDescriptor = {
    size: { width: 2, height: 1 },
    format: 'rgba8unorm' as const,
    usage: 6,
  };
  const texture = device.createTexture(textureDescriptor).unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const sampler = device.createSampler({}).unwrap();
  const tracer = (
    await createRayPathTracer(device, nullRhi.createShaderModule, {
      kernel: fixture.kernel,
      scene: buildRaySurfaceScene(
        Array.from({ length: 25 }, (_, id) => ({ ...plane(id), instanceId: id })),
      ).unwrap(),
      materials: Array.from({ length: 25 }, (_, id) => ({ ...material, id })),
      lights: [],
      settings: { ...settings, maxBounces: 8 },
      resolveTexture: () => ok({ view, sampler }),
    })
  ).unwrap();
  const graph = new RenderGraphBuilder<RenderGraphFrame>();
  const imported = graph.importTexture('coverage', textureDescriptor, () => texture).unwrap();
  const graphView = graph.importView(imported, {}, () => view).unwrap();
  tracer
    .addSampleToGraph(graph, {
      label: 'deep-mask',
      buffers: new Map(),
      textures: new Map([[view, graphView]]),
      reset: false,
    })
    .unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 8, height: 8 } }).unwrap();
  try {
    const graphPasses = compiled.inspect().passes.filter((pass) => pass.kind === 'compute').length;
    const beforeDispatches = device.totalDispatchCount;
    const beforePasses = device.framePassNames.length;
    const encoder = device.createCommandEncoder({}).unwrap();
    for (let sample = 0; sample < 16; sample++) tracer.recordSample(encoder).unwrap();
    expect(device.totalDispatchCount - beforeDispatches).toBe(16 * tracer.dispatchCount);
    expect(device.framePassNames.length - beforePasses).toBe(16 * graphPasses);
    expect(graphPasses).toBeLessThan(tracer.dispatchCount);
  } finally {
    await compiled.retire();
    tracer.dispose();
    device.destroyTexture(texture).unwrap();
  }
}, 120000);
