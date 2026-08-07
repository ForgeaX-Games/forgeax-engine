import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SSAO_KERNEL_SAMPLE_COUNT } from '../ssao-data';

const ownerSource = readFileSync(new URL('../ssao-data.ts', import.meta.url), 'utf8');
const bufferSource = readFileSync(new URL('../ssao-buffers.ts', import.meta.url), 'utf8');

describe('SSAO kernel cardinality owner', () => {
  it('keeps the generated and uploaded sample count on one owner', () => {
    expect(SSAO_KERNEL_SAMPLE_COUNT).toBe(64);
    expect(ownerSource.match(/export const SSAO_KERNEL_SAMPLE_COUNT\s*=\s*64/g)).toHaveLength(1);
    expect(bufferSource).toContain('SSAO_KERNEL_SAMPLE_COUNT');
    expect(bufferSource).not.toMatch(/const (KERNEL_SIZE|KERNEL_SAMPLE_COUNT)\s*=\s*64/);
  });
});
