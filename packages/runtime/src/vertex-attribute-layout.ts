// @forgeax/engine-runtime - Vertex attribute layout SSOT (6-key closed set
// to GPUVertexBufferLayout derived function).
//
// deriveVertexBufferLayout(map) consumes a partial VertexAttributeMap and produces
// a fixed-order array of GPUVertexBufferLayout entries — the single source of
// truth for @location(N) assignment + GPUVertexFormat for every attribute the
// engine pipeline can consume. Shader WGSL @location(N) declarations and
// geometry factories are consumers of this SSOT; naga reflection deep-equal
// tests (T-33 dawn-only) keep them in sync (AC-26 / plan-strategy D-7).
//
// Key index (plan-strategy D-7):
//   0: position   -> @location(0) float32x3
//   1: normal     -> @location(1) float32x3
//   2: uv         -> @location(2) float32x2
//   3: tangent    -> @location(3) float32x4
//   4: skinIndex  -> @location(4) uint16x4  (16-bit head room, jointCount <= 256)
//   5: skinWeight -> @location(5) float32x4
//
// feat-20260523-skin-skeleton-animation M2 / T-22.

import type { VertexAttributeMap } from '@forgeax/engine-types';

const ATTRIBUTE_FORMAT_MAP = {
  position: 'float32x3' as const,
  normal: 'float32x3' as const,
  uv: 'float32x2' as const,
  tangent: 'float32x4' as const,
  skinIndex: 'uint16x4' as const,
  skinWeight: 'float32x4' as const,
} as const;

type AttributeKey = keyof typeof ATTRIBUTE_FORMAT_MAP;

const ATTRIBUTE_BYTE_STRIDE: Record<AttributeKey, number> = {
  position: 12,
  normal: 12,
  uv: 8,
  tangent: 16,
  skinIndex: 8,
  skinWeight: 16,
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

export function deriveVertexBufferLayout(map: VertexAttributeMap): GpuVertexBufferLayoutEntry[] {
  const keys: readonly AttributeKey[] = [
    'position',
    'normal',
    'uv',
    'tangent',
    'skinIndex',
    'skinWeight',
  ];
  const present = keys.filter((k) => map[k] !== undefined);

  if (present.length === 0) return [];

  const entries: {
    readonly shaderLocation: number;
    readonly offset: number;
    readonly format: string;
  }[] = [];
  let offset = 0;

  for (const key of keys) {
    if (map[key] === undefined) continue;
    const format = ATTRIBUTE_FORMAT_MAP[key];
    entries.push({
      shaderLocation: keys.indexOf(key),
      offset,
      format,
    });
    offset += ATTRIBUTE_BYTE_STRIDE[key];
  }

  const arrayStride = offset;

  return [
    {
      arrayStride,
      attributes: entries,
    },
  ];
}
