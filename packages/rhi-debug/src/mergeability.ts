// @forgeax/engine-rhi-debug -- pure indexed-draw mergeability analysis.
//
// This module is intentionally an analysis-only gate. It never rewrites a tape
// or claims that two draw calls are semantically safe to merge merely because
// they use the same pipeline. A candidate run must preserve the effective
// render state, bindings (including dynamic offsets), vertex/index buffers,
// base vertex, instance state, and a contiguous index range within one pass.
// The result is a lower-risk theoretical upper bound for a later OFF/ON
// experiment; it is not a batching implementation and it is not GPU timing.

import type { Tape } from './types';

type BufferBindingState = {
  readonly bufferHandleId: string;
  readonly offset: number;
  readonly size: number;
};

type IndexBindingState = {
  readonly bufferHandleId: string;
  readonly format: 'uint16' | 'uint32';
  readonly offset: number;
};

type BindGroupState = {
  readonly bindGroupHandleId: string;
  readonly dynamicOffsets: readonly number[];
};

type RenderState = {
  readonly pipelineHandleId: string | undefined;
  readonly vertexBuffers: ReadonlyMap<number, BufferBindingState>;
  readonly indexBuffer: IndexBindingState | undefined;
  readonly bindGroups: ReadonlyMap<number, BindGroupState>;
  readonly viewport: readonly number[] | undefined;
  readonly scissor: readonly number[] | undefined;
  readonly blendConstant: readonly number[] | undefined;
  readonly stencilReference: number | undefined;
};

type DrawSnapshot = {
  readonly drawIdx: number;
  readonly passIdx: number;
  readonly pipelineHandleId: string;
  readonly indexBuffer: IndexBindingState;
  readonly firstIndex: number;
  readonly indexCount: number;
  readonly instanceCount: number;
  readonly firstInstance: number;
  readonly baseVertex: number;
  readonly stateKey: string;
};

type MutableRun = {
  readonly passIdx: number;
  readonly pipelineHandleId: string;
  readonly indexBuffer: IndexBindingState;
  readonly firstDrawIdx: number;
  readonly firstIndex: number;
  readonly stateKey: string;
  lastDrawIdx: number;
  lastIndexExclusive: number;
  drawCount: number;
  indexCount: number;
};

/** A contiguous indexed-draw interval that is structurally mergeable. */
export interface MergeabilityRun {
  readonly passIdx: number;
  readonly pipelineHandleId: string;
  readonly indexBufferHandleId: string;
  readonly firstDrawIdx: number;
  readonly lastDrawIdx: number;
  readonly firstIndex: number;
  readonly lastIndexExclusive: number;
  readonly drawCount: number;
  readonly indexCount: number;
  /** Number of draw calls theoretically saved by replacing this run with one draw. */
  readonly theoreticalDrawReduction: number;
}

/** Aggregate candidate runs for one pass/pipeline/index-buffer combination. */
export interface MergeabilityGroup {
  readonly passIdx: number;
  readonly pipelineHandleId: string;
  readonly indexBufferHandleId: string;
  readonly runCount: number;
  readonly candidateDrawCount: number;
  readonly theoreticalDrawReduction: number;
}

export interface MergeabilityReport {
  readonly schemaVersion: 'rhi-mergeability/v1';
  readonly totalDraws: number;
  readonly indexedDraws: number;
  readonly analysisEligibleDraws: number;
  readonly candidateRunCount: number;
  readonly candidateDrawCount: number;
  readonly theoreticalMergedDrawCount: number;
  readonly theoreticalDrawReduction: number;
  readonly theoreticalDrawReductionRatio: number;
  readonly groups: readonly MergeabilityGroup[];
  /** Largest runs first; the full tape remains the source of truth. */
  readonly topRuns: readonly MergeabilityRun[];
  readonly topRunsTruncated: boolean;
  readonly excluded: {
    readonly nonIndexedDraws: number;
    readonly missingPipelineOrIndexBuffer: number;
    readonly nonSingleInstanceDraws: number;
  };
  readonly note: string;
}

const DRAW_KINDS = new Set([
  'draw',
  'drawIndexed',
  'drawIndirect',
  'drawIndexedIndirect',
  'dispatchWorkgroups',
  'dispatchWorkgroupsIndirect',
]);

function stableMapEntries<T>(map: ReadonlyMap<number, T>): readonly (readonly [number, T])[] {
  return Array.from(map.entries()).sort(([a], [b]) => a - b);
}

function stateKey(state: RenderState, draw: DrawSnapshot): string {
  return JSON.stringify({
    passIdx: draw.passIdx,
    pipelineHandleId: state.pipelineHandleId,
    vertexBuffers: stableMapEntries(state.vertexBuffers),
    indexBuffer: state.indexBuffer,
    bindGroups: stableMapEntries(state.bindGroups),
    viewport: state.viewport,
    scissor: state.scissor,
    blendConstant: state.blendConstant,
    stencilReference: state.stencilReference,
    baseVertex: draw.baseVertex,
    instanceCount: draw.instanceCount,
    firstInstance: draw.firstInstance,
  });
}

function cloneState(): {
  pipelineHandleId: string | undefined;
  vertexBuffers: Map<number, BufferBindingState>;
  indexBuffer: IndexBindingState | undefined;
  bindGroups: Map<number, BindGroupState>;
  viewport: readonly number[] | undefined;
  scissor: readonly number[] | undefined;
  blendConstant: readonly number[] | undefined;
  stencilReference: number | undefined;
} {
  return {
    pipelineHandleId: undefined,
    vertexBuffers: new Map(),
    indexBuffer: undefined,
    bindGroups: new Map(),
    viewport: undefined,
    scissor: undefined,
    blendConstant: undefined,
    stencilReference: undefined,
  };
}

function colorValues(color: GPUColor): readonly number[] {
  if (Array.isArray(color)) return [...color];
  return [color.r, color.g, color.b, color.a];
}

function finishRun(run: MutableRun | undefined, runs: MergeabilityRun[]): void {
  if (run === undefined || run.drawCount < 2) return;
  runs.push({
    passIdx: run.passIdx,
    pipelineHandleId: run.pipelineHandleId,
    indexBufferHandleId: run.indexBuffer.bufferHandleId,
    firstDrawIdx: run.firstDrawIdx,
    lastDrawIdx: run.lastDrawIdx,
    firstIndex: run.firstIndex,
    lastIndexExclusive: run.lastIndexExclusive,
    drawCount: run.drawCount,
    indexCount: run.indexCount,
    theoreticalDrawReduction: run.drawCount - 1,
  });
}

function toRun(run: DrawSnapshot): MutableRun {
  return {
    passIdx: run.passIdx,
    pipelineHandleId: run.pipelineHandleId,
    indexBuffer: run.indexBuffer,
    firstDrawIdx: run.drawIdx,
    firstIndex: run.firstIndex,
    stateKey: run.stateKey,
    lastDrawIdx: run.drawIdx,
    lastIndexExclusive: run.firstIndex + run.indexCount,
    drawCount: 1,
    indexCount: run.indexCount,
  };
}

function canExtend(run: MutableRun | undefined, draw: DrawSnapshot): boolean {
  return (
    run !== undefined &&
    run.passIdx === draw.passIdx &&
    run.pipelineHandleId === draw.pipelineHandleId &&
    run.stateKey === draw.stateKey &&
    run.indexBuffer.bufferHandleId === draw.indexBuffer.bufferHandleId &&
    run.indexBuffer.format === draw.indexBuffer.format &&
    run.indexBuffer.offset === draw.indexBuffer.offset &&
    run.lastIndexExclusive === draw.firstIndex
  );
}

/**
 * Analyze a tape without a GPU or a live editor.
 *
 * The returned reduction is deliberately conservative: it only counts
 * adjacent drawIndexed calls that are structurally identical and contiguous.
 * A caller must still run a visual/semantic OFF/ON experiment before changing
 * the renderer.
 */
export function analyzeMergeability(tape: Tape): MergeabilityReport {
  const state = cloneState();
  const runs: MergeabilityRun[] = [];
  let currentRun: MutableRun | undefined;
  let passIdx = -1;
  let inRenderPass = false;
  let drawIdx = 0;
  let totalDraws = 0;
  let indexedDraws = 0;
  let analysisEligibleDraws = 0;
  let nonIndexedDraws = 0;
  let missingPipelineOrIndexBuffer = 0;
  let nonSingleInstanceDraws = 0;

  const flush = (): void => {
    finishRun(currentRun, runs);
    currentRun = undefined;
  };

  for (const event of tape.events) {
    if (event.kind === 'beginRenderPass' || event.kind === 'beginComputePass') {
      flush();
      passIdx += 1;
      inRenderPass = event.kind === 'beginRenderPass';
      Object.assign(state, cloneState());
      continue;
    }
    if (event.kind === 'endRenderPass' || event.kind === 'endComputePass') {
      flush();
      inRenderPass = false;
      continue;
    }

    if (event.kind === 'setPipeline') state.pipelineHandleId = event.pipelineHandleId;
    else if (event.kind === 'setVertexBuffer') {
      state.vertexBuffers.set(event.slot, {
        bufferHandleId: event.bufferHandleId,
        offset: event.offset ?? 0,
        size: event.size ?? 0,
      });
    } else if (event.kind === 'setIndexBuffer') {
      state.indexBuffer = {
        bufferHandleId: event.bufferHandleId,
        format: event.format,
        offset: event.offset ?? 0,
      };
    } else if (event.kind === 'setBindGroup') {
      state.bindGroups.set(event.index, {
        bindGroupHandleId: event.bindGroupHandleId,
        dynamicOffsets: [...(event.dynamicOffsets ?? [])],
      });
    } else if (event.kind === 'setViewport') {
      state.viewport = [event.x, event.y, event.w, event.h, event.minDepth, event.maxDepth];
    } else if (event.kind === 'setScissorRect') {
      state.scissor = [event.x, event.y, event.w, event.h];
    } else if (event.kind === 'setBlendConstant') {
      state.blendConstant = colorValues(event.color);
    } else if (event.kind === 'setStencilReference') {
      state.stencilReference = event.reference;
    }

    if (!DRAW_KINDS.has(event.kind)) continue;
    totalDraws += 1;

    if (event.kind !== 'drawIndexed' || !inRenderPass) {
      nonIndexedDraws += event.kind === 'drawIndexed' ? 0 : 1;
      flush();
      drawIdx += 1;
      continue;
    }

    indexedDraws += 1;
    const indexBuffer = state.indexBuffer;
    if (state.pipelineHandleId === undefined || indexBuffer === undefined) {
      missingPipelineOrIndexBuffer += 1;
      flush();
      drawIdx += 1;
      continue;
    }
    if (event.instanceCount !== 1 || event.firstInstance !== 0) {
      nonSingleInstanceDraws += 1;
      flush();
      drawIdx += 1;
      continue;
    }

    analysisEligibleDraws += 1;
    const snapshotWithoutKey = {
      drawIdx,
      passIdx,
      pipelineHandleId: state.pipelineHandleId,
      indexBuffer,
      firstIndex: event.firstIndex,
      indexCount: event.indexCount,
      instanceCount: event.instanceCount,
      firstInstance: event.firstInstance,
      baseVertex: event.baseVertex,
      stateKey: '',
    } satisfies Omit<DrawSnapshot, 'stateKey'> & { stateKey: string };
    const snapshot: DrawSnapshot = {
      ...snapshotWithoutKey,
      stateKey: stateKey(state, snapshotWithoutKey),
    };
    if (currentRun !== undefined && canExtend(currentRun, snapshot)) {
      currentRun.lastDrawIdx = snapshot.drawIdx;
      currentRun.lastIndexExclusive = snapshot.firstIndex + snapshot.indexCount;
      currentRun.drawCount += 1;
      currentRun.indexCount += snapshot.indexCount;
    } else {
      flush();
      currentRun = toRun(snapshot);
    }
    drawIdx += 1;
  }
  flush();

  const groupsByKey = new Map<
    string,
    {
      readonly passIdx: number;
      readonly pipelineHandleId: string;
      readonly indexBufferHandleId: string;
      runCount: number;
      candidateDrawCount: number;
      theoreticalDrawReduction: number;
    }
  >();
  for (const run of runs) {
    const key = `${run.passIdx}|${run.pipelineHandleId}|${run.indexBufferHandleId}`;
    let group = groupsByKey.get(key);
    if (group === undefined) {
      group = {
        passIdx: run.passIdx,
        pipelineHandleId: run.pipelineHandleId,
        indexBufferHandleId: run.indexBufferHandleId,
        runCount: 0,
        candidateDrawCount: 0,
        theoreticalDrawReduction: 0,
      };
      groupsByKey.set(key, group);
    }
    group.runCount += 1;
    group.candidateDrawCount += run.drawCount;
    group.theoreticalDrawReduction += run.theoreticalDrawReduction;
  }

  const theoreticalDrawReduction = runs.reduce((sum, run) => sum + run.theoreticalDrawReduction, 0);
  const topRuns = [...runs].sort((a, b) => {
    if (b.theoreticalDrawReduction !== a.theoreticalDrawReduction) {
      return b.theoreticalDrawReduction - a.theoreticalDrawReduction;
    }
    return a.firstDrawIdx - b.firstDrawIdx;
  });
  const maxTopRuns = 100;

  return {
    schemaVersion: 'rhi-mergeability/v1',
    totalDraws,
    indexedDraws,
    analysisEligibleDraws,
    candidateRunCount: runs.length,
    candidateDrawCount: runs.reduce((sum, run) => sum + run.drawCount, 0),
    theoreticalMergedDrawCount: runs.length,
    theoreticalDrawReduction,
    theoreticalDrawReductionRatio: indexedDraws === 0 ? 0 : theoreticalDrawReduction / indexedDraws,
    groups: [...groupsByKey.values()].sort(
      (a, b) => b.theoreticalDrawReduction - a.theoreticalDrawReduction,
    ),
    topRuns: topRuns.slice(0, maxTopRuns),
    topRunsTruncated: topRuns.length > maxTopRuns,
    excluded: {
      nonIndexedDraws,
      missingPipelineOrIndexBuffer,
      nonSingleInstanceDraws,
    },
    note: 'Structural upper bound only: run a visual/semantic OFF/ON experiment before changing draw submission.',
  };
}
