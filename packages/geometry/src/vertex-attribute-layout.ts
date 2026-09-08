// @forgeax/engine-runtime - Vertex attribute layout SSOT (14-key closed set
// to GPUVertexBufferLayout derived function).
//
// deriveVertexBufferLayout(map, opts?) consumes a partial VertexAttributeMap and produces
// a fixed-order array of GPUVertexBufferLayout entries — the single source of
// truth for @location(N) assignment + GPUVertexFormat for every attribute the
// engine pipeline can consume. Shader WGSL @location(N) declarations and
// geometry factories are consumers of this SSOT; naga reflection deep-equal
// tests (T-33 dawn-only) keep them in sync (AC-26 / plan-strategy D-7).
//
// Canonical interleaved order (plan-strategy F-1, must match bridge + import layers):
//   position / normal / uv / tangent / skinIndex / skinWeight / uv1..uv7 / color
//
// Key index (plan-strategy D-4 / D-7):
//   0: position   -> @location(0) float32x3
//   1: normal     -> @location(1) float32x3
//   2: uv         -> @location(2) float32x2  (set 0)
//   3: tangent    -> @location(3) float32x4
//   4: skinIndex  -> @location(4) uint16x4
//   5: skinWeight -> @location(5) float32x4
//   6: uv1        -> @location(6) float32x2  (set 1, fea-20260629 D-4)
//   7: uv2        -> @location(7) float32x2  (set 2)
//   8: uv3        -> @location(8) float32x2  (set 3)
//   9: uv4        -> @location(9) float32x2  (set 4)
//  10: uv5        -> @location(10) float32x2 (set 5)
//  11: uv6        -> @location(11) float32x2 (set 6)
//  12: uv7        -> @location(12) float32x2 (set 7)
//
// feat-20260523-skin-skeleton-animation M2 / T-22.
// feat-20260629-multi-uv-set-support m3-w4: uv1..uv7 + clamp-to-last alias (D-1).

import {
  ASSET_ERROR_HINTS,
  AssetError,
  countUvSets,
  err,
  ok,
  type Result,
  type VertexAttributeMap,
  type VertexAttributePackDetail,
  type VertexAttributeStorage,
} from '@forgeax/engine-types';

const ATTRIBUTE_FORMAT_MAP = {
  position: 'float32x3' as const,
  normal: 'float32x3' as const,
  uv: 'float32x2' as const,
  tangent: 'float32x4' as const,
  skinIndex: 'uint16x4' as const,
  skinWeight: 'float32x4' as const,
  uv1: 'float32x2' as const,
  uv2: 'float32x2' as const,
  uv3: 'float32x2' as const,
  uv4: 'float32x2' as const,
  uv5: 'float32x2' as const,
  uv6: 'float32x2' as const,
  uv7: 'float32x2' as const,
  color: 'float32x4' as const,
} as const;

type AttributeKey = keyof typeof ATTRIBUTE_FORMAT_MAP;

const ATTRIBUTE_BYTE_STRIDE: Record<AttributeKey, number> = {
  position: 12,
  normal: 12,
  uv: 8,
  tangent: 16,
  skinIndex: 8,
  skinWeight: 16,
  uv1: 8,
  uv2: 8,
  uv3: 8,
  uv4: 8,
  uv5: 8,
  uv6: 8,
  uv7: 8,
  color: 16,
};

export interface GpuVertexBufferLayoutEntry {
  readonly arrayStride: number;
  readonly attributes: ReadonlyArray<{
    readonly shaderLocation: number;
    readonly offset: number;
    readonly format: string;
  }>;
  readonly stepMode?: 'vertex' | 'instance' | undefined;
}

const isAttributeKey = (key: string): key is AttributeKey => key in ATTRIBUTE_FORMAT_MAP;

const CANONICAL_KEYS: readonly AttributeKey[] =
  Object.keys(ATTRIBUTE_FORMAT_MAP).filter(isAttributeKey);
const UV_KEYS: readonly AttributeKey[] = CANONICAL_KEYS.filter(
  (key) => key === 'uv' || key.startsWith('uv'),
);

type Entry = {
  readonly key: AttributeKey;
  readonly shaderLocation: number;
  readonly offset: number;
  readonly format: string;
};

function emitAliasEntries(
  entries: Entry[],
  fromIndex: number,
  toIndex: number,
  aliasOffset: number,
  currentStride: number,
): number {
  for (let k = fromIndex; k < toIndex && k < UV_KEYS.length; k++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded index on const array
    const uvKey = UV_KEYS[k]!;
    entries.push({
      key: uvKey,
      shaderLocation: CANONICAL_KEYS.indexOf(uvKey),
      offset: aliasOffset,
      format: ATTRIBUTE_FORMAT_MAP[uvKey],
    });
  }
  // When meshUvSetCount===0, allocate 8 bytes for the zero UV area.
  // Otherwise no stride increase (aliased to existing offset).
  return fromIndex === 0 ? currentStride + ATTRIBUTE_BYTE_STRIDE.uv : currentStride;
}

/**
 * Build a non-skin `VertexAttributeMap` carrying exactly `uvSetCount` UV sets
 * (set 0 = `uv`, then `uv1..uv{uvSetCount-1}`). `deriveVertexBufferLayout`
 * reads only key presence, so the zero-length typed-array values are sentinels.
 *
 * feat-20260629-multi-uv-set-support: the forward record stage owns only the
 * mesh's `uvSetCount` (a scalar threaded through MeshGpuHandles), not the
 * original `MeshAsset.attributes` map. It synthesizes the map here so the
 * material PSO's vertex layout includes the real @location(6+) attributes and
 * its stride matches the interleaved buffer (a mesh with 2 real UV sets has a
 * 56 B stride; a 48 B PSO layout against it puts every vertex after the first
 * off-screen). uvSetCount <= 1 yields the canonical 4-attribute single-UV map.
 */
export function buildMeshAttributeMapForUvSets(uvSetCount: number): VertexAttributeMap {
  const map: Record<string, Float32Array> = {
    position: new Float32Array(0),
    normal: new Float32Array(0),
    uv: new Float32Array(0),
    tangent: new Float32Array(0),
  };
  for (let set = 1; set < uvSetCount && set < UV_KEYS.length; set++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded index on const array
    map[UV_KEYS[set]!] = new Float32Array(0);
  }
  return map as unknown as VertexAttributeMap;
}

export function deriveVertexBufferLayout(
  map: VertexAttributeMap,
  opts?: { shaderUvSetCount?: number },
): GpuVertexBufferLayoutEntry[] {
  const shaderUvSetCount = opts?.shaderUvSetCount ?? 0;

  // Process present keys in canonical order; absent keys reserve no space.
  const entries: Entry[] = [];
  let offset = 0;

  for (const key of CANONICAL_KEYS) {
    if (map[key] === undefined) continue;
    entries.push({
      key,
      shaderLocation: CANONICAL_KEYS.indexOf(key),
      offset,
      format: ATTRIBUTE_FORMAT_MAP[key],
    });
    offset += ATTRIBUTE_BYTE_STRIDE[key];
  }

  const present = entries.length;

  // ── clamp-to-last alias (plan-strategy D-1) ──
  if (shaderUvSetCount > 0) {
    const meshUvSetCount = countUvSets(map);

    if (shaderUvSetCount > meshUvSetCount) {
      const lastUvIndex = meshUvSetCount - 1;
      const lastUvKey =
        lastUvIndex >= 0 && lastUvIndex < UV_KEYS.length ? UV_KEYS[lastUvIndex] : undefined;
      const aliasOffset = lastUvKey !== undefined ? CANONICAL_KEYS.indexOf(lastUvKey) : -1;

      const aliasByteOffset =
        aliasOffset >= 0
          ? (entries.find((e) => e.shaderLocation === aliasOffset)?.offset ?? 0)
          : offset;

      offset = emitAliasEntries(entries, meshUvSetCount, shaderUvSetCount, aliasByteOffset, offset);
    }
  }

  if (present === 0 && shaderUvSetCount === 0) return [];

  // Sort by shaderLocation for deterministic vertex buffer descriptor
  entries.sort((a, b) => a.shaderLocation - b.shaderLocation);

  return [
    {
      arrayStride: offset,
      attributes: entries.map(({ shaderLocation, offset: entryOffset, format }) => ({
        shaderLocation,
        offset: entryOffset,
        format,
      })),
    },
  ];
}

/** Build the GPU descriptor from an immutable projection, adding only shader UV aliases. */
export function deriveVertexBufferLayoutFromProjection(
  projection: VertexLayoutProjection,
  opts?: { shaderUvSetCount?: number },
): GpuVertexBufferLayoutEntry[] {
  const entries = projection.attributes.map(({ key, shaderLocation, offset, format }) => ({
    key,
    shaderLocation,
    offset,
    format,
  }));
  let arrayStride = projection.arrayStride;
  const shaderUvSetCount = opts?.shaderUvSetCount ?? 0;
  if (shaderUvSetCount > 0) {
    const meshUvSetCount = entries.filter(
      (entry) => entry.key === 'uv' || entry.key.startsWith('uv'),
    ).length;
    if (shaderUvSetCount > meshUvSetCount) {
      const lastUv = entries
        .filter((entry) => entry.key === 'uv' || entry.key.startsWith('uv'))
        .at(-1);
      const aliasOffset = lastUv?.offset ?? arrayStride;
      for (
        let index = meshUvSetCount;
        index < shaderUvSetCount && index < UV_KEYS.length;
        index += 1
      ) {
        const key = UV_KEYS[index];
        if (key === undefined) continue;
        entries.push({
          key,
          shaderLocation: CANONICAL_KEYS.indexOf(key),
          offset: aliasOffset,
          format: ATTRIBUTE_FORMAT_MAP[key],
        });
      }
      if (meshUvSetCount === 0) arrayStride += ATTRIBUTE_BYTE_STRIDE.uv;
    }
  }
  entries.sort((a, b) => a.shaderLocation - b.shaderLocation);
  return projection.attributes.length === 0
    ? []
    : [
        {
          arrayStride,
          attributes: entries.map(({ shaderLocation, offset, format }) => ({
            shaderLocation,
            offset,
            format,
          })),
        },
      ];
}

export interface VertexLayoutProjectionAttribute {
  readonly key: AttributeKey;
  readonly shaderLocation: number;
  readonly offset: number;
  readonly format: (typeof ATTRIBUTE_FORMAT_MAP)[AttributeKey];
  readonly byteLength: number;
}

/** Immutable geometry-owned projection consumed by packers and GPU consumers. */
export interface VertexLayoutProjection {
  readonly schemaVersion: 1;
  readonly attributes: readonly VertexLayoutProjectionAttribute[];
  readonly mask: number;
  readonly arrayStride: number;
  readonly digest: string;
}

function bytesForFormat(format: string): number {
  if (format === 'uint16x4' || format === 'float32x2') return 8;
  if (format === 'float32x3') return 12;
  return 16;
}

function storageOf(value: unknown): VertexAttributeStorage {
  if (value instanceof ArrayBuffer) return 'array-buffer';
  if (value instanceof Float32Array) return 'float32';
  if (value instanceof Uint16Array) return 'uint16';
  return 'other';
}

function elementView(
  value: VertexAttributeMap[AttributeKey],
  format: string,
): Float32Array | Uint16Array | undefined {
  if (value instanceof Float32Array || value instanceof Uint16Array) return value;
  if (value instanceof ArrayBuffer) {
    return format === 'uint16x4' ? new Uint16Array(value) : new Float32Array(value);
  }
  return undefined;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `vlp-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Derive the one canonical immutable layout projection for a vertex map. */
export function deriveVertexLayoutProjection(map: VertexAttributeMap): VertexLayoutProjection {
  const attributes: VertexLayoutProjectionAttribute[] = [];
  let offset = 0;
  let mask = 0;
  for (const key of CANONICAL_KEYS) {
    const value = map[key];
    if (value === undefined) continue;
    const format = ATTRIBUTE_FORMAT_MAP[key];
    const byteLength = bytesForFormat(format);
    attributes.push({
      key,
      shaderLocation: CANONICAL_KEYS.indexOf(key),
      offset,
      format,
      byteLength,
    });
    mask |= 1 << CANONICAL_KEYS.indexOf(key);
    offset += byteLength;
  }
  const digestInput = [
    '1',
    String(mask),
    String(offset),
    ...attributes.map(
      (entry) => `${entry.key},${entry.shaderLocation},${entry.offset},${entry.format}`,
    ),
  ].join('|');
  return Object.freeze({
    schemaVersion: 1,
    attributes: Object.freeze(attributes),
    mask,
    arrayStride: offset,
    digest: fnv1a(digestInput),
  });
}

export interface PackedVertexAttributes {
  readonly projection: VertexLayoutProjection;
  readonly vertices: Float32Array;
}

export class VertexAttributePackError extends AssetError {
  declare readonly detail: VertexAttributePackDetail;

  constructor(detail: VertexAttributePackDetail) {
    super({
      code: 'asset-invalid-value',
      expected: 'canonical vertex attributes with matching storage and cardinality',
      hint: ASSET_ERROR_HINTS['asset-invalid-value'],
      detail,
    });
  }
}

export interface VertexLayoutProjectionMaskError {
  readonly code: 'vertex-layout-mask-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly mask: number;
    readonly knownMask: number;
    readonly unknownMask: number;
    readonly reason: 'empty' | 'unknown-bits';
  };
}

/** Rebuild the canonical projection from a packed wire mask without a second schema. */
export function deriveVertexLayoutProjectionFromMask(
  mask: number,
): Result<VertexLayoutProjection, VertexLayoutProjectionMaskError> {
  const knownMask = (1 << CANONICAL_KEYS.length) - 1;
  const unsignedMask = Number.isInteger(mask) && mask >= 0 ? mask >>> 0 : 0xffffffff;
  const unknownMask = unsignedMask & ~knownMask;
  if (mask === 0) {
    return err({
      code: 'vertex-layout-mask-invalid',
      expected: 'a non-empty canonical vertex attribute mask',
      hint: 're-cook the mesh-bin payload from MeshAsset.attributes',
      detail: { mask, knownMask, unknownMask, reason: 'empty' },
    });
  }
  if (!Number.isInteger(mask) || mask < 0 || unknownMask !== 0) {
    return err({
      code: 'vertex-layout-mask-invalid',
      expected: `a mask using only canonical bits 0..${CANONICAL_KEYS.length - 1}`,
      hint: 're-cook the mesh-bin payload from MeshAsset.attributes',
      detail: { mask, knownMask, unknownMask, reason: 'unknown-bits' },
    });
  }
  const map: Record<string, Float32Array | Uint16Array> = {};
  for (let index = 0; index < CANONICAL_KEYS.length; index += 1) {
    if ((mask & (1 << index)) === 0) continue;
    const key = CANONICAL_KEYS[index];
    if (key !== undefined)
      map[key] = key === 'skinIndex' ? new Uint16Array(0) : new Float32Array(0);
  }
  return ok(deriveVertexLayoutProjection(map as VertexAttributeMap));
}

/** Pack tightly-owned attributes into the projection's canonical interleaved bytes. */
export function packInterleavedVertexAttributes(
  map: VertexAttributeMap,
  vertexCount: number,
): Result<PackedVertexAttributes, VertexAttributePackError> {
  const invalid = (detail: VertexAttributePackDetail): Result<never, VertexAttributePackError> =>
    err(new VertexAttributePackError(detail));
  if (!Number.isInteger(vertexCount) || vertexCount < 0) {
    return invalid({ field: 'vertexCount', reason: 'vertex-count-invalid', actual: vertexCount });
  }
  const projection = deriveVertexLayoutProjection(map);
  if (projection.attributes.length === 0) {
    return invalid({ field: 'attributes', reason: 'attributes-empty', actualCount: 0 });
  }
  const output = new ArrayBuffer(projection.arrayStride * vertexCount);
  const outputFloats = new Float32Array(output);
  const outputU16 = new Uint16Array(output);
  for (const entry of projection.attributes) {
    const sourceValue = map[entry.key];
    if (sourceValue === undefined) continue;
    const uint16 = entry.format === 'uint16x4';
    const components = entry.byteLength / (uint16 ? 2 : 4);
    const bytesPerComponent = uint16 ? 2 : 4;
    if (sourceValue instanceof ArrayBuffer && sourceValue.byteLength % bytesPerComponent !== 0) {
      return invalid({
        field: entry.key,
        reason: 'attribute-cardinality-mismatch',
        vertexCount,
        componentsPerVertex: components,
        expectedLength: vertexCount * components,
        actualLength: sourceValue.byteLength / bytesPerComponent,
      });
    }
    const source = elementView(sourceValue, entry.format);
    if (
      source === undefined ||
      (uint16
        ? storageOf(sourceValue) !== 'uint16' && storageOf(sourceValue) !== 'array-buffer'
        : storageOf(sourceValue) !== 'float32' && storageOf(sourceValue) !== 'array-buffer')
    ) {
      return invalid({
        field: entry.key,
        reason: 'attribute-storage-invalid',
        expectedStorage: uint16 ? 'uint16' : 'float32',
        actualStorage: storageOf(sourceValue),
      });
    }
    const expectedLength = vertexCount * components;
    if (source.length !== expectedLength) {
      return invalid({
        field: entry.key,
        reason: 'attribute-cardinality-mismatch',
        vertexCount,
        componentsPerVertex: components,
        expectedLength,
        actualLength: source.length,
      });
    }
    if (entry.key === 'color') {
      for (let elementIndex = 0; elementIndex < source.length; elementIndex += 1) {
        const component = source[elementIndex] as number;
        if (!Number.isFinite(component)) {
          return invalid({
            field: 'color',
            reason: 'attribute-non-finite',
            elementIndex,
            actual: Number.isNaN(component)
              ? 'nan'
              : component === Number.POSITIVE_INFINITY
                ? 'positive-infinity'
                : 'negative-infinity',
          });
        }
      }
    }
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      for (let component = 0; component < components; component += 1) {
        const sourceIndex = vertex * components + component;
        const byteOffset =
          vertex * projection.arrayStride + entry.offset + component * (uint16 ? 2 : 4);
        if (uint16) outputU16[byteOffset / 2] = Number(source[sourceIndex] ?? 0);
        else outputFloats[byteOffset / 4] = Number(source[sourceIndex] ?? 0);
      }
    }
  }
  return ok(Object.freeze({ projection, vertices: outputFloats }));
}
