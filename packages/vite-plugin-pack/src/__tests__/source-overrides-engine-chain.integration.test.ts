import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogReplica } from '@forgeax/engine-assets-runtime';
import { DdcEntryStore, DdcLifecycle, ddcOutputDigest } from '@forgeax/engine-ddc';
import { ImporterRegistry, type RunImportMeta, runImport } from '@forgeax/engine-import';
import type { Asset, CatalogDelta, ImportContext, ImportedAsset } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { type SemanticDdcInput, semanticDdcKey } from '../ddc-cache.js';

const GUID = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

function meta(sourceOverrides?: Record<string, Record<string, unknown>>): RunImportMeta {
  return {
    importer: 'fixture',
    source: 'fixture.source',
    ...(sourceOverrides === undefined ? {} : { sourceOverrides }),
    subAssets: [{ guid: GUID, sourceIndex: 0, sourceKey: 'mesh/main', kind: 'mesh' }],
  } as RunImportMeta;
}

function semantic(sourceOverrides?: Record<string, unknown>): SemanticDdcInput {
  return {
    schemaVersion: '2.0.0',
    importerVersion: 'fixture@1',
    codecVersion: 'fixture-codec@1',
    sourceDependencies: [{ path: 'fixture.source', digest: 'source-digest' }],
    settings: { profile: 'dev' },
    declaredGuids: [GUID],
    cookProfile: 'dev',
    ...(sourceOverrides === undefined ? {} : { sourceOverrides }),
  } as SemanticDdcInput;
}

function asset(): ImportedAsset {
  return {
    guid: GUID,
    kind: 'mesh',
    payload: { vertices: new Float32Array(), indices: new Uint16Array(), attributes: {} } as Asset,
    refs: [],
    artifacts: {},
  };
}

function registry(received: { value?: unknown }): ImporterRegistry {
  const result = new ImporterRegistry();
  result.register({
    key: 'fixture',
    import: (ctx: ImportContext) => {
      received.value = ctx.sourceOverrides;
      return {
        ok: true,
        value: { assets: [asset()], sourceDependencies: [] },
      };
    },
  });
  return result;
}

function fs() {
  return { readSource: async () => ({ ok: true as const, value: new Uint8Array([1, 2, 3]) }) };
}

async function writeEntry(root: string, key: string, payload: unknown) {
  const entry = {
    key,
    guid: GUID,
    payload,
    refs: [],
    artifacts: {},
    receipt: {
      guid: GUID,
      key,
      producer: 'fixture-producer',
      inputFingerprint: key,
      outputDigest: '',
    },
  };
  await new DdcEntryStore(root).write({
    ...entry,
    receipt: { ...entry.receipt, outputDigest: ddcOutputDigest(entry) },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('source override Engine consumer chain', () => {
  it('consumes producer Meta through ImportContext, DDC current, and Catalog replica', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-engine-chain-'));
    roots.push(root);
    const received: { value?: unknown } = {};
    const override = { 'mesh/main': { lod: 2 } };
    const imported = await runImport(meta(override), registry(received), fs());
    expect(imported.ok).toBe(true);
    expect(received.value).toEqual(override);
    if (!imported.ok || 'skipped' in imported.value) return;

    const desiredKey = semanticDdcKey(semantic(override));
    await writeEntry(root, desiredKey, imported.value.pack);
    const lifecycle = new DdcLifecycle(root);
    const lease = await lifecycle.begin(GUID, desiredKey);
    expect((await lifecycle.commit(lease, desiredKey)).result).toBe('current');

    const row = {
      guid: GUID,
      packageUrl: `/preview/${desiredKey}`,
      packageId: 'fixture-package',
      kind: 'mesh',
      sourcePath: 'fixture.source',
      sourceKey: 'mesh/main',
      revision: { digest: desiredKey, observedAt: 2, rootId: 'fixture-root' },
      lifecycle: 'current' as const,
      diagnostics: [],
    };
    const replica = new CatalogReplica({
      enumerate: async () => ({ ok: true as const, value: [row] }),
      subscribe: () => () => {},
    } as never);
    await replica.start();
    expect(await lifecycle.inspect(GUID, desiredKey)).toMatchObject({ state: 'current' });
    expect(replica.snapshot().entries).toEqual([row]);
  });

  it('keeps LKG when the same producer chain fails validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-engine-chain-'));
    roots.push(root);
    const oldKey = semanticDdcKey(semantic());
    const desiredKey = semanticDdcKey(semantic({ 'mesh/main': { lod: 3 } }));
    await writeEntry(root, oldKey, { version: 'old' });
    const lifecycle = new DdcLifecycle(root);
    const oldLease = await lifecycle.begin(GUID, oldKey);
    await lifecycle.commit(oldLease, oldKey);
    const failedLease = await lifecycle.begin(GUID, desiredKey);
    await lifecycle.fail(failedLease, { code: 'validation-failed', detail: 'fixture failure' });
    expect(await lifecycle.inspect(GUID, desiredKey)).toMatchObject({
      state: 'failed',
      currentKey: oldKey,
      lastKnownGoodKey: oldKey,
    });
  });

  it('reconciles a degraded Catalog gap without changing the Meta/DDC identity', async () => {
    const desiredKey = semanticDdcKey(semantic({ 'mesh/main': { lod: 4 } }));
    let emit: ((delta: CatalogDelta) => void) | undefined;
    const replica = new CatalogReplica({
      enumerate: async () => ({
        ok: true as const,
        value: [
          {
            guid: GUID,
            packageUrl: `/preview/${desiredKey}`,
            kind: 'mesh',
            sourcePath: 'fixture.source',
            lifecycle: 'current' as const,
          },
        ],
      }),
      subscribe: (listener: (delta: CatalogDelta) => void) => {
        emit = listener;
        return () => {};
      },
    } as never);
    await replica.start();
    emit?.({
      added: [],
      changed: [],
      removed: [],
      authority: 'degraded',
      diagnostics: [{ code: 'catalog-gap', severity: 'blocking', hint: 'reconcile' }],
    });
    expect(replica.snapshot().stale).toBe(true);
    await expect(replica.reconcile()).resolves.toMatchObject({ ok: true });
    expect(replica.snapshot().stale).toBe(false);
    expect(replica.snapshot().entries[0]?.packageUrl).toContain(desiredKey);
  });
});
