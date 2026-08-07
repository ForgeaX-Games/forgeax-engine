import { describe, expect, it } from 'vitest';
import {
  createUiCatalogRow,
  dedupeFinalizedUiEntries,
  finalizeUiArtifact,
} from '../ui-pack-finalizer.js';

describe('UI catalog rows', () => {
  it('contains only the final UI payload URL and no importer bookkeeping', () => {
    const row = createUiCatalogRow({
      guid: 'ui-guid',
      sourcePath: 'menu.ui.html',
      packageUrl: '/assets/menu.html',
    });
    expect(row).toEqual({
      guid: 'ui-guid',
      kind: 'ui',
      sourcePath: 'menu.ui.html',
      packageUrl: '/assets/menu.html',
    });
    expect(row).not.toHaveProperty('sourceDependencies');
    expect(row).not.toHaveProperty('resourceLedger');
  });

  it('production catalog keeps one finalized Pack v2 row when source and stale DDC rows coexist', () => {
    const guid = 'ui-guid';
    const finalizedUrl = '/assets/ui-guid-abc.pack.json';
    const catalog = dedupeFinalizedUiEntries(
      [
        createUiCatalogRow({ guid, sourcePath: 'menu.ui.html', packageUrl: '/menu.ui.html' }),
        createUiCatalogRow({ guid, sourcePath: 'menu.ui.html', packageUrl: '/menu.pack.json' }),
        createUiCatalogRow({ guid, sourcePath: 'menu.ui.html', packageUrl: finalizedUrl }),
      ],
      new Map([[guid, finalizedUrl]]),
    );

    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ guid, kind: 'ui', packageUrl: finalizedUrl });
    expect(catalog[0]?.packageUrl).toMatch(/\.pack\.json$/);
  });

  it('does not turn source importer bookkeeping into a second Catalog authority', () => {
    const row = createUiCatalogRow({
      guid: 'prepared-ui-guid',
      sourcePath: 'menu.ui.html',
      packageUrl: '/assets/prepared-ui.pack.json',
    });
    expect(row).toEqual({
      guid: 'prepared-ui-guid',
      kind: 'ui',
      sourcePath: 'menu.ui.html',
      packageUrl: '/assets/prepared-ui.pack.json',
    });
    expect(row).not.toHaveProperty('assetType');
    expect(row).not.toHaveProperty('importer');
  });

  it('rewrites UI companion tokens before the shared Pack v2 finalizer consumes the product', () => {
    const result = finalizeUiArtifact(
      {
        assets: [
          {
            guid: 'ui-guid',
            kind: 'ui',
            payload: {
              guid: 'ui-guid',
              html: '<img src="ui-token:icons/panel.png">',
              css: '.hud { background: url("ui-token:icons/panel.png"); }',
            },
            refs: [],
            artifacts: {
              'icons/panel.png': {
                mediaType: 'image/png',
                bytes: Uint8Array.of(1, 2, 3),
              },
            },
          },
        ],
        sourceDependencies: ['hud.ui.html', 'icons/panel.png'],
      } as never,
      { artifactUrl: ({ path }) => `/assets/${path}` },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.asset.html).toContain('/assets/icons/panel.png');
      expect(result.value.asset.css).toContain('/assets/icons/panel.png');
      expect(result.value.artifacts).toEqual([{ path: 'icons/panel.png', mimeType: 'image/png' }]);
    }
  });
});
