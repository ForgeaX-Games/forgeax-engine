import { authoringCapabilityForAssetKind } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { projectPackageCatalog } from '../build-catalog.js';

describe('catalog builder v2', () => {
  it('projects every asset in one package to the same packageUrl', () => {
    const rows = projectPackageCatalog(
      [
        {
          guid: 'a',
          kind: 'mesh',
          sourcePath: 'model.glb',
          name: 'body',
          refs: ['b'],
          authoring: authoringCapabilityForAssetKind('mesh'),
        },
        {
          guid: 'b',
          kind: 'texture',
          sourcePath: 'model.glb',
          name: 'albedo',
          refs: [],
          authoring: authoringCapabilityForAssetKind('texture'),
        },
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
        authoring: authoringCapabilityForAssetKind('mesh'),
        subject: 'internal-asset',
        execution: 'direct',
        lifecycle: 'current',
        projection: expect.objectContaining({
          subject: 'internal-asset',
          execution: 'direct',
          lifecycle: 'current',
        }),
      },
      {
        guid: 'b',
        kind: 'texture',
        sourcePath: 'model.glb',
        name: 'albedo',
        refs: [],
        packageUrl: '/preview/packages/model',
        authoring: authoringCapabilityForAssetKind('texture'),
        subject: 'internal-asset',
        execution: 'direct',
        lifecycle: 'current',
        projection: expect.objectContaining({
          subject: 'internal-asset',
          execution: 'direct',
          lifecycle: 'current',
        }),
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
    expect(row).not.toHaveProperty('authoring');
  });

  it('preserves a producer override for a new kind without consumer knowledge', () => {
    const authoring = {
      placement: { operation: 'spawnEntity' as const },
      binding: {
        operation: 'unavailable' as const,
        reason: { code: 'missing-producer-capability' as const, hint: 'provider-owned' },
      },
    };
    const [row] = projectPackageCatalog(
      [{ guid: 'custom', kind: 'host/new-kind', sourcePath: 'custom.meta.json', authoring }],
      '/preview/custom',
    );
    expect(row?.authoring).toEqual(authoring);
  });
});
