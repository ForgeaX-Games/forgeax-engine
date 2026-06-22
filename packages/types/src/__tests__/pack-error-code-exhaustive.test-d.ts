// pack-error-code-exhaustive.test-d - exhaustive switch over the 13-member
// PackErrorCode union (feat-20260608-scene-nesting-ecs-fication M1 / w4).
//
// Coverage (AC-09):
//   The exhaustive switch below visits every PackErrorCode literal. If any
//   member is missing from PackErrorCode, the `_exhaustiveCheck: never`
//   line at the bottom of the switch raises TS2322; if a new member lands
//   without being added here, the same line raises TS2322. Either way tsc
//   surfaces the drift (charter proposition 4: explicit failure).
//
// Members (current + 4 new from this feat, D-8 string literals):
//   - pack-malformed-meta
//   - pack-malformed-pack
//   - pack-guid-malformed
//   - pack-orphan-meta
//   - pack-meta-missing
//   - pack-guid-collision
//   - pack-cyclic-reference
//   - pack-subasset-index-out-of-range
//   - payload-schema-mismatch
//   - pack-mount-localid-overlap          (NEW; AC-04)
//   - pack-mount-count-mismatch           (NEW; AC-05)
//   - pack-mount-override-localid-out-of-range (NEW; AC-06)
//   - pack-mount-override-unknown-field   (NEW; AC-07)
//
// TDD red signal: until w8 widens PackErrorCode to 13 members the four
// new case clauses below are flagged TS2678 ('Type X is not comparable
// to type PackErrorCode'). w8 turns this red into green.

import { describe, it } from 'vitest';
import type { PackErrorCode } from '../index';

function exhaustivePackErrorCodeSwitch(code: PackErrorCode): string {
  switch (code) {
    case 'pack-malformed-meta':
      return 'malformed-meta';
    case 'pack-malformed-pack':
      return 'malformed-pack';
    case 'pack-guid-malformed':
      return 'guid-malformed';
    case 'pack-orphan-meta':
      return 'orphan-meta';
    case 'pack-meta-missing':
      return 'meta-missing';
    case 'pack-guid-collision':
      return 'guid-collision';
    case 'pack-cyclic-reference':
      return 'cyclic-reference';
    case 'pack-subasset-index-out-of-range':
      return 'subasset-index-out-of-range';
    case 'payload-schema-mismatch':
      return 'payload-schema-mismatch';
    case 'pack-mount-localid-overlap':
      return 'mount-localid-overlap';
    case 'pack-mount-count-mismatch':
      return 'mount-count-mismatch';
    case 'pack-mount-override-localid-out-of-range':
      return 'mount-override-localid-out-of-range';
    case 'pack-mount-override-unknown-field':
      return 'mount-override-unknown-field';
    default: {
      const _exhaustiveCheck: never = code;
      return _exhaustiveCheck;
    }
  }
}

describe('PackErrorCode exhaustive switch (AC-09; 13 members)', () => {
  it('compiles when every PackErrorCode member has a matching case', () => {
    // Smoke-call so the function gets type-checked end-to-end (vitest
    // typecheck pass) instead of being tree-shaken.
    exhaustivePackErrorCodeSwitch('pack-malformed-meta');
  });
});
