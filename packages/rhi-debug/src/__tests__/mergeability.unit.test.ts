// @forgeax/engine-rhi-debug/src/__tests__/mergeability.unit.test.ts
//
// Pure structural tests for the mergeability report. These tests deliberately
// prove both sides of the contract: contiguous, identical indexed ranges are
// candidates, while dynamic-offset or range gaps break a run.

import { describe, expect, it } from 'vitest';
import { analyzeMergeability } from '../mergeability';
import type { RhiCallEvent, Tape } from '../types';

function makeTape(events: readonly RhiCallEvent[]): Tape {
  return {
    formatVersion: 3,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm',
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      storageBuffer: false,
      timestampQuery: false,
    },
    events,
    blobPool: new Map(),
  };
}

const begin: RhiCallEvent = {
  kind: 'beginRenderPass',
  cmdHandleId: 'encoder:1',
  passHandleId: 'pass:1',
  desc: { colorAttachments: [] },
  colorAttachmentViewHandleIds: ['textureView:target'],
};

const end: RhiCallEvent = { kind: 'endRenderPass', passHandleId: 'pass:1' };

function setup(dynamicOffsets: readonly number[] = []): readonly RhiCallEvent[] {
  return [
    begin,
    { kind: 'setPipeline', passHandleId: 'pass:1', pipelineHandleId: 'pipeline:1' },
    {
      kind: 'setVertexBuffer',
      passHandleId: 'pass:1',
      slot: 0,
      bufferHandleId: 'buffer:vertex',
      offset: 0,
      size: 4096,
    },
    {
      kind: 'setIndexBuffer',
      passHandleId: 'pass:1',
      bufferHandleId: 'buffer:index',
      format: 'uint32',
      offset: 0,
    },
    {
      kind: 'setBindGroup',
      passHandleId: 'pass:1',
      index: 0,
      bindGroupHandleId: 'bindGroup:1',
      dynamicOffsets,
    },
  ];
}

function indexed(firstIndex: number, indexCount = 3): RhiCallEvent {
  return {
    kind: 'drawIndexed',
    passHandleId: 'pass:1',
    indexCount,
    instanceCount: 1,
    firstIndex,
    baseVertex: 0,
    firstInstance: 0,
  };
}

describe('analyzeMergeability', () => {
  it('reports adjacent identical contiguous indexed draws as one candidate run', () => {
    const report = analyzeMergeability(
      makeTape([...setup(), indexed(0), indexed(3), indexed(6), end]),
    );

    expect(report.totalDraws).toBe(3);
    expect(report.indexedDraws).toBe(3);
    expect(report.candidateRunCount).toBe(1);
    expect(report.candidateDrawCount).toBe(3);
    expect(report.theoreticalMergedDrawCount).toBe(1);
    expect(report.theoreticalDrawReduction).toBe(2);
    expect(report.theoreticalDrawReductionRatio).toBeCloseTo(2 / 3);
    expect(report.topRuns[0]).toMatchObject({
      firstDrawIdx: 0,
      lastDrawIdx: 2,
      firstIndex: 0,
      lastIndexExclusive: 9,
      drawCount: 3,
    });
  });

  it('breaks a run when dynamic offsets change', () => {
    const report = analyzeMergeability(
      makeTape([...setup([0]), indexed(0), ...setup([16]).slice(1), indexed(3), end]),
    );

    expect(report.candidateRunCount).toBe(0);
    expect(report.theoreticalDrawReduction).toBe(0);
    expect(report.analysisEligibleDraws).toBe(2);
  });

  it('breaks a run when the index range is not contiguous', () => {
    const report = analyzeMergeability(makeTape([...setup(), indexed(0), indexed(4), end]));

    expect(report.candidateRunCount).toBe(0);
    expect(report.indexedDraws).toBe(2);
    expect(report.excluded.nonIndexedDraws).toBe(0);
  });

  it('excludes non-single-instance draws from the conservative candidate set', () => {
    const report = analyzeMergeability(
      makeTape([
        ...setup(),
        {
          kind: 'drawIndexed',
          passHandleId: 'pass:1',
          indexCount: 3,
          instanceCount: 2,
          firstIndex: 0,
          baseVertex: 0,
          firstInstance: 0,
        },
        end,
      ]),
    );

    expect(report.indexedDraws).toBe(1);
    expect(report.analysisEligibleDraws).toBe(0);
    expect(report.excluded.nonSingleInstanceDraws).toBe(1);
  });
});
