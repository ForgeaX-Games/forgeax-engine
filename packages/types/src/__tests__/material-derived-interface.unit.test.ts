import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { derive, deriveObserved, ParamSchemaProjectionOwner } from '../derive-paramschema.js';
import type { ParamSchemaEntry } from '../index.js';

const CHARACTERIZATION_RECEIPT =
  '/tmp/forgeax-material-reflection-m1-owner-abi-characterization.json';

const coordinate = (name: string) => ({
  parameter: name,
  offset: 0,
  size: 32,
  alignment: 16,
  transformMember: `${name}CoordinatesTransform`,
  metadataMember: `${name}CoordinatesMetadata`,
});

describe('derived material interface contract matrix', () => {
  it('derives a self-contained empty interface', () => {
    const output = derive([]);

    expect(output.schemaVersion).toBe('material-abi/1');
    expect(output.group).toBe(1);
    expect(output.visibility).toBe(2);
    expect(output.numericMembers).toEqual([]);
    expect(output.coordinateRecords).toEqual([]);
    expect(output.resourceBindings).toEqual([]);
    expect(output.totalBytes).toBe(0);
    expect(output.layoutIdentity).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('records binding spans and the user-region boundary in the ABI projection', () => {
    const output = derive([
      { name: 'exposure', type: 'f32' },
      { name: 'albedo', type: 'texture2d' },
    ]);

    expect(output.bindingSpans).toEqual([
      { group: 1, binding: 0, start: 0, end: 48 },
      { group: 1, binding: 1, start: 0, end: 0 },
      { group: 1, binding: 2, start: 0, end: 0 },
    ]);
    expect(output.userRegion).toEqual({ group: 1, bindingStart: 0, bindingEnd: 3 });
  });

  it('derives numeric-only std140 members from schema order', () => {
    const output = derive([
      { name: 'roughness', type: 'f32' },
      { name: 'tint', type: 'vec3' },
    ]);

    expect(output.numericMembers).toEqual([
      { name: 'roughness', offset: 0, size: 4, alignment: 4, type: 'f32' },
      { name: 'tint', offset: 16, size: 12, alignment: 16, type: 'vec3' },
    ]);
    expect(output.coordinateRecords).toEqual([]);
    expect(output.totalBytes).toBe(32);
  });

  it('derives one coordinate record and its paired resources for texture-only schema', () => {
    const output = derive([{ name: 'albedo', type: 'texture2d' }]);

    expect(output.coordinateRecords).toEqual([coordinate('albedo')]);
    expect(output.resourceBindings).toEqual([
      { name: 'albedo_sampler', parameter: 'albedo', kind: 'sampler', binding: 1 },
      { name: 'albedo', parameter: 'albedo', kind: 'texture', binding: 2 },
    ]);
    expect(output.bglEntries.map((entry) => entry.binding)).toEqual([0, 1, 2]);
    expect(output.totalBytes).toBe(32);
  });

  it('derives array and volume texture bindings with their authored view dimensions', () => {
    const output = derive([
      { name: 'layers', type: 'texture2d_array' },
      { name: 'volume', type: 'texture3d' },
    ]);

    expect(output.bglEntries).toEqual([
      { binding: 0, visibility: 0x2, buffer: { type: 'uniform' } },
      { binding: 1, visibility: 0x2, sampler: { type: 'filtering' } },
      {
        binding: 2,
        visibility: 0x2,
        texture: { sampleType: 'float', viewDimension: '2d-array', multisampled: false },
      },
      { binding: 3, visibility: 0x2, sampler: { type: 'filtering' } },
      {
        binding: 4,
        visibility: 0x2,
        texture: { sampleType: 'float', viewDimension: '3d', multisampled: false },
      },
    ]);
    expect(output.resourceBindings.map((entry) => entry.name)).toEqual([
      'layers_sampler',
      'layers',
      'volume_sampler',
      'volume',
    ]);
  });

  it('keeps numeric members and coordinate records non-overlapping when interleaved', () => {
    const output = derive([
      { name: 'exposure', type: 'f32' },
      { name: 'albedo', type: 'texture2d' },
      { name: 'tint', type: 'vec4' },
      { name: 'normal', type: 'texture2d' },
    ]);

    expect(
      output.numericMembers.map((member) => [member.name, member.offset, member.size]),
    ).toEqual([
      ['exposure', 0, 4],
      ['tint', 48, 16],
    ]);
    expect(output.coordinateRecords).toEqual([
      { ...coordinate('albedo'), offset: 16 },
      { ...coordinate('normal'), offset: 64 },
    ]);
    expect(output.totalBytes).toBe(96);
    expect(output.resourceBindings.map((resource) => resource.binding)).toEqual([1, 2, 3, 4]);
  });

  it('preserves the byte-80 and byte-96 regions in one derived payload', () => {
    const output = derive([
      { name: 'brick0', type: 'vec4' },
      { name: 'brick1', type: 'vec4' },
      { name: 'brick2', type: 'vec4' },
      { name: 'brick3', type: 'vec4' },
      { name: 'brick4', type: 'vec4' },
      { name: 'byte80', type: 'f32' },
      { name: 'byte96', type: 'vec4' },
    ]);

    expect(output.numericMembers.find((member) => member.name === 'byte80')).toMatchObject({
      offset: 80,
      size: 4,
    });
    expect(output.numericMembers.find((member) => member.name === 'byte96')).toMatchObject({
      offset: 96,
      size: 16,
    });
    expect(output.totalBytes).toBe(112);
  });

  it('uses the same identity for repeated derivation and different shader consumers', () => {
    const schema = [
      { name: 'baseColor', type: 'color' as const },
      { name: 'albedo', type: 'texture2d' as const },
    ];

    const first = derive(schema);
    const second = derive(schema);
    const differentShaderConsumer = derive(schema);

    expect(second).toBe(first);
    expect(first.layoutIdentity).toBe(differentShaderConsumer.layoutIdentity);
  });

  it('reuses only an unchanged name/type shape and keeps the result immutable', () => {
    const schema: ParamSchemaEntry[] = [
      { name: '__fallback_cache_value', type: 'f32', default: 0 },
    ];
    const first = derive(schema);

    schema[0] = { name: '__fallback_cache_value', type: 'f32', default: 1 };
    expect(derive(schema)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.bglEntries)).toBe(true);
    expect(Object.isFrozen(first.uboLayout)).toBe(true);

    schema[0] = { name: '__fallback_cache_renamed', type: 'f32' };
    const changed = derive(schema);
    expect(changed).not.toBe(first);
    expect(changed.uboLayout.entries[0]?.name).toBe('__fallback_cache_renamed');

    schema[0] = { name: '', type: 'f32' };
    expect(() => derive(schema)).toThrow(/name/i);

    schema[0] = { name: '__fallback_cache_restored', type: 'f32' };
    expect(derive(schema).uboLayout.entries[0]?.name).toBe('__fallback_cache_restored');
  });

  it('observes fallback derivation, SHA, and identity-cache hits separately', () => {
    const schema: ParamSchemaEntry[] = [{ name: '__fallback_cache_observer', type: 'vec4' }];
    const events: string[] = [];
    const observer = {
      enabled: true,
      observe: ({ kind }: { readonly kind: string }) => events.push(kind),
    };

    deriveObserved(schema, observer, 'types-test');
    deriveObserved(schema, observer, 'types-test');

    expect(events).toEqual([
      'unregistered-fallback-derive',
      'fallback-layout-sha',
      'fallback-cache-hit',
    ]);
  });

  it('admits one immutable projection per owner revision', () => {
    const owner = new ParamSchemaProjectionOwner();
    const authored = [
      { name: 'baseColor', type: 'color' as const, default: [1, 1, 1, 1] },
      { name: 'albedo', type: 'texture2d' as const },
    ];

    const first = owner.admit({ ownerId: 'test::material', revision: 1, schema: authored });
    authored[0] = { name: 'mutated', type: 'color', default: [0, 0, 0, 0] };
    const repeated = owner.admit({
      ownerId: 'test::material',
      revision: 1,
      schema: [
        { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
        { name: 'albedo', type: 'texture2d' },
      ],
    });

    expect(repeated).toBe(first);
    expect(first.schema[0]?.name).toBe('baseColor');
    expect(Object.isFrozen(first.schema)).toBe(true);
    expect(Object.isFrozen(first.schema[0])).toBe(true);
    expect(Object.isFrozen(first.derivedInterface)).toBe(true);
    expect(derive(first.schema)).toBe(first.derivedInterface);
    expect(owner.stats()).toEqual({ admissions: 2, derivations: 1, projections: 1 });
  });

  it('rejects schema content changes that reuse an owner revision', () => {
    const owner = new ParamSchemaProjectionOwner();
    owner.admit({
      ownerId: 'test::material',
      revision: 1,
      schema: [{ name: 'baseColor', type: 'color' }],
    });

    expect(() =>
      owner.admit({
        ownerId: 'test::material',
        revision: 1,
        schema: [{ name: 'roughness', type: 'f32' }],
      }),
    ).toThrow(/reused with different schema content/);
  });

  it('serializes current ABI owner gaps as intermediate evidence', async () => {
    const schema = [
      { name: 'roughness', type: 'f32' as const },
      { name: 'albedo', type: 'texture2d' as const },
    ];
    const output = derive(schema);
    const receipt = {
      schemaVersion: 'material-reflection-characterization/1',
      status: 'intermediate',
      owner: 'types/material/derive-paramschema',
      observations: [
        {
          id: 'material-abi-derived-layout',
          status: 'observed',
          layoutIdentity: output.layoutIdentity,
          totalBytes: output.totalBytes,
          resourceBindings: output.resourceBindings,
        },
        {
          id: 'group-visibility-identity',
          status: 'expected-failure',
          observed: 'derive accepts no group or visibility inputs',
          evidence: { layoutIdentity: output.layoutIdentity },
        },
        {
          id: 'user-region-identity',
          status: 'observed',
          userRegionBindingEnd: output.userRegionBindingEnd,
        },
      ],
    } as const;

    await writeFile(CHARACTERIZATION_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(receipt.schemaVersion).toBe('material-reflection-characterization/1');
    expect(receipt.status).toBe('intermediate');
    expect(receipt.observations).toHaveLength(3);
    expect(receipt.observations[1]?.status).toBe('expected-failure');
  });
});
