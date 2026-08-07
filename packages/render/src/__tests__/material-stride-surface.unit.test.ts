import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MATERIAL_PER_ENTITY_STRIDE } from '../render-system';

const ownerSource = readFileSync(new URL('../render-system.ts', import.meta.url), 'utf8');
const recordSources = [
  readFileSync(new URL('../record/main-pass.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../record/main-pass-geometry.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../record/main-pass-sprite-draws.ts', import.meta.url), 'utf8'),
];

describe('material dynamic-offset stride surface', () => {
  it('keeps one internal owner and routes every record path through it', () => {
    expect(MATERIAL_PER_ENTITY_STRIDE).toBe(512);
    expect(ownerSource.match(/export const MATERIAL_PER_ENTITY_STRIDE\s*=\s*512/g)).toHaveLength(1);

    for (const source of recordSources) {
      expect(source).toContain('MATERIAL_PER_ENTITY_STRIDE');
      expect(source).not.toMatch(/const MATERIAL_PER_ENTITY_STRIDE\s*=/);
    }
  });
});
