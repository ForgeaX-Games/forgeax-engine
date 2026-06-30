// compare-param-schema.test.ts -- single-direction superset assertion
// (feat-20260613-material-paramschema-driven-binding M2 / w6).
//
// Decision anchors:
//   - plan-strategy D-9 single-direction superset: actual reflected BGL must
//     contain every binding emitted by derive(schema); actual may carry extra
//     bindings (engine-injection placeholders) without failing the build.
//   - plan-strategy D-10 add-only error code: failures emit
//     'material-shader-binding-mismatch' with .expected / .actual / .hint /
//     .detail. Existing `material-schema-mismatch` (with bg-overflow sub-kind)
//     stays put for register-time / overflow concerns.
//   - charter P3 explicit failure: build-time gate stops drift before runtime.
//
// TDD: this file lands red ahead of w7 (compareParamSchemaSuperset
// implementation rewrite). The function name is intentionally distinct from
// the legacy compareParamSchemaWithBgl so the topology dependency is clear.

import { describe, expect, it } from 'vitest';
import { compareParamSchemaSuperset } from '../compare-param-schema.js';
import { BINDING_MISMATCH_FIXTURES } from './fixtures/binding-mismatch.fixtures.js';

const PATH = 'test::material-shader';

describe('compareParamSchemaSuperset (M2 / w6)', () => {
  for (const fixture of BINDING_MISMATCH_FIXTURES) {
    it(`${fixture.name}: verdict=${fixture.verdict}`, () => {
      const result = compareParamSchemaSuperset(fixture.schema, fixture.actualBgls, PATH);
      if (fixture.verdict === 'ok') {
        if (!result.ok) {
          throw new Error(
            `expected fixture '${fixture.name}' to pass; got error code=${result.error.code} message=${result.error.message}`,
          );
        }
        expect(result.ok).toBe(true);
      } else {
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('material-shader-binding-mismatch');
        const detail = result.error.detail;
        if (detail?.code !== 'material-shader-binding-mismatch') {
          throw new Error(
            `expected detail.code='material-shader-binding-mismatch'; got ${String(detail?.code)}`,
          );
        }
        expect(detail.materialShaderPath).toBe(PATH);
        if (fixture.mismatchBinding !== undefined) {
          expect(detail.expected.binding).toBe(fixture.mismatchBinding);
        }
        if (fixture.mismatchParam !== undefined) {
          expect(detail.expectedParam).toBe(fixture.mismatchParam);
        }
        // hint must contain a concrete WGSL author guidance fragment so AI
        // users can fix without trial-and-error (charter F2 text-first).
        expect(result.error.hint.length).toBeGreaterThan(0);
      }
    });
  }

  it('empty schema + empty actual BGL -> ok (D-12 graceful)', () => {
    const result = compareParamSchemaSuperset([], [], PATH);
    expect(result.ok).toBe(true);
  });

  it('empty schema + non-empty actual BGL -> ok (all actual bindings are extras)', () => {
    const result = compareParamSchemaSuperset(
      [],
      [
        {
          entries: [
            {
              binding: 0,
              visibility: 0x2 as GPUShaderStageFlags,
              buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: 0 },
            },
          ],
        },
      ],
      PATH,
    );
    expect(result.ok).toBe(true);
  });
});
