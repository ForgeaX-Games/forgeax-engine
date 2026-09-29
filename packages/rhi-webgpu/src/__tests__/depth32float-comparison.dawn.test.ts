import { describe, expect, it } from 'vitest';
import { runDepth32floatComparisonEvidence } from './depth32float-comparison-evidence';

describe('depth32float comparison parity on Dawn WebGPU', () => {
  it('records real rgba16float controls for depth clear 1 and 0', async () => {
    const evidence = await runDepth32floatComparisonEvidence('dawn');
    // biome-ignore lint/suspicious/noConsole: raw backend evidence is part of the gate record
    console.log(JSON.stringify(evidence));
    expect(evidence.status).toBe('available');
    expect(evidence.errorReceipts).toEqual([]);
    expect(evidence.controls).toHaveLength(2);
    expect(evidence.controls[0]).toMatchObject({
      clearValue: 1,
      comparison: 1,
      rawHalfWords: [15360, 0, 0, 15360],
    });
    expect(evidence.controls[1]).toMatchObject({
      clearValue: 0,
      comparison: 0,
      rawHalfWords: [0, 0, 0, 15360],
    });
  });
});
