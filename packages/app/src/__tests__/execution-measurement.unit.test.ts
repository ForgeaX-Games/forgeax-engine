import { describe, expect, it } from 'vitest';
import { createMeasurementSeries } from '../execution/measurement';

describe('execution measurement series', () => {
  it('reports bounded percentiles while retaining the total sample count', () => {
    const series = createMeasurementSeries(3);
    series.add(100);
    series.add(2);
    series.add(3);
    const report = series.add(4);
    expect(report).toEqual({ samples: 4, p50: 3, p95: 4, p99: 4, jitter: 1 });
  });

  it('clears samples for a rebuilt World identity', () => {
    const series = createMeasurementSeries();
    series.add(1);
    series.clear();
    expect(series.add(5).samples).toBe(1);
  });
});
