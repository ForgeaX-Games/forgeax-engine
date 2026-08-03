import { describe, expect, it } from 'vitest';
import { readLogical, semanticDdcKey, writeLogical } from '../ddc-cache.js';
import {
  canonicalizeLogicalPackage,
  finalizePackage,
  type LogicalPackage,
} from '../package-finalizer.js';

const logicalPackage: LogicalPackage = {
  schemaVersion: '2.0.0',
  kind: 'internal-text-package',
  assets: [
    {
      guid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
      kind: 'mesh',
      payload: { vertices: [0, 1, 2] },
      refs: [],
      artifacts: {
        mesh: { mediaType: 'application/octet-stream', bytes: new Uint8Array([4, 5, 6]) },
      },
    },
  ],
};

describe('DDC and finalizer determinism', () => {
  it('re-finalizes a cache hit and preserves the cold semantic output', async () => {
    const key = semanticDdcKey({
      schemaVersion: '2.0.0',
      importerVersion: 'importer@1',
      codecVersion: 'codec@1',
      sourceDependencies: [{ path: 'mesh.bin', digest: 'digest' }],
      settings: { profile: 'dev' },
      declaredGuids: [logicalPackage.assets[0]?.guid ?? ''],
      cookProfile: 'dev',
    });
    const cwd = `/tmp/forgeax-ddc-test-${key}`;
    await writeLogical(cwd, key, logicalPackage);
    const cached = await readLogical(cwd, key);
    expect(cached).not.toBeNull();
    if (cached === null) return;

    const writes: string[] = [];
    const sink = {
      write(path: string, _bytes: Uint8Array) {
        writes.push(path);
      },
    };
    const cold = await finalizePackage(logicalPackage, sink, {
      base: '/',
      packagePath: 'cold.json',
      artifactPath: (guid, name) => `${guid}/${name}.bin`,
    });
    const hit = await finalizePackage(cached, sink, {
      base: '/',
      packagePath: 'hit.json',
      artifactPath: (guid, name) => `${guid}/${name}.bin`,
    });
    expect(hit.semantic).toBe(cold.semantic);
    expect(canonicalizeLogicalPackage(cached)).toBe(canonicalizeLogicalPackage(logicalPackage));
    expect(writes.length).toBeGreaterThan(0);
  });

  it('keeps semantic output stable when only publication paths change', async () => {
    const writes: string[] = [];
    const sink = {
      write(path: string, _bytes: Uint8Array) {
        writes.push(path);
      },
    };
    const first = await finalizePackage(logicalPackage, sink, {
      base: '/preview/',
      packagePath: 'assets/first.pack.json',
      artifactPath: (guid, name) => `assets/first/${guid}/${name}.bin`,
    });
    const second = await finalizePackage(logicalPackage, sink, {
      base: '/release/',
      packagePath: 'assets/second.pack.json',
      artifactPath: (guid, name) => `assets/second/${guid}/${name}.bin`,
    });

    expect(second.semantic).toBe(first.semantic);
    expect(writes).toContain('assets/first.pack.json');
    expect(writes).toContain('assets/second.pack.json');
  });
});
