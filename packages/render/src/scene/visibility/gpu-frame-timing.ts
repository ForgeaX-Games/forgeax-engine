/** Renderer-owned timestamp facts spanning one graph and one queue submit. */

export interface GpuFrameTimingProtocol {
  readonly firstMarker: 'frame.first-pass';
  readonly terminalMarker: 'occlusion.resolve-copy';
  readonly sameGraph: true;
  readonly sameSubmit: true;
}

export interface GpuFrameTiming {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly protocol: GpuFrameTimingProtocol;
  aborted: boolean;
  submitId: number | undefined;
}

export interface GpuFrameTimingRecord {
  readonly firstPassTimestampNs: number;
  readonly occlusionResolveTimestampNs: number;
  readonly submitted: boolean;
  readonly graphGeneration: number;
  readonly submitId: number;
}

export interface GpuFrameTimingSample {
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly durationUs: number;
  readonly protocol: GpuFrameTimingProtocol;
  readonly graphGeneration: number;
  readonly submitId: number;
}

export interface GpuFrameTimingSummary {
  readonly medianUs: number;
  readonly p95Us: number;
  readonly samples: number;
}

const PROTOCOL: GpuFrameTimingProtocol = Object.freeze({
  firstMarker: 'frame.first-pass',
  terminalMarker: 'occlusion.resolve-copy',
  sameGraph: true,
  sameSubmit: true,
});

export function createGpuFrameTiming(input: {
  readonly frameId: number;
  readonly deviceGeneration: number;
}): GpuFrameTiming {
  return { ...input, protocol: PROTOCOL, aborted: false, submitId: undefined };
}

export function recordGpuFrameTiming(
  timing: GpuFrameTiming,
  record: GpuFrameTimingRecord,
): GpuFrameTimingSample {
  if (!record.submitted) {
    timing.aborted = true;
    throw new Error('GPU frame timing requires a submitted frame');
  }
  if (timing.aborted) throw new Error('GPU frame timing cannot cross a failed submit');
  if (timing.submitId !== undefined && timing.submitId !== record.submitId) {
    throw new Error('GPU frame timing markers must share one submit');
  }
  if (
    !Number.isFinite(record.firstPassTimestampNs) ||
    !Number.isFinite(record.occlusionResolveTimestampNs)
  ) {
    throw new Error('GPU frame timing requires finite timestamps');
  }
  if (record.occlusionResolveTimestampNs < record.firstPassTimestampNs) {
    throw new Error('GPU frame timing terminal marker precedes first marker');
  }
  timing.submitId = record.submitId;
  return Object.freeze({
    frameId: timing.frameId,
    deviceGeneration: timing.deviceGeneration,
    durationUs: (record.occlusionResolveTimestampNs - record.firstPassTimestampNs) / 1_000,
    protocol: PROTOCOL,
    graphGeneration: record.graphGeneration,
    submitId: record.submitId,
  });
}

function nearestRank(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)] ?? 0;
}

export function summarizeGpuFrameTiming(
  samples: readonly GpuFrameTimingSample[],
): GpuFrameTimingSummary {
  const values = samples.map((sample) => sample.durationUs);
  return Object.freeze({
    medianUs: nearestRank(values, 0.5),
    p95Us: nearestRank(values, 0.95),
    samples: values.length,
  });
}
