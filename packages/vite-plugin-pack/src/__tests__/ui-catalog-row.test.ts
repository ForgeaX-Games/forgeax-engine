import { describe, expect, it } from 'vitest';
import { createUiCatalogRow, dedupeFinalizedUiEntries } from '../ui-artifact-finalizer.js';

describe('UI catalog rows', () => {
  it('contains only the final UI payload URL and no importer bookkeeping', () => {
    const row = createUiCatalogRow({
      guid: 'ui-guid',
      sourcePath: 'menu.ui.html',
      relativeUrl: '/assets/menu.html',
    });
    expect(row).toEqual({
      guid: 'ui-guid',
      kind: 'ui',
      sourcePath: 'menu.ui.html',
      relativeUrl: '/assets/menu.html',
    });
    expect(row).not.toHaveProperty('sourceDependencies');
    expect(row).not.toHaveProperty('resourceLedger');
  });

  it('production catalog keeps one finalized JSON row when source and stale DDC rows coexist', () => {
    const guid = 'ui-guid';
    const finalizedUrl = '/assets/ui-guid-abc.ui.json';
    const catalog = dedupeFinalizedUiEntries(
      [
        createUiCatalogRow({ guid, sourcePath: 'menu.ui.html', relativeUrl: '/menu.ui.html' }),
        createUiCatalogRow({ guid, sourcePath: 'menu.ui.html', relativeUrl: '/menu.pack.json' }),
        createUiCatalogRow({ guid, sourcePath: 'menu.ui.html', relativeUrl: finalizedUrl }),
      ],
      new Map([[guid, finalizedUrl]]),
    );

    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ guid, kind: 'ui', relativeUrl: finalizedUrl });
    expect(catalog[0]?.relativeUrl).toMatch(/\.ui\.json$/);
  });
});
