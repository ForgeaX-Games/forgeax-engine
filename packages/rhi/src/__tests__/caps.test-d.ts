// Type-level — RhiCaps capability layer field-set + readonly boolean shape.
//
// Baseline 7 fields (round 1 + rhi-resource-creation):
//   1) compute / 2) timestampQuery / 3) indirectDrawing / 4) textureCompression
//   5) multiDrawIndirect (reserved) / 6) pushConstants (reserved) /
//   7) textureBindingArray (reserved)
//
// Extended to 11 fields in feat-20260511-rhi-spec-realign-aggressive w2 (red) ->
// w7 (green) per plan-strategy D-P3 + requirements AC-05 + research R-03 §3.1
// 4-field mapping matrix:
//   8) samplerAliasing       — spec mandatory; both backends true
//   9) firstInstanceIndirect — gated by 'indirect-first-instance' feature
//  10) storageBuffer         — limits.maxStorageBuffersPerShaderStage > 0
//  11) storageTexture        — limits.maxStorageTexturesPerShaderStage > 0
//
// 3 reserved fields (#5/#6/#7) JSDoc wording amended in w8 from
// `@reserved-for-wgpu-wasm` to `@reserved-for-wgpu-native-only` (AC-06): on
// the browser path both rhi-webgpu and rhi-wgpu wasm always return false; only
// wgpu native (Tauri / native runtime) flips them.
//
// charter mapping: proposition 4 (explicit failure — caps.X = false is a
// signal, not an exception) + proposition 5 (consistent abstraction —
// browsers + native share one cap surface, differences are discoverable not
// hidden).

import { describe, expectTypeOf, it } from 'vitest';
import type { RhiCaps } from '../index';

describe('RhiCaps — 11-field shape', () => {
  it('contains 7 baseline boolean fields', () => {
    expectTypeOf<RhiCaps['compute']>().toEqualTypeOf<boolean>();
    expectTypeOf<RhiCaps['timestampQuery']>().toEqualTypeOf<boolean>();
    expectTypeOf<RhiCaps['indirectDrawing']>().toEqualTypeOf<boolean>();
    expectTypeOf<RhiCaps['textureCompression']>().toEqualTypeOf<boolean>();
    expectTypeOf<RhiCaps['multiDrawIndirect']>().toEqualTypeOf<boolean>();
    expectTypeOf<RhiCaps['pushConstants']>().toEqualTypeOf<boolean>();
    expectTypeOf<RhiCaps['textureBindingArray']>().toEqualTypeOf<boolean>();
  });

  it('contains 4 new D-P3 boolean fields (samplerAliasing / firstInstanceIndirect / storageBuffer / storageTexture)', () => {
    expectTypeOf<RhiCaps['samplerAliasing']>().toEqualTypeOf<boolean>();
    expectTypeOf<RhiCaps['firstInstanceIndirect']>().toEqualTypeOf<boolean>();
    expectTypeOf<RhiCaps['storageBuffer']>().toEqualTypeOf<boolean>();
    expectTypeOf<RhiCaps['storageTexture']>().toEqualTypeOf<boolean>();
  });

  // feat-20260612-hdrp-deferred-shading-learn-render-5-8 M1 / w2:
  // RhiCaps.maxColorAttachments field existence + type = number.
  it('contains maxColorAttachments: number field', () => {
    expectTypeOf<RhiCaps['maxColorAttachments']>().toEqualTypeOf<number>();
  });

  it('maxColorAttachments is readonly', () => {
    type Check = { readonly maxColorAttachments: number };
    expectTypeOf<Pick<RhiCaps, 'maxColorAttachments'>>().toEqualTypeOf<Check>();
  });

  it('all 12 fields are readonly', () => {
    type ReadonlyKeys = {
      readonly compute: boolean;
      readonly timestampQuery: boolean;
      readonly indirectDrawing: boolean;
      readonly textureCompression: boolean;
      readonly multiDrawIndirect: boolean;
      readonly pushConstants: boolean;
      readonly textureBindingArray: boolean;
      readonly samplerAliasing: boolean;
      readonly firstInstanceIndirect: boolean;
      readonly storageBuffer: boolean;
      readonly storageTexture: boolean;
      readonly maxColorAttachments: number;
    };
    expectTypeOf<RhiCaps>().toMatchTypeOf<ReadonlyKeys>();
  });
});
