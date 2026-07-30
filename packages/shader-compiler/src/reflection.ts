// reflection.ts — Naga emit_reflection JSON -> BindGroupLayoutDescriptor[] type
// alignment and validation (plan-strategy S-9 / D-R9).
//
// @forgeax/engine-naga already emits BGL fully explicitly on the Rust side as JSON
// (hasDynamicOffset / minBindingSize / visibility bitmask, etc.). As of
// feat-20260629 M4, the emit_reflection output format changed from an array
// to an object: { bindings: [...], uvSetCount: number }. This module handles
// both formats (old array = backwards compat test path; new object = production).

import type { BindGroupLayoutDescriptor, MaterialParameter } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import { type MaterialReflectionError, materialReflectionMismatch } from './errors.js';

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

export interface MaterialReflectionInput {
  readonly material: string;
  readonly pass: string;
  readonly parameters: readonly MaterialParameter[];
  readonly source: string;
  readonly reflection: {
    readonly uniformFields: readonly { readonly name: string; readonly type: string }[];
    readonly bindings: readonly unknown[];
    readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
  };
}

export interface MaterialReflection {
  readonly bindings: readonly unknown[];
  readonly uniformFields: readonly { readonly name: string; readonly type: string }[];
  readonly vertexInputs: readonly Readonly<Record<string, unknown>>[];
}

function expectedUniformType(parameter: MaterialParameter): string {
  switch (parameter.type) {
    case 'bool':
      return 'bool';
    case 'f32':
      return 'f32';
    case 'i32':
      return 'i32';
    case 'u32':
      return 'u32';
    case 'vec2':
      return 'vec2<f32>';
    case 'vec3':
      return 'vec3<f32>';
    case 'vec4':
      return 'vec4<f32>';
    case 'color':
      return 'vec4<f32>';
    case 'texture':
      return 'texture';
  }
}

function sourceContext(
  source: string,
  name: string,
): { line: number; column: number; context: string } {
  const lines = source.split('\n');
  const lineIndex = lines.findIndex((line) => line.includes(name));
  const safeIndex = lineIndex < 0 ? 0 : lineIndex;
  const line = lines[safeIndex] ?? '';
  return {
    line: safeIndex + 1,
    column: Math.max(1, line.indexOf(name) + 1),
    context: line,
  };
}

export function reflectMaterial(
  input: MaterialReflectionInput,
): Result<MaterialReflection, MaterialReflectionError> {
  const fields = new Map(input.reflection.uniformFields.map((field) => [field.name, field]));
  for (const parameter of input.parameters) {
    const field = fields.get(parameter.name);
    if (field === undefined) continue;
    const expected = expectedUniformType(parameter);
    if (expected === field.type) continue;
    const span = sourceContext(input.source, parameter.name);
    return err(
      materialReflectionMismatch({
        code: 'material-reflection-binding-mismatch',
        material: input.material,
        pass: input.pass,
        parameter: parameter.name,
        expected,
        actual: field.type,
        sourceSpan: { line: span.line, column: span.column },
        context: span.context,
      }),
    );
  }
  return ok({
    bindings: input.reflection.bindings,
    uniformFields: input.reflection.uniformFields,
    vertexInputs: input.reflection.vertexInputs,
  });
}
