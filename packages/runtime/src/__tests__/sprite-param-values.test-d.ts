// w1 / M1 — sprite paramValues type-level fixture (feat-20260527-sprite-nineslice).
//
// Type-level fixture for the sprite material `paramValues` literal at the
// MaterialAsset construction call-site. This is the AI-user-facing
// autocomplete + ts-expect-error surface for the 9-slice paramValues fields
// added in this feat (AC-01).
//
// SpriteParamValues is a local helper type — it is NOT a public sibling
// type of MaterialAsset (plan-strategy §D-1: do not introduce a
// SpriteMaterialAsset variant). It mirrors the field set of
// `packages/shader/src/sprite.wgsl.meta.json#paramSchema` 1:1 so AI users
// get the right autocomplete and the right ts-expect-error when they pass
// the wrong shape.
//
// Field set must match paramSchema name set: baseColor / texture / sampler /
// region / pivot / flipX / flipY (existing) + slices / sliceMode (added in
// w2). Bidirectional diff check is the implementer's responsibility at
// commit time (plan-strategy §R-7 fixture-schema alignment).
//
// sliceMode is constrained to the numeric literal union `0 | 1` per
// plan-strategy AI-user-affordance section 2 (numeric literal, not the
// 'stretch' / 'tile' string literal). This is intentional: the wire format on the GPU
// side encodes mode in vec4.w sign per plan-strategy §D-3 and the
// authoring surface stays a small numeric union for IDE autocomplete +
// machine-readable validation.
//
// 4 ts-expect-error assertions:
//   (a) slices as 3-tuple [1, 2, 3] is rejected — must be 4-tuple
//   (b) sliceMode = 'tile' string literal is rejected — must be 0 | 1
//   (c) sliceMode = 2 is rejected — out of 0 | 1 union
//   (d) missing required `texture` field is rejected

import { describe, it } from 'vitest';

// Local helper type — paramSchema field set 1:1, no public re-export.
// `texture` is required (paramSchema entry has no default); other fields
// are optional (paramSchema entries carry defaults).
type SpriteParamValues = {
  baseColor?: readonly [number, number, number, number];
  texture: string;
  sampler?: string | null;
  region?: readonly [number, number, number, number];
  pivot?: readonly [number, number];
  slices?: readonly [number, number, number, number];
  sliceMode?: 0 | 1;
  flipX?: 0 | 1;
  flipY?: 0 | 1;
};

describe('w1 type-level - sprite paramValues 9-slice fixture', () => {
  it('accepts a fully-specified literal with slices + sliceMode', () => {
    const _ok: SpriteParamValues = {
      texture: 'tex-guid',
      slices: [0.25, 0.25, 0.75, 0.75],
      sliceMode: 0,
    };
    void _ok;
  });

  it('rejects slices with wrong arity', () => {
    const _bad: SpriteParamValues = {
      texture: 'tex-guid',
      // @ts-expect-error - slices must be a 4-tuple, not a 3-tuple
      slices: [1, 2, 3],
    };
    void _bad;
  });

  it("rejects sliceMode as 'tile' string literal", () => {
    const _bad: SpriteParamValues = {
      texture: 'tex-guid',
      // @ts-expect-error - sliceMode must be the numeric literal union 0 | 1, not a string
      sliceMode: 'tile',
    };
    void _bad;
  });

  it('rejects sliceMode out of the 0 | 1 union', () => {
    const _bad: SpriteParamValues = {
      texture: 'tex-guid',
      // @ts-expect-error - sliceMode = 2 is out of the 0 | 1 union
      sliceMode: 2,
    };
    void _bad;
  });

  it('rejects literal missing the required `texture` field', () => {
    // @ts-expect-error - `texture` is required (paramSchema entry has no default)
    const _bad: SpriteParamValues = {
      slices: [0, 0, 1, 1],
    };
    void _bad;
  });
});
