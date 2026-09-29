export interface QualifiedGpuSample {
  readonly backend: 'browser-webgpu' | 'dawn-node';
  readonly width: number;
  readonly height: number;
  readonly gpuMs: number;
  readonly timestampQuery: true;
  readonly physicalAdapter: true;
  readonly stableFrameGrowth: 0;
}

export interface AutoExposureBenchmarkReport {
  readonly schemaVersion: 1;
  readonly status: 'qualified' | 'blocked' | 'failed';
  readonly samples: readonly QualifiedGpuSample[];
  readonly p95: { readonly '1920x1080': number | null; readonly '3840x2160': number | null };
  readonly thresholdsMs: { readonly '1920x1080': 0.35; readonly '3840x2160': 0.8 };
  readonly ineligible: readonly { readonly lane: string; readonly reason: string }[];
}

function nearestRankP95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

export function evaluateAutoExposureBenchmark(
  samples: readonly QualifiedGpuSample[],
  ineligible: readonly AutoExposureBenchmarkReport['ineligible'][number][] = [],
): AutoExposureBenchmarkReport {
  const at = (width: number, height: number) => nearestRankP95(samples.filter((sample) => sample.width === width && sample.height === height).map((sample) => sample.gpuMs));
  const p95 = { '1920x1080': at(1920, 1080), '3840x2160': at(3840, 2160) } as const;
  const status = samples.length === 0
    ? 'blocked'
    : (p95['1920x1080'] === null || p95['1920x1080'] > 0.35 || p95['3840x2160'] === null || p95['3840x2160'] > 0.8 ? 'failed' : 'qualified');
  return { schemaVersion: 1, status, samples, p95, thresholdsMs: { '1920x1080': 0.35, '3840x2160': 0.8 }, ineligible };
}
