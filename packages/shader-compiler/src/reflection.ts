// reflection.ts — Naga emit_reflection JSON -> BindGroupLayoutDescriptor[] type
// alignment and validation (plan-strategy S-9 / D-R9).
//
// @forgeax/engine-naga already emits BGL fully explicitly on the Rust side as JSON
// (hasDynamicOffset / minBindingSize / visibility bitmask, etc.). As of
// feat-20260629 M4, the emit_reflection output format changed from an array
// to an object: { bindings: [...], uvSetCount: number }. This module handles
// both formats (old array = backwards compat test path; new object = production).

import type { BindGroupLayoutDescriptor } from '@forgeax/engine-types';

/**
 * Parse the BGL JSON string emitted by naga emit_reflection.
 *
 * Since m4-w2 (feat-20260629), the format is { bindings: [...], uvSetCount: N }.
 * Older wasm builds emit a raw array []. Both are accepted: array-only
 * returns uvSetCount=0 (legacy path).
 *
 * Input = the @forgeax/engine-naga output format (byte-for-byte aligned with
 * @forgeax/engine-types.BindGroupLayoutDescriptor: label / entries / the 5 mutually
 * exclusive sub-dictionaries buffer / sampler / texture / storageTexture);
 * on failure throws SyntaxError, which the caller wraps as
 * ShaderError manifest-malformed.
 */
export interface ParsedReflection {
  readonly bindings: readonly BindGroupLayoutDescriptor[];
  readonly uvSetCount: number;
}

export function parseReflection(json: string): ParsedReflection {
  const parsed = JSON.parse(json);
  if (Array.isArray(parsed)) {
    // Legacy format (pre-m4-w2): raw BGL array, no uvSetCount.
    return { bindings: parsed as readonly BindGroupLayoutDescriptor[], uvSetCount: 0 };
  }
  const bindings = (parsed as { bindings: unknown }).bindings;
  if (!Array.isArray(bindings)) {
    throw new SyntaxError('reflection JSON missing bindings array');
  }
  const uvSetCount =
    typeof (parsed as { uvSetCount?: number }).uvSetCount === 'number'
      ? (parsed as { uvSetCount: number }).uvSetCount
      : 0;
  return { bindings: bindings as readonly BindGroupLayoutDescriptor[], uvSetCount };
}

/** @deprecated Use parseReflection instead for uvSetCount support. */
export function parseReflectionJson(json: string): readonly BindGroupLayoutDescriptor[] {
  return parseReflection(json).bindings;
}
