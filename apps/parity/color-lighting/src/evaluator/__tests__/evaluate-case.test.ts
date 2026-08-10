import { describe, expect, it } from 'vitest';
import { evaluateCase } from '../evaluate-case';

const base = {
  caseId: 'm0-evaluator',
  required: true,
  budget: { analyticMax: 0.01, roiMax: 0.01, byteMax: 0 },
  forgeax: { implementation: 'forgeax', version: 'dev' },
  three: { implementation: 'three', version: 'r184', renderer: 'webgpu' },
};

describe('per-case evaluator', () => {
  it('fails aggregate-only input', () => {
    const result = evaluateCase({ ...base, aggregateDiff: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected aggregate-only failure');
    expect(result.error.code).toBe('aggregate-only-input');
  });

  it('fails a single byte over budget and reports first divergence', () => {
    const result = evaluateCase({
      ...base,
      analytic: { max: 0 },
      roi: { max: 0 },
      bytes: { differing: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.value?.verdict).toBe('failed');
    expect(result.value?.firstDivergence).toBeDefined();
  });

  it('keeps WebGL2 byte drift diagnostic while enforcing numeric bounds', () => {
    const result = evaluateCase({
      ...base,
      three: { ...base.three, renderer: 'webgl' },
      allowThreeWebglFallback: true,
      captures: {
        forgeax: { linear: [], final: [], hash: 'forgeax' },
        three: { linear: [], final: [], hash: 'three' },
      },
      analytic: { max: 0.01 },
      roi: { max: 0.01 },
      bytes: { differing: 4096 },
    });
    expect(result.ok).toBe(true);
    expect(result.value?.metrics.differingBytes).toBe(4096);
  });

  it('rejects non-finite metrics and unjustified wide budgets', () => {
    expect(evaluateCase({ ...base, analytic: { max: Number.NaN }, roi: { max: 0 }, bytes: { differing: 0 } }).ok).toBe(false);
    expect(evaluateCase({ ...base, budget: { analyticMax: 999999, roiMax: 0, byteMax: 0 }, analytic: { max: 0 }, roi: { max: 0 }, bytes: { differing: 0 } }).ok).toBe(false);
  });
});
