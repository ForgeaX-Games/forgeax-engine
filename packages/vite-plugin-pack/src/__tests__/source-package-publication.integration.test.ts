import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImporterRegistry, type ImportRunnerFs } from '@forgeax/engine-import';
import type { ImportedAsset, Importer } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { produceSourcePackage } from '../producer/source-package.js';
import {
  publishSourcePackage,
  type SourcePackageDdcInput,
  sourcePackageDdcKey,
} from '../producer/source-package-publication.js';

const GUID_A = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const GUID_B = '019e3969-1d48-7c3b-ac24-6d68f4570660';

function asset(guid: string): ImportedAsset {
  return {
    guid,
    kind: 'mesh',
    payload: { kind: 'mesh', vertexCount: 3 },
    refs: [{ guid: GUID_B }],
    artifacts: {
      body: { mediaType: 'application/octet-stream', bytes: new Uint8Array([4, 5, 6]) },
    },
  } as unknown as ImportedAsset;
}

async function sourcePackage() {
  const importer: Importer = {
    key: 'gltf',
    import: async () => ({
      ok: true,
      value: {
        assets: [asset(GUID_A), { ...asset(GUID_B), refs: [] }],
        sourceDependencies: [],
      },
    }),
  };
  const registry = new ImporterRegistry();
  registry.register(importer);
  const fs: ImportRunnerFs = {
    readSource: async () => ({ ok: true, value: new Uint8Array([1, 2, 3]) }),
  };
  const result = await produceSourcePackage({
    registry,
    fs,
    meta: {
      importer: 'gltf',
      source: 'scene.gltf',
      subAssets: [
        { guid: GUID_A, sourceIndex: 0, kind: 'mesh', sourceKey: 'mesh/main' },
        { guid: GUID_B, sourceIndex: 1, kind: 'mesh', sourceKey: 'mesh/detail' },
      ],
    },
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function ddcInput(): SourcePackageDdcInput {
  return {
    schemaVersion: 'source-package-v1',
    importer: 'gltf',
    importerVersion: 'gltf@4',
    producerFingerprint: 'sha256:producer-a',
    codec: 'pack-v2',
    settings: {},
    sourceDependencies: [{ path: 'scene.gltf', digest: 'sha256:source-a' }],
    declaredGuids: [GUID_A, GUID_B],
    targetProfile: 'dev',
    publish: { base: '/', packagePath: `assets/${GUID_A}.pack.json` },
  };
}

describe('source package staged publication', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('keeps DDC and route output invisible until the complete closure is installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-package-publication-'));
    roots.push(root);
    const source = await sourcePackage();
    const input = ddcInput();
    const key = sourcePackageDdcKey(input);

    const result = await publishSourcePackage({
      ddcRoot: join(root, 'ddc'),
      routeRoot: join(root, 'route'),
      ddcInput: input,
      source,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.key).toBe(key);
    expect(await readdir(join(root, 'ddc', 'entries', key))).toEqual(
      expect.arrayContaining(['payload.json', 'refs.json', 'artifacts.json', 'integrity.json']),
    );
    const pack = JSON.parse(await readFile(join(root, 'route', `${GUID_A}.pack.json`), 'utf8')) as {
      assets: readonly { guid: string; refs: readonly string[]; artifacts: object }[];
    };
    expect(pack.assets).toHaveLength(2);
    expect(pack.assets[0]?.refs).toEqual([GUID_B]);
    expect(pack.assets[0]?.artifacts).toHaveProperty('body');
    expect(await readFile(join(root, 'route', GUID_A, 'body.bin'))).toEqual(Buffer.from([4, 5, 6]));
    expect(result.value.packageUrl).toBe(`/assets/${GUID_A}.pack.json`);
  });

  it('rejects an incomplete staged route before changing the current publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-source-package-publication-'));
    roots.push(root);
    const source = await sourcePackage();
    const input = ddcInput();

    const result = await publishSourcePackage({
      ddcRoot: join(root, 'ddc'),
      routeRoot: join(root, 'route'),
      ddcInput: input,
      source,
      route: { omitArtifact: `${GUID_A}/body.bin` },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('source-package-publication-invalid');
    expect(result.error.detail.stage).toBe('route-integrity');
    await expect(readFile(join(root, 'route', `${GUID_A}.pack.json`))).rejects.toThrow();
  });
});
