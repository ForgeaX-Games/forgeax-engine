import { describe, expect, it } from 'vitest';
import { resolvePostColorDomainContract } from '../../../../../../packages/render/src/render-pipeline';

describe('transparency post order', () => {
  it('reports a machine-readable sequence for paired LDR and HDR cases', () => {
    const urp = resolvePostColorDomainContract('urp');
    const hdrp = resolvePostColorDomainContract('hdrp');
    expect(urp.slice(1)).toEqual(hdrp.slice(1));
    expect(urp[0]).toEqual(['transparent-blend', 'linear-ldr', 'linear-ldr']);
    expect(hdrp[0]).toEqual(['transparent-blend', 'linear-hdr', 'linear-hdr']);
  });

  it('places output encoding after FXAA', () => {
    const stages = resolvePostColorDomainContract('urp');
    const fxaa = stages.findIndex(([name]) => name === 'fxaa');
    const output = stages.findIndex(([name]) => name === 'output');
    expect(fxaa).toBeGreaterThanOrEqual(0);
    expect(output).toBeGreaterThan(fxaa);
    expect(stages[output]?.[2]).toBe('display-encoded');
  });
});
