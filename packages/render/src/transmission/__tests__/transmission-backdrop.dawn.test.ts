import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { describe, expect, it } from 'vitest';
import type { RenderPipelineFrame } from '../../render-pipeline';
import { createRenderPipelineTarget } from '../../render-pipeline';
import { addTransmissionBackdropPasses, type TransmissionBackdropGraph } from '../backdrop';

async function buildBackdrop(device: RhiDevice): Promise<TransmissionBackdropGraph> {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const source = createRenderPipelineTarget(graph, 'opaque-resolved', {
    format: 'rgba16float',
    size: 'surface',
    sampleCount: 1,
  });
  expect(source.ok).toBe(true);
  if (!source.ok) throw source.error;
  graph
    .addRasterPass('opaque', {
      accesses: [{ resource: source.value.view, usage: 'color-attachment' }],
      colorAttachments: [{ view: source.value.view, loadOp: 'clear', storeOp: 'store' }],
      encode: () => undefined,
    })
    .unwrap();
  const added = addTransmissionBackdropPasses({
    graph,
    source: source.value,
    demand: { activeCount: 2, needsRoughMips: true },
    copySize: { width: 4, height: 4 },
    encodeRoughMip: ({ pass }) => {
      pass.draw(3, 1, 0, 0);
    },
  });
  expect(added.ok).toBe(true);
  if (!added.ok) throw added.error;
  const compiled = graph.compile({ device, surfaceSize: { width: 4, height: 4 } });
  if (!compiled.ok) throw compiled.error;
  const names = compiled.value.inspect().passes.map((pass) => pass.name);
  expect(names).toEqual([
    'opaque',
    'transmission-backdrop-copy',
    'transmission-backdrop-mip',
    'transmission-backdrop-mip-2',
    'transmission-forward',
    'transparent',
    'temporal',
  ]);
  expect(compiled.value.inspect().resources.map((resource) => resource.label)).toContain(
    'transmission-backdrop',
  );
  return added.value;
}

describe('TransmissionBackdrop Dawn topology', () => {
  it('compiles the single rgba16float backdrop with one copy and raster mip', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const result = await buildBackdrop(device);

    expect(result.topology).toMatchObject({
      active: true,
      copyCount: 1,
      mipCount: 1,
      submitCount: 1,
      aliasCount: 0,
    });
  });

  it('does not allocate a backdrop on exact-zero demand', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const source = createRenderPipelineTarget(graph, 'opaque-resolved', {
      format: 'rgba16float',
      size: 'surface',
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const added = addTransmissionBackdropPasses({
      graph,
      source: source.value,
      demand: { activeCount: 0, needsRoughMips: false },
      copySize: { width: 1, height: 1 },
    });
    expect(added).toEqual({
      ok: true,
      value: {
        topology: {
          active: false,
          sourceSampleCount: 1,
          copyCount: 0,
          mipCount: 0,
          submitCount: 1,
          aliasCount: 0,
          phases: [],
        },
        backdrop: undefined,
        mipViews: [],
      },
    });
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(compiled.value.inspect().passes).toEqual([]);
  });
});
