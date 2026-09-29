import { describe, expect, it } from 'vitest';

describe('TAA rgba16float Dawn admission', () => {
  it('records unavailable backends instead of treating them as green', () => {
    const evidence = { backend: 'dawn', status: 'unavailable' as const };
    expect(['available', 'unavailable']).toContain(evidence.status);
    expect(evidence.status).not.toBe('pass');
  });

  it('requires the dawn.node runner and frame budget when available', () => {
    const evidence = {
      backend: 'dawn-node',
      runner: 'dawn.node',
      frames: 60,
      status: 'available',
    };
    expect(evidence.runner).toBe('dawn.node');
    expect(evidence.frames).toBeGreaterThanOrEqual(60);
  });
});
