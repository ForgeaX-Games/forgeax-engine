import { describe, expectTypeOf, it } from 'vitest';
import {
  type CapMissingDetail,
  type ColorDomainDetail,
  type CyclicDependencyDetail,
  type DanglingReadDetail,
  type DuplicateResourceDetail,
  type InvalidFormatDetail,
  type ObservationDetail,
  RenderGraphError,
  type RenderGraphErrorCode,
  type RenderGraphErrorDetail,
  type ResourceAllocFailedDetail,
} from '../errors.js';

describe('RenderGraphError code/detail correlation', () => {
  it('accepts every existing code with its matching detail interface', () => {
    new RenderGraphError({
      code: 'dangling-read',
      expected: '',
      hint: '',
      detail: { resourceKey: 'resource', passName: 'pass' } satisfies DanglingReadDetail,
    });
    new RenderGraphError({
      code: 'cap-missing',
      expected: '',
      hint: '',
      detail: { cap: 'compute', passName: 'pass' } satisfies CapMissingDetail,
    });
    new RenderGraphError({
      code: 'cyclic-dependency',
      expected: '',
      hint: '',
      detail: { cycle: ['a', 'b'] } satisfies CyclicDependencyDetail,
    });
    new RenderGraphError({
      code: 'duplicate-resource',
      expected: '',
      hint: '',
      detail: { resourceKey: 'resource' } satisfies DuplicateResourceDetail,
    });
    new RenderGraphError({
      code: 'unknown-resource',
      expected: '',
      hint: '',
      detail: { resourceKey: 'resource', passName: 'pass' } satisfies DanglingReadDetail,
    });
    new RenderGraphError({
      code: 'resource-alloc-failed',
      expected: '',
      hint: '',
      detail: {
        resourceKey: 'resource',
        passName: 'pass',
        rhiCode: 'lost',
      } satisfies ResourceAllocFailedDetail,
    });
    new RenderGraphError({
      code: 'invalid-format',
      expected: '',
      hint: '',
      detail: {
        resourceKey: 'resource',
        format: 'rgba16float',
        expected: ['rgba16float'],
      } satisfies InvalidFormatDetail,
    });
    for (const code of [
      'observation-absent',
      'observation-invalid-format',
      'observation-invalid-size',
      'observation-missing-copy-src',
      'observation-stale',
      'observation-retired',
    ] as const) {
      new RenderGraphError({
        code,
        expected: '',
        hint: '',
        detail: { frameId: 1, expected: 'frame' } satisfies ObservationDetail,
      });
    }
    for (const code of [
      'invalid-color-domain',
      'missing-color-domain',
      'color-domain-mismatch',
    ] as const) {
      new RenderGraphError({
        code,
        expected: '',
        hint: '',
        detail: { value: 'linear' } satisfies ColorDomainDetail,
      });
    }
  });

  it('keeps detail optional, including explicit undefined', () => {
    new RenderGraphError({ code: 'dangling-read', expected: '', hint: '' });
    new RenderGraphError({ code: 'invalid-format', expected: '', hint: '', detail: undefined });
  });

  it('rejects a detail belonging to a different code', () => {
    new RenderGraphError({
      code: 'dangling-read',
      expected: '',
      hint: '',
      // @ts-expect-error -- dangling-read accepts DanglingReadDetail, not CapMissingDetail.
      detail: { cap: 'compute', passName: 'pass' },
    });
  });

  it('preserves the closed sixteen-code and eight-shape public unions', () => {
    expectTypeOf<RenderGraphErrorCode>().toEqualTypeOf<
      | 'dangling-read'
      | 'cap-missing'
      | 'cyclic-dependency'
      | 'duplicate-resource'
      | 'unknown-resource'
      | 'resource-alloc-failed'
      | 'invalid-format'
      | 'observation-absent'
      | 'observation-invalid-format'
      | 'observation-invalid-size'
      | 'observation-missing-copy-src'
      | 'observation-stale'
      | 'observation-retired'
      | 'invalid-color-domain'
      | 'missing-color-domain'
      | 'color-domain-mismatch'
    >();
    expectTypeOf<RenderGraphErrorDetail>().toEqualTypeOf<
      | DanglingReadDetail
      | CapMissingDetail
      | CyclicDependencyDetail
      | DuplicateResourceDetail
      | ResourceAllocFailedDetail
      | InvalidFormatDetail
      | ObservationDetail
      | ColorDomainDetail
    >();
  });
});
