import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RenderPipelineFrame } from '../../render-pipeline';
import { createRenderPipelineTarget } from '../../render-pipeline';
import { sortDispatchByQueue } from '../../render-system-extract';
import { addTransmissionBackdropPasses, type TransmissionBackdropGraph } from '../backdrop';
import { fresnelReflectance, resolveRefractionBackdrop } from '../oracle.js';

let device: RhiDevice;

beforeAll(async () => {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const created = await adapter.value.requestDevice();
  if (!created.ok) throw created.error;
  device = created.value;
});

async function buildComposition(): Promise<{
  readonly graph: TransmissionBackdropGraph;
  readonly passes: readonly string[];
  readonly accesses: ReadonlyMap<string, readonly string[]>;
  readonly roughMipLevels: readonly number[];
}> {
  const roughMipLevels: number[] = [];
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const source = createRenderPipelineTarget(graph, 'opaque-resolved', {
    format: 'rgba16float',
    size: 'surface',
    sampleCount: 1,
  });
  if (!source.ok) throw source.error;
  graph
    .addRasterPass('opaque-resolve', {
      accesses: [{ resource: source.value.view, usage: 'color-attachment' }],
      colorAttachments: [{ view: source.value.view, loadOp: 'clear', storeOp: 'store' }],
      encode: () => undefined,
    })
    .unwrap();

  const added = addTransmissionBackdropPasses({
    graph,
    source: source.value,
    demand: { activeCount: 1, needsRoughMips: true },
    copySize: { width: 8, height: 4 },
    encodeRoughMip: ({ pass, level }) => {
      roughMipLevels.push(level);
      pass.draw(3, 1, 0, 0);
    },
  });
  if (!added.ok) throw added.error;
  const compiled = graph.compile({ device, surfaceSize: { width: 8, height: 4 } });
  if (!compiled.ok) throw compiled.error;
  const encoder = device.createCommandEncoder({ label: 'transmission-composition-test' });
  if (!encoder.ok) throw encoder.error;
  const executed = compiled.value.execute({ encoder: encoder.value } as RenderPipelineFrame);
  if (!executed.ok) throw executed.error;
  const finished = encoder.value.finish();
  if (!finished.ok) throw finished.error;
  const inspected = compiled.value.inspect();
  return {
    graph: added.value,
    passes: inspected.passes.map((pass) => pass.name),
    accesses: new Map(
      inspected.passes.map((pass) => [
        pass.name,
        pass.accesses.map((access) => `${access.resource}:${access.usage}`),
      ]),
    ),
    roughMipLevels,
  };
}

function expectCompositionContract(
  passes: readonly string[],
  accesses: ReadonlyMap<string, readonly string[]>,
): void {
  expect(passes).toEqual([
    'opaque-resolve',
    'transmission-backdrop-copy',
    'transmission-backdrop-mip',
    'transmission-backdrop-mip-2',
    'transmission-backdrop-mip-3',
    'transmission-forward',
    'transparent',
    'temporal',
  ]);
  expect(accesses.get('transmission-backdrop-copy')).toEqual([
    'opaque-resolved:copy-src',
    'transmission-backdrop:copy-dst',
  ]);
}

describe('transmission composition integration', () => {
  it('keeps one shared backdrop copy before single-layer consumers', async () => {
    const built = await buildComposition();

    expect(built.graph.topology).toMatchObject({
      active: true,
      copyCount: 1,
      mipCount: 1,
      aliasCount: 0,
    });
    expectCompositionContract(built.passes, built.accesses);
    expect(built.roughMipLevels).toEqual([1, 2, 3]);
  });

  it('falls back from edge or TIR refraction through environment to unrefracted color', () => {
    expect(
      resolveRefractionBackdrop({
        uv: [0.01, 0.5],
        refracted: [0.1, 0.2, 0.3],
        environment: [0.4, 0.5, 0.6],
        unrefracted: [0.7, 0.8, 0.9],
      }),
    ).toEqual({ source: 'environment', color: [0.4, 0.5, 0.6] });
    expect(
      resolveRefractionBackdrop({
        uv: [0.01, 0.5],
        unrefracted: [0.7, 0.8, 0.9],
      }),
    ).toEqual({ source: 'unrefracted', color: [0.7, 0.8, 0.9] });
    expect(fresnelReflectance(0.5, 1.5)).toBe(1);
  });

  it('keeps transmission layers before ordinary BLEND in stable queue order', () => {
    const ordered = sortDispatchByQueue([
      { id: 'near-blend', queue: 3000 },
      { id: 'near-transmission', queue: 2001 },
      { id: 'far-transmission', queue: 2000 },
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual([
      'far-transmission',
      'near-transmission',
      'near-blend',
    ]);
  });

  it.each([
    [
      'omitted-backdrop-copy',
      (passes: readonly string[]) => passes.filter((name) => name !== 'transmission-backdrop-copy'),
    ],
    ['reversed-phase-order', (passes: readonly string[]) => [...passes].reverse()],
  ] as const)('dev falsifier %s breaks the composition contract', async (_name, falsify) => {
    const built = await buildComposition();
    expect(() => expectCompositionContract(falsify(built.passes), built.accesses)).toThrow();
  });

  it('dev falsifier reactive-zero-coverage breaks the composition contract', async () => {
    const built = await buildComposition();
    expect(() =>
      expectCompositionContract(
        built.passes.filter((name) => name !== 'temporal'),
        built.accesses,
      ),
    ).toThrow();
  });
});
