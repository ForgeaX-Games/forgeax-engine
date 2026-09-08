// reflection.ts — strict shader-reflection/2 reader and derived-interface check.

import {
  parseReflectionWire,
  type ShaderReflection,
  type ShaderReflectionBoundGlobal,
  type ShaderReflectionMember,
} from '@forgeax/engine-naga';
import type {
  BindGroupLayoutDescriptor,
  DerivedMaterialInterface,
  MaterialErrorFor,
  Result as MaterialResult,
} from '@forgeax/engine-types';
import { createMaterialError, err, ok } from '@forgeax/engine-types';

/**
 * Parse the BGL JSON string emitted by naga emit_reflection.
 *
 * The generic bound-global wire is authoritative. The optional bindings
 * projection remains only as a downstream layout convenience; old raw arrays
 * and material-shaped projections are rejected by the Naga reader.
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
  readonly boundGlobals: readonly ShaderReflectionBoundGlobal[];
  readonly wire: ShaderReflection;
}

export function parseReflection(json: string): ParsedReflection {
  const wire = parseReflectionWire(json);
  const parsed = JSON.parse(json) as { bindings?: unknown };
  const bindings = Array.isArray(parsed.bindings)
    ? (parsed.bindings as readonly BindGroupLayoutDescriptor[])
    : [];
  return {
    bindings,
    uvSetCount: wire.uvSetCount,
    boundGlobals: wire.boundGlobals,
    wire,
  };
}

export function compareDerivedMaterialInterface(
  derived: DerivedMaterialInterface,
  reflection: Pick<ParsedReflection, 'boundGlobals'>,
): MaterialResult<void, MaterialErrorFor<'material-derived-interface-mismatch'>> {
  const expectedMembers = expectedMaterialMembers(derived);
  const actualByCoordinate = new Map(
    reflection.boundGlobals.map((global) => [`${global.group}:${global.binding}`, global]),
  );
  const expectedGlobals = derived.bglEntries;
  const uniform = expectedGlobals.find((entry) => entry.buffer?.type === 'uniform');
  for (const expected of expectedGlobals) {
    const actual = actualByCoordinate.get(`${derived.group}:${expected.binding}`);
    if (actual === undefined)
      return interfaceMismatch(derived, parameterForBinding(derived, expected.binding));
    const kindMatches = resourceKindMatches(expected, actual);
    // Naga keeps declarations for generated resources that no entry point
    // reads, but reports visibility=0 for those resources. The engine still
    // allocates the derived layout, so an unused material binding is valid;
    // non-zero visibility must still include every derived stage.
    const visibilityMatches =
      actual.visibility === 0 || (actual.visibility & expected.visibility) === expected.visibility;
    if (!kindMatches || !visibilityMatches) {
      return interfaceMismatch(derived, parameterForBinding(derived, expected.binding));
    }
    if (uniform !== undefined && expected.binding === uniform.binding) {
      const actualMembers = actual.members ?? [];
      const expectedRawEnd = expectedMembers.reduce(
        (end, member) => Math.max(end, member.offset + member.reflectedSize),
        0,
      );
      const expectedRawAlignment = expectedMembers.reduce(
        (alignment, member) => Math.max(alignment, member.alignment),
        1,
      );
      const expectedRawSpan = roundUp(expectedRawEnd, expectedRawAlignment);
      const expectedAllocationSpan = roundUp(expectedRawSpan, 16);
      // Naga reports the logical WGSL struct span. The derived interface
      // reports the host allocation span, which is rounded to 16 bytes.
      if (actual.span !== expectedRawSpan || expectedAllocationSpan !== derived.totalBytes) {
        return interfaceMismatch(derived, expectedMembers[0]?.parameter ?? '<uniform-span>');
      }
      if (actualMembers.length !== expectedMembers.length) {
        return interfaceMismatch(derived, '<uniform-span>');
      }
      for (let index = 0; index < expectedMembers.length; index += 1) {
        const expectedMember = expectedMembers[index];
        const actualMember = actualMembers[index];
        if (
          expectedMember === undefined ||
          actualMember === undefined ||
          !sameMember(expectedMember, actualMember)
        ) {
          return interfaceMismatch(derived, expectedMember?.parameter ?? '<member>');
        }
      }
    }
  }
  return ok(undefined);
}

function parameterForBinding(derived: DerivedMaterialInterface, binding: number): string {
  const resource = derived.resourceBindings.find((entry) => entry.binding === binding);
  if (resource?.parameter !== undefined) return resource.parameter;
  if (resource !== undefined) return resource.name;
  const member = derived.numericMembers[0];
  return member?.name ?? '<binding>';
}

interface ExpectedMaterialMember {
  readonly parameter: string;
  readonly name: string;
  readonly type: string;
  readonly offset: number;
  readonly size: number;
  readonly reflectedSize: number;
  readonly alignment: number;
}

function expectedMaterialMembers(derived: DerivedMaterialInterface): ExpectedMaterialMember[] {
  const members: ExpectedMaterialMember[] = (derived.numericMembers ?? []).map((member) => ({
    parameter: member.name,
    name: member.name,
    type: numericWgslType(member.type),
    offset: member.offset,
    // A vec3 occupies a 16-byte tail in a WGSL struct even though its
    // reflected member payload is 12 bytes; this is the raw struct span.
    size: Math.max(member.size, member.alignment),
    reflectedSize: member.size,
    alignment: member.alignment,
  }));
  for (const coordinates of derived.coordinateRecords ?? []) {
    members.push(
      {
        parameter: coordinates.parameter,
        name: coordinates.transformMember,
        type: 'vec4<f32>',
        offset: coordinates.offset,
        size: 16,
        reflectedSize: 16,
        alignment: 16,
      },
      {
        parameter: coordinates.parameter,
        name: coordinates.metadataMember,
        type: 'vec4<f32>',
        offset: coordinates.offset + 16,
        size: 16,
        reflectedSize: 16,
        alignment: 16,
      },
    );
  }
  return members.sort((left, right) => left.offset - right.offset);
}

function roundUp(value: number, alignment: number): number {
  return value === 0 ? 0 : Math.ceil(value / alignment) * alignment;
}

function numericWgslType(type: string): string {
  switch (type) {
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
    case 'color':
      return 'vec4<f32>';
    default:
      return type;
  }
}

function sameMember(expected: ExpectedMaterialMember, actual: ShaderReflectionMember): boolean {
  return (
    expected.name === actual.name &&
    expected.type === actual.type &&
    expected.offset === actual.offset &&
    expected.reflectedSize === actual.size &&
    expected.alignment === actual.alignment
  );
}

function resourceKindMatches(
  expected: DerivedMaterialInterface['bglEntries'][number],
  actual: ShaderReflectionBoundGlobal,
): boolean {
  if (expected.buffer?.type === 'uniform') {
    return actual.addressSpace === 'uniform' && actual.resourceKind === 'buffer';
  }
  if (expected.buffer?.type === 'storage' || expected.buffer?.type === 'read-only-storage') {
    return actual.addressSpace === 'storage' && actual.resourceKind === 'storage-buffer';
  }
  if (expected.sampler !== undefined) {
    return actual.addressSpace === 'handle' && actual.resourceKind === 'sampler';
  }
  if (expected.texture !== undefined) {
    return actual.addressSpace === 'handle' && actual.resourceKind === 'texture';
  }
  return (
    expected.storageTexture !== undefined &&
    actual.addressSpace === 'handle' &&
    actual.resourceKind === 'texture'
  );
}

function interfaceMismatch(
  derived: DerivedMaterialInterface,
  parameter: string,
): MaterialResult<never, MaterialErrorFor<'material-derived-interface-mismatch'>> {
  return err(
    createMaterialError('material-derived-interface-mismatch', {
      code: 'material-derived-interface-mismatch',
      stage: 'compile',
      material: '<generated-material>',
      layoutIdentity: derived.layoutIdentity,
      expectedIdentity: derived.layoutIdentity,
      parameter,
      action: 'recook',
    }),
  );
}
