import { describe, expect, it } from 'vitest';
import {
  IMPORT_ERROR_HINTS as DIRECT_IMPORT_ERROR_HINTS,
  ImportError as DirectImportError,
} from '../import.js';
import type { ImportedArtifact, ImportProduct, ImportResult, SourceDependency } from '../index.js';
import { IMPORT_ERROR_HINTS, ImportError } from '../index.js';

describe('generic import contract', () => {
  it('keeps the main entry and import module on one runtime contract', () => {
    expect(ImportError).toBe(DirectImportError);
    expect(IMPORT_ERROR_HINTS).toBe(DIRECT_IMPORT_ERROR_HINTS);
  });

  it('models a product with assets, artifacts, and normalized source dependencies', () => {
    const product: ImportProduct = {
      assets: [],
      artifacts: [],
      sourceDependencies: ['ui/main.html', 'ui/main.css'],
    };
    expect(product.sourceDependencies).toEqual(['ui/main.html', 'ui/main.css']);
    const dependency: SourceDependency = 'ui/main.css';
    expect(dependency).toBe('ui/main.css');
  });

  it('models artifacts without coupling them to a specific asset kind', () => {
    const artifact: ImportedArtifact = {
      path: 'ui/icon.svg',
      mimeType: 'image/svg+xml',
      bytes: new Uint8Array([60, 115, 118, 103, 62]),
    };
    expect(artifact.path).toContain('icon.svg');
    expect(artifact.bytes).toBeInstanceOf(Uint8Array);
  });

  it('supports structured success and failure results without legacy arrays', () => {
    const success: ImportResult = {
      ok: true,
      value: { assets: [], artifacts: [], sourceDependencies: [] },
    };
    const failure: ImportResult = {
      ok: false,
      error: new ImportError({
        code: 'source-read-failed',
        expected: 'a readable source',
        hint: IMPORT_ERROR_HINTS['source-read-failed'],
        detail: { source: 'main.html', reason: 'ENOENT' },
      }),
    };
    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
  });
});
