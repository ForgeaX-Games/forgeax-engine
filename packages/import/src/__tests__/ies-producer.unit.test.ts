import type { ImportContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { iesImporter } from '../ies/ies-importer.js';
import { parseLm63TypeC } from '../ies/parse-lm63.js';
import { readFloat16LE, resampleTypeC } from '../ies/resample-type-c.js';

const GUID = '019f0000-0000-7000-8000-000000000081';
const SOURCE = `IESNA:LM-63-2002
TILT=NONE
1 1000 1 3 3 1 1 1 1 1 1 1
0 90 180
0 90 180
1 2 3
4 5 6
1 2 3
`;

function context(source: string): ImportContext {
  return {
    source: 'fixtures/asymmetric.ies',
    readSource: async () => ({ ok: true as const, value: new TextEncoder().encode(source) }),
    readSibling: async () => ({ ok: false as const, error: new Error('not used') as never }),
    decodeImage: async () => {
      throw new Error('not used');
    },
    subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'ies/main', kind: 'ies-profile' }],
    importSettings: {},
  };
}

function fixture(): string {
  return `IESNA:LM-63-2002
[TEST] ForgeaX Type C fixture
TILT=NONE
1 1000 1 3 3 1 1 1 1 1 1 1
0 90 180
0 90 180
1 2 3
4 5 6
1 2 3
`;
}

describe('LM-63 Type C producer primitives', () => {
  it('parses TILT=NONE and preserves Type C angle tables', () => {
    const parsed = parseLm63TypeC(fixture());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.horizontalAnglesDeg).toEqual([0, 90, 180]);
      expect(parsed.value.candela).toHaveLength(9);
      expect(parsed.value.tilt).toBe('NONE');
    }
  });

  it('rejects tilted or non-Type-C sources with source diagnostics', () => {
    const tilted = parseLm63TypeC(fixture().replace('TILT=NONE', 'TILT=INCLUDE'));
    const nonTypeC = parseLm63TypeC(fixture().replace('1 1000 1 3 3 1 1', '1 1000 1 3 3 2 1'));
    expect(tilted.ok).toBe(false);
    expect(nonTypeC.ok).toBe(false);
  });

  it('resamples to deterministic finite peak-normalized little-endian f16 bytes', () => {
    const parsed = parseLm63TypeC(fixture());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const first = resampleTypeC(parsed.value);
    const second = resampleTypeC(parsed.value);
    expect(first).toEqual(second);
    expect(first).toHaveLength(256 * 128 * 2);
    const samples = Array.from({ length: 256 * 128 }, (_, index) =>
      readFloat16LE(first, index * 2),
    );
    expect(samples.every(Number.isFinite)).toBe(true);
    expect(Math.max(...samples)).toBeCloseTo(1, 6);
    const lastSample = samples.at(-1) ?? 0;
    expect(samples[255]).toBeCloseTo(lastSample, 3);
  });
});

describe('IES Pack and publication boundary', () => {
  it('publishes the authored GUID and cooked artifact without source text', async () => {
    const result = await iesImporter.import(context(SOURCE));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assets).toHaveLength(1);
    expect(result.value.assets[0]).toMatchObject({ guid: GUID, kind: 'ies-profile' });
    expect(result.value.assets[0]?.payload).toMatchObject({ kind: 'ies-profile' });
    expect(result.value.assets[0]?.artifacts.body?.bytes).toHaveLength(256 * 128 * 2);
  });

  it('is byte deterministic and rejects invalid sources before publication', async () => {
    const first = await iesImporter.import(context(SOURCE));
    const second = await iesImporter.import(context(SOURCE));
    expect(first).toEqual(second);

    const failed = await iesImporter.import(context(SOURCE.replace('TILT=NONE', 'TILT=INCLUDE')));
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toMatchObject({ code: 'source-validation-failed' });
      expect(failed.error.expected).toContain('TILT=NONE');
      expect(failed.error.detail).toMatchObject({ diagnostics: expect.any(Array) });
    }
  });
});
