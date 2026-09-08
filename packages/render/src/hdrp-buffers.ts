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
// Storage usage flags come from the render package's dependency-free buffer
// usage owner; this module stays decoupled from renderer bootstrap.
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
  type TextureView,
} from '@forgeax/engine-rhi';
import { GPU_SHADER_STAGE_COMPUTE } from './gpu-stage';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from './gpu-usage';
import { BYTES_PER_LIGHT_SLOT } from './light-buffer-layout';
import {
  CLUSTER_GRID_STRIDE_U32,
  DEFAULT_CLUSTER_GRID,
  LIGHT_INDEX_LIST_CAPACITY,
  MAX_LIGHTS,
} from './pipeline/standard-profile';
import { createHdrpBindGroupLayoutDescriptor } from './pipeline-spec';
import { MESH_PER_ENTITY_STRIDE, MESH_UBO_FULL_ARRAY_BYTES } from './record/mesh-ssbo';
import type { RenderSystemRuntime } from './record/render-context';
import { getOrCreateSsaoFallbackTexture } from './ssao-buffers';

export { getOrCreateSsaoFallbackTexture } from './ssao-buffers';

/**
 * WebGL2 HDRP downlevel light-list capacity. 128 x 64 B = 8 KiB, below the
 * WebGL2 minimum uniform-buffer binding size of 16 KiB. The storage path
 * keeps the full MAX_LIGHTS budget; the uniform path uses the same LightSlot
 * POD and only changes the transport.
 */
export const HDRP_UNIFORM_LIGHT_CAPACITY = 128;

/** Bind-group layout used only by the WebGPU cluster membership producer. */
export function createHdrpClusterMembershipBindGroupLayoutDescriptor(): BindGroupLayoutDescriptor {
  return {
    label: 'hdrp-cluster-membership-bgl',
    entries: [
      {
        binding: 0,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        buffer: { type: 'read-only-storage', hasDynamicOffset: false },
      },
      {
        binding: 1,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        buffer: { type: 'storage', hasDynamicOffset: false },
      },
      {
        binding: 2,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        buffer: { type: 'uniform', hasDynamicOffset: false },
      },
      {
        binding: 3,
        visibility: GPU_SHADER_STAGE_COMPUTE,
        buffer: { type: 'read-only-storage', hasDynamicOffset: false },
      },
    ],
  };
}

/**
 * The persistent HDRP GPU buffers (plan D-1, BGL slot 3..6) plus the unified
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
  /** Whether bindings 3..5 carry storage buffers or uniform-buffer fallback data. */
  readonly storageBuffer: boolean;
  /** light_data -- 256 x 64 B on storage, 128 x 64 B on uniform fallback. */
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
  /** CPU-produced light AABBs consumed by the optional WebGPU membership pass. */
  readonly lightBoundsBuffer: Buffer;
  readonly lightBoundsBytes: number;
  /** The grid the buffers were sized for; cluster_grid is sized by gridX*gridY*gridZ. */
  readonly grid: { readonly x: number; readonly y: number; readonly z: number };
  /** Unified BGL layout for group(2). */
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
  const storageBuffer = runtime.device.caps?.storageBuffer === true;
  const clusterUniformBytes = 32;
  const lightDataBytes =
    (storageBuffer ? MAX_LIGHTS : HDRP_UNIFORM_LIGHT_CAPACITY) * BYTES_PER_LIGHT_SLOT;
  const clusterCells = grid.x * grid.y * grid.z;
  const clusterGridBytes = storageBuffer
    ? clusterCells * CLUSTER_GRID_STRIDE_U32 * 4
    : clusterUniformBytes;
  const lightIndexListBytes = storageBuffer ? LIGHT_INDEX_LIST_CAPACITY * 4 : clusterUniformBytes;
  const lightBoundsBytes = MAX_LIGHTS * 6 * 4;

  const lightData = device.createBuffer({
    label: 'hdrp-light-data',
    size: lightDataBytes,
    usage:
      (storageBuffer ? GPU_BUFFER_USAGE_STORAGE : GPU_BUFFER_USAGE_UNIFORM) |
      GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!lightData.ok) {
    runtime.errorRegistry.fire(lightData.error);
    return null;
  }
  const clusterGrid = device.createBuffer({
    label: 'hdrp-cluster-grid',
    size: clusterGridBytes,
    usage:
      (storageBuffer ? GPU_BUFFER_USAGE_STORAGE : GPU_BUFFER_USAGE_UNIFORM) |
      GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!clusterGrid.ok) {
    runtime.errorRegistry.fire(clusterGrid.error);
    return null;
  }
  const lightIndexList = device.createBuffer({
    label: 'hdrp-light-index-list',
    size: lightIndexListBytes,
    usage:
      (storageBuffer ? GPU_BUFFER_USAGE_STORAGE : GPU_BUFFER_USAGE_UNIFORM) |
      GPU_BUFFER_USAGE_COPY_DST,
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
  const lightBounds = device.createBuffer({
    label: 'hdrp-light-bounds',
    size: lightBoundsBytes,
    usage:
      (storageBuffer ? GPU_BUFFER_USAGE_STORAGE : GPU_BUFFER_USAGE_UNIFORM) |
      GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!lightBounds.ok) {
    runtime.errorRegistry.fire(lightBounds.error);
    return null;
  }

  // Create the unified 7-entry BGL layout for group(2)
  // (plan D-6, feat-20260609-hdrp-cluster-fragment-ggx M3).
  // The HDRP BGL descriptor is owned by pipeline-spec and shared with the
  // pipeline dispatcher and its byte-identical tests.
  const storageBufferCap = runtime.device.caps?.storageBuffer === true;
  const unifiedBglRes = device.createBindGroupLayout(
    createHdrpBindGroupLayoutDescriptor(storageBufferCap),
  );
  if (!unifiedBglRes.ok) {
    runtime.errorRegistry.fire(unifiedBglRes.error);
    return null;
  }
  const buffers: HdrpBuffers = {
    storageBuffer,
    lightDataBuffer: lightData.value,
    lightDataBytes,
    clusterGridBuffer: clusterGrid.value,
    clusterGridBytes,
    lightIndexListBuffer: lightIndexList.value,
    lightIndexListBytes,
    clusterUniformBuffer: clusterUniform.value,
    clusterUniformBytes,
    lightBoundsBuffer: lightBounds.value,
    lightBoundsBytes,
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
 *   [3] lightCount u32 (vec4 alignment; capped by the active transport)
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
  lightCount: number = 0,
  lightCapacity: number = HDRP_UNIFORM_LIGHT_CAPACITY,
): ArrayBuffer {
  const buf = new ArrayBuffer(32);
  const u32 = new Uint32Array(buf);
  const f32 = new Float32Array(buf);
  u32[0] = grid.x >>> 0;
  u32[1] = grid.y >>> 0;
  u32[2] = grid.z >>> 0;
  u32[3] = Math.min(Math.max(lightCount, 0), lightCapacity) >>> 0;
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
 * Consumers pass the same mesh storage buffer + stride that URP uses, so the
 * dynamic offset (`i * MESH_PER_ENTITY_STRIDE`) at `setBindGroup(2, ...)`
 * stays valid across both pipelines.
 */
/**
 * Build the unified group(2) BindGroup for HDRP — binding 0 = mesh SSBO
 * (dynamic offset, same buffer URP binds), bindings 3..6 = the cluster
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
            size: hdrpBuffers.storageBuffer ? MESH_PER_ENTITY_STRIDE : MESH_UBO_FULL_ARRAY_BYTES,
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

/**
 * Build the compute-only bind group for ordered cluster membership output.
 * Its group is intentionally separate from the fragment group: the same
 * light-index buffer is read-only in the fragment pipeline but read-write in
 * the producer pipeline, which WebGPU represents with different binding
 * types.
 */
export function createHdrpClusterMembershipBindGroup(
  runtime: RenderSystemRuntime,
  hdrpBuffers: HdrpBuffers,
  layout: BindGroupLayout,
): BindGroup | null {
  const result = runtime.device.createBindGroup({
    label: 'hdrp-cluster-membership-bg',
    layout,
    entries: [
      {
        binding: 0,
        resource: { kind: 'buffer', value: { buffer: hdrpBuffers.clusterGridBuffer } },
      },
      {
        binding: 1,
        resource: { kind: 'buffer', value: { buffer: hdrpBuffers.lightIndexListBuffer } },
      },
      {
        binding: 2,
        resource: { kind: 'buffer', value: { buffer: hdrpBuffers.clusterUniformBuffer } },
      },
      {
        binding: 3,
        resource: { kind: 'buffer', value: { buffer: hdrpBuffers.lightBoundsBuffer } },
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
