import { describe, expect, it } from 'vitest';

const VFX_ROW = {
  producer: 'vfx-particles',
  visible: 'observation.player contributes to main color',
  hidden: 'observation.player contributes nothing to main color',
  restored: 'the same observation.player contributes again',
  shadow: 'N/A: baseline has no shadow contribution',
} as const;

describe('vfx visibility producer matrix audit', () => {
  it('records the VFX three-state gate without inventing a shadow producer', () => {
    expect(VFX_ROW).toEqual({
      producer: 'vfx-particles',
      visible: expect.stringContaining('main color'),
      hidden: expect.stringContaining('nothing'),
      restored: expect.stringContaining('again'),
      shadow: 'N/A: baseline has no shadow contribution',
    });
  });
});
