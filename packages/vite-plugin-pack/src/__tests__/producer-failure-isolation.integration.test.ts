import { describe, expect, it } from 'vitest';
import { currentProjectionFor } from '../build-catalog.js';
import { projectSourcePackageFailure } from '../dev/package-routes.js';
import { sourcePackageError } from '../producer/source-package-errors.js';

const INVALID_GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const VALID_GUID = '019e3969-1d48-7c3b-ac24-6d68f4570660';

describe('source-package failure isolation', () => {
  it('keeps an unrelated package ready beside structured unavailable evidence', () => {
    const rows = [
      {
        guid: INVALID_GUID,
        packageUrl: `/__forgeax-ddc/${INVALID_GUID}.pack.json`,
        kind: 'fixture-mesh',
        sourcePath: 'broken.fixture',
        ...currentProjectionFor('imported-output', 'cooked'),
      },
      {
        guid: VALID_GUID,
        packageUrl: `/__forgeax-ddc/${VALID_GUID}.pack.json`,
        kind: 'fixture-mesh',
        sourcePath: 'valid.fixture',
        ...currentProjectionFor('imported-output', 'cooked'),
      },
    ];
    const error = sourcePackageError(
      'source-package-conversion-failed',
      {
        sourceMeta: 'broken.fixture.meta.json',
        anchorGuid: INVALID_GUID,
        affectedGuids: [INVALID_GUID],
        producer: 'source-package/fixture',
        importer: 'fixture',
      },
      {
        stage: 'conversion',
        reason: 'fixture conversion failed',
      },
    );

    const projected = projectSourcePackageFailure(rows, error);
    const invalid = projected[0];
    const valid = projected[1];

    expect(invalid?.lifecycle).toBe('failed');
    expect(invalid?.projection?.lifecycle).toBe('failed');
    expect(invalid?.diagnostics).toEqual([
      expect.objectContaining({
        code: error.code,
        severity: 'blocking',
        expected: error.expected,
        hint: error.hint,
        authority: 'producer',
      }),
    ]);
    expect(invalid?.diagnostics?.[0]).toHaveProperty('evidence', [
      { type: 'asset', id: INVALID_GUID },
    ]);
    expect(valid).toEqual(rows[1]);
  });
});
