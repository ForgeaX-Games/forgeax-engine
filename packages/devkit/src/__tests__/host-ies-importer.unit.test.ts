import { describe, expect, it } from 'vitest';
import { DEFAULT_IMPORTERS } from '../host.js';

describe('standalone host IES importer seed', () => {
  it('seeds the built-in importers beside the existing importer set', () => {
    const ies = DEFAULT_IMPORTERS.find((importer) => importer.key === 'ies');
    expect(ies).toBeDefined();
    expect(DEFAULT_IMPORTERS.map((importer) => importer.key)).toEqual([
      'audio',
      'image',
      'fbx',
      'gltf',
      'font',
      'ies',
      'ui',
    ]);
  });
});
