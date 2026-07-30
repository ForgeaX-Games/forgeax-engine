import { describe, expect, it } from 'vitest';
import { MaterialGenerationCache } from '../material/generation-cache.js';

describe('material stale generation publication', () => {
  it('retries once and reports the generation vector when dependencies change', async () => {
    const cache = new MaterialGenerationCache();
    let calls = 0;
    const result = await cache.loadWithGeneration('mat-a', ['texture/a'], async (generation) => {
      calls += 1;
      if (calls === 1) cache.bump('texture/a');
      return { generation, value: calls };
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(cache.generationError('mat-a')).toBeUndefined();
  });

  it('exposes stale-generation details after the retry budget is exhausted', async () => {
    const cache = new MaterialGenerationCache();
    const result = await cache.loadWithGeneration('mat-a', ['texture/a'], async (generation) => {
      cache.bump('texture/a');
      return { generation, value: 1 };
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'material-specialization-stale-generation' },
    });
  });
});
