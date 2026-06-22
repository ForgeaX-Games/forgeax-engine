// reflection.ts — Naga emit_reflection JSON → BindGroupLayoutDescriptor[] type
// alignment and validation (plan-strategy §S-9 / D-R9).
//
// @forgeax/engine-naga already emits BGL fully explicitly on the Rust side as JSON
// (hasDynamicOffset / minBindingSize / visibility bitmask, etc.). This module
// merely runs JSON.parse and casts to @forgeax/engine-types.BindGroupLayoutDescriptor[]:
// the structures are byte-for-byte aligned, no field renames
// (plan-strategy §S-9 spec byte-for-byte alignment).

import type { BindGroupLayoutDescriptor } from '@forgeax/engine-types';

/**
 * Parse the BGL JSON string emitted by naga emit_reflection.
 *
 * Input = the @forgeax/engine-naga output format (byte-for-byte aligned with
 * @forgeax/engine-types.BindGroupLayoutDescriptor: label / entries / the 5 mutually
 * exclusive sub-dictionaries buffer / sampler / texture / storageTexture);
 * on failure throws SyntaxError, which the caller wraps as
 * ShaderError manifest-malformed.
 */
export function parseReflectionJson(json: string): readonly BindGroupLayoutDescriptor[] {
  return JSON.parse(json) as readonly BindGroupLayoutDescriptor[];
}
