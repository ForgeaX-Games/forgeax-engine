import { describe, expect, it } from 'vitest';
import { resolvePostColorDomainContract } from '../render-pipeline';

describe('URP post color-domain order', () => {
  it('declares the required linear-to-encoded stage sequence', () => {
    expect(resolvePostColorDomainContract('urp')).toEqual([
      ['transparent-blend', 'linear-ldr', 'linear-ldr'],
      ['bloom', 'linear-hdr', 'linear-hdr'],
      ['tone', 'linear-hdr', 'linear-ldr'],
      ['fxaa', 'linear-ldr', 'linear-ldr'],
      ['output', 'linear-ldr', 'display-encoded'],
    ]);
  });
});
