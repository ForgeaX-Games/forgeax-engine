import { describe, expect, it } from 'vitest';
import { resolvePostColorDomainContract } from '../render-pipeline';

describe('HDRP post color-domain order', () => {
  it('keeps transparent and bloom work in linear HDR before tone output', () => {
    const stages = resolvePostColorDomainContract('hdrp');
    expect(stages).toContainEqual(['transparent-blend', 'linear-hdr', 'linear-hdr']);
    expect(stages).toContainEqual(['bloom', 'linear-hdr', 'linear-hdr']);
    expect(stages).toContainEqual(['tone', 'linear-hdr', 'linear-ldr']);
    expect(stages).toContainEqual(['output', 'linear-ldr', 'display-encoded']);
    expect(stages.findIndex(([name]) => name === 'tone')).toBeGreaterThan(
      stages.findIndex(([name]) => name === 'bloom'),
    );
  });
});
