import { describe, expect, it } from 'vitest';

describe('audio decoder registration stays loader-owned', () => {
  it('does not project the decoder implementation from the public root', async () => {
    const root = (await import('../index')) as Record<string, unknown>;
    expect(root).not.toHaveProperty('decodeAudioClipBytes');
  });
});
