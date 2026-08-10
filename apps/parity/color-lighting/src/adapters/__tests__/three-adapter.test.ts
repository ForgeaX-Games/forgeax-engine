import { describe, expect, it } from 'vitest';
import { threeToneMappingId } from '../three-adapter';

describe('Three r184 tone adapter', () => {
  it('uses Three r184 tone mapping IDs for browser output', () => {
    const modes = ['linear', 'reinhard', 'cineon', 'aces-filmic', 'agx', 'neutral'] as const;
    expect(modes.map((mode) => threeToneMappingId(mode))).toEqual([
      1, 2, 3, 4, 6, 7,
    ]);
  });
});
