// @forgeax/engine-runtime - RenderData projection layer
// (feat-20260601-gpu-resource-store-extraction M2 / w5).
//
// The middle of the three GPU-asset layers: AssetRegistry catalogues CPU asset
// POD; `deriveRenderData*` PROJECTS a POD into the GPU descriptor a resource
// build needs; GpuResourceStore owns device-side resource life/death. These
// projections are PURE -- they know the asset `kind` but never touch a device
// (AC-07). The store consumes the descriptor and does the createTexture /
// createBuffer / writeX work.
//
// Coverage is exactly the three GPU-resource kinds (mesh / texture / equirect,
// the latter projected to a cubemap). Asset kinds with no GPU residency are
// never projected -- the
// `ensureResident` miss switch dispatches per-kind with no default, so a fourth
// GPU-resource kind would surface as a `tsc -b` exhaustiveness error at the
// switch rather than a silent fallthrough (AC-06).

import { err, ok, type Result } from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  type AssetError,
  countExtraUvSets,
  type MeshAsset,
  type Submesh,
  type TextureAsset,
} from '@forgeax/engine-types';
import { numMipLevels } from './mipmap-generator';

// AssetError without importing AssetRegistry: build the 4-field surface
// (.code / .expected / .hint) directly against the @forgeax/engine-types SSOT
// (charter P5 producer / consumer split; mirrors the store's RuntimeAssetError).
class ProjectionAssetError extends Error implements AssetError {
  readonly code: AssetError['code'];
  readonly expected: string;
  readonly hint: string;
  constructor(fields: { code: AssetError['code']; expected: string; hint: string }) {
    super(`[AssetError ${fields.code}] expected: ${fields.expected}; hint: ${fields.hint}`);
    this.name = 'AssetError';
    this.code = fields.code;
    this.expected = fields.expected;
    this.hint = fields.hint;
  }
}

function projectionError(fields: {
  code: AssetError['code'];
  expected: string;
  hint: string;
}): AssetError {
  return new ProjectionAssetError(fields);
}

// GPU usage-flag constants (spec values; mirror the inline literals the store's
// pre-M2 upload paths carried).
const GPU_BUFFER_USAGE_VERTEX = 0x20;
const GPU_BUFFER_USAGE_INDEX = 0x10;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;
const GPU_TEXTURE_USAGE_COPY_SRC = 0x1;
const GPU_TEXTURE_USAGE_COPY_DST = 0x2;
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x4;
const GPU_TEXTURE_USAGE_RENDER_ATTACHMENT = 0x10;

/** Descriptor for a mesh's GPU vertex + index buffers (projected from POD). */
export interface MeshRenderData {
  readonly vertexByteLength: number;
  /** Index byte length padded up to a 4-byte multiple (writeBuffer alignment). */
  readonly indexByteLength: number;
  readonly indexCount: number;
  readonly indexFormat: 'uint16' | 'uint32';
  /**
   * Vertex stride discriminator. `'12F'` = position(3) + normal(3) + uv(2) +
   * tangent(4) = 12 floats = 48 B. `'18F'` = 12F + skinIndex(4 uint16 packed
   * into 2 floats) + skinWeight(4 floats) = 18 floats = 72 B (feat-20260611).
   * Derived from the source `MeshAsset.attributes` -- presence of `skinIndex`
   * (set only via the parse-gltf -> bridge path for primitives carrying
   * JOINTS_0/WEIGHTS_0) flips the layout to 18F. Builtin / procedural
   * geometry never sets skinIndex and stays 12F (OOS-3).
   */
  readonly layout: '12F' | '18F';
  /**
   * Number of UV sets the interleaved vertex buffer actually carries (set 0 =
   * `uv` always present; +1 per `uv1..uv7` in `MeshAsset.attributes`).
   * feat-20260629-multi-uv-set-support: the `layout` discriminator only encodes
   * the 12F/18F base stride and cannot express the extra 8 B per UV set; a mesh
   * with a real second UV set has a 56 B stride that the forward record stage
   * must hand to `getMaterialShaderPipeline` so `deriveVertexBufferLayout`
   * emits the matching @location(6+) attribute (otherwise the pipeline reads a
   * 48 B stride against a 56 B buffer and every vertex after the first lands
   * off-screen -- the hello-multi-uv plane rendered nothing before this field).
   */
  readonly uvSetCount: number;
  readonly vertexUsage: number;
  readonly indexUsage: number;
  /**
   * Submeshes from the source MeshAsset, projected verbatim to the GPU store
   * so the record stage can iterate per-submesh draw calls (feat-20260608 M4 / w16).
   * Mirrors MeshAsset.submeshes (readonly Submesh[]) 1:1.
   */
  readonly submeshes: readonly Submesh[];
}

/** Descriptor for a 2D texture's GPU resource (projected from POD). */
export interface TextureRenderData {
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly mipLevelCount: number;
  readonly usage: number;
  /** Tightly packed RGBA8 row pitch the store passes to `writeTexture`. */
  readonly bytesPerRow: number;
}

/** Descriptor for a cubemap built from an equirect source (projected from POD). */
export interface CubeRenderData {
  /** Square cube face edge length (== source equirect height). */
  readonly cubeFaceSize: number;
  /** Filterable output format the IBL pipeline BGL expects. */
  readonly outputFormat: 'rgba16float';
  /** True when the source is rgba32float and the store must pack to rgba16float. */
  readonly needsHalfConversion: boolean;
  readonly cubeUsage: number;
}

/**
 * Project a `MeshAsset` POD into its GPU vertex / index buffer descriptor.
 * Pure: computes byte lengths, the 4-byte-aligned index size, index format,
 * and the buffer usage flags the store's `createBuffer` calls need.
 */
export function deriveRenderDataMesh(mesh: MeshAsset): Result<MeshRenderData, AssetError> {
  // Vertex-only meshes (no `indices`) take the non-indexed draw path. Their
  // index-side fields are zeroed; `indexFormat` keeps a `'uint16'` placeholder
  // (never consumed when no index buffer is built).
  const indices = mesh.indices;
  const indexBytesUnpadded = indices === undefined ? 0 : indices.byteLength;
  const indexByteLength = ((indexBytesUnpadded + 3) >> 2) << 2;
  // feat-20260611: presence of `attributes.skinIndex` is the per-MeshAsset
  // 18F discriminator. The parse-gltf -> bridge path sets this only for
  // primitives carrying both JOINTS_0 and WEIGHTS_0 (D-2 -- per-MeshAsset
  // unified stride; D-6 -- attr pair check fail-fast happens upstream in
  // parse). Builtin / procedural geometry never sets skinIndex (OOS-3).
  const layout: '12F' | '18F' = mesh.attributes.skinIndex !== undefined ? '18F' : '12F';
  // set 0 (`uv`) is always present in the canonical interleaved layout; each
  // `uv1..uv7` in attributes adds one more set (and 8 B to the stride).
  const uvSetCount = 1 + countExtraUvSets(mesh.attributes);
  return ok({
    vertexByteLength: mesh.vertices.byteLength,
    indexByteLength,
    indexCount: indices === undefined ? 0 : indices.length,
    indexFormat: indices instanceof Uint32Array ? 'uint32' : 'uint16',
    layout,
    uvSetCount,
    vertexUsage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    indexUsage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
    submeshes: mesh.submeshes,
  });
}

/**
 * Project a `TextureAsset` POD into its GPU texture descriptor. Pure: derives
 * the mip-level count (when `mipmap`), the row pitch, and the usage flags, and
 * fails fast if the POD's `format` and `colorSpace` are internally
 * inconsistent (a `-srgb` format requires an `srgb` colorSpace and vice versa).
 */
export function deriveRenderDataTexture(tex: TextureAsset): Result<TextureRenderData, AssetError> {
  const isSrgbFormat = tex.format.endsWith('-srgb');
  const expectedColorSpace: 'srgb' | 'linear' = isSrgbFormat ? 'srgb' : 'linear';
  if (tex.colorSpace !== expectedColorSpace) {
    return err(
      projectionError({
        code: 'invalid-source-format',
        expected: "format ends in '-srgb' iff colorSpace is 'srgb' (linear otherwise)",
        hint: ASSET_ERROR_HINTS['invalid-source-format'],
      }),
    );
  }
  const mipLevelCount = tex.mipmap ? numMipLevels(tex) : 1;
  return ok({
    width: tex.width,
    height: tex.height,
    format: tex.format,
    mipLevelCount,
    usage:
      GPU_TEXTURE_USAGE_TEXTURE_BINDING |
      GPU_TEXTURE_USAGE_COPY_DST |
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
    bytesPerRow: tex.width * 4,
  });
}

/**
 * Project an equirectangular HDR `TextureAsset` source into its cubemap
 * descriptor. Pure: validates the source is a linear half/float HDR format,
 * computes the square cube face size (== source height), narrows the output to
 * the filterable `rgba16float` the IBL pipeline expects, and flags whether the
 * store must pack an rgba32float source down to rgba16float. The store keeps
 * the resource build (createTexture / cube + face views / IBL precompute) and
 * the rgba32f->rgba16f byte conversion.
 */
export function deriveRenderDataCubemap(source: TextureAsset): Result<CubeRenderData, AssetError> {
  if (
    (source.format !== 'rgba16float' && source.format !== 'rgba32float') ||
    source.colorSpace !== 'linear'
  ) {
    return err(
      projectionError({
        code: 'invalid-source-format',
        expected: "format 'rgba16float' or 'rgba32float' with colorSpace 'linear'",
        hint: ASSET_ERROR_HINTS['invalid-source-format'],
      }),
    );
  }
  return ok({
    cubeFaceSize: source.height,
    outputFormat: 'rgba16float',
    needsHalfConversion: source.format === 'rgba32float',
    cubeUsage:
      GPU_TEXTURE_USAGE_TEXTURE_BINDING |
      GPU_TEXTURE_USAGE_COPY_DST |
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_COPY_SRC,
  });
}
