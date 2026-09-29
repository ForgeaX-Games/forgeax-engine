import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FALLBACK_BYTES_PER_ROW } from '../ibl/skylight-bind-group';

const ownerSource = readFileSync(new URL('../ibl/skylight-bind-group.ts', import.meta.url), 'utf8');
const rendererSource = readFileSync(
  new URL('../assembly/webgpu-ready.ts', import.meta.url),
  'utf8',
);

describe('fallback texture row-stride owner', () => {
  it('keeps both 1x1 fallback upload paths on one owner', () => {
    expect(FALLBACK_BYTES_PER_ROW).toBe(256);
    expect(ownerSource.match(/export const FALLBACK_BYTES_PER_ROW\s*=\s*256/g)).toHaveLength(1);
    expect(rendererSource).toContain('FALLBACK_BYTES_PER_ROW');
    expect(rendererSource).not.toMatch(/const FALLBACK_BYTES_PER_ROW\s*=\s*256/);
  });

  it('uploads an exactly neutral normal instead of treating 128/255 as one half', () => {
    const creation = rendererSource.slice(
      rendererSource.indexOf('const fallbackNormalTextureResult ='),
      rendererSource.indexOf('const fallbackNormalTextureViewResult ='),
    );
    expect(creation).toContain("format: 'rgba16float'");
    const start = creation.indexOf('const fallbackNormalPixel =');
    const end = creation.indexOf('const fallbackNormalWriteResult =');
    // Execute the actual owner payload construction; do not duplicate its bytes.
    const bytes = new Function(
      'FALLBACK_BYTES_PER_ROW',
      `${creation.slice(start, end)}; return fallbackNormalPixel;`,
    )(FALLBACK_BYTES_PER_ROW) as Uint8Array;
    const values = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect([0, 1, 2, 3].map((i) => values.getUint16(i * 2, true))).toEqual([
      0x3800, 0x3800, 0x3c00, 0x3c00,
    ]);
  });
});
