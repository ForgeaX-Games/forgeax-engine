import { type RasterGraphPass, RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { addStandardDeferredLighting } from '../pipeline/standard-deferred-lighting';
import { buildPerFrameBindGroups } from '../record/frame-lighting';
import { prepareMaterialSkylight } from '../record/main-pass-material';
import type { RenderPipelineFrame } from '../render-pipeline';

vi.mock('../record/frame-lighting', () => ({ buildPerFrameBindGroups: vi.fn() }));
vi.mock('../record/main-pass-material', () => ({ prepareMaterialSkylight: vi.fn() }));

it('rebinds Deferred geometry when only the receiver texture view changes', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const texture = device
    .createTexture({ size: { width: 1, height: 1 }, format: 'r32uint', usage: 4 })
    .unwrap();
  const stable = device.createTextureView(texture, {}).unwrap();
  const replacement = device.createTextureView(texture, {}).unwrap();
  const buffer = device.createBuffer({ size: 256, usage: 0x40 | 0x80 }).unwrap();
  const sampler = device.createSampler({}).unwrap();
  const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
  const group = device.createBindGroup({ layout, entries: [] }).unwrap();
  vi.mocked(buildPerFrameBindGroups).mockReturnValue({ viewBindGroup: group } as ReturnType<
    typeof buildPerFrameBindGroups
  >);
  vi.mocked(prepareMaterialSkylight).mockReturnValue({
    skylightResources: {
      irradianceView: stable,
      prefilterView: stable,
      brdfLutView: stable,
      irradianceSampler: sampler,
      prefilterSampler: sampler,
      intensityBuffer: buffer,
    },
  } as ReturnType<typeof prepareMaterialSkylight>);
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const raster = vi.spyOn(graph, 'addRasterPass');
  const target = (name: string) => {
    const texture = graph
      .createTexture(name, { size: { width: 1, height: 1 }, format: 'r32uint' })
      .unwrap();
    return {
      texture,
      view: graph.view(texture, {}).unwrap(),
      format: 'r32uint' as const,
      sampleCount: 1 as const,
    };
  };
  const receiver = target('receiver');
  const surface = target('surface');
  addStandardDeferredLighting(graph, {
    color: surface,
    gbuffer: [surface, surface, surface, surface],
    receiverGeometry: receiver,
    depth: surface.view,
    spotShadow: surface,
    cluster: null,
    extraAccesses: [],
    size: { width: 1, height: 1 },
  }).unwrap();
  const encode = raster.mock.calls.find(([name]) => name === 'lighting')?.[1].encode;
  expect(encode).toBeDefined();
  const frame = {
    runtime: {
      device,
      standardDeferredShaders: { unclustered: '' },
      shaderModuleFactory: {
        createShaderModule: (desc: Parameters<typeof createShaderModuleImmediate>[1]) =>
          createShaderModuleImmediate(device, desc),
      },
    },
    frameState: {},
    pipelineState: { viewBindGroupLayout: layout, defaultWhiteTextureView: stable },
    bindGroupCounts: { createBindGroup: 0, keys: [] },
  } as unknown as RenderPipelineFrame;
  const createGroup = vi.spyOn(device, 'createBindGroup');
  let receiverView = stable;
  const context = {
    frame,
    resources: {
      textureView: (ref: typeof receiver.view) => ok(ref === receiver.view ? receiverView : stable),
      buffer: () => ok(buffer),
    },
    pass: { setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn() },
  } as unknown as Parameters<RasterGraphPass<RenderPipelineFrame>['encode']>[0];
  encode?.(context);
  const groups = () =>
    createGroup.mock.calls.filter(([desc]) =>
      Array.from(desc.entries).some((entry) => entry.binding === 15),
    );
  expect(groups()).toHaveLength(1);
  encode?.(context);
  expect(groups()).toHaveLength(1);
  receiverView = replacement;
  encode?.(context);
  expect(groups()).toHaveLength(2);
  expect(
    Array.from(groups()[1]?.[0].entries ?? []).find((entry) => entry.binding === 15)?.resource,
  ).toEqual({
    kind: 'textureView',
    value: replacement,
  });
  expect(context.pass.setBindGroup).toHaveBeenCalledTimes(12);
  device.destroyBuffer(buffer).unwrap();
  device.destroyTexture(texture).unwrap();
});
