import { describe, expect, it } from 'vitest';

describe('animation graph registration stays plugin-owned', () => {
  it('does not project the plugin-internal registration helper from the public root', async () => {
    const root = (await import('../index')) as Record<string, unknown>;
    expect(root).not.toHaveProperty('registerEvaluateAnimationGraph');
  });
});
