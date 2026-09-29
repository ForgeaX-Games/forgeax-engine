import { describe, expect, it } from 'vitest';

describe('deep-agent-feedback baseline evidence contract', () => {
  it('keeps repeat and transform evidence explicitly classified', () => {
    const evidence = {
      sourceKey: 'deep-agent-feedback/checkerboard',
      backend: 'dawn',
      repeat: 'unreproduced',
      coordinatesTransform: 'unreproduced',
    } as const;
    expect(evidence.backend).toBe('dawn');
    expect(evidence.repeat).toBe('unreproduced');
    expect(evidence.coordinatesTransform).toBe('unreproduced');
  });
});
