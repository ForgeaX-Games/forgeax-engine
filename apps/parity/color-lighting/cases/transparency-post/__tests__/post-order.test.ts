import { describe, expect, it } from 'vitest';
import { resolvePostColorDomainContract } from '../../../../../../packages/render/src/render-pipeline';

describe('transparency post order', () => {
  it('reports a machine-readable sequence for paired LDR and HDR cases', () => {
    const ldr = resolvePostColorDomainContract('linear-ldr');
    const hdr = resolvePostColorDomainContract('linear-hdr');
    expect(ldr.slice(1)).toEqual(hdr.slice(1));
    expect(ldr[0]).toEqual(['transparent-blend', 'linear-ldr', 'linear-ldr']);
    expect(hdr[0]).toEqual(['transparent-blend', 'linear-hdr', 'linear-hdr']);
  });

  it('places output encoding after FXAA', () => {
    const stages = resolvePostColorDomainContract('linear-ldr');
    const fxaa = stages.findIndex(([name]) => name === 'fxaa');
    const output = stages.findIndex(([name]) => name === 'output');
    expect(fxaa).toBeGreaterThanOrEqual(0);
    expect(output).toBeGreaterThan(fxaa);
    expect(stages[output]?.[2]).toBe('display-encoded');
  });
});
