import { expect, expectTypeOf, test } from 'vitest';
import { packFogParams, type FogFalloffMode } from '../fog.js';

expectTypeOf<FogFalloffMode>().toEqualTypeOf<'linear' | 'exponential' | 'exponential-squared'>();
expectTypeOf(packFogParams).parameter(0).toEqualTypeOf<FogFalloffMode>();
expectTypeOf(packFogParams).returns.toEqualTypeOf<Uint8Array>();

test('rejects a mode outside the exact fog vocabulary', () => {
  // @ts-expect-error Unknown fog falloff modes are not assignable.
  const invalidMode: FogFalloffMode = 'quadratic';
  void invalidMode;
});

test('preserves the numeric fog encodings and packed bytes', () => {
  expect(packFogParams('linear', 5, 20)).toEqual(
    new Uint8Array(Float32Array.of(0, 5, 20, 0).buffer),
  );
  expect(packFogParams('exponential', 0.25, 20)).toEqual(
    new Uint8Array(Float32Array.of(1, 0.25, 20, 0).buffer),
  );
  expect(packFogParams('exponential-squared', 0.125, 20)).toEqual(
    new Uint8Array(Float32Array.of(2, 0.125, 20, 0).buffer),
  );
});
