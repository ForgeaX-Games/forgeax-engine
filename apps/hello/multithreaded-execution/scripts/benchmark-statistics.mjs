export function quantile(values, q) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

export function summarize(values) {
  return {
    samples: values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    jitter: quantile(values, 0.95) - quantile(values, 0.5),
  };
}

export function confidenceInterval(inline, shared) {
  let state = 0x46_6f_72_67;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_00_00_00_00;
  };
  const improvements = [];
  for (let round = 0; round < 2_000; round++) {
    const inlineSample = Array.from(
      { length: inline.length },
      () => inline[Math.floor(random() * inline.length)],
    );
    const sharedSample = Array.from(
      { length: shared.length },
      () => shared[Math.floor(random() * shared.length)],
    );
    improvements.push(1 - quantile(sharedSample, 0.95) / quantile(inlineSample, 0.95));
  }
  return {
    method: 'deterministic-bootstrap-p95-ratio',
    rounds: improvements.length,
    low: quantile(improvements, 0.025),
    high: quantile(improvements, 0.975),
  };
}

export function assessProductImprovement(inline, shared, requiredImprovement = 0.15) {
  const inlineP95 = quantile(inline, 0.95);
  const sharedP95 = quantile(shared, 0.95);
  const confidenceInterval95 = confidenceInterval(inline, shared);
  return {
    requiredImprovement,
    observedImprovement: 1 - sharedP95 / inlineP95,
    confidenceInterval95,
    passed: confidenceInterval95.low >= requiredImprovement,
  };
}
