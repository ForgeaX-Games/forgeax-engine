import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import type { PassSelector } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import type { RenderPipelineFrame } from '../render-pipeline';
import { createRenderPipelineTarget } from '../render-pipeline';

const { encodeMainPass, buildPerFrameBindGroups } = vi.hoisted(() => ({
  encodeMainPass: vi.fn(),
  buildPerFrameBindGroups: vi.fn(),
}));

vi.mock('../record/main-pass', () => ({ encodeMainPass }));
vi.mock('../record/frame-lighting', () => ({ buildPerFrameBindGroups }));

import { addTypedScenePass } from '../typed-render-graph-primitives';

function targetDescriptor(format: 'rgba8unorm' | 'depth24plus-stencil8') {
  return { format, size: { width: 1, height: 1 } };
}

function frameFor(device: RhiDevice, materialSlots: readonly object[]): RenderPipelineFrame {
  return {
    encoder: device.createCommandEncoder({ label: 'material-cache-test' }).unwrap(),
    runtime: {
      device,
      errorRegistry: { fire: vi.fn() },
    },
    frameState: {},
    pipelineState: { colorAttachmentFormat: 'rgba8unorm' },
    validated: [],
    validatedOrdered: [],
    materialSlots,
    materialSlotCount: materialSlots.length,
    bindGroupCounts: {},
  } as unknown as RenderPipelineFrame;
}

describe('typed scene pass material payload cache', () => {
  it('reuses one frame owner cache across scene passes and refreshes on a new frame', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    buildPerFrameBindGroups.mockReturnValue({
      viewBindGroup: null,
      meshBindGroup: null,
      hdrpClusterBindGroup: null,
      hdrpClusterMembershipBindGroup: null,
    });

    const materialA = [{ id: 'A' }];
    const materialB = [{ id: 'B' }];
    const payloadA = new Uint8Array([1]);
    const payloadB = new Uint8Array([2]);
    const seenCacheInputs: Array<unknown> = [];
    encodeMainPass.mockImplementation(
      (
        context: {
          materialSlots: readonly object[];
          materialSlotCount: number;
          materialUboPayloadCache?: {
            materialSlots: readonly object[];
            materialSlotCount: number;
            payload: Uint8Array;
          };
        },
        _pass: { end(): void },
      ) => {
        seenCacheInputs.push(context.materialUboPayloadCache);
        const payload = context.materialSlots === materialA ? payloadA : payloadB;
        if (
          context.materialUboPayloadCache?.materialSlots !== context.materialSlots ||
          context.materialUboPayloadCache?.materialSlotCount !== context.materialSlotCount
        ) {
          context.materialUboPayloadCache = {
            materialSlots: context.materialSlots,
            materialSlotCount: context.materialSlotCount,
            payload,
          };
        }
      },
    );

    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const color = createRenderPipelineTarget(
      graph,
      'material-cache-color',
      targetDescriptor('rgba8unorm'),
    ).unwrap();
    const depth = createRenderPipelineTarget(
      graph,
      'material-cache-depth',
      targetDescriptor('depth24plus-stencil8'),
    ).unwrap();
    const options = {
      name: 'material-cache-scene',
      color,
      depth,
      selector: {} as PassSelector,
    };
    expect(addTypedScenePass(graph, options).ok).toBe(true);
    expect(addTypedScenePass(graph, { ...options, name: 'material-cache-scene-2' }).ok).toBe(true);
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();

    const firstFrame = frameFor(device, materialA);
    const firstExecution = compiled.execute(firstFrame);
    expect(firstExecution.ok).toBe(true);
    expect(encodeMainPass).toHaveBeenCalledTimes(2);
    expect(seenCacheInputs).toEqual([undefined, expect.objectContaining({ payload: payloadA })]);
    const firstCache = (firstFrame as unknown as { materialUboPayloadCache?: unknown })
      .materialUboPayloadCache;
    expect(seenCacheInputs[1]).toBe(firstCache);
    expect((firstCache as { payload: Uint8Array }).payload).toBe(payloadA);

    encodeMainPass.mockClear();
    seenCacheInputs.length = 0;
    const nextFrame = frameFor(device, materialB);
    const nextExecution = compiled.execute(nextFrame);
    expect(nextExecution.ok).toBe(true);
    expect(seenCacheInputs).toEqual([undefined, expect.objectContaining({ payload: payloadB })]);
    const nextCache = (nextFrame as unknown as { materialUboPayloadCache?: unknown })
      .materialUboPayloadCache;
    expect(seenCacheInputs[1]).toBe(nextCache);
    expect((nextCache as { payload: Uint8Array }).payload).toBe(payloadB);
  });
});
