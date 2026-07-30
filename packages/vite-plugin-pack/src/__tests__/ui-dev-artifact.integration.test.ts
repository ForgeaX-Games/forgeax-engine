import { describe, expect, it } from 'vitest';
import { logicalPackageFromImportProduct } from '../import-products.js';

describe('UI Pack v2 artifact transport', () => {
  it('keeps companion bytes asset-local instead of publishing top-level payload URLs', () => {
    const pack = logicalPackageFromImportProduct({
      assets: [
        {
          guid: 'ui-guid',
          kind: 'ui',
          payload: { guid: 'ui-guid', html: '<img src="hero.png">', css: '' },
          refs: [],
          artifacts: {
            'hero.png': { mediaType: 'image/png', bytes: new Uint8Array([137]) },
            'font.woff2': { mediaType: 'font/woff2', bytes: new Uint8Array([119]) },
          },
        },
      ],
    });
    const asset = pack.assets[0];
    expect(pack.schemaVersion).toBe('2.0.0');
    expect(asset?.payload).toMatchObject({ guid: 'ui-guid' });
    expect(Object.keys(asset?.artifacts ?? {})).toEqual(['hero.png', 'font.woff2']);
    expect(JSON.stringify(pack)).not.toContain('/__ui/');
  });

  it('normalises typed-array payload fields before JSON transport', () => {
    const pack = logicalPackageFromImportProduct({
      assets: [
        {
          guid: 'skeleton-guid',
          kind: 'skeleton',
          payload: { inverseBindMatrices: new Float32Array([1, 2, 3, 4]) },
          refs: [],
          artifacts: {},
        },
      ],
    });
    expect(pack.assets[0]?.payload.inverseBindMatrices).toEqual([1, 2, 3, 4]);
  });
});
