import type { RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { RhiErrorListenerRegistry } from '../lifecycle';
import type { RenderFrameState } from '../record/frame-snapshot';
import { makeZeroCameraFallbackSnapshot } from '../record/frame-snapshot';
import type { PipelineState, RenderSystemInternals } from '../record/render-context';
import {
  ensureCompiledFrameGraph,
  executeCompiledFrameGraph,
  inspectRenderGraphGenerationAllocation,
  retire as retireCompiledGraph,
  settleCompiledFrameGraphCandidate,
  shareRenderGraphGenerationAllocationOwner,
} from '../record/typed-frame-graph';
import type { RenderPipeline } from '../render-pipeline';
import type { ExtractedLights } from '../render-system-extract';

function createRecoveryGraphHarness(texture = false) {
  let failBuild = false;
  const activePipeline: RenderPipeline = {
    build: ({ graph }) => {
      if (failBuild) return { ok: false, error: { code: 'injected-build-failure' } } as never;
      if (texture) {
        const target = graph
          .createTexture('recovery-color', { size: { width: 2, height: 2 }, format: 'rgba8unorm' })
          .unwrap();
        const view = graph.view(target).unwrap();
        return graph.addRasterPass('recovery-clear', {
          accesses: [{ resource: view, usage: 'color-attachment' }],
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          encode() {},
        });
      }
      const buffer = graph.createBuffer('recovery-graph-bytes', { size: 16 });
      if (!buffer.ok) return buffer;
      return graph.addCopyPass('recovery-graph-seed', {
        accesses: [{ resource: buffer.value, usage: 'copy-dst' }],
        encode: () => undefined,
      });
    },
  };
  const frameState = {
    compiledFrameGraph: null,
    compiledFrameGraphTopologyKey: null,
    graphGeneration: 0,
    compiledFrameGraphGeneration: 0,
    standardLightingGraphSignature: '',
    retiredCompiledFrameGraphs: new Set(),
    activePipeline,
    installedPipelineConfig: undefined,
  } as unknown as RenderFrameState;
  const errorRegistry = new RhiErrorListenerRegistry();
  let device: RhiDevice | undefined;
  const internals = {
    get device() {
      return device as RhiDevice;
    },
    errorRegistry,
  } as unknown as RenderSystemInternals;
  const pipelineState = {
    format: 'rgba8unorm',
    colorAttachmentFormat: 'rgba8unorm',
  } as unknown as PipelineState;
  const lights = {
    cascadeCount: undefined,
    pointShadow: [],
    spot: [],
  } as unknown as ExtractedLights;
  return {
    activePipeline,
    frameState,
    internals,
    pipelineState,
    lights,
    setDevice(nextDevice: RhiDevice) {
      device = nextDevice;
    },
    compile(width = 1) {
      return ensureCompiledFrameGraph(
        internals,
        frameState,
        pipelineState,
        makeZeroCameraFallbackSnapshot(),
        lights,
        width,
        1,
        undefined,
      );
    },
    accept() {
      settleCompiledFrameGraphCandidate(frameState, true);
    },
    setFail(value: boolean) {
      failBuild = value;
    },
  };
}

describe('detached recovery graph execution boundary', () => {
  it('counts shared physical textures once across active, candidate and retiring generations', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    let finish: () => void = () => undefined;
    vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementation(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined);
        }),
    );
    const creates = vi.spyOn(device, 'createTexture');
    const destroys = vi.spyOn(device, 'destroyTexture');
    const harness = createRecoveryGraphHarness(true);
    harness.setDevice(device);
    const first = harness.compile();
    if (first === null) throw new Error('first compile failed');
    harness.frameState.compiledFrameGraphTopologyKey = null;
    const second = harness.compile();
    if (second === null) throw new Error('replacement compile failed');
    expect(first).not.toBe(second);
    expect(creates).toHaveBeenCalledTimes(1);
    expect(inspectRenderGraphGenerationAllocation(harness.frameState)).toMatchObject({
      liveBytes: 16,
      pendingRetirementBytes: 0,
      peakBytes: 16,
    });
    expect(second.inspect().resourceAllocation).toMatchObject({
      successfulAllocationCount: 0,
      successfulAllocationBytes: 0,
    });
    harness.accept();
    expect(inspectRenderGraphGenerationAllocation(harness.frameState)).toMatchObject({
      liveBytes: 16,
      pendingRetirementBytes: 0,
      peakBytes: 16,
    });
    finish();
    await first.retire();
    expect(destroys).not.toHaveBeenCalled();
    const retiring = second.retire();
    expect(inspectRenderGraphGenerationAllocation(harness.frameState)).toMatchObject({
      liveBytes: 0,
      pendingRetirementBytes: 16,
      peakBytes: 16,
    });
    finish();
    await retiring;
    expect(destroys).toHaveBeenCalledTimes(1);
  });

  it('keeps topology inspection while rejecting detached LKG and then retires it on replacement', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);

    const candidate = harness.compile();
    expect(candidate).not.toBeNull();
    if (candidate === null) return;
    harness.accept();
    harness.frameState.compiledFrameGraphTopologyKey = null;
    harness.frameState.perFrameGraph = null;
    harness.setFail(true);
    expect(harness.compile()).toBeNull();
    expect(harness.frameState.compiledFrameGraph).toBe(candidate);

    harness.setFail(false);
    const replacement = harness.compile();
    expect(replacement).not.toBeNull();
    expect(replacement).not.toBe(candidate);
    expect(harness.frameState.compiledFrameGraph).toBe(replacement);
    expect(harness.frameState.compiledFrameGraphTopologyKey).not.toBeNull();
    expect(harness.frameState.retiredCompiledFrameGraphs.has(candidate)).toBe(false);
    harness.accept();
    expect(harness.frameState.retiredCompiledFrameGraphs.has(candidate)).toBe(true);

    harness.setFail(true);
    expect(harness.compile()).toBe(replacement);
  });

  it('does not execute or submit a detached graph', () => {
    const execute = vi.fn(() => ok(undefined));
    const submit = vi.fn(() => ok(undefined));
    const frameState = {
      compiledFrameGraph: { execute },
      compiledFrameGraphTopologyKey: null,
      retiredCompiledFrameGraphs: new Set(),
    } as unknown as RenderFrameState;
    const internals = {
      errorRegistry: { fire: vi.fn() },
      device: { queue: { submit } },
    } as never;

    const submitted = executeCompiledFrameGraph(
      internals,
      frameState,
      {} as never,
      {} as RhiCommandEncoder,
    );

    expect(submitted).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('projects active candidate overlap and graph-generation peak bytes', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);

    const first = harness.compile();
    expect(first).not.toBeNull();
    if (first === null) return;
    harness.accept();
    harness.frameState.compiledFrameGraphTopologyKey = null;
    const replacement = harness.compile();
    expect(replacement).not.toBeNull();
    if (replacement === null) return;
    // The old graph remains live until the replacement submission is accepted.
    expect(inspectRenderGraphGenerationAllocation(harness.frameState).liveBytes).toBe(32);
    harness.accept();

    const allocation = inspectRenderGraphGenerationAllocation(harness.frameState);
    expect(allocation.availability).toBe('complete');
    expect(allocation.entries).toHaveLength(2);
    expect(
      allocation.entries.find((entry) => entry.generation === replacement.inspect().generation)
        ?.roles,
    ).toEqual(expect.arrayContaining(['active']));
    expect(
      allocation.entries.find((entry) => entry.generation === first.inspect().generation)?.roles,
    ).toEqual(expect.arrayContaining(['retiring']));
    expect(allocation.liveBytes).toBe(16);
    expect(allocation.pendingRetirementBytes).toBe(16);
    expect(allocation.peakBytes).toBe(32);
  });

  it('records graph-generation overlap without an allocation inspection sample', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);

    const first = harness.compile();
    expect(first).not.toBeNull();
    if (first === null) return;
    harness.accept();

    // Force two ordinary graph replacements. Do not call the allocation
    // inspection between them: the renderer owner must observe compile and
    // retirement events itself rather than treating inspect() as a sampler.
    harness.frameState.compiledFrameGraphTopologyKey = null;
    const second = harness.compile();
    expect(second).not.toBeNull();
    if (second === null) return;
    harness.accept();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    harness.frameState.compiledFrameGraphTopologyKey = null;
    const third = harness.compile();
    expect(third).not.toBeNull();
    if (third === null) return;
    harness.accept();

    // RHI-null retires the old generations on its queue fence. The first
    // inspection therefore sees one live graph, while peakBytes retains the
    // live + retiring overlap observed during replacement.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const allocation = inspectRenderGraphGenerationAllocation(harness.frameState);
    expect(allocation.liveBytes).toBe(16);
    expect(allocation.pendingRetirementBytes).toBe(0);
    expect(allocation.peakBytes).toBe(32);
    expect(allocation.entries).toHaveLength(1);
    expect(allocation.entries[0]?.generation).toBe(third.inspect().generation);
  });

  it('keeps a failed graph retirement visible in the renderer generation ledger', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);

    const first = harness.compile();
    expect(first).not.toBeNull();
    if (first === null) return;
    harness.accept();
    (device as unknown as { destroyBuffer: RhiDevice['destroyBuffer'] }).destroyBuffer = () =>
      ({ ok: false, error: { code: 'webgpu-runtime-error' } }) as never;
    harness.frameState.compiledFrameGraphTopologyKey = null;
    const replacement = harness.compile();
    expect(replacement).not.toBeNull();
    if (replacement === null) return;
    harness.accept();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const allocation = inspectRenderGraphGenerationAllocation(harness.frameState);
    const failed = allocation.entries.find(
      (entry) => entry.generation === first.inspect().generation,
    );
    expect(failed?.retirement).toBe('failed');
    expect(failed?.allocation.pendingRetirementBytes).toBe(16);
    expect(allocation.failedRetirementCount).toBe(1);
    expect(allocation.failedRetirementBytes).toBe(16);
  });

  it('keeps a detached recovery candidate failure in the shared owner', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const harness = createRecoveryGraphHarness();
    harness.setDevice(device);
    const active = harness.compile();
    expect(active).not.toBeNull();
    if (active === null) return;
    harness.accept();

    const candidateFrameState = {
      ...harness.frameState,
      compiledFrameGraph: null,
      compiledFrameGraphTopologyKey: null,
      retiredCompiledFrameGraphs: new Set(),
    } as unknown as RenderFrameState;
    shareRenderGraphGenerationAllocationOwner(harness.frameState, candidateFrameState);
    const candidate = ensureCompiledFrameGraph(
      harness.internals,
      candidateFrameState,
      harness.pipelineState,
      makeZeroCameraFallbackSnapshot(),
      harness.lights,
      1,
      1,
      undefined,
    );
    expect(candidate).not.toBeNull();
    if (candidate === null) return;

    (device as unknown as { destroyBuffer: RhiDevice['destroyBuffer'] }).destroyBuffer = () =>
      ({ ok: false, error: { code: 'webgpu-runtime-error' } }) as never;
    retireCompiledGraph(candidateFrameState, candidate);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const allocation = inspectRenderGraphGenerationAllocation(harness.frameState);
    const failed = allocation.entries.find(
      (entry) => entry.generation === candidate.inspect().generation,
    );
    expect(failed?.retirement).toBe('failed');
    expect(failed?.roles).toEqual(expect.arrayContaining(['retiring']));
    expect(allocation.failedRetirementCount).toBe(1);
    expect(allocation.failedRetirementBytes).toBe(16);
  });
});

it('restores the complete graph projection and retires a failed resize candidate exactly once', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const harness = createRecoveryGraphHarness();
  harness.setDevice(device);
  const accepted = harness.compile();
  if (accepted === null) throw new Error('initial graph missing');
  harness.accept();
  const state = harness.frameState;
  const previous = {
    graph: state.compiledFrameGraph,
    key: state.compiledFrameGraphTopologyKey,
    lookup: state.perFrameGraph,
    generation: state.graphGeneration,
    compiledGeneration: state.compiledFrameGraphGeneration,
    lighting: state.standardLightingGraphSignature,
  };
  const candidate = harness.compile(2);
  if (candidate === null) throw new Error('resize graph missing');
  const retire = vi.spyOn(candidate, 'retire');
  settleCompiledFrameGraphCandidate(state, false);
  settleCompiledFrameGraphCandidate(state, false);
  expect(retire).toHaveBeenCalledTimes(1);
  expect(state.compiledFrameGraph).toBe(previous.graph);
  expect(state.compiledFrameGraphTopologyKey).toBe(previous.key);
  expect(state.perFrameGraph).toBe(previous.lookup);
  expect(state.graphGeneration).toBe(previous.generation);
  expect(state.compiledFrameGraphGeneration).toBe(previous.compiledGeneration);
  expect(state.standardLightingGraphSignature).toBe(previous.lighting);
  const retried = harness.compile(2);
  expect(retried).not.toBe(candidate);
  const retireAccepted = vi.spyOn(accepted, 'retire');
  harness.accept();
  harness.accept();
  expect(retireAccepted).toHaveBeenCalledTimes(1);
  await retried?.retire();
});

it('keeps the accepted graph when an unsubmitted candidate is replaced again and the frame fails', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const harness = createRecoveryGraphHarness();
  harness.setDevice(device);
  const accepted = harness.compile();
  if (accepted === null) throw new Error('initial graph missing');
  harness.accept();
  const acceptedKey = harness.frameState.compiledFrameGraphTopologyKey;
  const acceptedRetire = vi.spyOn(accepted, 'retire');
  const first = harness.compile(2);
  if (first === null) throw new Error('first candidate missing');
  const firstRetire = vi.spyOn(first, 'retire');
  const second = harness.compile(3);
  if (second === null) throw new Error('second candidate missing');
  const secondRetire = vi.spyOn(second, 'retire');
  settleCompiledFrameGraphCandidate(harness.frameState, false);
  expect(harness.frameState.compiledFrameGraph).toBe(accepted);
  expect(harness.frameState.compiledFrameGraphTopologyKey).toBe(acceptedKey);
  expect(acceptedRetire).not.toHaveBeenCalled();
  expect(firstRetire).toHaveBeenCalledTimes(1);
  expect(secondRetire).toHaveBeenCalledTimes(1);
  await accepted.retire();
});
