import { describe, expect, it } from 'vitest';
import { runStandardLutReadback } from './standard-output-gpu-evidence';

describe('Standard output LUT readback on Dawn', () => {
  it('proves 3D filtered sampling, alpha preservation, and one OETF on a real device', async () => {
    const evidence = await runStandardLutReadback();
    expect(evidence.backend).toBe('webgpu');
    expect(evidence.linearLdr[0]).toBeCloseTo(0.292, 2);
    expect(evidence.linearLdr[1]).toBeCloseTo(0.344, 2);
    expect(evidence.linearLdr[2]).toBeCloseTo(0.396, 2);
    expect(evidence.finalSrgb[3]).toBeGreaterThan(170);
    expect(evidence.singleOetf).toBe(true);
    expect(evidence.lkgRecovery).toBe('preserved');
  });
});
