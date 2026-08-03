import { describe, expect, it } from 'vitest';
import { type ExistingExternalAssetPackage, reimportReuseMeta } from '../reimport-reuse-meta.js';
import { deriveImageSourceKey, deriveImageSourceKeys } from '../source-key.js';
import { subAssetKey } from '../sub-asset-key.js';

const GUID = '01928000-7c00-7000-8000-000000000042';

function decoded(): Parameters<typeof reimportReuseMeta>[0] {
  return {
    bytes: new Uint8Array(4),
    width: 1,
    height: 1,
    mime: 'image/png',
    colorSpace: 'srgb',
    mipmap: true,
  };
}

function existing(): ExistingExternalAssetPackage {
  return {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: 'renamed.png',
    importSettings: {},
    subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'texture', sourceKey: 'image:texture' }],
  };
}

describe('image producer sourceKey', () => {
  it('uses a role key independent of path and sourceIndex', () => {
    expect(deriveImageSourceKey('texture')).toBe('image:texture');
    expect(deriveImageSourceKey('texture', { sourcePath: 'moved/wood.png', sourceIndex: 8 })).toBe(
      'image:texture',
    );
  });

  it('rejects an empty role instead of manufacturing an index key', () => {
    expect(deriveImageSourceKey('')).toBeUndefined();
  });

  it('requires unique semantic roles for multi-output images', () => {
    expect(deriveImageSourceKeys(['texture', 'equirect'])).toEqual({
      ok: true,
      keys: ['image:texture', 'image:equirect'],
    });
    expect(deriveImageSourceKeys(['texture', 'texture'])).toMatchObject({
      ok: false,
      code: 'duplicate-source-key',
    });
  });

  it('keeps legacy indexFallback separate from producer sourceKey', () => {
    expect(subAssetKey({ kind: 'texture', sourceIndex: 0 })).toEqual({
      kind: 'texture',
      indexFallback: 'textures/0',
    });
    expect(deriveImageSourceKey('texture')).not.toContain('0');
  });

  it('reuses identity after source relocation while emitting the role key', () => {
    const result = reimportReuseMeta(decoded(), existing());
    expect(result[0]).toMatchObject({ guid: GUID, sourceIndex: 0, sourceKey: 'image:texture' });
  });
});
