export function summarizeIntervalSet(intervals) {
  if (intervals.length === 0) {
    return {
      measuredPassCount: 0,
      sumTicks: '0',
      unionTicks: '0',
      outerSpanTicks: '0',
      duplicatedTicks: '0',
      overlapPairCount: 0,
      longestOverlaps: [],
    };
  }
  let sumTicks = 0n;
  for (const interval of intervals) sumTicks += interval.end - interval.beginning;
  const sorted = [...intervals].sort((left, right) => {
    if (left.beginning < right.beginning) return -1;
    if (left.beginning > right.beginning) return 1;
    return left.end < right.end ? -1 : left.end > right.end ? 1 : 0;
  });
  const outerBeginning = sorted[0].beginning;
  let outerEnd = sorted[0].end;
  let unionTicks = 0n;
  let unionBeginning = sorted[0].beginning;
  let unionEnd = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.end > outerEnd) outerEnd = interval.end;
    if (interval.beginning > unionEnd) {
      unionTicks += unionEnd - unionBeginning;
      unionBeginning = interval.beginning;
      unionEnd = interval.end;
    } else if (interval.end > unionEnd) {
      unionEnd = interval.end;
    }
  }
  unionTicks += unionEnd - unionBeginning;
  const longestOverlaps = [];
  let overlapPairCount = 0;
  for (let leftIndex = 0; leftIndex < intervals.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < intervals.length; rightIndex += 1) {
      const left = intervals[leftIndex];
      const right = intervals[rightIndex];
      const overlapEnd = left.end < right.end ? left.end : right.end;
      const overlapBeginning = left.beginning > right.beginning ? left.beginning : right.beginning;
      if (overlapEnd <= overlapBeginning) continue;
      overlapPairCount += 1;
      longestOverlaps.push({
        left: left.passName,
        right: right.passName,
        overlapTicks: (overlapEnd - overlapBeginning).toString(),
      });
    }
  }
  longestOverlaps.sort((left, right) => {
    const leftTicks = BigInt(left.overlapTicks);
    const rightTicks = BigInt(right.overlapTicks);
    return leftTicks < rightTicks ? 1 : leftTicks > rightTicks ? -1 : 0;
  });
  return {
    measuredPassCount: intervals.length,
    sumTicks: sumTicks.toString(),
    unionTicks: unionTicks.toString(),
    outerSpanTicks: (outerEnd - outerBeginning).toString(),
    duplicatedTicks: (sumTicks - unionTicks).toString(),
    overlapPairCount,
    longestOverlaps: longestOverlaps.slice(0, 8),
  };
}
