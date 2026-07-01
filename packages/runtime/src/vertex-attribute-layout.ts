// @forgeax/engine-runtime - Vertex attribute layout SSOT (13-key closed set
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
//   position / normal / uv / tangent / skinIndex / skinWeight / uv1..uv7
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

import { countUvSets, type VertexAttributeMap } from '@forgeax/engine-types';

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

const CANONICAL_KEYS: readonly AttributeKey[] = [
  'position',
  'normal',
  'uv',
  'tangent',
  'skinIndex',
  'skinWeight',
  'uv1',
  'uv2',
  'uv3',
  'uv4',
  'uv5',
  'uv6',
  'uv7',
];

const UV_KEYS: readonly AttributeKey[] = ['uv', 'uv1', 'uv2', 'uv3', 'uv4', 'uv5', 'uv6', 'uv7'];

type Entry = {
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
      attributes: entries,
    },
  ];
}
