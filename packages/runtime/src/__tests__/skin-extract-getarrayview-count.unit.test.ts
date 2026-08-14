// @ts-nocheck -- node:fs / node:path / node:url imports outside @types/node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the hot extract path: joint/instance array fields must
// stay on the zero-copy column route instead of whole-row world.get calls.

const extractPath = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', '..', 'render', 'src', 'render-system-extract.ts');
})();

describe('_getArrayView count (AC-03 gate)', () => {
  it('keeps skin and instance hot fields on column views', () => {
    const src = readFileSync(extractPath, 'utf8');
    expect(src).toContain("_getArrayView(jointEntity, Transform, 'world')");
    expect(src).toContain("_getArrayView(entity, Instances, 'transforms')");
    expect(src).toContain("_getArrayView(entity, SpriteInstances, 'transforms')");
    expect(src).toContain("_getArrayView(entity, SpriteInstances, 'regions')");
    expect(src).not.toMatch(/^\s*const\s+\w+\s*=\s*world\.get\(jointEntity, Transform\)/m);
    expect(src).not.toMatch(/^\s*const\s+\w+\s*=\s*world\.get\(entity, Instances\)/m);
  });
});
