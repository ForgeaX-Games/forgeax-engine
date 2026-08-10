import { describe, expect, it } from 'vitest';
import {
  TONEMAP_ACES_FILMIC,
  TONEMAP_AGX,
  TONEMAP_CINEON,
  TONEMAP_LINEAR,
  TONEMAP_NEUTRAL,
  TONEMAP_REINHARD,
  TONEMAP_REINHARD_EXTENDED,
  tonemapFromF32,
  tonemapToU32,
} from '@forgeax/engine-render';
import { THREE_R184_TONE_MODES } from '../../analytic/three-r184-tonemap';

describe('public tone mode naming', () => {
  it('maps every Three r184 name to one public numeric mode', () => {
    const expected = {
      linear: TONEMAP_LINEAR,
      reinhard: TONEMAP_REINHARD,
      cineon: TONEMAP_CINEON,
      'aces-filmic': TONEMAP_ACES_FILMIC,
      agx: TONEMAP_AGX,
      neutral: TONEMAP_NEUTRAL,
    } as const;
    for (const mode of THREE_R184_TONE_MODES) {
      expect(tonemapToU32(mode)).toBe(expected[mode]);
      expect(tonemapFromF32(expected[mode])).toBe(mode);
    }
  });

  it('does not reuse a Three name for the Forge extended curve', () => {
    expect(TONEMAP_REINHARD_EXTENDED).not.toBe(TONEMAP_REINHARD);
    expect(tonemapFromF32(TONEMAP_REINHARD_EXTENDED)).toBe('reinhard-extended');
  });

  it('fails explicitly for an unknown public mode', () => {
    expect(() => tonemapToU32('unknown' as never)).toThrow();
  });
});
