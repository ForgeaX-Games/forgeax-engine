// ecs-error-code-31.test-d - EcsErrorCode union widening type-test
// (feat-20260608-scene-nesting-ecs-fication M1 / w6).
//
// Coverage (plan-strategy D-9):
//   - EcsErrorCode union has gained the 31st member 'scene-override-type-
//     mismatch' (literal D-9 string locked).
//   - The new literal is assignable to EcsErrorCode at the type layer
//     (positive assertion). Cross-feat hardening: the literal must NOT
//     be quietly aliased to a different existing member.
//
// EcsErrorDetail evolution for this code (detail shape `{ code, comp,
// field, expectedType, actualType }`) is exercised by M2 unit tests
// (requirements §Edge cases table last row, reviewer Issue 1) — out
// of scope here; this file only locks the EcsErrorCode union literal.
//
// TDD red signal: until w9 widens EcsErrorCode to 31 members, the
// `toExtend<EcsErrorCode>` assertion produces TS2344. w9 turns this
// red into green.
//
// Note: plan-tasks.json originally listed the targetFile under
// packages/types; @forgeax/engine-types has zero engine-ecs dep
// (math-free + ecs-free per AGENTS.md). The test must live under the
// ecs package to import EcsErrorCode locally — recorded in the M1
// report as filesOutsideTargets with reason.
//
// Charter mapping: proposition 4 (explicit failure: type-level union
// widening surfaced at compile-time, not via ad-hoc string literal
// matching).

import { describe, expectTypeOf, it } from 'vitest';
import type { EcsErrorCode } from '../errors';

describe('EcsErrorCode 31st member (D-9)', () => {
  it("includes the 'scene-override-type-mismatch' literal", () => {
    expectTypeOf<'scene-override-type-mismatch'>().toExtend<EcsErrorCode>();
  });

  it('exhaustive switch over EcsErrorCode requires the new case', () => {
    function _exhaust(code: EcsErrorCode): string {
      if (code === 'scene-override-type-mismatch') return 'override-type-mismatch';
      return 'other';
    }
    expectTypeOf(_exhaust).parameter(0).toEqualTypeOf<EcsErrorCode>();
  });
});
