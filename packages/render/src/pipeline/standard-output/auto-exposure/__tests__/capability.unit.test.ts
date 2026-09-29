import { describe, expect, it } from 'vitest';
import { resolveAutoExposureCapability } from '../capability';

const complete = {
  compute: true,
  storageBuffer: true,
  float32Filterable: true,
  rgba16floatRenderable: true,
};

describe('auto exposure capability contract', () => {
  it('requires live compute, storage, and float filtering facts', () => {
    expect(resolveAutoExposureCapability(complete, 8)).toMatchObject({
      ok: true,
      value: { available: true, generation: 8 },
    });
    expect(resolveAutoExposureCapability({ ...complete, compute: false }, 8)).toMatchObject({
      ok: false,
      error: { code: 'auto-exposure-capability-unavailable', detail: { capability: 'compute' } },
    });
    expect(
      resolveAutoExposureCapability({ ...complete, float32Filterable: false }, 8),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'auto-exposure-capability-unavailable',
        detail: { capability: 'float-filterable' },
      },
    });
  });

  it('does not infer float filtering from rgba16float renderability', () => {
    expect(
      resolveAutoExposureCapability(
        { ...complete, float32Filterable: false, rgba16floatRenderable: true },
        9,
      ),
    ).toMatchObject({ ok: false, error: { detail: { capability: 'float-filterable' } } });
  });
});
