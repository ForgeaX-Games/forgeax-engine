// derive(schema) — paramSchema -> one DerivedMaterialInterface.
// feat-20260613-material-paramschema-driven-binding M1 / w3
//
// Decision anchors (plan-strategy §2):
//   - D-2  single pure function, no side effect; one signature consumed by 3
//          downstream paths (BGL build / UBO record / loader-extract).
//   - D-3  consecutive numeric entries are run-merged into one UBO entry at
//          one binding slot (uniform buffer); std140-aligned offsets.
//   - D-4  every texture* family entry auto-pairs a filtering sampler at
//          binding-1 (sampler emitted FIRST, then texture); sampler /
//          sampler_comparison stay user-declared.
//   - D-7  type set is the 14-literal MaterialParamType union.
//   - D-12 empty schema is graceful: bglEntries=[] / totalBytes=0 / fields empty.
//
// std140 alignment table (WGSL uniform):
//   - f32 / i32 / u32     size 4   align 4
//   - vec2<f32>           size 8   align 8
//   - vec3<f32>           size 12  align 16
//   - vec4 / color (rgba) size 16  align 16
//   - struct round-up: totalBytes is rounded up to 16-byte alignment.

import type {
  BindGroupLayoutEntry,
  MaterialParamType,
  NumericParamType,
  ParamSchemaEntry,
  TextureBindingParamType,
} from './index.js';

const FRAGMENT = 0x2 as GPUShaderStageFlags;

const NUMERIC_TYPES: ReadonlySet<MaterialParamType> = new Set<MaterialParamType>([
  'f32',
  'i32',
  'u32',
  'vec2',
  'vec3',
  'vec4',
  'color',
]);

const TEXTURE_VIEW_TYPES: ReadonlySet<MaterialParamType> = new Set<MaterialParamType>([
  'texture2d',
  'texture_cube',
  'texture_depth_2d',
  'texture_cube_array',
]);

const SAMPLER_TYPES: ReadonlySet<MaterialParamType> = new Set<MaterialParamType>([
  'sampler',
  'sampler_comparison',
]);

const ALL_TYPES: ReadonlySet<MaterialParamType> = new Set<MaterialParamType>([
  ...NUMERIC_TYPES,
  ...TEXTURE_VIEW_TYPES,
  ...SAMPLER_TYPES,
  'storage_buffer',
]);

interface NumericFootprint {
  readonly size: number;
  readonly align: number;
}

function numericFootprint(t: NumericParamType): NumericFootprint {
  switch (t) {
    case 'f32':
    case 'i32':
    case 'u32':
      return { size: 4, align: 4 };
    case 'vec2':
      return { size: 8, align: 8 };
    case 'vec3':
      return { size: 12, align: 16 };
    case 'vec4':
    case 'color':
      return { size: 16, align: 16 };
  }
}

function alignUp(value: number, alignment: number): number {
  return (value + alignment - 1) & ~(alignment - 1);
}

interface TextureBglDescriptor {
  readonly sampleType: GPUTextureSampleType;
  readonly viewDimension: GPUTextureViewDimension;
}

function textureBglDescriptor(t: TextureBindingParamType): TextureBglDescriptor {
  switch (t) {
    case 'texture2d':
      return { sampleType: 'float', viewDimension: '2d' };
    case 'texture_cube':
      return { sampleType: 'float', viewDimension: 'cube' };
    case 'texture_depth_2d':
      return { sampleType: 'depth', viewDimension: '2d' };
    case 'texture_cube_array':
      return { sampleType: 'float', viewDimension: 'cube-array' };
    case 'sampler':
    case 'sampler_comparison':
      // Not a texture view — caller must dispatch separately. Falling through
      // here is a defensive guard; numericFootprint / sampler handler covers
      // these branches before this function is reached.
      throw new Error(`derive: textureBglDescriptor called on sampler-family type '${t}'`);
  }
}

function samplerBindingType(t: 'sampler' | 'sampler_comparison'): GPUSamplerBindingType {
  return t === 'sampler' ? 'filtering' : 'comparison';
}

/** Single UBO sub-entry — one merged std140 slot. */
export interface UboFieldLayout {
  readonly name: string;
  readonly offset: number;
  readonly size: number;
  readonly type: NumericParamType;
}

export interface DerivedNumericMember extends UboFieldLayout {
  readonly alignment: number;
}

export interface MaterialCoordinateRecordLayout {
  readonly parameter: string;
  readonly offset: number;
  readonly size: 32;
  readonly alignment: 16;
  readonly transformMember: string;
  readonly metadataMember: string;
}

export type MaterialResourceKind = 'sampler' | 'texture' | 'storage-buffer';

export interface MaterialResourceBindingLayout {
  readonly name: string;
  readonly parameter?: string;
  readonly kind: MaterialResourceKind;
  readonly binding: number;
}

export interface MaterialBindingSpan {
  readonly group: number;
  readonly binding: number;
  readonly start: number;
  readonly end: number;
}

export interface MaterialUserRegion {
  readonly group: number;
  readonly bindingStart: number;
  readonly bindingEnd: number;
}

export interface MaterialParameterResourceProjection {
  readonly kind: 'sampler' | 'storage-buffer';
  readonly name: string;
  readonly type: 'sampler' | 'sampler_comparison' | 'storage_buffer';
  readonly resource: MaterialResourceBindingLayout;
  readonly coordinates?: never;
}

export interface MaterialParameterTextureProjection {
  readonly kind: 'texture';
  readonly name: string;
  readonly type: TextureBindingParamType;
  readonly coordinates: MaterialCoordinateRecordLayout;
  readonly resource: {
    readonly parameter: string;
    readonly texture: MaterialResourceBindingLayout;
    readonly sampler: MaterialResourceBindingLayout;
  };
}

export interface MaterialParameterNumericProjection {
  readonly kind: 'numeric';
  readonly name: string;
  readonly type: NumericParamType;
  readonly member: DerivedNumericMember;
  readonly coordinates?: never;
  readonly resource?: never;
}

export type MaterialParameterProjection =
  | MaterialParameterNumericProjection
  | MaterialParameterTextureProjection
  | MaterialParameterResourceProjection;

export interface DerivedMaterialInterface {
  readonly schemaVersion: 'material-abi/1';
  readonly group: number;
  readonly visibility: GPUShaderStageFlags;
  readonly bglEntries: readonly BindGroupLayoutEntry[];
  readonly uboLayout: UboLayout;
  readonly numericMembers: readonly DerivedNumericMember[];
  readonly coordinateRecords: readonly MaterialCoordinateRecordLayout[];
  readonly resourceBindings: readonly MaterialResourceBindingLayout[];
  readonly totalBytes: number;
  readonly layoutIdentity: string;
  readonly textureFieldNames: ReadonlySet<string>;
  readonly samplerForTexture: ReadonlyMap<string, string>;
  readonly userRegionBindingEnd: number;
  readonly bindingSpans: readonly MaterialBindingSpan[];
  readonly userRegion: MaterialUserRegion;
}

export interface UboLayout {
  readonly entries: readonly UboFieldLayout[];
  readonly totalBytes: number;
}

export type DeriveOutput = DerivedMaterialInterface;

export interface ImmutableParamSchemaProjection {
  readonly ownerId: string;
  readonly revision: number;
  readonly schema: readonly ParamSchemaEntry[];
  readonly derivedInterface: DerivedMaterialInterface;
}

export interface ParamSchemaProjectionOwnerStats {
  readonly admissions: number;
  readonly derivations: number;
  readonly projections: number;
}

export type ParamSchemaDeriveObservationKind =
  | 'admitted-identity-hit'
  | 'unregistered-fallback-derive'
  | 'fallback-layout-sha';

export interface ParamSchemaDeriveObserver {
  readonly enabled: boolean;
  readonly observe: (event: {
    readonly kind: ParamSchemaDeriveObservationKind;
    readonly site: string;
  }) => void;
}

interface OwnedParamSchemaProjection extends ImmutableParamSchemaProjection {
  readonly canonicalSchema: string;
}

// Runtime consumers can still receive the schema array through older API
// surfaces. Admission binds that immutable array identity back to the one
// owner projection, so those compatibility calls return the admitted result
// without deriving or hashing again. Unregistered schemas keep the pure
// offline/compiler behavior.
const ADMITTED_PARAM_SCHEMA_PROJECTIONS = new WeakMap<
  readonly ParamSchemaEntry[],
  DerivedMaterialInterface
>();

/**
 * Immutable/revision owner for runtime ParamSchema projections.
 *
 * A new `(ownerId, revision)` performs exactly one pure derivation. Repeating
 * the same admission is idempotent when the schema bytes match and fails loud
 * when a revision is reused for different schema content. The admitted schema
 * is cloned and frozen so caller-side mutation cannot alter a published
 * revision.
 */
export class ParamSchemaProjectionOwner {
  readonly #projections = new Map<string, OwnedParamSchemaProjection>();
  #admissions = 0;
  #derivations = 0;

  admit(args: {
    readonly ownerId: string;
    readonly revision: number;
    readonly schema: readonly ParamSchemaEntry[];
  }): ImmutableParamSchemaProjection {
    if (args.ownerId.length === 0) {
      throw new Error('ParamSchemaProjectionOwner: ownerId must be non-empty');
    }
    if (!Number.isSafeInteger(args.revision) || args.revision < 1) {
      throw new Error('ParamSchemaProjectionOwner: revision must be a positive safe integer');
    }
    this.#admissions += 1;
    const key = `${args.ownerId}\u0000${args.revision}`;
    const canonicalSchema = JSON.stringify(args.schema);
    const existing = this.#projections.get(key);
    if (existing !== undefined) {
      if (existing.canonicalSchema !== canonicalSchema) {
        throw new Error(
          `ParamSchemaProjectionOwner: ${args.ownerId}@${args.revision} reused with different schema content`,
        );
      }
      return existing;
    }

    const schema = freezeParamSchema(args.schema);
    const derivedInterface = freezeDerivedMaterialInterface(derivePure(schema));
    this.#derivations += 1;
    ADMITTED_PARAM_SCHEMA_PROJECTIONS.set(schema, derivedInterface);
    const projection = Object.freeze({
      ownerId: args.ownerId,
      revision: args.revision,
      schema,
      derivedInterface,
      canonicalSchema,
    });
    this.#projections.set(key, projection);
    return projection;
  }

  get(ownerId: string, revision: number): ImmutableParamSchemaProjection | undefined {
    return this.#projections.get(`${ownerId}\u0000${revision}`);
  }

  stats(): ParamSchemaProjectionOwnerStats {
    return Object.freeze({
      admissions: this.#admissions,
      derivations: this.#derivations,
      projections: this.#projections.size,
    });
  }
}

/**
 * Pure derivation: paramSchema -> BGL entries + UBO byte layout + field maps.
 *
 * The function has no side effects and is the SSOT for BGL / UBO / loader
 * lookup tables (D-2). Runtime / vite-plugin-shader / loader all call into
 * this single entry point; in particular, `userRegionBindingEnd` is the
 * post-user-region binding index that engine-injected groups (shadow / IBL
 * / lightmap, see D-6) must start from.
 *
 * Throws on schema authoring errors:
 *   - duplicate entry name (numeric or non-numeric)
 *   - unrecognised type literal (not in the 14-member union)
 *   - empty entry name
 *   - user-declared name collides with the auto-paired `<tex>_sampler`
 */
export function derive(schema: readonly ParamSchemaEntry[]): DeriveOutput {
  const admitted = ADMITTED_PARAM_SCHEMA_PROJECTIONS.get(schema);
  if (admitted !== undefined) return admitted;
  return derivePure(schema);
}

/**
 * Debug-only observation seam for runtime compatibility consumers.
 *
 * This wrapper deliberately does not cache or change derivation semantics. It
 * only records whether the supplied schema identity was admitted by the
 * ParamSchemaProjectionOwner before delegating to the existing pure `derive`
 * function. Keeping the observer out of the normal `derive` signature leaves
 * production callers on the existing zero-argument path.
 */
export function deriveObserved(
  schema: readonly ParamSchemaEntry[],
  observer: ParamSchemaDeriveObserver,
  site: string,
): DeriveOutput {
  const admitted = ADMITTED_PARAM_SCHEMA_PROJECTIONS.has(schema);
  const output = derive(schema);
  if (observer.enabled) {
    observer.observe({
      kind: admitted ? 'admitted-identity-hit' : 'unregistered-fallback-derive',
      site,
    });
    if (!admitted) observer.observe({ kind: 'fallback-layout-sha', site });
  }
  return output;
}

function derivePure(schema: readonly ParamSchemaEntry[]): DeriveOutput {
  const bglEntries: BindGroupLayoutEntry[] = [];
  const uboFields: UboFieldLayout[] = [];
  const numericMembers: DerivedNumericMember[] = [];
  const coordinateRecords: MaterialCoordinateRecordLayout[] = [];
  const resourceBindings: MaterialResourceBindingLayout[] = [];
  const bindingSpans: MaterialBindingSpan[] = [];
  const textureFieldNames = new Set<string>();
  const samplerForTexture = new Map<string, string>();
  const seenNames = new Set<string>();
  const reservedSamplerNames = new Set<string>();

  let nextBinding = 0;
  let uboCursor = 0;
  let uboBinding: number | null = null;

  const ensureUboBinding = (): number => {
    if (uboBinding !== null) return uboBinding;
    uboBinding = nextBinding;
    nextBinding += 1;
    bglEntries.push({
      binding: uboBinding,
      visibility: FRAGMENT,
      buffer: { type: 'uniform' },
    });
    bindingSpans.push({ group: 1, binding: uboBinding, start: 0, end: 0 });
    return uboBinding;
  };

  for (const rawEntry of schema) {
    const entry = rawEntry as ParamSchemaEntry;
    if (entry.name.length === 0) {
      throw new Error('derive: schema entry name must be non-empty');
    }
    if (!ALL_TYPES.has(entry.type)) {
      throw new Error(`derive: unrecognised paramSchema type literal '${entry.type}'`);
    }
    if (seenNames.has(entry.name)) {
      throw new Error(`derive: duplicate paramSchema entry name '${entry.name}'`);
    }
    if (reservedSamplerNames.has(entry.name)) {
      throw new Error(
        `derive: paramSchema entry '${entry.name}' collides with auto-paired sampler name`,
      );
    }
    seenNames.add(entry.name);

    if (NUMERIC_TYPES.has(entry.type)) {
      const numericType = entry.type as NumericParamType;
      const { size, align } = numericFootprint(numericType);
      ensureUboBinding();
      const offset = alignUp(uboCursor, align);
      uboFields.push({ name: entry.name, offset, size, type: numericType });
      numericMembers.push({ name: entry.name, offset, size, alignment: align, type: numericType });
      uboCursor = offset + size;
      continue;
    }

    if (TEXTURE_VIEW_TYPES.has(entry.type)) {
      const texType = entry.type as TextureBindingParamType;
      ensureUboBinding();
      const coordinateOffset = alignUp(uboCursor, 16);
      const coordinates: MaterialCoordinateRecordLayout = {
        parameter: entry.name,
        offset: coordinateOffset,
        size: 32,
        alignment: 16,
        transformMember: `${entry.name}CoordinatesTransform`,
        metadataMember: `${entry.name}CoordinatesMetadata`,
      };
      coordinateRecords.push(coordinates);
      uboCursor = coordinateOffset + coordinates.size;
      const { sampleType, viewDimension } = textureBglDescriptor(texType);
      // Sampler-first per plan §D-4: emit auto-paired filtering sampler at
      // binding N, then the texture view at binding N+1. Matches the actual
      // WGSL @binding declaration order in the 5 built-in shaders (sampler
      // declared on the odd binding, texture on the even+1 binding).
      const samplerName = `${entry.name}_sampler`;
      if (seenNames.has(samplerName)) {
        throw new Error(
          `derive: auto-paired sampler name '${samplerName}' collides with existing entry`,
        );
      }
      reservedSamplerNames.add(samplerName);
      samplerForTexture.set(entry.name, samplerName);
      const samplerBinding = nextBinding;
      nextBinding += 1;
      bglEntries.push({
        binding: samplerBinding,
        visibility: FRAGMENT,
        sampler: { type: 'filtering' },
      });
      bindingSpans.push({ group: 1, binding: samplerBinding, start: 0, end: 0 });
      resourceBindings.push({
        name: samplerName,
        parameter: entry.name,
        kind: 'sampler',
        binding: samplerBinding,
      });

      const texBinding = nextBinding;
      nextBinding += 1;
      bglEntries.push({
        binding: texBinding,
        visibility: FRAGMENT,
        texture: { sampleType, viewDimension, multisampled: false },
      });
      bindingSpans.push({ group: 1, binding: texBinding, start: 0, end: 0 });
      resourceBindings.push({
        name: entry.name,
        parameter: entry.name,
        kind: 'texture',
        binding: texBinding,
      });
      textureFieldNames.add(entry.name);
      continue;
    }

    if (SAMPLER_TYPES.has(entry.type)) {
      const samplerType = entry.type as 'sampler' | 'sampler_comparison';
      const samplerBinding = nextBinding;
      nextBinding += 1;
      bglEntries.push({
        binding: samplerBinding,
        visibility: FRAGMENT,
        sampler: { type: samplerBindingType(samplerType) },
      });
      bindingSpans.push({ group: 1, binding: samplerBinding, start: 0, end: 0 });
      resourceBindings.push({
        name: entry.name,
        parameter: entry.name,
        kind: 'sampler',
        binding: samplerBinding,
      });
      continue;
    }

    // entry.type === 'storage_buffer'
    const storageBinding = nextBinding;
    nextBinding += 1;
    bglEntries.push({
      binding: storageBinding,
      visibility: FRAGMENT,
      buffer: { type: 'read-only-storage' },
    });
    bindingSpans.push({ group: 1, binding: storageBinding, start: 0, end: 0 });
    resourceBindings.push({
      name: entry.name,
      parameter: entry.name,
      kind: 'storage-buffer',
      binding: storageBinding,
    });
  }

  const totalBytes = uboCursor === 0 ? 0 : alignUp(uboCursor, 16);
  const uniformSpan = bindingSpans.find((span) => span.binding === uboBinding);
  if (uniformSpan !== undefined) {
    const index = bindingSpans.indexOf(uniformSpan);
    bindingSpans[index] = { ...uniformSpan, end: totalBytes };
  }
  const userRegion: MaterialUserRegion = { group: 1, bindingStart: 0, bindingEnd: nextBinding };
  const layoutIdentity = sha256LayoutIdentity({
    numericMembers,
    coordinateRecords,
    resourceBindings,
    totalBytes,
    bindingSpans,
    userRegion,
  });

  return {
    schemaVersion: 'material-abi/1',
    group: 1,
    visibility: FRAGMENT,
    bglEntries,
    uboLayout: { entries: uboFields, totalBytes },
    numericMembers,
    coordinateRecords,
    resourceBindings,
    totalBytes,
    layoutIdentity,
    textureFieldNames,
    samplerForTexture,
    userRegionBindingEnd: nextBinding,
    bindingSpans,
    userRegion,
  };
}

function freezeParamSchema(schema: readonly ParamSchemaEntry[]): readonly ParamSchemaEntry[] {
  return Object.freeze(
    schema.map((entry) => {
      const defaultValue = cloneAndFreezeSchemaValue(entry.default);
      return Object.freeze({
        ...entry,
        ...(entry.default === undefined ? {} : { default: defaultValue }),
      }) as ParamSchemaEntry;
    }),
  );
}

function cloneAndFreezeSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreezeSchemaValue(item)));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, cloneAndFreezeSchemaValue(item)]),
      ),
    );
  }
  return value;
}

function freezeDerivedMaterialInterface(
  derived: DerivedMaterialInterface,
): DerivedMaterialInterface {
  deepFreeze(derived.bglEntries);
  deepFreeze(derived.uboLayout);
  deepFreeze(derived.numericMembers);
  deepFreeze(derived.coordinateRecords);
  deepFreeze(derived.resourceBindings);
  deepFreeze(derived.bindingSpans);
  deepFreeze(derived.userRegion);
  return Object.freeze({
    ...derived,
    textureFieldNames: new ImmutableSetView(derived.textureFieldNames),
    samplerForTexture: new ImmutableMapView(derived.samplerForTexture),
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

class ImmutableSetView<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;

  constructor(values: Iterable<T>) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: T): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[T, T]> {
    return this.#values.entries();
  }

  keys(): SetIterator<T> {
    return this.#values.keys();
  }

  values(): SetIterator<T> {
    return this.#values.values();
  }

  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.#values[Symbol.iterator]();
  }
}

class ImmutableMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(values: Iterable<readonly [K, V]>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: K): V | undefined {
    return this.#values.get(key);
  }

  has(key: K): boolean {
    return this.#values.has(key);
  }

  entries(): MapIterator<[K, V]> {
    return this.#values.entries();
  }

  keys(): MapIterator<K> {
    return this.#values.keys();
  }

  values(): MapIterator<V> {
    return this.#values.values();
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#values[Symbol.iterator]();
  }
}

export function inferMaterialParameterKind(
  entry: ParamSchemaEntry,
): MaterialParameterProjection['kind'] {
  if (NUMERIC_TYPES.has(entry.type)) return 'numeric';
  if (TEXTURE_VIEW_TYPES.has(entry.type)) return 'texture';
  if (entry.type === 'storage_buffer') return 'storage-buffer';
  return 'sampler';
}

function sha256LayoutIdentity(value: {
  readonly numericMembers: readonly DerivedNumericMember[];
  readonly coordinateRecords: readonly MaterialCoordinateRecordLayout[];
  readonly resourceBindings: readonly MaterialResourceBindingLayout[];
  readonly totalBytes: number;
  readonly bindingSpans: readonly MaterialBindingSpan[];
  readonly userRegion: MaterialUserRegion;
}): string {
  const canonical = JSON.stringify({
    version: 1,
    numericMembers: value.numericMembers,
    coordinateRecords: value.coordinateRecords,
    resourceBindings: value.resourceBindings,
    totalBytes: value.totalBytes,
    bindingSpans: value.bindingSpans,
    userRegion: value.userRegion,
  });
  return `sha256-${sha256(canonical)}`;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function sha256(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bytes.length * 8, false);
  let hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  for (let block = 0; block < padded.length; block += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1)
      words[index] = view.getUint32(block + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15] ?? 0;
      const b = words[index - 2] ?? 0;
      words[index] =
        (smallSigma1(b) + (words[index - 7] ?? 0) + smallSigma0(a) + (words[index - 16] ?? 0)) >>>
        0;
    }
    let a = hash[0] ?? 0;
    let b = hash[1] ?? 0;
    let c = hash[2] ?? 0;
    let d = hash[3] ?? 0;
    let e = hash[4] ?? 0;
    let f = hash[5] ?? 0;
    let g = hash[6] ?? 0;
    let h = hash[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const choose = (e & f) ^ (~e & g);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t1 = (h + bigSigma1(e) + choose + (SHA256_K[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const t2 = (bigSigma0(a) + majority) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    const state = [a, b, c, d, e, f, g, h];
    hash = new Uint32Array(hash.map((value, index) => ((value + (state[index] ?? 0)) >>> 0) >>> 0));
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join('');
}

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

function bigSigma0(value: number): number {
  return rotateRight(value, 2) ^ rotateRight(value, 13) ^ rotateRight(value, 22);
}

function bigSigma1(value: number): number {
  return rotateRight(value, 6) ^ rotateRight(value, 11) ^ rotateRight(value, 25);
}

function smallSigma0(value: number): number {
  return rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3);
}

function smallSigma1(value: number): number {
  return rotateRight(value, 17) ^ rotateRight(value, 19) ^ (value >>> 10);
}

/**
 * The three user-region material texture fields whose handles flow through the
 * paramSchema-driven extract filter (`validateTextureHandle`). They map to the
 * fixed `@group(1) @binding(2/4/6)` slots in the standard material BGL.
 *
 * `emissiveTexture` / `occlusionTexture` are deliberately EXCLUDED: they live
 * in the engine-managed lightmap injection region (`appendInjection`,
 * bindings 14..17), are sampled by `default-standard-pbr` without a schema
 * entry, and are never filtered by `validateTextureHandle`. Including them
 * would false-positive the engine's own PBR shader.
 */
const USER_REGION_TEXTURE_FIELDS: readonly string[] = [
  'baseColorTexture',
  'metallicRoughnessTexture',
  'normalTexture',
];

/** Strip `//` line comments and block comments before scanning WGSL source. */
function stripWgslComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Detect user-region material textures a shader actually `textureSample`s but
 * its paramSchema fails to declare as a texture entry.
 *
 * This is the runtime (register-time) counterpart of the build-time superset
 * gate (`compareParamSchemaSuperset`): user shaders registered directly via
 * `ShaderRegistry.installMaterialArtifact` bypass the vite-plugin-shader
 * reflection path, so an under-declared schema would otherwise let the extract
 * stage's `validateTextureHandle` silently drop the sampled texture's handle
 * and fall back to the default white texture (charter P3 violation — the bug
 * that turned the LearnOpenGL 4.3 blending demo's grass + windows opaque white;
 * see docs/handover/2026-06-19-blending-transparency-regression-bisect.md).
 *
 * Returns the field names that are sampled-but-undeclared (empty = consistent).
 * Scan is name-based on the WGSL var passed as the first `textureSample*`
 * argument; comments are stripped first so a commented-out sample never trips
 * the check. Only the three `USER_REGION_TEXTURE_FIELDS` participate, so a
 * shader that merely *declares* the standard binding layout without sampling it
 * (e.g. an outline / depth-viz shader reusing the PBR BGL) is not flagged.
 */
export function findUndeclaredSampledTextures(
  wgslSource: string,
  schema: readonly ParamSchemaEntry[],
): readonly string[] {
  const declared = derive(schema).textureFieldNames;
  const clean = stripWgslComments(wgslSource);
  const sampleRe = /textureSample[A-Za-z]*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  const sampled = new Set<string>();
  for (let m = sampleRe.exec(clean); m !== null; m = sampleRe.exec(clean)) {
    const name = m[1];
    if (name !== undefined) sampled.add(name);
  }
  return USER_REGION_TEXTURE_FIELDS.filter((f) => sampled.has(f) && !declared.has(f));
}
