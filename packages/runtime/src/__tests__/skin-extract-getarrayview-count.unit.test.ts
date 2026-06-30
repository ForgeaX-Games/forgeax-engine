// @ts-nocheck -- node:fs / node:path / node:url imports outside @types/node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// M2 / m2-1: regression guard for AC-03 -- after retiring the _getArrayView
// call at the joint-world resolve loop (migrated to public world.get), the
// total _getArrayView count in render-system-extract.ts must be exactly
// 16 occurrences (1 definition + 1 SpriteRegionOverride call site + 14
// comment / narrative lines).
//
// feat-20260625-refactor-sprite-as-transparent-mesh M3 / w12: count fell
// from 18 to 16 because the legacy isSprite extract block (with its
// duplicated _getArrayView narrative + override-read pair) collapsed into
// a single SpriteRegionOverride read inside the post-w12 generic-with-fold
// branch; the call site itself is unchanged.

const extractPath = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'render-system-extract.ts');
})();

describe('_getArrayView count (AC-03 gate)', () => {
  it('exactly 16 _getArrayView occurrences in render-system-extract.ts post-M3-w12', () => {
    const src = readFileSync(extractPath, 'utf8');
    const hits = src.split('_getArrayView').length - 1;
    expect(hits).toBe(16);
  });
});
