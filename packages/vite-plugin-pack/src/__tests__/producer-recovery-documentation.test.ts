import { describe, expect, it } from 'vitest';
import {
  type SourcePackageError,
  type SourcePackageErrorCode,
  sourcePackageError,
} from '../producer/source-package-errors.js';

const context = {
  sourceMeta: 'assets/scene.gltf.meta.json',
  anchorGuid: '019e3969-1d48-7c3b-ac24-6d68f457065f',
  affectedGuids: ['019e3969-1d48-7c3b-ac24-6d68f457065f'],
  producer: 'source-package/gltf',
  importer: 'gltf',
} as const;

type RecoveryStep = 'inspect' | 'rebuild' | 'cold-cook' | 'verify' | 'retry';

function recoverySteps(error: SourcePackageError): readonly RecoveryStep[] {
  const steps: RecoveryStep[] = ['inspect'];
  switch (error.code) {
    case 'source-package-meta-invalid':
    case 'source-package-importer-missing':
    case 'source-package-conversion-failed':
      steps.push('rebuild', 'verify', 'retry');
      return steps;
    case 'source-package-ddc-failed':
    case 'source-package-publication-invalid':
    case 'source-package-guid-closure-mismatch':
      steps.push('cold-cook', 'verify', 'retry');
      return steps;
  }
  const exhaustive: never = error.code;
  return exhaustive;
}

describe('producer recovery contract', () => {
  it('branches on structured code and detail, then retries the same GUID', () => {
    const error = sourcePackageError('source-package-importer-missing', context, {
      stage: 'importer',
      registeredImporters: ['image'],
    });

    expect(error.code).toBe('source-package-importer-missing');
    expect(error.detail.stage).toBe('importer');
    expect(error.detail.registeredImporters).toEqual(['image']);
    expect(recoverySteps(error)).toEqual(['inspect', 'rebuild', 'verify', 'retry']);
    expect(error.hint).toContain('cold-cook');
    expect(error.detail.anchorGuid).toBe(context.anchorGuid);
  });

  it('keeps recovery choices closed over producer error codes', () => {
    const codes: readonly SourcePackageErrorCode[] = [
      'source-package-meta-invalid',
      'source-package-importer-missing',
      'source-package-conversion-failed',
      'source-package-ddc-failed',
      'source-package-publication-invalid',
      'source-package-guid-closure-mismatch',
    ];

    expect(codes).toHaveLength(6);
    expect(
      codes.map((code) =>
        recoverySteps(sourcePackageError(code, context, { stage: 'conversion' })),
      ),
    ).toEqual([
      ['inspect', 'rebuild', 'verify', 'retry'],
      ['inspect', 'rebuild', 'verify', 'retry'],
      ['inspect', 'rebuild', 'verify', 'retry'],
      ['inspect', 'cold-cook', 'verify', 'retry'],
      ['inspect', 'cold-cook', 'verify', 'retry'],
      ['inspect', 'cold-cook', 'verify', 'retry'],
    ]);
  });
});
