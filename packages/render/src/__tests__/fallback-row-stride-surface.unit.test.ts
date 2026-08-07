import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FALLBACK_BYTES_PER_ROW } from '../ibl/skylight-bind-group';

const ownerSource = readFileSync(new URL('../ibl/skylight-bind-group.ts', import.meta.url), 'utf8');
const rendererSource = readFileSync(
  new URL('../renderer/renderer-factory.ts', import.meta.url),
  'utf8',
);

describe('fallback texture row-stride owner', () => {
  it('keeps both 1x1 fallback upload paths on one owner', () => {
    expect(FALLBACK_BYTES_PER_ROW).toBe(256);
    expect(ownerSource.match(/export const FALLBACK_BYTES_PER_ROW\s*=\s*256/g)).toHaveLength(1);
    expect(rendererSource).toContain('FALLBACK_BYTES_PER_ROW');
    expect(rendererSource).not.toMatch(/const FALLBACK_BYTES_PER_ROW\s*=\s*256/);
  });
});
