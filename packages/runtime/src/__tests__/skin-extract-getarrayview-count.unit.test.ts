// @ts-nocheck -- node:fs / node:path / node:url imports outside @types/node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// M2 / m2-1: regression guard for AC-03 -- after retiring the _getArrayView
// call at the joint-world resolve loop (migrated to public world.get), the
// total _getArrayView invocation surface in render-system-extract.ts must stay
// at seven occurrences (one facade declaration + six call sites). Count code
// syntax rather than comments so documentation edits cannot trip this gate.
//
// feat-20260625-refactor-sprite-as-transparent-mesh M3 / w12: count fell
// from 18 to 16 because the legacy isSprite extract block (with its
// duplicated _getArrayView narrative + override-read pair) collapsed into
// a single SpriteRegionOverride read inside the post-w12 generic-with-fold
// branch; the call site itself is unchanged.

const extractPath = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', 'render', 'src', 'render-system-extract.ts');
})();

describe('_getArrayView count (AC-03 gate)', () => {
  it('keeps the bounded _getArrayView invocation surface in render-system-extract.ts', () => {
    const src = readFileSync(extractPath, 'utf8');
    const invocations = src.match(/_getArrayView\s*\(/g)?.length ?? 0;
    expect(invocations).toBe(7);
  });
});
