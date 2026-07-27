import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogDiagnostic, CatalogEntry } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { validatePack } from '../schema-compiled.js';

const roots: string[] = [];
const DUPLICATE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d411';
const OTHER_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d412';

interface CanonicalCatalogResult {
  readonly authority: 'authoritative' | 'degraded';
  readonly entries: readonly CatalogEntry[];
  readonly diagnostics: readonly CatalogDiagnostic[];
}

interface RecoveryDecision {
  readonly action: 'repair-input' | 'rollback-verified-revision' | 'reject-update';
  readonly code: string;
  readonly hint: string;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function duplicatePack(): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    packageId: 'pkg/ai-recovery',
    assets: [
      {
        guid: DUPLICATE_GUID,
        kind: 'nebula/fragment',
        sourceKey: 'fragment/main',
        sourceIndex: 0,
        payload: {},
        refs: [],
      },
      {
        guid: OTHER_GUID,
        kind: 'nebula/fragment',
        sourceKey: 'fragment/main',
        sourceIndex: 1,
        payload: {},
        refs: [],
      },
    ],
  };
}

function duplicateDiagnostic(): CatalogDiagnostic {
  return {
    code: 'catalog-source-key-duplicate',
    severity: 'blocking',
    subject: { type: 'asset', id: OTHER_GUID },
    expected: 'sourceKey values must be unique within one producer package',
    actual: 'fragment/main',
    hint: 'rename the duplicate semantic sourceKey and rebuild the catalog',
    authority: 'catalog',
  };
}

function staleRevisionDiagnostic(): CatalogDiagnostic {
  return {
    code: 'catalog-revision-stale',
    severity: 'blocking',
    subject: { type: 'package', id: 'root-ai-recovery' },
    expected: 'current revision must not be older than baseline',
    actual: '8 -> 7',
    hint: 'discard the stale update and request a fresh catalog snapshot',
    authority: 'catalog',
  };
}

function decideRecovery(result: CanonicalCatalogResult): RecoveryDecision {
  const diagnostic = result.diagnostics.find(({ severity }) => severity === 'blocking');
  if (diagnostic === undefined || diagnostic.hint === undefined) {
    return { action: 'reject-update', code: 'unknown', hint: 'keep the last verified result' };
  }
  if (result.authority === 'degraded' && diagnostic.code === 'catalog-revision-stale') {
    return {
      action: 'rollback-verified-revision',
      code: diagnostic.code,
      hint: diagnostic.hint,
    };
  }
  if (diagnostic.code === 'catalog-source-key-duplicate') {
    return { action: 'repair-input', code: diagnostic.code, hint: diagnostic.hint };
  }
  return { action: 'reject-update', code: diagnostic.code, hint: diagnostic.hint };
}

function repairDuplicateKey(
  entries: readonly CatalogEntry[],
  diagnostic: CatalogDiagnostic,
): readonly CatalogEntry[] {
  return entries.map((entry) =>
    entry.guid === diagnostic.subject?.id
      ? { ...entry, sourceKey: `${entry.sourceKey ?? 'output'}/repaired` }
      : entry,
  );
}

describe('AI recovery from canonical catalog fields', () => {
  it('discovers the canonical pack schema and repairs a duplicate key without producer source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ai-recovery-'));
    roots.push(root);
    const pack = duplicatePack();
    expect(validatePack(pack)).toBe(true);
    await writeFile(join(root, 'duplicate.pack.json'), JSON.stringify(pack));

    const diagnostic = duplicateDiagnostic();
    const initial: CanonicalCatalogResult = {
      authority: 'degraded',
      entries: [
        {
          guid: DUPLICATE_GUID,
          relativeUrl: '/duplicate/main.bin',
          sourcePath: 'duplicate.pack.json',
          kind: 'nebula/fragment',
          packageId: 'pkg/ai-recovery',
          sourceKey: 'fragment/main',
          sourceIndex: 0,
        },
        {
          guid: OTHER_GUID,
          relativeUrl: '/duplicate/other.bin',
          sourcePath: 'duplicate.pack.json',
          kind: 'nebula/fragment',
          packageId: 'pkg/ai-recovery',
          sourceKey: 'fragment/main',
          sourceIndex: 1,
        },
      ],
      diagnostics: [diagnostic],
    };

    const decision = decideRecovery(initial);
    expect(decision).toMatchObject({ action: 'repair-input', code: diagnostic.code });
    const repairedEntries = repairDuplicateKey(initial.entries, diagnostic);
    expect(new Set(repairedEntries.map((entry) => entry.sourceKey)).size).toBe(2);
    expect(decision.hint).toBe(diagnostic.hint);
  });

  it('rolls back a degraded stale revision using authority and code fields only', () => {
    const diagnostic = staleRevisionDiagnostic();
    const result: CanonicalCatalogResult = {
      authority: 'degraded',
      entries: [],
      diagnostics: [diagnostic],
    };

    expect(decideRecovery(result)).toEqual({
      action: 'rollback-verified-revision',
      code: 'catalog-revision-stale',
      hint: diagnostic.hint,
    });
  });
});
