// image-importer-hdr-equirect.test.ts
// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M1 / w1.
//
// TDD red->green: locks the .hdr arm of imageImporter producing an
// EquirectAsset POD (kind:'equirect', rgba16float 2D) for an 'equirect'
// sub-asset, instead of the prior TextureAsset (kind:'texture') for a
// 'texture' sub-asset. research F-10 + plan-strategy D-9; orchestrator
// adjudication: equirect produces a build-time .bin (2D rgba16float image).

import type { EquirectAsset, ImportContext, ImportSubAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { imageImporter } from '../image-importer.js';

const HDR_GUID = '019e3969-1d43-7610-8810-e80dbd491d91';

function makeHdrFixture(width: number, height: number): Uint8Array {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(header);

  const hi = (width >> 8) & 0xff;
  const lo = width & 0xff;
  const prefix = new Uint8Array([0x02, 0x02, hi, lo]);

  const chRun = new Uint8Array([128 + width, 128]);
  const scanlineBytes = 4 + 4 * 2;
  const pixelBytes = new Uint8Array(height * scanlineBytes);

  for (let y = 0; y < height; y++) {
    let off = y * scanlineBytes;
    pixelBytes.set(prefix, off);
    off += 4;
    pixelBytes.set(chRun, off);
    off += 2;
    pixelBytes.set(chRun, off);
    off += 2;
    pixelBytes.set(chRun, off);
    off += 2;
    pixelBytes.set(chRun, off);
  }

  const total = new Uint8Array(headerBytes.length + pixelBytes.length);
  total.set(headerBytes);
  total.set(pixelBytes, headerBytes.length);
  return total;
}

function makeHdrCtx(
  source: string,
  bytes: Uint8Array,
  subAssets: readonly ImportSubAsset[],
  importSettings: Readonly<Record<string, unknown>> = {},
): ImportContext {
  return {
    source,
    readSource: async () => ({ ok: true, value: bytes }),
    readSibling: async () => ({ ok: true, value: new Uint8Array() }),
    decodeImage: async () => {
      throw new Error('decodeImage not used by imageImporter');
    },
    subAssets,
    importSettings,
  };
}

describe('imageImporter HDR arm produces EquirectAsset (w1)', () => {
  it('(a) .hdr + equirect sub-asset -> EquirectAsset POD kind:"equirect" + rgba16float', async () => {
    const width = 8;
    const height = 4;
    const ctx = makeHdrCtx('env.hdr', makeHdrFixture(width, height), [
      { guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' },
    ]);

    const produced = await imageImporter.import(ctx);
    expect(produced.length).toBe(1);
    const asset = produced[0];
    expect(asset?.guid).toBe(HDR_GUID);
    expect(asset?.kind).toBe('equirect');

    const payload = asset?.payload as EquirectAsset;
    expect(payload.kind).toBe('equirect');
    expect(payload.format).toBe('rgba16float');
    expect(payload.colorSpace).toBe('linear');
    expect(payload.width).toBe(width);
    expect(payload.height).toBe(height);
  });

  it('(b) byte length is width * height * 4 * 2 (rgba16f = 8 bytes/pixel)', async () => {
    const width = 8;
    const height = 4;
    const ctx = makeHdrCtx('env.hdr', makeHdrFixture(width, height), [
      { guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' },
    ]);

    const produced = await imageImporter.import(ctx);
    const payload = (produced[0] as { payload: EquirectAsset })?.payload;
    expect(payload.data.length).toBe(width * height * 4 * 2);
  });

  it('(c) a texture sub-asset with .hdr source is NOT folded (only equirect is)', async () => {
    const ctx = makeHdrCtx('env.hdr', makeHdrFixture(8, 4), [
      { guid: HDR_GUID, sourceIndex: 0, kind: 'texture' },
    ]);
    const produced = await imageImporter.import(ctx);
    expect(produced.length).toBe(0);
  });

  it('(d) .hdr extension upper-case is still recognized via toLowerCase()', async () => {
    const ctx = makeHdrCtx('ENV.HDR', makeHdrFixture(8, 2), [
      { guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' },
    ]);
    const produced = await imageImporter.import(ctx);
    expect(produced.length).toBe(1);
    expect(produced[0]?.kind).toBe('equirect');
  });

  it('(e) throws for a corrupt .hdr source (invalid RGBE header)', async () => {
    const corrupt = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const ctx = makeHdrCtx('bad.hdr', corrupt, [
      { guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' },
    ]);
    await expect(imageImporter.import(ctx)).rejects.toThrow();
  });
});
