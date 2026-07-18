// @forgeax/engine-runtime - HDRP per-runtime persistent GPU buffers.
//
// feat-20260608-cluster-lighting Round-2 fix-up [w18-fix-r2] (F-1 / F-2):
//
// The HDRP cluster-forward path needs four persistent GPU buffers (light_data
// SSBO, cluster_grid SSBO, light_index_list SSBO, cluster_uniform UBO) on BGL
// slots 3..6 (plan D-1). Round-1 declared them only as graph resources -- no
// underlying RHI buffers existed, so the graph fail-fast'd on dangling-read
// every frame and the binner output was discarded.
//
// This module owns the lazy, per-runtime allocation of those buffers via a
// WeakMap keyed on RenderSystemRuntime. The HDRP buildGraph reaches in via
// `getOrCreateHdrpBuffers(runtime)`; subsequent calls in the same frame return
// the cached pair so `device.queue.writeBuffer` lands on the same handles as
// the (eventual) bind-group layout consumer (charter P5: one resource, one
// owner; AC-13: 4 RHI buffers actually exist on slot 3..6 layout).
//
// Storage usage flag values mirror the pattern already in use in
// `createRenderer.ts` (GPU_BUFFER_USAGE_STORAGE = 0x80 etc.) -- copied here
// rather than imported because that file does not export them and this module
// must stay decoupled from createRenderer.
//
// Sizes:
//   - light_data        : 256 x 64 B  = 16 384 B
//   - cluster_grid      : maxGridCells x 8 B = 64 x 64 x 64 x 8 B = 2 097 152 B max
//                         (plan D-grid: x,y,z each in [1..64]; maxCells=262144;
//                          stride 2 u32 = 8B; we allocate at the install-time
//                          grid passed via DEFAULT_CLUSTER_GRID 16x9x24=3456 cells).
//   - light_index_list  : 65536 u32   = 262 144 B
//   - cluster_uniform   :              = 32 B (2 vec4 std140)
//
// AC-14: cluster_uniform is allocated once with the install-time grid; runtime
// grid changes do NOT trigger PSO rebuild because grid lives in the UBO not in
// shader specialization. (Shader-side draw is M-future; this AC is satisfied
// by the buffer being a UBO with field-level updates.)

import {
  type BindGroup,
  type BindGroupLayout,
  type BindGroupLayoutDescriptor,
  type Buffer,
  RhiError,
  type Sampler,
  type Texture,
  type TextureView,
} from '@forgeax/engine-rhi';
import {
  CLUSTER_GRID_STRIDE_U32,
  DEFAULT_CLUSTER_GRID,
  LIGHT_INDEX_LIST_CAPACITY,
  MAX_LIGHTS,
} from './hdrp-pipeline';
import { BYTES_PER_LIGHT_SLOT } from './light-buffer-layout';
import { buildBindGroupLayoutDescriptor, type PipelineSpec } from './pipeline-spec';
import type { RenderSystemRuntime } from './render-system';

// Stub PipelineSpec for the HDRP BGL site. The dispatcher's 'hdrp-7-slot'
// arm reads only options.caps; spec content is unused without a registry
// (D-13 round-2: HDRP unified BGL is caps-driven, with the cluster-buffer
// fallback toggled by RhiCaps.storageBuffer).
const HDRP_BGL_SPEC_STUB: PipelineSpec = Object.freeze({
  shader: { id: '', passKind: 'forward', variantSet: 'CLUSTER_FORWARD_AVAILABLE=true' },
  attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
  geometry: { topology: 'triangle-list', vertexLayout: {} },
  renderState: undefined,
}) as PipelineSpec;

// WebGPU buffer-usage flag values (mirrors createRenderer.ts constants;
// re-declared locally to keep this module decoupled from that file).
const GPU_BUFFER_USAGE_UNIFORM = 0x40;
const GPU_BUFFER_USAGE_STORAGE = 0x80;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;

// WebGPU shader-stage visibility flags (mirrors pbr-pipeline.ts constants;
// re-declared locally to keep this module decoupled).
const GPU_SHADER_STAGE_VERTEX = 0x1;
const GPU_SHADER_STAGE_FRAGMENT = 0x2;

// WebGPU texture-usage flags (matching GPUTextureUsage enum). Mirrors
// ssao-buffers.ts; re-declared locally to keep the module decoupled.
const GPU_TEXTURE_USAGE_COPY_DST = 0x02;
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x04;

/**
 * Build the unified BGL descriptor for HDRP group(2). Round-2 (M7) extends
 * the original 5-entry layout (binding 0 + 3..6) with 2 SSAO-specific slots
 * at binding 7..8, giving 7 total entries.
 *
 * Entries:
 *   binding 0 — mesh SSBO (vertex stage, dynamic offset)
 *   binding 1 — absent (URP isolation gap)
 *   binding 2 — absent (URP isolation gap)
 *   binding 3 — light_data SSBO (fragment stage)
 *   binding 4 — cluster_grid SSBO (fragment stage)
 *   binding 5 — light_index_list SSBO (fragment stage)
 *   binding 6 — cluster_uniform UBO (fragment stage; .near_far_log.w
 *               carries SSAO intensity — scope-amend-webgl2-ubo fold)
 *   binding 7 — ssaoBlurred texture_2d<f32> (fragment stage; plan D-B)
 *   binding 8 — ssaoSampler (fragment stage; plan D-B)
 *
 * Single PSO, dual behavior: when SSAO is disabled the bind group at
 * binding 7 binds a 1x1 white fallback texture (AO = 1.0) and the host
 * writes intensity=0 into cluster_uniform.near_far_log.w, so the lighting
 * blend `mix(1.0, ssao*ao, 0) = 1.0` collapses to the round-1 baseline
 * (plan-strategy §D-B; charter P4 one consistent abstraction). Material
 * PSOs never recompile across enable / disable.
 *
 * scope-amend-webgl2-ubo: a dedicated @binding(9) intensity UBO would push
 * fragment-stage UBO count to 12, exceeding WebGL2's
 * `max_uniform_buffers_per_shader_stage = 11` budget on rhi-wgpu's
 * fallback path. Folding intensity into the existing cluster UBO pad
 * lane keeps the count at 11.
 *
 * When `storageBuffer=false` (no storage-buffer caps), bindings 0,3,4,5 fall
 * back to 'uniform' (same pattern as `buildPbrViewBglEntries` in pbr-pipeline.ts).
 *
 * Exported for unit-test access (w28: BGL 7-slot descriptor assertion).
 */
export function createHdrpBindGroupLayoutDescriptor(
  storageBuffer: boolean = true,
): BindGroupLayoutDescriptor {
  const meshBufType: GPUBufferBindingType = storageBuffer ? 'read-only-storage' : 'uniform';
  const clusterBufType: GPUBufferBindingType = storageBuffer ? 'read-only-storage' : 'uniform';
  return {
    label: 'hdrp-unified-bgl-group2',
    entries: [
      {
        binding: 0,
        visibility: GPU_SHADER_STAGE_VERTEX,
        buffer: { type: meshBufType, hasDynamicOffset: true },
      },
      // binding 1, 2: absent (URP physical isolation gap; plan D-6)
      {
        binding: 3,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        buffer: { type: clusterBufType, hasDynamicOffset: false },
      },
      {
        binding: 4,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        buffer: { type: clusterBufType, hasDynamicOffset: false },
      },
      {
        binding: 5,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        buffer: { type: clusterBufType, hasDynamicOffset: false },
      },
      {
        binding: 6,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: false },
      },
      {
        binding: 7,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
      },
      {
        binding: 8,
        visibility: GPU_SHADER_STAGE_FRAGMENT,
        sampler: { type: 'filtering' },
      },
    ],
  };
}

// ── 1x1 white fallback texture (plan-strategy §D-B) ───────────────────────
//
// Single-PSO invariant: the HDRP unified BGL always declares a binding 7
// texture_2d<f32>. When SSAO is disabled (or its resources are not yet
// allocated), the bind group binds this 1x1 r8unorm texture filled with
// 0xFF. r8unorm normalizes 255 -> 1.0, so the lighting shader reads
// `ssaoFactor = 1.0`, and `mix(1.0, ssao*ao, intensity) = ao` collapses
// back to the round-1 baseline (ambient = baked-AO only). No shader
// recompile across enable/disable.

interface SsaoFallbackResources {
  readonly texture: Texture;
  readonly view: TextureView;
  readonly sampler: Sampler;
}

const fallbackCache = new WeakMap<RenderSystemRuntime, SsaoFallbackResources>();

/**
 * Lazily allocate the 1x1 r8unorm white fallback texture + a sampler for
 * SSAO disabled / resource-missing path. Cached per RenderSystemRuntime so
 * subsequent calls reuse the same resources (charter P5 one-owner).
 *
 * Returns `null` if `device.createTexture` / `createTextureView` /
 * `createSampler` / `queue.writeTexture` fails; the caller (createBindGroup)
 * propagates the structured RhiError that landed on `runtime.errorRegistry`.
 */
export function getOrCreateSsaoFallbackTexture(
  runtime: RenderSystemRuntime,
): SsaoFallbackResources | null {
  const cached = fallbackCache.get(runtime);
  if (cached !== undefined) return cached;

  const device = runtime.device;
  const texRes = device.createTexture({
    label: 'hdrp-ssao-fallback-white',
    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    mipLevelCount: 1,
    sampleCount: 1,
    dimension: '2d',
    format: 'r8unorm',
    usage: GPU_TEXTURE_USAGE_TEXTURE_BINDING | GPU_TEXTURE_USAGE_COPY_DST,
    textureBindingViewDimension: undefined,
  });
  if (!texRes.ok) {
    runtime.errorRegistry.fire(texRes.error);
    return null;
  }

  // r8unorm: a single byte 0xFF normalizes to 1.0 (white => AO = 1.0).
  const whitePixel = new Uint8Array([255]);
  const writeRes = device.queue.writeTexture(
    {
      texture: texRes.value as unknown as GPUTexture,
      mipLevel: 0,
      origin: { x: 0, y: 0, z: 0 },
    },
    whitePixel,
    { offset: 0, bytesPerRow: 256, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  if (!writeRes.ok) {
    runtime.errorRegistry.fire(writeRes.error);
    return null;
  }

  const viewRes = device.createTextureView(texRes.value, {
    label: 'hdrp-ssao-fallback-white-view',
    format: 'r8unorm',
    dimension: '2d',
    aspect: 'all',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!viewRes.ok) {
    runtime.errorRegistry.fire(viewRes.error);
    return null;
  }

  const samplerRes = device.createSampler({
    label: 'hdrp-ssao-fallback-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
  });
  if (!samplerRes.ok) {
    runtime.errorRegistry.fire(samplerRes.error);
    return null;
  }

  const resources: SsaoFallbackResources = {
    texture: texRes.value,
    view: viewRes.value,
    sampler: samplerRes.value,
  };
  fallbackCache.set(runtime, resources);
  return resources;
}

/**
 * The 4 persistent HDRP GPU buffers (plan D-1, BGL slot 3..6) plus the unified
 * BGL layout for group(2) (plan D-6, feat-20260609-hdrp-cluster-fragment-ggx M3).
 *
 * AC-11: light_data stride = `BYTES_PER_LIGHT_SLOT` = 64 (double-sided lock with
 * WGSL hdrp-cluster-forward.wgsl LightSlot).
 * AC-13: 4 distinct RHI Buffer handles, ready for slot-3..6 BGL binding.
 * AC-14: clusterUniform is a uniform buffer (not storage); runtime grid change
 * is a writeBuffer field update, not a PSO rebuild.
 * AC-06: unifiedBindGroupLayout is the 7-entry group(2) BGL (mesh SSBO +
 * cluster 4 buffer).
 */
export interface HdrpBuffers {
  /** light_data SSBO -- 256 x 64 B = 16 KiB, BGL slot 3. */
  readonly lightDataBuffer: Buffer;
  readonly lightDataBytes: number;
  /** cluster_grid SSBO -- gridX*gridY*gridZ * 2 u32, BGL slot 4. */
  readonly clusterGridBuffer: Buffer;
  readonly clusterGridBytes: number;
  /** light_index_list SSBO -- 65536 u32 = 256 KiB, BGL slot 5. */
  readonly lightIndexListBuffer: Buffer;
  readonly lightIndexListBytes: number;
  /** cluster_uniform UBO -- 32 B (2 vec4 std140), BGL slot 6. */
  readonly clusterUniformBuffer: Buffer;
  readonly clusterUniformBytes: number;
  /** The grid the buffers were sized for; cluster_grid is sized by gridX*gridY*gridZ. */
  readonly grid: { readonly x: number; readonly y: number; readonly z: number };
  /** Unified BGL layout for group(2) — 7 entries: binding 0 + 3..6 (plan D-6). */
  readonly unifiedBindGroupLayout: BindGroupLayout;
}

const cache = new WeakMap<RenderSystemRuntime, HdrpBuffers>();

/**
 * Lazily allocate the 4 persistent HDRP buffers for `runtime`. Returns the same
 * `HdrpBuffers` object on subsequent calls (per-RenderSystem stable identity).
 *
 * On `device.createBuffer` failure, fires a structured RhiError on the runtime's
 * error registry and returns `null`; HDRP buildGraph treats null as a hard
 * pipeline disable (charter P3 explicit failure).
 *
 * `grid` defaults to `DEFAULT_CLUSTER_GRID` when undefined (matches the M5
 * record-stage default). The buffers are sized at the *first* call's grid; a
 * later install with a different grid keeps the existing allocation as long as
 * it has enough capacity (gridX*gridY*gridZ <= cached.grid product). Different
 * grids that exceed capacity are not currently re-allocated -- M-future.
 */
export function getOrCreateHdrpBuffers(
  runtime: RenderSystemRuntime,
  grid: { x: number; y: number; z: number } = DEFAULT_CLUSTER_GRID,
): HdrpBuffers | null {
  const cached = cache.get(runtime);
  if (cached !== undefined) return cached;

  const device = runtime.device;
  const lightDataBytes = MAX_LIGHTS * BYTES_PER_LIGHT_SLOT;
  const clusterCells = grid.x * grid.y * grid.z;
  const clusterGridBytes = clusterCells * CLUSTER_GRID_STRIDE_U32 * 4;
  const lightIndexListBytes = LIGHT_INDEX_LIST_CAPACITY * 4;
  const clusterUniformBytes = 32;

  const lightData = device.createBuffer({
    label: 'hdrp-light-data',
    size: lightDataBytes,
    usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!lightData.ok) {
    runtime.errorRegistry.fire(lightData.error);
    return null;
  }
  const clusterGrid = device.createBuffer({
    label: 'hdrp-cluster-grid',
    size: clusterGridBytes,
    usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!clusterGrid.ok) {
    runtime.errorRegistry.fire(clusterGrid.error);
    return null;
  }
  const lightIndexList = device.createBuffer({
    label: 'hdrp-light-index-list',
    size: lightIndexListBytes,
    usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!lightIndexList.ok) {
    runtime.errorRegistry.fire(lightIndexList.error);
    return null;
  }
  const clusterUniform = device.createBuffer({
    label: 'hdrp-cluster-uniform',
    size: clusterUniformBytes,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!clusterUniform.ok) {
    runtime.errorRegistry.fire(clusterUniform.error);
    return null;
  }

  // Create the unified 7-entry BGL layout for group(2)
  // (plan D-6, feat-20260609-hdrp-cluster-fragment-ggx M3).
  // D-13 round-2: route through buildBindGroupLayoutDescriptor (the
  // 'hdrp-7-slot' arm delegates to createHdrpBindGroupLayoutDescriptor).
  const storageBufferCap = runtime.device.caps.storageBuffer;
  const unifiedBglRes = device.createBindGroupLayout(
    buildBindGroupLayoutDescriptor(HDRP_BGL_SPEC_STUB, {
      kind: 'hdrp-7-slot',
      caps: { storageBuffer: storageBufferCap },
    }),
  );
  if (!unifiedBglRes.ok) {
    runtime.errorRegistry.fire(unifiedBglRes.error);
    return null;
  }

  const buffers: HdrpBuffers = {
    lightDataBuffer: lightData.value,
    lightDataBytes,
    clusterGridBuffer: clusterGrid.value,
    clusterGridBytes,
    lightIndexListBuffer: lightIndexList.value,
    lightIndexListBytes,
    clusterUniformBuffer: clusterUniform.value,
    clusterUniformBytes,
    grid: { x: grid.x, y: grid.y, z: grid.z },
    unifiedBindGroupLayout: unifiedBglRes.value,
  };
  cache.set(runtime, buffers);
  return buffers;
}

/**
 * Build the 8-float cluster_uniform std140 payload.
 *
 *   [0] gridX  u32 (cast in shader)
 *   [1] gridY  u32
 *   [2] gridZ  u32
 *   [3] pad1   u32 = 0 (vec4 alignment)
 *   [4] near   f32
 *   [5] far    f32
 *   [6] logFarOverNear  f32
 *   [7] ssaoIntensity   f32   (scope-amend-webgl2-ubo: folded from removed
 *                              dedicated @binding(9) UBO; lighting shader
 *                              reads `cluster_uniform.near_far_log.w`)
 *
 * Matches `__tests__/hdrp-bgl-slots.test.ts CLUSTER_UNIFORM_LAYOUT`.
 *
 * Note: u32 values written into a Float32Array view are bit-pattern correct
 * because writeBuffer copies raw bytes; the WGSL `var<uniform>` declares the
 * field as u32 / f32 per its position so the device reinterprets correctly.
 * Use a Uint32Array view for the integer slots to keep the bit pattern intact.
 */
export function packClusterUniform(
  grid: { x: number; y: number; z: number },
  near: number,
  far: number,
  ssaoIntensity: number = 0,
): ArrayBuffer {
  const buf = new ArrayBuffer(32);
  const u32 = new Uint32Array(buf);
  const f32 = new Float32Array(buf);
  u32[0] = grid.x >>> 0;
  u32[1] = grid.y >>> 0;
  u32[2] = grid.z >>> 0;
  // u32[3] = 0 (zero-init)
  f32[4] = near;
  f32[5] = far;
  // logFarOverNear: log(far/near) used by the shader for log-z slice mapping.
  // Guard against near=0 / far<=near (returns 0; downstream uses fallback).
  f32[6] = near > 0 && far > near ? Math.log(far / near) : 0;
  // f32[7] = SSAO intensity (default 0 = disabled-equivalent: mix(1.0, x, 0) = 1).
  f32[7] = ssaoIntensity;
  return buf;
}

/**
 * Per-entity mesh-SSBO slice size in bytes (must match
 * `MESH_PER_ENTITY_STRIDE` in render-system-record.ts). Kept in sync via the
 * value used here; consumers pass the SAME mesh storage buffer + stride that
 * URP uses, so the dynamic offset (`i * stride`) at `setBindGroup(2, ...)`
 * stays valid across both pipelines.
 *
 * Re-declared as a local constant rather than imported to keep this module
 * decoupled from render-system-record.ts (charter P5: one resource owner).
 */
const MESH_SSBO_PER_ENTITY_STRIDE = 256;

/**
 * Build the unified group(2) BindGroup for HDRP — binding 0 = mesh SSBO
 * (dynamic offset, same buffer URP binds), bindings 3..6 = the 4 cluster
 * buffers from `getOrCreateHdrpBuffers`.
 *
 * feat-20260609-hdrp-cluster-fragment-ggx M4 / w19. Called per-frame from the
 * recordFrame HDRP block after binner+writeBuffer; the resulting BindGroup
 * lands on `passCtx.hdrpClusterBindGroup` and recordMainPass binds it at
 * group(2) when `frameState.isHdrpActive`.
 *
 * Returns `null` on `device.createBindGroup` failure (a structured RhiError
 * is fired on `runtime.errorRegistry`); recordMainPass gracefully falls back
 * to the URP mesh bindGroup when null.
 *
 * Plan D-1 / D-4: the mesh SSBO buffer + stride mirror the URP path, so the
 * single dynamic offset issued at `setBindGroup(2, ...)` covers binding 0 of
 * the unified BGL just as it covers binding 0 of the URP mesh BGL.
 */
/**
 * SSAO bind-group input (plan-strategy §D-B, M7;
 * scope-amend-webgl2-ubo: dedicated @binding(9) intensity UBO removed).
 *
 * The HDRP unified BGL always declares 7 entries (cluster 5 + ssao 2); the
 * caller supplies one of two shapes depending on `config.ssao?.enabled`:
 *
 *   { enabled: true, ssaoBlurredView }
 *     -> binding 7 = real ssaoBlurred view
 *     -> binding 8 = real ssao sampler (lazy-allocated alongside fallback)
 *
 *   { enabled: false }
 *     -> binding 7 = 1x1 white fallback texture (AO = 1.0)
 *     -> binding 8 = fallback sampler
 *
 * Intensity flows via `cluster_uniform.near_far_log.w` (binding 6); the host
 * writes intensity=0 when SSAO is disabled so the lighting blend
 * `mix(1.0, ssao*ao, 0) = 1.0` collapses to the round-1 baseline. The
 * "always-7-entries" invariant lets every PBR PSO use the same pipeline
 * layout regardless of SSAO state — toggling the runtime config never
 * triggers shader recompile (charter P4 one consistent abstraction).
 *
 * `ssaoBuffers` is no longer carried in the enabled variant: the SSAO
 * compute-side UBO continues to live on the SSAO compute pipeline's own
 * group(0) BGL, decoupled from the lighting-stage group(2).
 */
export type SsaoBindOptions =
  | {
      readonly enabled: true;
      readonly ssaoBlurredView: TextureView;
    }
  | { readonly enabled: false };

export function createHdrpUnifiedBindGroup(
  runtime: RenderSystemRuntime,
  hdrpBuffers: HdrpBuffers,
  meshStorageBuffer: Buffer,
  ssaoOptions: SsaoBindOptions = { enabled: false },
): BindGroup | null {
  const fallback = getOrCreateSsaoFallbackTexture(runtime);
  if (fallback === null) return null;

  const ssaoTexView: TextureView = ssaoOptions.enabled
    ? ssaoOptions.ssaoBlurredView
    : fallback.view;
  const ssaoSampler: Sampler = fallback.sampler;

  const result = runtime.device.createBindGroup({
    label: 'hdrp-unified-bg-group2',
    layout: hdrpBuffers.unifiedBindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: {
          kind: 'buffer',
          value: {
            buffer: meshStorageBuffer,
            offset: 0,
            size: MESH_SSBO_PER_ENTITY_STRIDE,
          },
        },
      },
      {
        binding: 3,
        resource: {
          kind: 'buffer',
          value: { buffer: hdrpBuffers.lightDataBuffer },
        },
      },
      {
        binding: 4,
        resource: {
          kind: 'buffer',
          value: { buffer: hdrpBuffers.clusterGridBuffer },
        },
      },
      {
        binding: 5,
        resource: {
          kind: 'buffer',
          value: { buffer: hdrpBuffers.lightIndexListBuffer },
        },
      },
      {
        binding: 6,
        resource: {
          kind: 'buffer',
          value: { buffer: hdrpBuffers.clusterUniformBuffer },
        },
      },
      {
        binding: 7,
        resource: { kind: 'textureView', value: ssaoTexView },
      },
      {
        binding: 8,
        resource: { kind: 'sampler', value: ssaoSampler },
      },
    ],
  });
  if (!result.ok) {
    runtime.errorRegistry.fire(result.error);
    return null;
  }
  return result.value;
}

/** Sentinel error class re-export for tests asserting the error path. */
export { RhiError as HdrpBufferAllocError };
