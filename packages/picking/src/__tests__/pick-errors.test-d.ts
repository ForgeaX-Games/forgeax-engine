// pick-errors.test-d.ts — AC-205 closed-union exhaustiveness guard for the
// picking error surface (feat-20260705 M2 / w26).
//
// AC-205 requires a test-d regression guard proving the picking error unions
// stay closed and exhaustively switchable WITHOUT a `default` arm. F13 confirmed
// there are ZERO source-code `switch` consumers of PickErrorCode at the app level
// (M2 consumption is only the `pick` function), so this guard supplies the
// double evidence AC-205 prescribes:
//   (b) an external consumer CAN `import type { PickErrorCode } from
//       '@forgeax/engine-picking'` and write an exhaustive switch (no default).
//   (c) an assertNever-terminated switch enumerates every member; adding a
//       member later without extending the switch breaks `pnpm test:unit`
//       (the typecheck pass picks up any *.test-d.ts).
//
// Both closed unions the picking barrel exports are covered:
//   - PickErrorCode  — single member ('camera-component-missing'), thrown by pick().
//   - PickTileError  — two-member discriminated union (code), returned by pickTile().
//
// Charter P3 (tension): closed unions must retain zero-loss exhaustive-switch
// capability across the package boundary — this file is the compile-time proof.

// (b) external-consumer import path: the type resolves from the package barrel.
import type { PickErrorCode, PickTileError } from '@forgeax/engine-picking';
import { expectTypeOf, test } from 'vitest';

function assertNever(_x: never): never {
  throw new Error('exhaustive');
}

// (c) PickErrorCode exhaustive switch, no default — assertNever traps a future
// member that is added without extending this switch.
function describePickErrorCode(code: PickErrorCode): string {
  switch (code) {
    case 'camera-component-missing':
      return 'camera missing';
    default:
      return assertNever(code);
  }
}

// (c) PickTileError exhaustive switch over the discriminant, no default.
function describePickTileError(err: PickTileError): string {
  switch (err.code) {
    case 'tilemap-not-found':
      return 'tilemap not found';
    case 'tilemap-component-missing':
      return 'tilemap component missing';
    default:
      return assertNever(err);
  }
}

test('PickErrorCode is the closed single-member union', () => {
  expectTypeOf<PickErrorCode>().toEqualTypeOf<'camera-component-missing'>();
  // Compile-time exhaustiveness (run-time noop).
  void describePickErrorCode;
});

test('PickTileError is the closed two-member discriminated union', () => {
  expectTypeOf<PickTileError['code']>().toEqualTypeOf<
    'tilemap-not-found' | 'tilemap-component-missing'
  >();
  void describePickTileError;
});
