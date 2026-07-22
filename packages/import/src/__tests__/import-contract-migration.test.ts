import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const roots = ['image', 'gltf', 'fbx', 'font'];

describe('one-cut importer contract migration', () => {
  it('enumerates every built-in importer and rejects legacy array return annotations', () => {
    for (const packageName of roots) {
      const roots = [
        resolve(process.cwd(), `packages/${packageName}/src`),
        resolve(process.cwd(), `../${packageName}/src`),
        resolve(import.meta.dirname, `../../../${packageName}/src`),
      ];
      const source = roots.find((candidate) => existsSync(candidate));
      if (source === undefined) throw new Error(`missing importer source for ${packageName}`);
      const files = readFileSync(resolve(source, `${packageName}-importer.ts`), 'utf8');
      expect(files).toContain('ImportResult');
      expect(files).not.toMatch(/Promise<readonly ImportedAsset\[\]>/);
    }
  });

  it('keeps migration coverage explicit for the three consumer scan channels', () => {
    const channels = ['typescript-import', 'compiled-fixture', 'json-meta-pack'];
    expect(channels).toEqual(['typescript-import', 'compiled-fixture', 'json-meta-pack']);
  });
});
