import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import type {
  RenderFeatureGraphicsPassDescriptor,
  RenderFeaturePreparedGraphicsState,
  RenderFeaturePreparedRef,
} from '../features/prepared-graphics';
import type { PreparedGraphicsResolvedResource } from '../prepare/prepared-graphics-resolver';
import {
  type RenderFeatureGraphicsRecordingLedger,
  recordResolvedRenderFeatureGraphicsPass,
} from '../record/frame-targets';

function ref<Kind extends RenderFeaturePreparedRef['kind']>(
  kind: Kind,
  generation = 3,
): RenderFeaturePreparedRef<Kind> {
  return Object.freeze({ kind, generation });
}

const pipeline = ref('pipeline');
const bindings = ref('bindings');
const vertices = ref('vertex-data');

const pass: RenderFeatureGraphicsPassDescriptor = {
  attachments: {
    colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
  },
  draws: [
    {
      kind: 'draw',
      pipeline,
      bindings: [bindings],
      vertexData: [{ slot: 0, resource: vertices }],
      command: { vertexCount: 3, instanceCount: 1 },
    },
  ],
};

const state: RenderFeaturePreparedGraphicsState = {
  capabilityAvailable: true,
  generation: 3,
  attachments: [{ resource: 'color', format: 'rgba8unorm' }],
  pipeline,
  bindings: [bindings],
  vertexData: [vertices],
  indexData: [],
};

function ledger(calls: unknown[]): RenderFeatureGraphicsRecordingLedger {
  return {
    pipeline: 0,
    binding: 0,
    vertex: 0,
    index: 0,
    draw: 0,
    setPipeline: (handle) => calls.push(handle),
    setBindGroup: (handle) => calls.push(handle),
    setVertexBuffer: (_slot, handle) => calls.push(handle),
    recordDraw: () => undefined,
  };
}

describe('resolved prepared graphics recording', () => {
  it('records current-device handles from the private resolved lookup', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const buffer = device.createBuffer({ size: 4, usage: 40 }).unwrap();
    const shader = (
      await rhi.createShaderModule(device, { code: 'synthetic' })
    ).unwrap() as unknown as GPUShaderModule;
    const pipelineHandle = device
      .createRenderPipeline({
        layout: 'auto',
        vertex: { module: shader, entryPoint: 'main', buffers: [] },
        fragment: { module: shader, entryPoint: 'main', targets: [] },
      })
      .unwrap();
    const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const bindingsHandle = device.createBindGroup({ layout, entries: [] }).unwrap();
    const resources = new Map<object, PreparedGraphicsResolvedResource>([
      [pipeline, { kind: 'pipeline', reference: pipeline, handle: pipelineHandle }],
      [bindings, { kind: 'bindings', reference: bindings, handle: bindingsHandle }],
      [vertices, { kind: 'vertex-data', reference: vertices, handle: buffer }],
    ]);
    const calls: unknown[] = [];
    const resolved = {
      generation: 3,
      resolve: (reference: RenderFeaturePreparedRef) => resources.get(reference),
    };
    const result = recordResolvedRenderFeatureGraphicsPass(
      'synthetic.resolved',
      pass,
      state,
      resolved,
      ledger(calls),
    );
    expect(result).toMatchObject({ ok: true, value: { acceptedDrawCount: 1 } });
    expect(calls).toEqual([pipelineHandle, bindingsHandle, buffer]);
    expect(calls).not.toContain(pipeline);
    expect(calls).not.toContain(bindings);
    expect(calls).not.toContain(vertices);
  });

  it('rejects unresolved work before the first recording mutation', () => {
    const calls: unknown[] = [];
    const result = recordResolvedRenderFeatureGraphicsPass(
      'synthetic.invalid',
      pass,
      state,
      { generation: 3, resolve: () => undefined },
      ledger(calls),
    );
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('forwards prepared binding dynamic offsets to the render pass', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const buffer = device.createBuffer({ size: 4, usage: 40 }).unwrap();
    const shader = (
      await rhi.createShaderModule(device, { code: 'synthetic' })
    ).unwrap() as unknown as GPUShaderModule;
    const pipelineHandle = device
      .createRenderPipeline({
        layout: 'auto',
        vertex: { module: shader, entryPoint: 'main', buffers: [] },
        fragment: { module: shader, entryPoint: 'main', targets: [] },
      })
      .unwrap();
    const layout = device.createBindGroupLayout({ entries: [] }).unwrap();
    const bindingsHandle = device.createBindGroup({ layout, entries: [] }).unwrap();
    const resources = new Map<object, PreparedGraphicsResolvedResource>([
      [pipeline, { kind: 'pipeline', reference: pipeline, handle: pipelineHandle }],
      [
        bindings,
        {
          kind: 'bindings',
          reference: bindings,
          handle: bindingsHandle,
          dynamicOffsets: [256],
        },
      ],
      [vertices, { kind: 'vertex-data', reference: vertices, handle: buffer }],
    ]);
    const calls: unknown[] = [];
    const result = recordResolvedRenderFeatureGraphicsPass(
      'synthetic.dynamic-offset',
      pass,
      state,
      { generation: 3, resolve: (reference) => resources.get(reference) },
      {
        ...ledger(calls),
        setBindGroupAt: (index, handle, offsets) => calls.push([index, handle, offsets]),
      },
    );

    expect(result).toMatchObject({ ok: true });
    expect(calls).toContainEqual([0, bindingsHandle, [256]]);
  });
});
