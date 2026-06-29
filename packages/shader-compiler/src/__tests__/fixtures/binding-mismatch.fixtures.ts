// binding-mismatch.fixtures.ts -- positive + negative fixtures for the w6/w7
// single-direction superset check (plan-strategy D-9 / D-10).
//
// Each fixture pairs a paramSchema with an "actual reflected BGL" (as if
// emitted by naga reflection on the user's WGSL) and the expected verdict.
// Negative fixtures must trigger the new 'material-shader-binding-mismatch'
// code; positive fixtures must pass even when the actual BGL has extra
// bindings beyond what derive(schema) requires (engine-injection placeholder).

import type {
  BindGroupLayoutDescriptor,
  BindGroupLayoutEntry,
  ParamSchemaEntry,
} from '@forgeax/engine-types';

const FRAGMENT = 0x2 as GPUShaderStageFlags;

function uboEntry(binding: number): BindGroupLayoutEntry {
  return {
    binding,
    visibility: FRAGMENT,
    buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: 0 },
  };
}

function tex2dEntry(binding: number): BindGroupLayoutEntry {
  return {
    binding,
    visibility: FRAGMENT,
    texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
  };
}

function filteringSamplerEntry(binding: number): BindGroupLayoutEntry {
  return {
    binding,
    visibility: FRAGMENT,
    sampler: { type: 'filtering' },
  };
}

export interface BindingMismatchFixture {
  readonly name: string;
  readonly schema: readonly ParamSchemaEntry[];
  readonly actualBgls: readonly BindGroupLayoutDescriptor[];
  readonly verdict: 'ok' | 'mismatch';
  /** When verdict='mismatch', the binding number that the error should reference. */
  readonly mismatchBinding?: number;
  /** When verdict='mismatch', the schema entry name that the error should reference. */
  readonly mismatchParam?: string;
}

// ---- Positive: exact match (schema yields exactly the actual BGL) ------------

const POS_EXACT_MATCH: BindingMismatchFixture = {
  name: 'pos-exact-match',
  schema: [
    { name: 'tint', type: 'color' },
    { name: 'mainTex', type: 'texture2d' },
  ],
  // Sampler-first per §D-4: derive yields [UBO@0, sampler@1, tex@2].
  actualBgls: [
    {
      entries: [uboEntry(0), filteringSamplerEntry(1), tex2dEntry(2)],
    },
  ],
  verdict: 'ok',
};

// ---- Positive: extra binding tolerated (engine-injection placeholder) --------
// derive(schema=[tint:color]) yields BGL [UBO@0]; WGSL author left an extra
// texture@1 reserved for future engine injection. Single-direction superset
// (actual ⊇ derive) accepts this.

const POS_EXTRA_BINDING_TOLERATED: BindingMismatchFixture = {
  name: 'pos-extra-binding-tolerated',
  schema: [{ name: 'tint', type: 'color' }],
  actualBgls: [
    {
      entries: [uboEntry(0), tex2dEntry(1)],
    },
  ],
  verdict: 'ok',
};

// ---- Negative: binding misnumbered ------------------------------------------
// derive([{name:'mainTex', type:'texture2d'}]) -> sampler@0 + tex@1 (sampler-first §D-4).
// Actual WGSL has sampler@2 + tex@3 (off-by-two). Missing entries at @0 and @1.

const NEG_BINDING_MISNUMBERED: BindingMismatchFixture = {
  name: 'neg-binding-misnumbered',
  schema: [{ name: 'mainTex', type: 'texture2d' }],
  actualBgls: [
    {
      entries: [filteringSamplerEntry(2), tex2dEntry(3)],
    },
  ],
  verdict: 'mismatch',
  // expected[0] is the auto-paired sampler at binding 0 ('mainTex_sampler'),
  // which is missing on the actual side.
  mismatchBinding: 0,
  mismatchParam: 'mainTex_sampler',
};

// ---- Negative: missing binding ----------------------------------------------
// derive([{tint:color},{mainTex:texture2d}]) -> UBO@0, sampler@1, tex@2 (sampler-first).
// Actual WGSL only has UBO@0 (forgot to declare sampler+texture).

const NEG_MISSING_BINDING: BindingMismatchFixture = {
  name: 'neg-missing-binding',
  schema: [
    { name: 'tint', type: 'color' },
    { name: 'mainTex', type: 'texture2d' },
  ],
  actualBgls: [
    {
      entries: [uboEntry(0)],
    },
  ],
  verdict: 'mismatch',
  // First missing expected binding is @1 (the auto-paired sampler).
  mismatchBinding: 1,
  mismatchParam: 'mainTex_sampler',
};

// ---- Negative: type mismatch ------------------------------------------------
// derive([{mainTex:texture2d}]) -> sampler@0, tex@1 (sampler-first §D-4).
// Actual WGSL declares UBO@0 instead of sampler@0 (wrong resource kind).

const NEG_TYPE_MISMATCH: BindingMismatchFixture = {
  name: 'neg-type-mismatch',
  schema: [{ name: 'mainTex', type: 'texture2d' }],
  actualBgls: [
    {
      entries: [uboEntry(0), tex2dEntry(1)],
    },
  ],
  verdict: 'mismatch',
  mismatchBinding: 0,
  mismatchParam: 'mainTex_sampler',
};

export const BINDING_MISMATCH_FIXTURES: readonly BindingMismatchFixture[] = [
  POS_EXACT_MATCH,
  POS_EXTRA_BINDING_TOLERATED,
  NEG_BINDING_MISNUMBERED,
  NEG_MISSING_BINDING,
  NEG_TYPE_MISMATCH,
];
