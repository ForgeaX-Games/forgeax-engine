import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EcsErrorCode } from '../errors';
import { SpawnLightInvalidBoundsError } from '../errors';
import type { EcsError } from '../world';

describe('SpawnLightInvalidBoundsError policy ownership', () => {
  it('preserves the PointLight range diagnostic exactly', () => {
    const error = new SpawnLightInvalidBoundsError('PointLight', 'range', -1);
    const code: EcsErrorCode = error.code;

    expect(code).toBe('spawn-light-invalid-bounds');
    expectTypeOf(error).toMatchTypeOf<EcsError>();
    expectTypeOf(error.code).toEqualTypeOf<'spawn-light-invalid-bounds'>();
    expectTypeOf(error.detail.field).toEqualTypeOf<
      'range' | 'innerOuter' | 'outerNinety' | 'direction'
    >();
    expect(error.expected).toBe('range >= 0 or Number.POSITIVE_INFINITY');
    expect(error.hint).toBe(
      'PointLight.range = -1 is invalid; use Number.POSITIVE_INFINITY for unlimited range, or a non-negative meter value',
    );
    expect(error.message).toBe(
      'PointLight: spawn payload bound violation.\n' +
        '  code: spawn-light-invalid-bounds\n' +
        '  component: PointLight\n' +
        '  field: range\n' +
        '  got: -1\n' +
        '  expected: range >= 0 or Number.POSITIVE_INFINITY\n' +
        '  hint: PointLight.range = -1 is invalid; use Number.POSITIVE_INFINITY for unlimited range, or a non-negative meter value',
    );
    expect(error.detail).toEqual({ field: 'range', got: -1 });
  });

  it('preserves the SpotLight inner/outer diagnostic exactly', () => {
    const error = new SpawnLightInvalidBoundsError('SpotLight', 'innerOuter', 25);

    expect(error.expected).toBe('outerConeDeg > innerConeDeg');
    expect(error.hint).toBe(
      'SpotLight.outerConeDeg <= innerConeDeg (got 25); inner cone is the saturated bright region, outer cone is the falloff edge; outerConeDeg > innerConeDeg required',
    );
    expect(error.message).toBe(
      'SpotLight: spawn payload bound violation.\n' +
        '  code: spawn-light-invalid-bounds\n' +
        '  component: SpotLight\n' +
        '  field: innerOuter\n' +
        '  got: 25\n' +
        '  expected: outerConeDeg > innerConeDeg\n' +
        '  hint: SpotLight.outerConeDeg <= innerConeDeg (got 25); inner cone is the saturated bright region, outer cone is the falloff edge; outerConeDeg > innerConeDeg required',
    );
    expect(error.detail).toEqual({ field: 'innerOuter', got: 25 });
  });

  it('preserves the SpotLight ninety-degree diagnostic exactly', () => {
    const error = new SpawnLightInvalidBoundsError('SpotLight', 'outerNinety', 91);

    expect(error.expected).toBe('outerConeDeg <= 90 (KHR_lights_punctual upper bound)');
    expect(error.hint).toBe(
      'SpotLight.outerConeDeg = 91 > 90; a spot light cone wider than 90 degrees becomes a point light; use PointLight instead',
    );
    expect(error.message).toBe(
      'SpotLight: spawn payload bound violation.\n' +
        '  code: spawn-light-invalid-bounds\n' +
        '  component: SpotLight\n' +
        '  field: outerNinety\n' +
        '  got: 91\n' +
        '  expected: outerConeDeg <= 90 (KHR_lights_punctual upper bound)\n' +
        '  hint: SpotLight.outerConeDeg = 91 > 90; a spot light cone wider than 90 degrees becomes a point light; use PointLight instead',
    );
    expect(error.detail).toEqual({ field: 'outerNinety', got: 91 });
  });

  it('preserves the DirectionalLight direction array diagnostic exactly', () => {
    const got = [0, 0, 0] as const;
    const error = new SpawnLightInvalidBoundsError('DirectionalLight', 'direction', got);

    expect(error.expected).toBe('direction is a non-zero [x, y, z] vector');
    expect(error.hint).toBe(
      'DirectionalLight.direction is missing or a zero vector (got [0,0,0]); direction has no default, provide a non-zero direction, e.g. [-0.5, -1, -0.3]',
    );
    expect(error.message).toBe(
      'DirectionalLight: spawn payload bound violation.\n' +
        '  code: spawn-light-invalid-bounds\n' +
        '  component: DirectionalLight\n' +
        '  field: direction\n' +
        '  got: 0,0,0\n' +
        '  expected: direction is a non-zero [x, y, z] vector\n' +
        '  hint: DirectionalLight.direction is missing or a zero vector (got [0,0,0]); direction has no default, provide a non-zero direction, e.g. [-0.5, -1, -0.3]',
    );
    expect(error.detail).toEqual({ field: 'direction', got });
    expect(error.detail.got).toBe(got);
  });

  it('preserves Error identity, detail narrowing, own-key order, and descriptors', () => {
    const error = new SpawnLightInvalidBoundsError('PointLight', 'range', -1);
    const keys = Object.keys(error);

    switch (error.detail.field) {
      case 'range':
        expect(error.detail.got).toBe(-1);
        break;
      case 'innerOuter':
        expect(error.detail.got).toBeGreaterThan(0);
        break;
      case 'outerNinety':
        expect(error.detail.got).toBeGreaterThan(90);
        break;
      case 'direction':
        expect(error.detail.got).toHaveLength(3);
        break;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SpawnLightInvalidBoundsError);
    expect(error.name).toBe('SpawnLightInvalidBoundsError');
    expect(typeof error.stack).toBe('string');
    expect(keys).toEqual(['name', 'code', 'hint', 'expected', 'detail']);

    for (const key of ['name', 'code', 'hint', 'expected', 'detail'] as const) {
      expect(Object.getOwnPropertyDescriptor(error, key)).toEqual({
        value: error[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  });
});
