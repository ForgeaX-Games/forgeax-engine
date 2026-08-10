import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImporterRegistry, type ImportRunnerFs } from '@forgeax/engine-import';
import type { ImportedAsset, Importer } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { produceSourcePackage } from '../producer/source-package.js';
import {
  createSourcePackagePublication,
  type SourcePackageDdcInput,
  sourcePackageDdcKey,
} from '../producer/source-package-publication.js';

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';

function input(): SourcePackageDdcInput {
  return {
    schemaVersion: 'source-package-v1',
    importer: 'image',
    importerVersion: 'image@4',
    producerFingerprint: 'sha256:producer-a',
    codec: 'pack-v2',
    settings: { colorSpace: 'srgb' },
    sourceDependencies: [{ path: 'image.png', digest: 'sha256:image-a' }],
    declaredGuids: [GUID],
    targetProfile: 'dev',
    publish: { base: '/', packagePath: `assets/${GUID}.pack.json` },
  };
}

function produceFixture(counter: { calls: number }) {
  return async () => {
    counter.calls += 1;
    const importer: Importer = {
      key: 'image',
      import: async () => ({
        ok: true,
        value: {
          assets: [
            {
              guid: GUID,
              kind: 'texture',
              payload: { kind: 'texture', width: 1, height: 1 },
              refs: [],
              artifacts: {
                body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) },
              },
            } as unknown as ImportedAsset,
          ],
          sourceDependencies: [],
        },
      }),
    };
    const registry = new ImporterRegistry();
    registry.register(importer);
    const fs: ImportRunnerFs = {
      readSource: async () => ({ ok: true, value: new Uint8Array([4, 5, 6]) }),
    };
    const result = await produceSourcePackage({
      registry,
      fs,
      meta: {
        importer: 'image',
        source: 'image.png',
        subAssets: [{ guid: GUID, sourceIndex: 0, kind: 'texture' }],
      },
    });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };
}

describe('source package restart and coalescing', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reuses a complete entry after a fresh publisher is created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-package-restart-'));
    roots.push(root);
    const firstCounter = { calls: 0 };
    const first = createSourcePackagePublication({
      ddcRoot: join(root, 'ddc'),
      routeRoot: join(root, 'route'),
      ddcInput: input(),
      produce: produceFixture(firstCounter),
    });
    const cold = await first.ensure();
    expect(cold.ok).toBe(true);
    expect(firstCounter.calls).toBe(1);

    const secondCounter = { calls: 0 };
    const second = createSourcePackagePublication({
      ddcRoot: join(root, 'ddc'),
      routeRoot: join(root, 'route'),
      ddcInput: input(),
      produce: produceFixture(secondCounter),
    });
    const warm = await second.ensure();

    expect(warm.ok).toBe(true);
    if (!cold.ok || !warm.ok) return;
    expect(secondCounter.calls).toBe(0);
    expect(warm.value.key).toBe(sourcePackageDdcKey(input()));
    expect(warm.value.semanticDigest).toBe(cold.value.semanticDigest);
  });

  it('coalesces concurrent callers into one complete current entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-package-restart-'));
    roots.push(root);
    const counter = { calls: 0 };
    const produce = vi.fn(produceFixture(counter));
    const publication = createSourcePackagePublication({
      ddcRoot: join(root, 'ddc'),
      routeRoot: join(root, 'route'),
      ddcInput: input(),
      produce,
    });

    const results = await Promise.all([publication.ensure(), publication.ensure()]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(produce).toHaveBeenCalledTimes(1);
    expect(counter.calls).toBe(1);
    if (!results[0]?.ok || !results[1]?.ok) return;
    expect(results[0].value.semanticDigest).toBe(results[1].value.semanticDigest);
  });
});
