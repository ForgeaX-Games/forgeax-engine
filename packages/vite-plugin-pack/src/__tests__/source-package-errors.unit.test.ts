import { ImportError } from '@forgeax/engine-import';
import { describe, expect, it } from 'vitest';
import {
  normalizeSourcePackageError,
  type SourcePackageErrorContext,
  sourcePackageError,
} from '../producer/source-package-errors.js';

const context: SourcePackageErrorContext = {
  sourceMeta: 'assets/scene.gltf.meta.json',
  anchorGuid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
  affectedGuids: ['019e3969-1d48-7c3b-ac24-6d68f457065f', '019e3969-1d48-7c3b-ac24-6d68f4570660'],
  producer: 'source-package/gltf',
  importer: 'gltf',
};

describe('source package structured failures', () => {
  it('normalizes lower-level importer failures without losing typed facts', () => {
    const error = normalizeSourcePackageError(
      new ImportError({
        code: 'importer-not-registered',
        expected: 'a registered gltf importer',
        hint: 'register gltf',
        detail: { importer: 'gltf', registeredImporters: ['image'] },
      }),
      context,
    );

    expect(error.code).toBe('source-package-importer-missing');
    expect(error.expected).toContain('registered importer');
    expect(error.hint).toContain('register');
    expect(error.detail).toMatchObject({
      sourceMeta: context.sourceMeta,
      affectedGuids: context.affectedGuids,
      stage: 'importer',
      importer: 'gltf',
      registeredImporters: ['image'],
    });
  });

  it.each([
    ['source-package-meta-invalid', 'meta', { reason: 'missing subAssets' }],
    ['source-package-conversion-failed', 'conversion', { reason: 'decoder rejected source' }],
    ['source-package-ddc-failed', 'ddc', { reason: 'write denied' }],
    ['source-package-publication-invalid', 'route-integrity', { missing: ['body.bin'] }],
  ] as const)('includes recovery facts for %s', (code, stage, detail) => {
    const error = sourcePackageError(code, context, { stage, ...detail });

    expect(error.code).toBe(code);
    expect(error.expected).toBeTruthy();
    expect(error.hint).toMatch(/rebuild|cold-cook|repair/i);
    expect(error.detail).toMatchObject({
      sourceMeta: context.sourceMeta,
      anchorGuid: context.anchorGuid,
      affectedGuids: context.affectedGuids,
      stage,
    });
  });
});
