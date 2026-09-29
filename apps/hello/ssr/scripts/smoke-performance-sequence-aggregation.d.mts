export type SsrInterval = {
  passName?: string;
  beginning: bigint;
  end: bigint;
};

export type SsrIntervalSummary = {
  measuredPassCount: number;
  sumTicks: string;
  unionTicks: string;
  outerSpanTicks: string;
  duplicatedTicks: string;
  overlapPairCount: number;
  longestOverlaps: Array<{
    left: string | undefined;
    right: string | undefined;
    overlapTicks: string;
  }>;
};

export declare function summarizeIntervalSet(
  intervals: readonly SsrInterval[],
): SsrIntervalSummary;
