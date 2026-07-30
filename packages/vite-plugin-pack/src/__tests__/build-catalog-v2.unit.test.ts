import { describe, expect, it } from 'vitest';
import { projectPackageCatalog } from '../build-catalog.js';

describe('catalog builder v2', () => {
  it('projects every asset in one package to the same packageUrl', () => {
    const rows = projectPackageCatalog(
      [
        { guid: 'a', kind: 'mesh', sourcePath: 'model.glb', name: 'body', refs: ['b'] },
        { guid: 'b', kind: 'texture', sourcePath: 'model.glb', name: 'albedo', refs: [] },
      ],
      '/preview/packages/model',
    );

    expect(rows).toEqual([
      {
        guid: 'a',
        kind: 'mesh',
        sourcePath: 'model.glb',
        name: 'body',
        refs: ['b'],
        packageUrl: '/preview/packages/model',
      },
      {
        guid: 'b',
        kind: 'texture',
        sourcePath: 'model.glb',
        name: 'albedo',
        refs: [],
        packageUrl: '/preview/packages/model',
      },
    ]);
  });

  it('keeps catalog rows free of artifact content facts', () => {
    const [row] = projectPackageCatalog(
      [{ guid: 'a', kind: 'host-kind', sourcePath: 'source.meta.json' }],
      '/preview/packages/source',
    );

    expect(row).toBeDefined();
    expect(row?.packageUrl).toBe('/preview/packages/source');
    expect(row).not.toHaveProperty('metadata');
    expect(row).not.toHaveProperty('compression');
    expect(row).not.toHaveProperty('artifacts');
  });
});
