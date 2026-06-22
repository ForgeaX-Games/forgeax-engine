// @ts-nocheck -- node:fs / node:path / node:url imports outside @types/node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// M2 / m2-1: regression guard for AC-03 -- after retiring the _getArrayView
// call at the joint-world resolve loop (migrated to public world.get), the
// total _getArrayView count in render-system-extract.ts must be exactly 18
// (1 definition at :872 + 16 comment/narrative lines + 1 comment line at the
// retired site). Pre-M2 count was 19 (1 definition + 17 comment/narrative
// lines + 1 joint-read call at :2463). Any deviation forces an explicit
// decision: a new call site or a removed one.

const extractPath = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'render-system-extract.ts');
})();

describe('_getArrayView count (AC-03 gate)', () => {
  it('exactly 18 _getArrayView occurrences in render-system-extract.ts post-M2', () => {
    const src = readFileSync(extractPath, 'utf8');
    const hits = src.split('_getArrayView').length - 1;
    expect(hits).toBe(18);
  });
});
