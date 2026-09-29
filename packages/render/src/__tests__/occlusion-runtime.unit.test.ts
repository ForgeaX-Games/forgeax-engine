import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { QuerySet, RhiRenderPassEncoder, ShaderModule } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRenderPipelineTarget, type RenderPipelineFrame } from '../render-pipeline';
import { createVisibilityBudget } from '../scene/visibility/budget';
import { VisibilityFacetStore } from '../scene/visibility/facet';
import {
  OcclusionRenderRuntime,
  type OcclusionRuntimeCandidate,
} from '../scene/visibility/occlusion-runtime';
import { addTypedScenePass } from '../typed-render-graph-primitives';

describe('occlusion runtime proxy encoding', () => {
  it('binds one proxy buffer and advances firstVertex across candidates', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const facets = new VisibilityFacetStore(createVisibilityBudget(2));
    const candidates: OcclusionRuntimeCandidate[] = [candidate(0, 3), candidate(1, 2)];
    const runtime = new OcclusionRenderRuntime(device, facets, {
      createShaderModule: () => ok({} as ShaderModule),
    });
    const writeBuffer = vi.spyOn(device.queue, 'writeBuffer');
    const projection = runtime.prepareBatch(candidates, 1, false);
    expect(projection).toBeDefined();
    if (projection === undefined) return;

    const vertexBindings: unknown[][] = [];
    const draws: unknown[][] = [];
    const beginQueries: number[] = [];
    let endCount = 0;
    const pass = {
      setPipeline: () => undefined,
      setVertexBuffer: (...args: unknown[]) => vertexBindings.push(args),
      draw: (...args: unknown[]) => draws.push(args),
      beginOcclusionQuery: (queryIndex: number) => {
        beginQueries.push(queryIndex);
        return ok(undefined);
      },
      endOcclusionQuery: () => {
        endCount += 1;
        return ok(undefined);
      },
    } as unknown as RhiRenderPassEncoder;

    expect(projection.encodeProxyBounds(pass).ok).toBe(true);
    expect(vertexBindings).toHaveLength(1);
    expect(vertexBindings[0]?.[0]).toBe(0);
    expect(vertexBindings[0]?.[2]).toBeUndefined();
    expect(vertexBindings[0]?.[3]).toBeUndefined();
    expect(beginQueries).toEqual([0, 1]);
    expect(draws.map((draw) => draw.slice(0, 4))).toEqual([
      [3, 1, 0, 0],
      [2, 1, 3, 0],
    ]);
    expect(endCount).toBe(2);
    expect(runtime.prepareBatch(candidates, 1, false)).toBeUndefined();
    expect(runtime.prepareUnavailable).toBe(true);
    const profilePhases: string[] = [];
    projection.commit(false, 1, (phase, action) => {
      profilePhases.push(phase);
      return action();
    });
    expect(profilePhases).toEqual(['record/occlusion-query-submit']);

    const nextProjection = runtime.prepareBatch(candidates, 1, false);
    expect(nextProjection).toBeDefined();
    if (nextProjection === undefined) return;
    expect(nextProjection.encodeProxyBounds(pass).ok).toBe(true);
    expect(writeBuffer).toHaveBeenCalledTimes(2);
    const firstUpload = writeBuffer.mock.calls[0]?.[2];
    const secondUpload = writeBuffer.mock.calls[1]?.[2];
    expect(ArrayBuffer.isView(firstUpload) && ArrayBuffer.isView(secondUpload)).toBe(true);
    if (ArrayBuffer.isView(firstUpload) && ArrayBuffer.isView(secondUpload)) {
      expect(firstUpload.buffer).toBe(secondUpload.buffer);
    }
    nextProjection.commit(false, 2);
    runtime.dispose();
  });

  it('retains its projection during an idle query frame without allocating or encoding work', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const facets = new VisibilityFacetStore(createVisibilityBudget(2));
    const runtime = new OcclusionRenderRuntime(device, facets, {
      createShaderModule: () => ok({} as ShaderModule),
    });
    const candidates = [candidate(0, 3)];
    const active = runtime.prepareBatch(candidates, 4, false);
    if (active === undefined) throw new Error('Expected active query projection');
    expect(active.queryCount).toBe(1);
    expect(runtime.prepareBatch(candidates, 1, false)).toBeUndefined();
    expect(active.sampleCount).toBe(4);
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const color = createRenderPipelineTarget(graph, 'color', {
      format: 'rgba8unorm',
      size: 'surface',
    }).unwrap();
    const depth = createRenderPipelineTarget(graph, 'depth', {
      format: 'depth24plus-stencil8',
      size: 'surface',
    }).unwrap();
    const raster = vi.spyOn(graph, 'addRasterPass');
    addTypedScenePass(graph, {
      name: 'scene',
      color,
      depth,
      selector: { LightMode: ['Forward'] },
      occlusion: active,
    }).unwrap();
    const descriptor = raster.mock.calls[0]?.[1];
    if (descriptor === undefined) throw new Error('Expected scene pass descriptor');
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
    const submittedQuerySet = () => {
      let observed: QuerySet | undefined;
      const encoder = device.createCommandEncoder().unwrap();
      encoder.beginRenderPass = (input) => {
        observed = input.occlusionQuerySet;
        throw new Error('stop after observing the submitted descriptor');
      };
      expect(compiled.execute({ encoder } as RenderPipelineFrame).ok).toBe(false);
      return observed;
    };
    expect(submittedQuerySet()).toBe(active.querySet);
    active.commit(false, 1);
    const allocate = vi.spyOn(device, 'createQuerySet');
    const idle = runtime.prepareBatch(candidates, 4, true);
    expect(idle).toBe(active);
    expect(idle?.sampleCount).toBe(4);
    expect(idle?.queryCount).toBe(0);
    expect(idle?.querySet).toBeUndefined();
    expect(submittedQuerySet()).toBeUndefined();
    expect(idle?.encodeProxyBounds({} as RhiRenderPassEncoder).ok).toBe(true);
    expect(idle?.recordResolve({} as never).ok).toBe(true);
    const advance = vi.spyOn(facets, 'advanceSuccessfulSubmits');
    idle?.commit(false, 2);
    expect(advance).not.toHaveBeenCalled();
    const phases: string[] = [];
    idle?.commit(true, 2, (phase, action) => {
      phases.push(phase);
      return action();
    });
    expect(advance).toHaveBeenCalledExactlyOnceWith(2);
    expect(phases).toEqual(['record/occlusion-global-advance']);
    expect(allocate).not.toHaveBeenCalled();
    const resumed = runtime.prepareBatch(candidates, 4, false);
    expect(resumed).toBe(active);
    expect(resumed?.queryCount).toBe(1);
    expect(resumed?.querySet).toBeDefined();
    expect(submittedQuerySet()).toBe(resumed?.querySet);
    (await compiled.retire()).unwrap();
    resumed?.commit(false, 3);
    runtime.dispose();
  });

  it('cancels and requeues a reservation when the fixed scratch overflows', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const budget = createVisibilityBudget(1);
    const facets = new VisibilityFacetStore(budget);
    const oversized = candidate(0, budget.effectiveQueryBudget * 36 + 1);
    facets.activateView(oversized.view);
    expect(facets.setCandidate(oversized.view, oversized.primitive, oversized.candidate)).toBe(
      true,
    );
    const runtime = new OcclusionRenderRuntime(device, facets, {
      createShaderModule: () => ok({} as ShaderModule),
    });

    expect(runtime.prepareBatch([oversized], 1, true)).toBeUndefined();
    expect(runtime.prepareUnavailable).toBe(true);
    expect(facets.dequeueQueryCandidates(oversized.view, 1)).toHaveLength(1);
    runtime.dispose();
  });
});

function candidate(primitiveSlot: number, vertexCount: number): OcclusionRuntimeCandidate {
  return {
    view: {
      attachmentId: 'color-depth',
      cameraEntity: 7,
      viewRole: 'main',
      viewGeneration: 1,
    },
    primitive: {
      attachmentId: 'color-depth',
      worldGeneration: 3,
      primitiveSlot,
      slotGeneration: 1,
    },
    epoch: 0,
    bounds: { min: [-1, -1, 0], max: [1, 1, 1] },
    candidate: { level: 0, confidence: 1 },
    deviceGeneration: 1,
    proxyVertices: new Float32Array(vertexCount * 4),
  };
}
