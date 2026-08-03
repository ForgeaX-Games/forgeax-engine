import type { CatalogDelta, CatalogEntry } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { CatalogReplica } from '../registry/catalog-state.js';

type EnumerationResult = { readonly ok: true; readonly value: readonly CatalogEntry[] };

const base = {
  guid: '11111111-1111-4111-8111-111111111111',
  packageUrl: '/preview/base',
  packageId: 'fixture-package',
  kind: 'mesh',
  sourcePath: 'model.source',
  sourceKey: 'mesh/main',
  sourceIndex: 0,
  provenance: { provider: 'fixture', version: '1' },
  revision: { digest: 'digest-1', observedAt: 1, rootId: 'fixture-root' },
  relations: [],
  lifecycle: 'current' as const,
  diagnostics: [{ code: 'fixture-note', severity: 'info' as const, hint: 'none' }],
};

const other = {
  ...base,
  guid: '22222222-2222-4222-8222-222222222222',
  sourceKey: 'mesh/other',
  sourceIndex: 1,
  packageUrl: '/preview/other',
};

function source() {
  let listener: ((delta: CatalogDelta) => void) | undefined;
  let enumerate: (() => Promise<EnumerationResult>) | undefined;
  const source = {
    subscribe(next: (delta: CatalogDelta) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    enumerate() {
      return enumerate?.() ?? Promise.resolve({ ok: true as const, value: [base] });
    },
  };
  return {
    source,
    emit(delta: CatalogDelta) {
      listener?.(delta);
    },
    deferEnumeration() {
      let resolve!: (result: EnumerationResult) => void;
      enumerate = () => new Promise((next) => (resolve = next));
      return (result: EnumerationResult) => resolve(result);
    },
  };
}

describe('CatalogReplica', () => {
  it('subscribes before enumerate and folds an early delta after the baseline', async () => {
    const fixture = source();
    const release = fixture.deferEnumeration();
    const replica = new CatalogReplica(fixture.source as never);
    const started = replica.start();

    fixture.emit({ added: [other], changed: [], removed: [] });
    release({ ok: true, value: [base] });
    await expect(started).resolves.toMatchObject({ ok: true });
    expect(replica.snapshot().entries.map((entry) => entry.guid)).toEqual([base.guid, other.guid]);
  });

  it('is idempotent, rejects older revisions, and preserves complete producer facts', async () => {
    const fixture = source();
    const replica = new CatalogReplica(fixture.source as never);
    await replica.start();
    const delta = {
      added: [],
      changed: [
        { ...base, packageUrl: '/preview/new', revision: { ...base.revision, observedAt: 2 } },
      ],
      removed: [],
      revisions: {
        baseline: [{ rootId: 'fixture-root', revision: 1 }],
        current: [{ rootId: 'fixture-root', revision: 2 }],
      },
    };

    fixture.emit(delta);
    fixture.emit(delta);
    fixture.emit({
      ...delta,
      changed: [
        { ...base, packageUrl: '/preview/old', revision: { ...base.revision, observedAt: 1 } },
      ],
      revisions: {
        baseline: [{ rootId: 'fixture-root', revision: 2 }],
        current: [{ rootId: 'fixture-root', revision: 1 }],
      },
    });

    const row = replica.snapshot().entries.find((entry) => entry.guid === base.guid);
    expect(row).toMatchObject({
      packageUrl: '/preview/new',
      sourceKey: 'mesh/main',
      provenance: base.provenance,
      relations: base.relations,
      diagnostics: base.diagnostics,
    });
    expect(replica.snapshot().version).toBe(1);
  });

  it('marks degraded gaps stale and reconcile restores the authoritative set', async () => {
    const fixture = source();
    const release = fixture.deferEnumeration();
    const replica = new CatalogReplica(fixture.source as never);
    const started = replica.start();
    release({ ok: true, value: [base] });
    await started;

    fixture.emit({
      added: [],
      changed: [],
      removed: [],
      authority: 'degraded',
      diagnostics: [{ code: 'catalog-gap', severity: 'blocking', hint: 'reconcile' }],
    });
    expect(replica.snapshot()).toMatchObject({ stale: true });

    const reconciling = replica.reconcile();
    release({ ok: true, value: [other] });
    await expect(reconciling).resolves.toMatchObject({ ok: true });
    expect(replica.snapshot()).toMatchObject({ stale: false, entries: [other] });
  });
});
