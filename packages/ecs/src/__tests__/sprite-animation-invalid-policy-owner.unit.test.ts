import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EcsErrorCode, EcsErrorDetail } from '../errors';
import { SpriteAnimationInvalidError } from '../errors';

describe('SpriteAnimationInvalidError policy ownership', () => {
  it('preserves the regions-length diagnostic and detail identity exactly', () => {
    const detail = { field: 'regions-length' as const, regionsLength: 7, frameCount: 3 };
    const error = new SpriteAnimationInvalidError(detail);
    const code: EcsErrorCode = error.code;

    expect(code).toBe('sprite-animation-invalid');
    expectTypeOf(error).toMatchTypeOf<Error>();
    expectTypeOf(error.code).toEqualTypeOf<'sprite-animation-invalid'>();
    expectTypeOf(error.detail.field).toEqualTypeOf<'regions-length' | 'frame-duration'>();
    expect(error.expected).toBe('SpriteAnimation.regions.length === frameCount * 4');
    expect(error.hint).toBe(
      "SpriteAnimation.regions.length = 7 does not match frameCount * 4 = 12; pack 4 floats [uMin, vMin, uW, vH] per frame (see <name>.atlas.meta.json sidecar 'regions' map)",
    );
    expect(error.message).toBe(
      'SpriteAnimation: invariant violated.\n' +
        '  code: sprite-animation-invalid\n' +
        '  field: regions-length\n' +
        '  expected: SpriteAnimation.regions.length === frameCount * 4\n' +
        "  hint: SpriteAnimation.regions.length = 7 does not match frameCount * 4 = 12; pack 4 floats [uMin, vMin, uW, vH] per frame (see <name>.atlas.meta.json sidecar 'regions' map)",
    );
    expect(error.detail).toBe(detail);
    expect(error.detail).toEqual({ field: 'regions-length', regionsLength: 7, frameCount: 3 });
  });

  it('preserves zero-length and zero-frame interpolation', () => {
    const detail = { field: 'regions-length' as const, regionsLength: 0, frameCount: 2 };
    const error = new SpriteAnimationInvalidError(detail);

    expect(error.expected).toBe('SpriteAnimation.regions.length === frameCount * 4');
    expect(error.hint).toBe(
      "SpriteAnimation.regions.length = 0 does not match frameCount * 4 = 8; pack 4 floats [uMin, vMin, uW, vH] per frame (see <name>.atlas.meta.json sidecar 'regions' map)",
    );
    expect(error.detail).toBe(detail);
  });

  it('preserves zero-duration diagnostics exactly', () => {
    const detail = { field: 'frame-duration' as const, frameDuration: 0 };
    const error = new SpriteAnimationInvalidError(detail);

    expect(error.expected).toBe('SpriteAnimation.frameDuration > 0');
    expect(error.hint).toBe(
      'SpriteAnimation.frameDuration = 0 is invalid; use a positive seconds-per-frame value (e.g. 0.1 = 10 fps)',
    );
    expect(error.message).toBe(
      'SpriteAnimation: invariant violated.\n' +
        '  code: sprite-animation-invalid\n' +
        '  field: frame-duration\n' +
        '  expected: SpriteAnimation.frameDuration > 0\n' +
        '  hint: SpriteAnimation.frameDuration = 0 is invalid; use a positive seconds-per-frame value (e.g. 0.1 = 10 fps)',
    );
    expect(error.detail).toBe(detail);
  });

  it('preserves negative-duration interpolation and detail identity', () => {
    const detail = { field: 'frame-duration' as const, frameDuration: -0.05 };
    const error = new SpriteAnimationInvalidError(detail);

    expect(error.expected).toBe('SpriteAnimation.frameDuration > 0');
    expect(error.hint).toBe(
      'SpriteAnimation.frameDuration = -0.05 is invalid; use a positive seconds-per-frame value (e.g. 0.1 = 10 fps)',
    );
    expect(error.message).toBe(
      'SpriteAnimation: invariant violated.\n' +
        '  code: sprite-animation-invalid\n' +
        '  field: frame-duration\n' +
        '  expected: SpriteAnimation.frameDuration > 0\n' +
        '  hint: SpriteAnimation.frameDuration = -0.05 is invalid; use a positive seconds-per-frame value (e.g. 0.1 = 10 fps)',
    );
    expect(error.detail).toBe(detail);
  });

  it('preserves correlated detail narrowing and Error descriptors', () => {
    const regionsDetail: EcsErrorDetail = {
      code: 'sprite-animation-invalid',
      field: 'regions-length',
      regionsLength: 7,
      frameCount: 3,
    };
    const durationDetail: EcsErrorDetail = {
      code: 'sprite-animation-invalid',
      field: 'frame-duration',
      frameDuration: -0.05,
    };

    for (const detail of [regionsDetail, durationDetail]) {
      if (detail.code !== 'sprite-animation-invalid') continue;
      switch (detail.field) {
        case 'regions-length':
          expectTypeOf(detail.regionsLength).toEqualTypeOf<number>();
          expectTypeOf(detail.frameCount).toEqualTypeOf<number>();
          expect(detail.regionsLength).toBe(7);
          expect(detail.frameCount).toBe(3);
          break;
        case 'frame-duration':
          expectTypeOf(detail.frameDuration).toEqualTypeOf<number>();
          expect(detail.frameDuration).toBe(-0.05);
          break;
      }
    }

    const errors = [
      new SpriteAnimationInvalidError({
        field: 'regions-length',
        regionsLength: 7,
        frameCount: 3,
      }),
      new SpriteAnimationInvalidError({ field: 'frame-duration', frameDuration: -0.05 }),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(SpriteAnimationInvalidError);
      expect(error.name).toBe('SpriteAnimationInvalidError');
      expect(typeof error.stack).toBe('string');
      expect(Object.keys(error)).toEqual(['name', 'code', 'hint', 'expected', 'detail']);

      for (const key of ['name', 'code', 'hint', 'expected', 'detail'] as const) {
        expect(Object.getOwnPropertyDescriptor(error, key)).toEqual({
          value: error[key],
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
  });
});
