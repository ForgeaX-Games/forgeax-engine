// @forgeax/engine-runtime - GpuResourceStore
// (feat-20260601-gpu-resource-store-extraction M1; M2 added the deriveRenderData
// projection seam — see render-data.ts).
//
// Owns the GPU residency layer extracted from AssetRegistry: per-handle GPU
// texture / cubemap / mesh buffer caches plus the upload primitives that
// build them. The store is engine-agnostic by default (no @webgpu/types
// imports) and holds ZERO reference to AssetRegistry (D-2): every upload
// primitive receives its source POD from the caller, never reaches back into
// a registry. The cubemap path mints its EquirectAsset POD handle through
// a wire-injected `registerCube` callback (D-3) so CPU cataloguing stays the
// registry's job while the store keeps the single-call upload contract. The
// cubemap projection (`_uploadCubemapFromEquirect`) is internal (@internal,
// feat-20260630): AI users declare `Skylight{equirect}` and the render-system
// record arm drives the projection; the method is never reached from user code.
//
// Residency model (D-2 pull): consumers call `ensureResident(handle, pod)`
// at first draw-time access; the store builds the GPU resource on a miss and
// returns the cached handles on subsequent O(1) hits. There is no global
// replay queue -- the pull model is purely lazy (user ruling). Builtin
// meshes are NOT routed through `ensureResident`; createRenderer seeds them
// via its step-3 direct upload + pipelineState.meshes (D-1).
//
// Texture residency is SYNCHRONOUS (D-9): `uploadTexture`'s only async source
// was the one-time per-device mipmap shader-module build, which is hoisted to
// `prewarmMipmapPipeline` (called from `createRenderer.ready`, already async).
// After prewarm the per-texture mipmap blit is pure synchronous encoder work,
// so the sync `draw(world)` frame contract is preserved. A format that was
// not prewarmed surfaces a structured RhiError on the sync path -- it is never
// lazily awaited (that would break the sync draw contract).

import {
  blitMipmapsSync,
  getOrCreateMipmapPipeline,
  type MipmapBlitDevice,
  type MipmapShaderModuleFactory,
} from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import { halfFloat } from '@forgeax/engine-math';
import {
  type Buffer,
  err,
  ok,
  type Result,
  type RhiCaps,
  type RhiDevice,
  RhiError,
  type Texture,
} from '@forgeax/engine-rhi';
import {
  ASSET_ERROR_HINTS,
  type AssetError,
  countExtraUvSets,
  type DecodedImage,
  type EquirectAsset,
  type Handle,
  handleSlot,
  IMAGE_ERROR_HINTS,
  type ImageError,
  type ImageErrorDetail,
  type PrimitiveTopology,
  type TextureAsset,
  type MeshAsset as TypesMeshAsset,
} from '@forgeax/engine-types';
import { GpuBuffer, GpuTexture } from './gpu-resource';
import {
  createFaceUniformsBuffer,
  createPrefilterUniformsBuffer,
  writeAllFaceUniforms,
  writeAllPrefilterUniforms,
} from './ibl/face-uniforms';
import {
  CUBEMAP_FACE_VERTICES,
  createIblPipelines,
  runIblPrecompute,
} from './ibl/IblPipelineCache';
import {
  type CubeRenderData,
  deriveMipUploadLayout,
  deriveRenderDataCubemap,
  deriveRenderDataMesh,
  deriveRenderDataTexture,
  type MeshRenderData,
  type TextureRenderData,
} from './render-data';
import type { RhiErrorListenerRegistry } from './renderer';

// AssetError is constructed without importing the AssetRegistry's class; the
// store builds the 4-field surface (.code / .expected / .hint / .detail)
// directly against the @forgeax/engine-types SSOT (charter P5 producer /
// consumer split; mirrors AssetRegistry's local RuntimeImageError).
class RuntimeAssetError extends Error implements AssetError {
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

function makeAssetError(fields: {
  code: AssetError['code'];
  expected: string;
  hint: string;
}): AssetError {
  return new RuntimeAssetError(fields);
}

const IMAGE_ERROR_EXPECTED_LOCAL: Readonly<Record<string, string>> = {
  'image-decode-failed': 'PNG / JPG byte stream decodes successfully',
  'image-format-unsupported': "format ends in '-srgb' iff colorSpace is 'srgb' (linear otherwise)",
  'image-dimension-out-of-bounds':
    'width and height fall under device caps maxTextureDimension2D (or 16384 hard cap)',
};

class RuntimeImageError extends Error implements ImageError {
  readonly code: ImageError['code'];
  readonly expected: string;
  readonly hint: string;
  readonly detail: ImageErrorDetail;
  constructor(detail: ImageErrorDetail) {
    const code = detail.code;
    const expected = IMAGE_ERROR_EXPECTED_LOCAL[code] ?? '';
    const hint = IMAGE_ERROR_HINTS[code];
    super(`[ImageError ${code}] expected: ${expected}; hint: ${hint}`);
    this.name = 'ImageError';
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.detail = detail;
  }
}

function makeImageError(detail: ImageErrorDetail): ImageError {
  return new RuntimeImageError(detail);
}

// Extended device shape adding `queue.writeTexture` on top of
// `MipmapBlitDevice` (the mipmap-generator only needs the encoder + queue
// submit surface; uploadTexture additionally writes pixel bytes via
// `queue.writeTexture` -- spec anchor: WebGPU 26.6.4.4).
type MipmapBlitDeviceWithWriteTexture = MipmapBlitDevice & {
  readonly queue: MipmapBlitDevice['queue'] & {
    // biome-ignore lint/suspicious/noExplicitAny: shim accepts any descriptor
    writeTexture(dst: any, data: any, layout: any, size: any): Result<void, any>;
  };
};

// Extended device shape adding `createBuffer` + `queue.writeBuffer` on top of
// `MipmapBlitDevice` for the user-mesh GPU upload path.
type MipmapBlitDeviceWithBuffer = MipmapBlitDevice & {
  // biome-ignore lint/suspicious/noExplicitAny: shim accepts any descriptor
  createBuffer(desc: any): Result<any, any>;
  readonly queue: MipmapBlitDevice['queue'] & {
    // biome-ignore lint/suspicious/noExplicitAny: shim accepts any descriptor
    writeBuffer(buffer: any, offset: number, data: any): Result<void, any>;
  };
};

/** Cube-POD register-relay injected by the wire layer (D-3). */
type RegisterCube = (
  world: World,
  pod: EquirectAsset,
) => Result<Handle<'EquirectAsset', 'shared'>, AssetError>;

// feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M-3 / w11:
// the three handle map value types now hold GpuTexture / GpuBuffer wrappers
// (plan-strategy D-9). Views (TextureView) stay raw RHI handles -- they are
// not destroyable on their own; their lifetime is bound to the parent
// GpuTexture, which the wrapper owns. destroyAll() walks the GpuResource
// fields and forwards .destroy() to the RHI shim.
interface TextureGpuEntry {
  readonly texture: GpuTexture;
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture view (not a GpuResource)
  readonly view: any;
}

// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M2 / w11
// (D-3): the projection-status truth lives here (the store's cubemap map is the
// single authority — the SkylightSnapshot carries no status, D-3). `status`:
//   - 'pending' — projection launched (fire-and-forget) but not complete; the
//     record arm binds the white-cube fallback for this frame.
//   - 'ready'   — texture + cube view + 6 face views are live; bind the real
//     IBL cube.
//   - 'failed'  — projection errored; recorded EXPLICITLY so the record arm
//     stops and does NOT retry every frame (R-2 / AC-09). A failed entry has
//     no GPU resources (texture/view are placeholders never bound).
// `texture`/`view`/`faceViews` are non-readonly so a 'pending' entry can be
// promoted to 'ready' in place (rebuilds the same slot). A 'failed' entry holds
// no GPU resources (`texture:null` / `view:undefined`): it exists only to mark
// the source as terminally failed so the record arm stops retrying (R-2).
interface CubemapGpuEntry {
  status: 'pending' | 'ready' | 'failed';
  texture: GpuTexture | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU cubemap view (not a GpuResource)
  view: any;
  // biome-ignore lint/suspicious/noExplicitAny: per-face 2D views (6 faces; not GpuResources)
  faceViews: readonly any[];
}

interface MeshGpuEntry {
  readonly vertexBuffer: GpuBuffer;
  /**
   * Index buffer wrapper, or `null` for a vertex-only mesh
   * (no `MeshAsset.indices`). When `null` the record stage takes the
   * non-indexed `pass.draw(vertexCount)` path and never calls
   * `setIndexBuffer`. Gated on `indexed` below.
   */
  readonly indexBuffer: GpuBuffer | null;
  /**
   * Allocation byte sizes for the vbo / ibo (mirrors GPUBuffer.size). Used
   * by `updateMeshById` to decide reuse vs reallocation; tracked here so
   * the runtime never reads `.size` off the opaque RHI handle (which is
   * not on the spec-aligned RHI Buffer interface; charter §RHI form rules).
   */
  readonly vboBytes: number;
  /** Allocation byte size for the ibo, or 0 when indexBuffer is null. */
  readonly iboBytes: number;
  readonly indexCount: number;
  readonly indexFormat: 'uint16' | 'uint32';
  /**
   * Vertex stride discriminator (feat-20260611). `'12F'` = 48 B
   * (position+normal+uv+tangent); `'18F'` = 72 B (12F + skinIndex(uint16x4) +
   * skinWeight(float32x4)). Mirrors `MeshRenderData.layout` in render-data.ts
   * and `MeshGpuHandles.layout` in render-system.ts -- the three layout
   * fields are the same union and move together.
   */
  readonly layout: '12F' | '18F';
  /**
   * Number of UV sets the interleaved buffer carries (1 = single `uv`, +1 per
   * `uv1..uv7`). feat-20260629-multi-uv-set-support: threaded to the record
   * stage so the forward PSO's vertex layout stride matches the buffer for
   * meshes with a real extra UV set. Mirrors MeshRenderData.uvSetCount /
   * MeshGpuHandles.uvSetCount.
   */
  readonly uvSetCount: number;
  /** Vertex count = `vertices.length / (layout === '18F' ? 18 : 12)`. Mirrors MeshGpuHandles. */
  readonly vertexCount: number;
  /** True when `MeshAsset.indices` is present (indexed draw path). */
  readonly indexed: boolean;
  /** Primitive topology (default 'triangle-list'). Mirrors MeshGpuHandles. */
  readonly topology: PrimitiveTopology;
  /**
   * Submeshes from MeshAsset.submeshes, carried through to the record stage
   * so per-submesh drawIndexed can iterate independently (feat-20260608 M4 / w16).
   * For single-submesh meshes this is a 1-element array (byte-identical to pre-M4).
   */
  readonly submeshes: readonly import('@forgeax/engine-types').Submesh[];
}

/**
 * GPU residency store. Owns the per-handle GPU caches and the upload
 * primitives that build them. Constructed once per renderer; wired with the
 * GPU device via `configureGpuDevice` after `Renderer.ready` resolves.
 */
export class GpuResourceStore {
  private gpuDevice: MipmapBlitDevice | undefined = undefined;
  // Shader-module factory injected at `configureGpuDevice`; threaded into the
  // mipmap-pipeline prewarm + the IBL precompute path. `undefined` until wired.
  private asyncCreateShaderModule: MipmapShaderModuleFactory | undefined = undefined;
  // Cube-POD register relay injected at `configureGpuDevice` (D-3); the store
  // never imports AssetRegistry, so CPU cataloguing flows through this fn.
  private registerCube: RegisterCube | undefined = undefined;
  // Error registry injected by createRenderer; evict / releaseUnreferenced
  // fire structured errors through this channel (feat-20260619 D-1/D-6).
  private errorRegistry: RhiErrorListenerRegistry | undefined = undefined;
  // Hardware-probe caps injected at `configureGpuDevice`; guards the HDR cubemap
  // path (_uploadCubemapFromEquirect) when `rgba16floatRenderable` is false.
  private caps: RhiCaps | undefined = undefined;

  private readonly textureGpuHandles: Map<number, TextureGpuEntry> = new Map();
  private readonly cubemapGpuHandles: Map<number, CubemapGpuEntry> = new Map();
  // Maps source EquirectAsset handle id -> minted cubemap handle so the same
  // equirect source always resolves to the same cubemap (idempotent, A2).
  private readonly cubemapIdempotentMap: Map<number, Handle<'EquirectAsset', 'shared'>> = new Map();
  private readonly meshGpuHandles: Map<number, MeshGpuEntry> = new Map();

  /**
   * Wire the GPU device, shader-module factory, and cube-POD register relay.
   * Called once by createRenderer after `Renderer.ready` resolves. Unlike the
   * pre-extraction AssetRegistry.configureGpuDevice, this performs NO replay:
   * the pull model builds resources lazily at first `ensureResident` access.
   */
  configureGpuDevice(
    device: MipmapBlitDevice,
    asyncCreateShaderModule: MipmapShaderModuleFactory | undefined,
    registerCube: RegisterCube,
    caps: RhiCaps,
  ): void {
    this.gpuDevice = device;
    this.asyncCreateShaderModule = asyncCreateShaderModule;
    this.registerCube = registerCube;
    this.caps = caps;
  }

  /**
   * Wrap a raw RHI Buffer handle into a GpuBuffer. The wrapper holds a
   * reference to the device so `.destroy()` forwards to
   * `device.destroyBuffer(handle)` (M-3 / w11; plan-strategy D-2).
   *
   * Pre: `configureGpuDevice` has been called. Callers that build a buffer
   * via `device.createBuffer` already gate on a wired device, so this private
   * helper trusts the caller; an unwired call is a programmer error and
   * surfaces as a non-null assertion rather than a structured error.
   */
  private wrapBuf(rawHandle: Buffer): GpuBuffer {
    const device = this.gpuDevice as MipmapBlitDevice & RhiDevice;
    return new GpuBuffer(device, rawHandle);
  }

  /** Wrap a raw RHI Texture handle into a GpuTexture (mirror of wrapBuf). */
  private wrapTex(rawHandle: Texture): GpuTexture {
    const device = this.gpuDevice as MipmapBlitDevice & RhiDevice;
    return new GpuTexture(device, rawHandle);
  }

  /**
   * Walk the three handle maps and destroy every GpuResource, then clear
   * the maps. Called from `Renderer.dispose()` (M-5) as the first step of
   * the dispose chain (plan-strategy D-2: dispose chain walks
   * `gpuStore.destroyAll()` → `graph.drain()` → `instanceBuffers.clear()`
   * → ...).
   *
   * Idempotent: a second call after the maps were cleared is a no-op
   * (architecture-principles §6 idempotency). Each `.destroy()` call
   * routes through the RHI shim's per-handle bookkeeping, so a stray
   * second-destroy on a handle the runtime did not flip to destroyed
   * surfaces as the structured `'destroy-after-destroy'` error from the
   * RHI shim; that error is *not* re-thrown here -- destroyAll is a
   * sweep that tolerates per-handle failures so the dispose chain can
   * make progress (plan-strategy D-3 / D-8).
   */
  destroyAll(): void {
    // The cubemap path registers two entries (sourceId + cubeId) sharing one
    // GpuTexture wrapper, so destroyAll must dedupe on the wrapper identity
    // before forwarding `.destroy()` -- otherwise the second call surfaces
    // `'destroy-after-destroy'` from the RHI shim. The `isDestroyed` getter
    // on the wrapper is the dedupe gate (architecture-principles §6).
    const destroyTex = (gpuTex: GpuTexture): void => {
      if (!gpuTex.isDestroyed) gpuTex.destroy();
    };
    const destroyBuf = (gpuBuf: GpuBuffer): void => {
      if (!gpuBuf.isDestroyed) gpuBuf.destroy();
    };

    for (const entry of this.textureGpuHandles.values()) {
      destroyTex(entry.texture);
    }
    this.textureGpuHandles.clear();

    for (const entry of this.cubemapGpuHandles.values()) {
      if (entry.texture !== null) destroyTex(entry.texture);
    }
    this.cubemapGpuHandles.clear();
    this.cubemapIdempotentMap.clear();

    for (const entry of this.meshGpuHandles.values()) {
      destroyBuf(entry.vertexBuffer);
      if (entry.indexBuffer !== null) destroyBuf(entry.indexBuffer);
    }
    this.meshGpuHandles.clear();
  }

  /**
   * Set the error registry channel (wired by createRenderer). evict /
   * releaseUnreferenced fire structured errors here instead of throwing -
   * sweeps continue past individual failures (feat-20260619 D-1/D-6).
   */
  setErrorRegistry(registry: RhiErrorListenerRegistry): void {
    this.errorRegistry = registry;
  }

  /**
   * evictTexture / evictMesh / evictCubemap — per-handle evict primitives.
   *
   * Reuses destroyAll's isDestroyed dedup logic + cubemap wrapper
   * shared-dedup (feat-20260619 D-1). Returns {freed, errors} so callers
   * can consume the aggregate result (D-3). Key not present -> no-op
   * returning {freed:0, errors:[]}.
   */
  evictTexture(handle: Handle<'TextureAsset', 'shared'>): { freed: number; errors: RhiError[] } {
    const id = handleSlot(handle);
    const entry = this.textureGpuHandles.get(id);
    if (entry === undefined) return { freed: 0, errors: [] };

    let freed = 0;
    const errors: RhiError[] = [];

    if (!entry.texture.isDestroyed) {
      const r = entry.texture.destroy();
      if (r.ok) {
        freed = 1;
      } else {
        errors.push(r.error);
        if (this.errorRegistry) this.errorRegistry.fire(r.error);
      }
    }

    this.textureGpuHandles.delete(id);
    return { freed, errors };
  }

  evictMesh(handle: Handle<'MeshAsset', 'shared'>): { freed: number; errors: RhiError[] } {
    const id = handleSlot(handle);
    const entry = this.meshGpuHandles.get(id);
    if (entry === undefined) return { freed: 0, errors: [] };

    let freed = 0;
    const errors: RhiError[] = [];

    const destroyBuf = (gpuBuf: GpuBuffer): void => {
      if (!gpuBuf.isDestroyed) {
        const r = gpuBuf.destroy();
        if (r.ok) {
          freed += 1;
        } else {
          errors.push(r.error);
          if (this.errorRegistry) this.errorRegistry.fire(r.error);
        }
      }
    };

    destroyBuf(entry.vertexBuffer);
    if (entry.indexBuffer !== null) destroyBuf(entry.indexBuffer);

    this.meshGpuHandles.delete(id);
    return { freed: freed > 0 ? 1 : 0, errors };
  }

  evictCubemap(id: number): { freed: number; errors: RhiError[] } {
    const entry = this.cubemapGpuHandles.get(id);
    if (entry === undefined) return { freed: 0, errors: [] };

    let freed = 0;
    const errors: RhiError[] = [];

    // cubemap wrapper shared-dedup (D-1): sourceId and cubeId may share one
    // GpuTexture wrapper. The isDestroyed gate ensures the underlying RHI
    // texture is destroyed at most once, even when both entries are evicted.
    // A 'failed' entry holds no GPU texture (texture:null) — nothing to free.
    if (entry.texture !== null && !entry.texture.isDestroyed) {
      const r = entry.texture.destroy();
      if (r.ok) {
        freed = 1;
      } else {
        errors.push(r.error);
        if (this.errorRegistry) this.errorRegistry.fire(r.error);
      }
    }

    this.cubemapGpuHandles.delete(id);
    return { freed, errors };
  }

  /**
   * releaseUnreferenced — iterate the three handle maps and evict entries
   * whose key is NOT in `liveSet`.
   *
   * Iterates Map keys (not liveSet — store has no reverse index, D-8).
   * IDs in liveSet that don't exist in the store are naturally ignored.
   * Empty liveSet -> full release; second call -> no-op (maps empty,
   * evict primitives are key-not-present no-op).
   */
  releaseUnreferenced(liveSet: Set<number>): { freed: number; errors: RhiError[] } {
    let freed = 0;
    const errors: RhiError[] = [];

    for (const key of this.textureGpuHandles.keys()) {
      if (!liveSet.has(key)) {
        const entry = this.textureGpuHandles.get(key);
        if (entry !== undefined) {
          if (!entry.texture.isDestroyed) {
            const r = entry.texture.destroy();
            if (r.ok) {
              freed += 1;
            } else {
              errors.push(r.error);
              if (this.errorRegistry) this.errorRegistry.fire(r.error);
            }
          }
          this.textureGpuHandles.delete(key);
        }
      }
    }

    for (const key of this.cubemapGpuHandles.keys()) {
      if (!liveSet.has(key)) {
        const entry = this.cubemapGpuHandles.get(key);
        if (entry !== undefined) {
          // A 'failed' entry holds no GPU texture (texture:null) — nothing to free.
          if (entry.texture !== null && !entry.texture.isDestroyed) {
            const r = entry.texture.destroy();
            if (r.ok) {
              freed += 1;
            } else {
              errors.push(r.error);
              if (this.errorRegistry) this.errorRegistry.fire(r.error);
            }
          }
          this.cubemapGpuHandles.delete(key);
        }
      }
    }

    for (const key of this.meshGpuHandles.keys()) {
      if (!liveSet.has(key)) {
        const entry = this.meshGpuHandles.get(key);
        if (entry !== undefined) {
          if (!entry.vertexBuffer.isDestroyed) {
            const r = entry.vertexBuffer.destroy();
            if (r.ok) {
              freed += 1;
            } else {
              errors.push(r.error);
              if (this.errorRegistry) this.errorRegistry.fire(r.error);
            }
          }
          if (entry.indexBuffer !== null && !entry.indexBuffer.isDestroyed) {
            const r = entry.indexBuffer.destroy();
            if (r.ok) {
              freed += 1;
            } else {
              errors.push(r.error);
              if (this.errorRegistry) this.errorRegistry.fire(r.error);
            }
          }
          this.meshGpuHandles.delete(key);
        }
      }
    }

    return { freed, errors };
  }

  /**
   * Prewarm the mipmap pipeline cache for the given texture formats (D-9).
   * Called from `createRenderer.ready` (already async): builds the one-time
   * mipmap shader module + per-format render pipeline into the mipmap-generator
   * deviceCache so the per-texture mipmap blit at record-stage `ensureResident`
   * is pure synchronous encoder work. A format absent from this list will make
   * the sync `ensureResident` texture arm return a structured RhiError rather
   * than lazily await a build (which would break the sync draw contract).
   */
  async prewarmMipmapPipeline(
    device: MipmapBlitDevice,
    formats: readonly GPUTextureFormat[],
  ): Promise<Result<void, RhiError>> {
    const factory = this.asyncCreateShaderModule;
    if (factory === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'asyncCreateShaderModule wired by configureGpuDevice before prewarm',
          hint: 'call gpuStore.configureGpuDevice(device, packShaderFactory, registerCube) before prewarmMipmapPipeline',
        }),
      );
    }
    for (const format of formats) {
      const res = await getOrCreateMipmapPipeline(device, format, factory);
      if (!res.ok) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: `mipmap pipeline for format ${format} builds during prewarm`,
            hint: `prewarmMipmapPipeline failed building the mipmap pipeline for ${format}; the format may be unsupported by the device`,
          }),
        );
      }
    }
    return ok(undefined);
  }

  /**
   * Return the GpuTexture wrapper for a `Handle<TextureAsset>` if it has been
   * made resident, else `undefined`.
   *
   * @internal — test-only seam for cow-survivor / AC-02 integration tests; not
   * part of the engine's public API surface.
   */
  _getTextureGpuTexture(handle: Handle<'TextureAsset', 'shared'>): GpuTexture | undefined {
    return this.textureGpuHandles.get(handleSlot(handle))?.texture;
  }

  /**
   * Return the GPU texture-view for a `Handle<TextureAsset>` if it has been
   * made resident, else `undefined`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture-view return
  getTextureGpuView(handle: Handle<'TextureAsset', 'shared'>): any | undefined {
    return this.textureGpuHandles.get(handleSlot(handle))?.view;
  }

  /**
   * Return the GpuTexture wrapper for the cubemap, or `undefined` if not
   * uploaded yet. Consumers that need the raw RHI Texture handle (e.g.
   * `device.createTextureView` arguments) read `.handle` on the wrapper;
   * `.destroy()` routes through the destroy chain (M-3 / w11).
   */
  getCubemapGpuTexture(handle: Handle<'EquirectAsset', 'shared'>): GpuTexture | undefined {
    // A 'failed' entry has texture:null; normalise to undefined (not resident).
    return this.cubemapGpuHandles.get(handleSlot(handle))?.texture ?? undefined;
  }

  /** Return the full-cube texture view, or `undefined` if not uploaded yet. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture view
  getCubemapGpuView(handle: Handle<'EquirectAsset', 'shared'>): any | undefined {
    return this.cubemapGpuHandles.get(handleSlot(handle))?.view;
  }

  /** Return per-face 2D views (6 faces), or `undefined` if not uploaded yet. */
  // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture views
  getCubemapFaceViews(handle: Handle<'EquirectAsset', 'shared'>): readonly any[] | undefined {
    return this.cubemapGpuHandles.get(handleSlot(handle))?.faceViews;
  }

  /**
   * Query the projection status for an equirect source handle (D-3 SSOT: the
   * store's CubemapGpuEntry is the single authority). Returns `undefined` when
   * no projection has been launched for this source yet (the record arm reads
   * this to decide whether to fire the lazy projection; feat-20260630 M3 / w18):
   *   - undefined -> no entry: caller may launch projection (fire-and-forget)
   *   - 'pending' -> projection launched, not complete: bind white-cube fallback
   *   - 'ready'   -> projected cube + IBL views live: bind real IBL
   *   - 'failed'  -> projection errored: bind white fallback, do NOT retry (R-2)
   */
  getCubemapStatus(
    handle: Handle<'EquirectAsset', 'shared'>,
  ): 'pending' | 'ready' | 'failed' | undefined {
    return this.cubemapGpuHandles.get(handleSlot(handle))?.status;
  }

  /**
   * Return the GPU vertex / index buffer handles + index count for a
   * `Handle<MeshAsset>` if resident, else `undefined`. Consumers treat this
   * as the canonical "mesh asset has GPU residency" probe.
   */
  getMeshGpuHandles(handle: Handle<'MeshAsset', 'shared'>): MeshGpuEntry | undefined {
    return this.meshGpuHandles.get(handleSlot(handle));
  }

  /**
   * Pull-model residency: build the GPU resource for `handle` from the
   * caller-provided POD on a miss, return the cached handles on a hit (D-2).
   *
   * - mesh POD -> synchronous vertex / index buffer upload (mirrors the
   *   pre-extraction `uploadMeshById`).
   * - texture POD -> synchronous texture upload + mipmap blit (D-9). The
   *   mipmap pipeline MUST have been prewarmed via `prewarmMipmapPipeline`;
   *   an un-prewarmed format returns a structured RhiError (never awaits).
   *
   * Cubemap is NOT routed here -- it is an eager user call
   * (`_uploadCubemapFromEquirect`). Builtin meshes are NOT routed here either
   * (createRenderer step-3 owns them; D-1).
   */
  ensureResident(
    handle: Handle<'MeshAsset', 'shared'> | Handle<'TextureAsset', 'shared'>,
    pod: TypesMeshAsset | TextureAsset,
    // biome-ignore lint/suspicious/noExplicitAny: opaque GPU handle entry union
  ): Result<any, RhiError | AssetError | ImageError> {
    const id = handleSlot(handle);
    // Hit: O(1) cache lookup, never re-projects (AC-09 -- deriveRenderData*
    // runs only on a miss). The miss arms below dispatch on `pod.kind` with NO
    // default: only the two GPU-resource kinds reachable here (mesh / texture)
    // have arms, so a third reachable kind would surface as a `tsc -b`
    // exhaustiveness error at the switch rather than a silent fallthrough
    // (AC-06; the cube-texture kind is the eager `_uploadCubemapFromEquirect`
    // path, not routed here).
    switch (pod.kind) {
      case 'mesh': {
        const existing = this.meshGpuHandles.get(id);
        if (existing !== undefined) return ok(existing);
        const projected = deriveRenderDataMesh(pod);
        if (!projected.ok) return projected;
        return this.uploadMeshById(id, pod, projected.value);
      }
      case 'texture': {
        const existing = this.textureGpuHandles.get(id);
        if (existing !== undefined) return ok(existing);
        const projected = deriveRenderDataTexture(pod);
        if (!projected.ok) return projected;
        // Synthesize the DecodedImage shape the upload prelude consumes from
        // the TextureAsset POD: `data` carries the pixel bytes.
        const decoded: DecodedImage = decodedFromTexture(pod);
        return this.uploadTextureSync(
          handle as Handle<'TextureAsset', 'shared'>,
          pod,
          decoded,
          projected.value,
        );
      }
    }
  }

  /**
   * Eager public surface: upload decoded image bytes into a GPU texture and
   * cache (texture + view) under the handle. The TextureAsset POD supplies the
   * GPU format (D-2: caller provides POD, store never reaches a registry); the
   * DecodedImage supplies the pixel bytes + colorSpace. Retains the async
   * signature so callers that have not prewarmed can drive a mipmap build here
   * (the one async source).
   */
  async uploadTexture(
    handle: Handle<'TextureAsset', 'shared'>,
    pod: TextureAsset,
    decoded: DecodedImage,
  ): Promise<Result<void, AssetError | ImageError | RhiError>> {
    const device = this.gpuDevice;
    const projected = deriveRenderDataTexture(pod);
    if (!projected.ok) return projected;
    const prepared = this.prepareTextureUpload(handle, pod, decoded, projected.value);
    if (!prepared.ok) return prepared;
    if (device === undefined) return ok(undefined);
    const { id, tex, levels, gpuTexture } = prepared.value;
    if (gpuTexture === undefined) return ok(undefined);

    // feat-20260707 M5 / w36: compressed textures already have every mip level
    // uploaded from `data` (prepareTextureUpload); the runtime blit path is
    // uncompressed-only (compressed formats are not render targets, and the w35
    // mip gate already blocked runtime mip-gen for them).
    if (!projected.value.compressed && decoded.mipmap === true && levels > 1) {
      const factory = this.asyncCreateShaderModule;
      if (factory === undefined) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'asyncCreateShaderModule wired by configureGpuDevice',
            hint: 'GpuResourceStore.uploadTexture mipmap branch needs a shader-module factory; rhi-webgpu / rhi-wgpu shims expose it via pack.createShaderModule. Explicit-rhi instances must surface the factory on the RhiInstance.',
          }),
        );
      }
      const pipelineRes = await getOrCreateMipmapPipeline(device, tex.format, factory);
      if (!pipelineRes.ok) {
        return err(
          new RhiError({
            code: 'rhi-not-available',
            expected: `mipmap pipeline for format ${tex.format} builds`,
            hint: 'GpuResourceStore.uploadTexture could not build the mipmap pipeline',
          }),
        );
      }
      const blitRes = blitMipmapsSync(device, gpuTexture, {
        format: tex.format,
        width: tex.width,
        height: tex.height,
        levels,
      });
      if (!blitRes.ok) return blitRes as Result<void, RhiError>;
    }

    const viewRes = device.createTextureView(gpuTexture, {
      label: `texture-view-${id}`,
      dimension: '2d',
    });
    if (!viewRes.ok) return viewRes;
    this.textureGpuHandles.set(id, { texture: this.wrapTex(gpuTexture), view: viewRes.value });
    return ok(undefined);
  }

  /**
   * Synchronous texture upload used by `ensureResident` (D-9). Identical to
   * `uploadTexture` except the mipmap pipeline is read from the prewarmed
   * cache via the synchronous `blitMipmapsSync` -- an un-prewarmed format
   * returns a structured RhiError instead of awaiting a build.
   */
  private uploadTextureSync(
    handle: Handle<'TextureAsset', 'shared'>,
    pod: TextureAsset,
    decoded: DecodedImage,
    renderData: TextureRenderData,
  ): Result<TextureGpuEntry, AssetError | ImageError | RhiError> {
    const device = this.gpuDevice;
    const prepared = this.prepareTextureUpload(handle, pod, decoded, renderData);
    if (!prepared.ok) return prepared;
    if (device === undefined || prepared.value.gpuTexture === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'GpuResourceStore.configureGpuDevice wired before ensureResident',
          hint: 'a texture ensureResident ran before the GPU device was wired; call gpuStore.configureGpuDevice in createRenderer',
        }),
      );
    }
    const { id, tex, levels, gpuTexture } = prepared.value;

    // feat-20260707 M5 / w36: compressed mips are pre-uploaded from `data`; the
    // blit path is uncompressed-only (see uploadTexture note).
    if (!renderData.compressed && decoded.mipmap === true && levels > 1) {
      const blitRes = blitMipmapsSync(device, gpuTexture, {
        format: tex.format,
        width: tex.width,
        height: tex.height,
        levels,
      });
      if (!blitRes.ok) return blitRes as Result<TextureGpuEntry, RhiError>;
    }

    const viewRes = device.createTextureView(gpuTexture, {
      label: `texture-view-${id}`,
      dimension: '2d',
    });
    if (!viewRes.ok) return viewRes;
    const entry: TextureGpuEntry = { texture: this.wrapTex(gpuTexture), view: viewRes.value };
    this.textureGpuHandles.set(id, entry);
    return ok(entry);
  }

  /**
   * Shared texture-upload prelude: format / colorSpace consistency assertion,
   * GPU texture allocation + writeTexture. Returns `gpuTexture: undefined`
   * (with ok) when no device is wired (deferred path).
   */
  private prepareTextureUpload(
    handle: Handle<'TextureAsset', 'shared'>,
    pod: TextureAsset,
    decoded: DecodedImage,
    renderData: TextureRenderData,
  ): Result<
    // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture handle
    { id: number; tex: TextureAsset; levels: number; gpuTexture: any | undefined },
    AssetError | ImageError | RhiError
  > {
    const id = handleSlot(handle);
    // The store does not hold the registry (D-2); the caller-provided POD is
    // the GPU-format SSOT and `renderData` is its projection (format / usage /
    // mipLevelCount). `decoded` supplies the pixel bytes + colorSpace; the
    // assertion below guards the actual upload-source colorSpace against the
    // projected format (the projection already checked the POD's own colorSpace).
    const tex = pod;
    const levels = renderData.mipLevelCount;

    const formatExpected: 'srgb' | 'linear' = renderData.format.endsWith('-srgb')
      ? 'srgb'
      : 'linear';
    if (decoded.colorSpace !== formatExpected) {
      const detail: ImageErrorDetail = {
        code: 'image-format-unsupported',
        actualMime: decoded.mime,
        formatColorSpaceConflict: {
          format: renderData.format,
          colorSpace: decoded.colorSpace,
          expected: formatExpected,
        },
      };
      return err(makeImageError(detail));
    }

    const device = this.gpuDevice;
    if (device === undefined) {
      return ok({ id, tex, levels, gpuTexture: undefined });
    }

    // WebGL2/wgpu exposes texture limits that are lower than many source
    // images (for example the 2085px LearnOpenGL Mars texture). Reject the
    // upload before allocating a handle; binding a texture that the backend
    // accepted syntactically but cannot use later surfaces only as a generic
    // invalid-bind-group submit error.
    const maxDimension =
      (device as unknown as { readonly limits?: { readonly maxTextureDimension2D?: number } })
        .limits?.maxTextureDimension2D ?? 16_384;
    if (tex.width > maxDimension || tex.height > maxDimension) {
      return err(
        makeImageError({
          code: 'image-dimension-out-of-bounds',
          requested: { width: tex.width, height: tex.height },
          limit: maxDimension,
        }),
      );
    }

    const createTexRes = device.createTexture({
      label: `texture-${id}`,
      size: {
        width: renderData.physicalExtent.width,
        height: renderData.physicalExtent.height,
        depthOrArrayLayers: 1,
      },
      mipLevelCount: levels,
      sampleCount: 1,
      dimension: '2d',
      format: renderData.format,
      usage: renderData.usage,
      viewFormats: [],
    });
    if (!createTexRes.ok) return createTexRes;
    const gpuTexture = createTexRes.value;
    const queue = (device as unknown as MipmapBlitDeviceWithWriteTexture).queue;

    if (renderData.compressed) {
      // feat-20260707 M5 / w36 (AC-08): block-compressed textures carry their
      // mip chain in `data` (offline-baked -- the GPU cannot generate compressed
      // mips). Upload each level with its own block-padded bytesPerRow /
      // rowsPerImage and mip-major byte offset (deriveMipUploadLayout, SSOT
      // block math). Full-subresource copies retain their logical size, including
      // non-block-aligned dimensions. queue.writeTexture avoids the 256 B
      // copyBufferToTexture alignment trap.
      const layout = deriveMipUploadLayout(renderData.format, tex.width, tex.height, levels);
      for (const lvl of layout) {
        const slice = decoded.bytes.subarray(lvl.byteOffset, lvl.byteOffset + lvl.byteLength);
        const writeRes = queue.writeTexture(
          { texture: gpuTexture, mipLevel: lvl.level, origin: { x: 0, y: 0, z: 0 } },
          slice,
          { offset: 0, bytesPerRow: lvl.bytesPerRow, rowsPerImage: lvl.rowsPerImage },
          { width: lvl.copyWidth, height: lvl.copyHeight, depthOrArrayLayers: 1 },
        );
        if (!writeRes.ok) return writeRes;
      }
      return ok({ id, tex, levels, gpuTexture });
    }

    // Uncompressed base-mip write; higher mips (when mipmap) are GPU-generated by
    // the caller's blit pass. rowsPerImage is the pixel height for linear RGBA.
    const bytesPerRow = renderData.bytesPerRow;
    const writeTextureRes = queue.writeTexture(
      { texture: gpuTexture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      decoded.bytes,
      { offset: 0, bytesPerRow, rowsPerImage: tex.height },
      { width: tex.width, height: tex.height, depthOrArrayLayers: 1 },
    );
    if (!writeTextureRes.ok) return writeTextureRes;

    return ok({ id, tex, levels, gpuTexture });
  }

  /**
   * Project an equirectangular HDR `EquirectAsset` into a GPU cubemap + IBL
   * precompute. NOT part of the `ensureResident` pull path.
   *
   * @internal — feat-20260630 D-3 / F-9: the cubemap projection is engine
   * internals, not a user surface. AI users declare `Skylight{equirect}` and
   * the render-system record arm (same package) drives this method per-frame;
   * the `_` prefix + `@internal` mark it package-internal (lint:internal gate)
   * so it never appears as a user-facing call. (A cross-file `private` is not
   * reachable by the record arm; package-internal is the correct visibility.)
   *
   * Idempotent: a second call with the same source handle returns the cached
   * cubemap handle (no second GPU texture). The minted cubemap handle is an
   * `EquirectAsset` shared ref catalogued via the injected `registerCube` relay
   * (D-3); the store never imports AssetRegistry.
   *
   * Status (D-3): every entry written carries `status`. A failed projection
   * records `status:'failed'` EXPLICITLY (R-2 / AC-09) so the caller never
   * retries by inferring "no entry => try again".
   */
  async _uploadCubemapFromEquirect(
    world: World,
    sourceHandle: Handle<'EquirectAsset', 'shared'>,
    sourcePod: EquirectAsset,
  ): Promise<Result<Handle<'EquirectAsset', 'shared'>, AssetError | RhiError>> {
    const sourceId = handleSlot(sourceHandle);

    const existing = this.cubemapIdempotentMap.get(sourceId);
    if (existing !== undefined) {
      return ok(existing);
    }

    // R-2 / AC-09: a previously-failed projection is recorded EXPLICITLY as a
    // 'failed' entry. Short-circuit here so the record arm never retries the
    // upload every frame (the missing-key inference would loop forever).
    if (this.cubemapGpuHandles.get(sourceId)?.status === 'failed') {
      return err(
        new RhiError({
          code: 'feature-not-enabled',
          expected: 'a prior cubemap projection for this equirect source did not fail',
          hint: 'this equirect source already failed projection; the record arm must not retry (R-2). Inspect the original failure on the error channel',
        }),
      );
    }

    // feat-20260630 M3 / w18: a projection already in flight is marked
    // 'pending' synchronously below (before the first await). A re-entry while
    // pending short-circuits so the fire-and-forget record arm launches the
    // async projection exactly once per source (D-4 idempotent; the record arm
    // calls this every frame until status flips to ready/failed). The pending
    // entry holds no live GPU resources yet; the record arm binds the white
    // fallback while pending.
    if (this.cubemapGpuHandles.get(sourceId)?.status === 'pending') {
      return ok(sourceHandle);
    }

    // Record a failed projection explicitly so a re-query short-circuits and the
    // record arm never retries every frame (R-2 / AC-09). The placeholder
    // texture wrapper is never bound (a 'failed' entry has no live GPU view).
    const recordFailed = <E>(error: E): Result<never, E> => {
      this.cubemapGpuHandles.set(sourceId, {
        status: 'failed',
        texture: null,
        view: undefined,
        faceViews: [],
      });
      return err(error);
    };

    const registerCube = this.registerCube;
    if (registerCube === undefined) {
      return recordFailed(
        makeAssetError({
          code: 'asset-not-found',
          expected: 'GpuResourceStore.configureGpuDevice wired with registerCube',
          hint: 'call gpuStore.configureGpuDevice(device, factory, registerCube) before _uploadCubemapFromEquirect',
        }),
      );
    }

    if (sourcePod.kind !== 'equirect') {
      return recordFailed(
        makeAssetError({
          code: 'asset-not-found',
          expected: `source POD for handle id ${sourceId} is an EquirectAsset`,
          hint: ASSET_ERROR_HINTS['asset-not-found'],
        }),
      );
    }

    // feat-20260630 M3 / w18: mark the source 'pending' SYNCHRONOUSLY (this runs
    // before the first `await` below, so the fire-and-forget record arm that
    // never awaits still observes the pending entry on the next frame's
    // getCubemapStatus). All sync fail-fast gates (idempotent / failed / pending
    // / registerCube / caps / kind) have passed, so the projection is committed;
    // a re-entry while async work is in flight short-circuits on the 'pending'
    // guard above. The entry holds no live GPU resources yet (record binds the
    // white fallback while pending); the texture/views are filled in below when
    // the projection completes (status flips to 'ready'), or replaced by a
    // 'failed' entry via recordFailed if any later step errors.
    this.cubemapGpuHandles.set(sourceId, {
      status: 'pending',
      texture: null,
      view: undefined,
      faceViews: [],
    });

    // The cubemap projection + IBL precompute consume a 2D-image view of the
    // source. EquirectAsset mirrors the TextureAsset 2D surface (width / height
    // / format / data / colorSpace) but has no CPU mip chain, so the derived
    // texture view declares `mipmap:false` (the IBL prefilter mip chain is a
    // GPU-side pass, not a CPU-authored level set).
    const sourceTex: TextureAsset = {
      kind: 'texture',
      width: sourcePod.width,
      height: sourcePod.height,
      format: sourcePod.format,
      data: sourcePod.data,
      colorSpace: sourcePod.colorSpace,
      mipmap: false,
    };

    // Project the equirect source POD into the cubemap descriptor (D-5): the
    // asset-semantic decisions (format / colorSpace validation, square cube
    // face size, rgba32f->rgba16f narrowing) live in the pure projection; the
    // resource build (texture / views / IBL precompute) + the byte conversion
    // stay here in the store.
    const projected: CubeRenderData | undefined = (() => {
      const p = deriveRenderDataCubemap(sourceTex);
      return p.ok ? p.value : undefined;
    })();
    if (projected === undefined) {
      return recordFailed(
        makeAssetError({
          code: 'invalid-source-format',
          expected: "format 'rgba16float' or 'rgba32float' with colorSpace 'linear'",
          hint: ASSET_ERROR_HINTS['invalid-source-format'],
        }),
      );
    }

    const tex: TextureAsset = projected.needsHalfConversion
      ? {
          kind: 'texture',
          width: sourceTex.width,
          height: sourceTex.height,
          format: projected.outputFormat,
          data: halfFloat.f32ToF16Bytes(
            sourceTex.data instanceof Uint8ClampedArray
              ? new Uint8Array(
                  sourceTex.data.buffer,
                  sourceTex.data.byteOffset,
                  sourceTex.data.byteLength,
                )
              : sourceTex.data,
          ),
          colorSpace: 'linear',
          mipmap: false,
        }
      : sourceTex;

    const cubeFaceSize = projected.cubeFaceSize;
    // The source equirect stays float for filtering, but WebGL2 cannot render
    // rgba16float attachments. Downlevel only the precompute outputs to the
    // universally renderable rgba8 path; the same format is threaded through
    // the cubemap and all three IBL side textures by IblPipelineCache.
    const outputFormat = this.caps?.rgba16floatRenderable === false ? 'rgba8unorm' : tex.format;

    // Lazy projection runs from the record arm, where the device is always
    // wired (research R-5). The device-not-wired queue + placeholder cube path
    // is removed (D-7); a missing device here is a fail-fast, not a queue.
    const device = this.gpuDevice;
    if (device === undefined) {
      return recordFailed(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'GpuResourceStore.configureGpuDevice wired before cubemap projection',
          hint: 'a cubemap projection ran before the GPU device was wired; the record arm projects only after the device is configured',
        }),
      );
    }

    // Usage flags for the small equirect helper texture (sampled source for the
    // IBL precompute pass); the cube texture's usage comes from the projection.
    const TEXTURE_BINDING = 0x4;
    const COPY_DST = 0x2;

    // biome-ignore lint/suspicious/noExplicitAny: union of shim/raw return shapes
    const unwrap = (r: any): any => {
      if (r === null || r === undefined) return undefined;
      if (typeof r === 'object' && 'ok' in r) return r.ok ? r.value : undefined;
      return r;
    };
    // biome-ignore lint/suspicious/noExplicitAny: shim/raw device split
    const makeTextureView = (dev: any, texture: any, desc: any): any => {
      if (typeof dev.createTextureView === 'function') {
        const u = unwrap(dev.createTextureView(texture, desc));
        if (u !== undefined) return u;
      }
      if (texture !== null && texture !== undefined && typeof texture.createView === 'function') {
        try {
          return texture.createView(desc);
        } catch {
          return undefined;
        }
      }
      return undefined;
    };

    const gpuTextureRet = device.createTexture({
      label: `cubemap-${sourceId}`,
      size: { width: cubeFaceSize, height: cubeFaceSize, depthOrArrayLayers: 6 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: outputFormat,
      usage: projected.cubeUsage,
      viewFormats: [],
    });
    const gpuTexture = unwrap(gpuTextureRet);
    if (gpuTexture === undefined) {
      return recordFailed(
        makeAssetError({
          code: 'ibl-precompute-not-dispatched',
          expected: `device.createTexture cubemap-${sourceId} to return a valid texture`,
          hint: ASSET_ERROR_HINTS['ibl-precompute-not-dispatched'],
        }),
      );
    }

    const cubeView = makeTextureView(device, gpuTexture, {
      label: `cubemap-view-${sourceId}`,
      dimension: 'cube',
      arrayLayerCount: 6,
    });
    if (cubeView === undefined) {
      return recordFailed(
        makeAssetError({
          code: 'ibl-precompute-not-dispatched',
          expected: `device.createTextureView cubemap-view-${sourceId} to return a valid view`,
          hint: ASSET_ERROR_HINTS['ibl-precompute-not-dispatched'],
        }),
      );
    }

    // biome-ignore lint/suspicious/noExplicitAny: opaque GPU texture views
    const faceViews: any[] = [];
    for (let face = 0; face < 6; face++) {
      const fv = makeTextureView(device, gpuTexture, {
        label: `cubemap-face-${sourceId}-${face}`,
        dimension: '2d',
        baseArrayLayer: face,
        arrayLayerCount: 1,
      });
      if (fv === undefined) {
        return recordFailed(
          makeAssetError({
            code: 'ibl-precompute-not-dispatched',
            expected: `device.createTextureView cubemap-face-${sourceId}-${face} to return a valid view`,
            hint: ASSET_ERROR_HINTS['ibl-precompute-not-dispatched'],
          }),
        );
      }
      faceViews.push(fv);
    }

    // M-3 / w11: a single GpuTexture wrapper is shared between sourceId
    // and cubeId entries (the underlying RHI handle is the same physical
    // texture). destroyAll() walks each entry, so attempting to destroy
    // twice via two wrappers would surface 'destroy-after-destroy' on
    // the second pass; sharing one wrapper keeps the destroy chain
    // surfacing exactly one destroy call per physical resource.
    const gpuTextureWrapper = this.wrapTex(gpuTexture);

    this.cubemapGpuHandles.set(sourceId, {
      status: 'ready',
      texture: gpuTextureWrapper,
      view: cubeView,
      faceViews,
    });

    // The minted cubemap handle is a synthetic shared ref (identity token for
    // the GPU cube residency); its POD is an EquirectAsset placeholder matching
    // the projected dimensions/format (D-3: the retired cube-texture asset kind
    // is gone; the relay mints an EquirectAsset shared ref instead).
    const cubeAsset: EquirectAsset = {
      kind: 'equirect',
      width: cubeFaceSize,
      height: cubeFaceSize,
      format: tex.format,
      data: tex.data,
      colorSpace: 'linear',
    };
    const regResult = registerCube(world, cubeAsset);
    if (!regResult.ok) return recordFailed(regResult.error);
    const cubeHandle = regResult.value;
    const cubeId = handleSlot(cubeHandle);

    this.cubemapGpuHandles.set(cubeId, {
      status: 'ready',
      texture: gpuTextureWrapper,
      view: cubeView,
      faceViews,
    });

    this.cubemapIdempotentMap.set(sourceId, cubeHandle);

    if (this.asyncCreateShaderModule !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: device shim narrowed at runtime
      const ipDevice = device as any;
      const pipelinesRes = await createIblPipelines(
        ipDevice,
        // biome-ignore lint/suspicious/noExplicitAny: factory signatures are interoperable; device shim is structural
        this.asyncCreateShaderModule as any,
        outputFormat,
      );
      if (pipelinesRes.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: device shim
        const fdevice = device as any;
        const equirectGpuTexRet = fdevice.createTexture({
          label: `equirect-${sourceId}`,
          size: { width: tex.width, height: tex.height, depthOrArrayLayers: 1 },
          mipLevelCount: 1,
          sampleCount: 1,
          dimension: '2d',
          format: tex.format,
          usage: TEXTURE_BINDING | COPY_DST,
          viewFormats: [],
        });
        const equirectGpuTex = unwrap(equirectGpuTexRet);
        if (equirectGpuTex !== undefined && typeof fdevice.queue?.writeTexture === 'function') {
          const bytesPerPixel =
            tex.format === 'rgba32float' ? 16 : tex.format === 'rgba16float' ? 8 : 4;
          fdevice.queue.writeTexture(
            { texture: equirectGpuTex },
            tex.data,
            { bytesPerRow: tex.width * bytesPerPixel, rowsPerImage: tex.height },
            { width: tex.width, height: tex.height, depthOrArrayLayers: 1 },
          );
        }
        const equirectView =
          equirectGpuTex !== undefined
            ? makeTextureView(fdevice, equirectGpuTex, {
                label: `equirect-view-${sourceId}`,
                dimension: '2d',
              })
            : undefined;
        const faceBuf = unwrap(createFaceUniformsBuffer(ipDevice));
        const prefBuf = unwrap(createPrefilterUniformsBuffer(ipDevice));
        const cubeVertex = unwrap(
          fdevice.createBuffer({
            label: 'ibl-cube-verts',
            size: CUBEMAP_FACE_VERTICES.byteLength,
            usage: 0x20 | 0x08,
            mappedAtCreation: false,
          }),
        );
        if (
          equirectGpuTex !== undefined &&
          equirectView !== undefined &&
          faceBuf !== undefined &&
          prefBuf !== undefined &&
          cubeVertex !== undefined &&
          typeof fdevice.queue?.writeBuffer === 'function'
        ) {
          fdevice.queue.writeBuffer(cubeVertex, 0, CUBEMAP_FACE_VERTICES);
          writeAllFaceUniforms(ipDevice, faceBuf);
          writeAllPrefilterUniforms(ipDevice, prefBuf);
          const runRes = runIblPrecompute({
            device: ipDevice,
            equirectGpuTex,
            equirectView,
            cubeGpuTex: gpuTexture,
            cubeView,
            cubeFaceViews: faceViews,
            faceUniformsBuffer: faceBuf,
            prefilterUniformsBuffer: prefBuf,
            cubeVertexBuffer: cubeVertex,
          });
          if (!runRes.ok) {
            return recordFailed(
              makeAssetError({
                code: 'ibl-precompute-not-dispatched',
                expected: runRes.error.expected,
                hint: runRes.error.hint,
              }),
            );
          }
        }
      }
    }

    return ok(cubeHandle);
  }

  /**
   * Upload `MeshAsset.vertices` + `MeshAsset.indices` to GPU buffers and cache
   * the handles under the asset id. Synchronous; mirrors the pre-extraction
   * `uploadMeshById` byte-for-byte. Returns the cached entry on success.
   */
  private uploadMeshById(
    id: number,
    mesh: TypesMeshAsset,
    renderData: MeshRenderData,
  ): Result<MeshGpuEntry, RhiError> {
    const device = this.gpuDevice as MipmapBlitDeviceWithBuffer | undefined;
    if (device === undefined) {
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'GpuResourceStore.configureGpuDevice wired before mesh ensureResident',
          hint: 'a mesh ensureResident ran before the GPU device was wired; call gpuStore.configureGpuDevice in createRenderer',
        }),
      );
    }

    // biome-ignore lint/suspicious/noExplicitAny: union of shim/raw return shapes
    const unwrapBuffer = (r: any): any => {
      if (r === null || r === undefined) return undefined;
      if (typeof r === 'object' && 'ok' in r) return r.ok ? r.value : undefined;
      return r;
    };
    // biome-ignore lint/suspicious/noExplicitAny: union of shim/raw write return
    const writeOk = (r: any): boolean => {
      if (r === undefined) return true;
      if (typeof r === 'object' && 'ok' in r) return r.ok === true;
      return true;
    };

    const indices = mesh.indices;
    const indexBytesUnpadded = indices === undefined ? 0 : indices.byteLength;
    const indexBytes = renderData.indexByteLength;

    const vboRet = device.createBuffer({
      label: `mesh-${id}-vbo`,
      size: renderData.vertexByteLength,
      usage: renderData.vertexUsage,
      mappedAtCreation: false,
    });
    const vbo = unwrapBuffer(vboRet);
    if (vbo === undefined) {
      return err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: `device.createBuffer mesh-${id}-vbo to return a valid buffer`,
          hint: 'mesh vertex buffer allocation returned undefined',
        }),
      );
    }
    // Vertex-only mesh: skip the index buffer entirely. The indexed path below
    // is unchanged byte-for-byte when `indices` is present.
    let ibo: unknown = null;
    if (indices !== undefined) {
      const iboRet = device.createBuffer({
        label: `mesh-${id}-ibo`,
        size: indexBytes,
        usage: renderData.indexUsage,
        mappedAtCreation: false,
      });
      ibo = unwrapBuffer(iboRet);
      if (ibo === undefined) {
        return err(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: `device.createBuffer mesh-${id}-ibo to return a valid buffer`,
            hint: 'mesh index buffer allocation returned undefined',
          }),
        );
      }
    }

    const vboWriteRet = device.queue.writeBuffer(vbo, 0, mesh.vertices);
    if (!writeOk(vboWriteRet)) {
      return err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: `queue.writeBuffer mesh-${id}-vbo to succeed`,
          hint: 'mesh vertex buffer write failed',
        }),
      );
    }

    if (indices !== undefined) {
      const indexSrc = new Uint8Array(indexBytes);
      indexSrc.set(new Uint8Array(indices.buffer, indices.byteOffset, indexBytesUnpadded));
      const iboWriteRet = device.queue.writeBuffer(ibo, 0, indexSrc);
      if (!writeOk(iboWriteRet)) {
        return err(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: `queue.writeBuffer mesh-${id}-ibo to succeed`,
            hint: 'mesh index buffer write failed',
          }),
        );
      }
    }

    // feat-20260611: per-layout vertexCount divisor. '18F' (skinned glTF
    // path) carries 18 floats per vertex (12F + skinIndex(uint16x4 packed
    // as 2 floats) + skinWeight(float32x4)); '12F' is the legacy stride.
    // feat-20260629 multi-uv: extra UV sets add 2 floats each per vertex
    // in the interleaved buffer (canonical order). Count them from attributes.
    // Closed-union switch -- a third layout addition would surface as a
    // tsc exhaustiveness error here, mirroring the discriminator union.
    const baseFloatsPerVertex = renderData.layout === '18F' ? 18 : 12;
    const extraUvSets = countExtraUvSets(mesh.attributes);
    const floatsPerVertex = baseFloatsPerVertex + extraUvSets * 2;
    const entry: MeshGpuEntry = {
      vertexBuffer: this.wrapBuf(vbo as Buffer),
      indexBuffer: ibo === null ? null : this.wrapBuf(ibo as Buffer),
      vboBytes: renderData.vertexByteLength,
      iboBytes: indices === undefined ? 0 : indexBytes,
      indexCount: renderData.indexCount,
      indexFormat: renderData.indexFormat,
      layout: renderData.layout,
      uvSetCount: 1 + extraUvSets,
      vertexCount: mesh.vertices.length / floatsPerVertex,
      indexed: indices !== undefined,
      topology: renderData.submeshes[0]?.topology ?? 'triangle-list',
      submeshes: renderData.submeshes,
    };
    this.meshGpuHandles.set(id, entry);
    return ok(entry);
  }

  /**
   * Update an existing mesh's GPU buffer data in-place (or expand). The handle
   * must already be resident. Mirrors the pre-extraction `updateMeshById`.
   */
  private updateMeshById(id: number, newVertices: Float32Array, newIndices: Uint16Array): void {
    const device = this.gpuDevice as MipmapBlitDeviceWithBuffer | undefined;
    if (device === undefined) return;
    const entry = this.meshGpuHandles.get(id);
    if (entry === undefined) return;

    const GPU_BUFFER_USAGE_VERTEX = 0x20;
    const GPU_BUFFER_USAGE_INDEX = 0x10;
    const GPU_BUFFER_USAGE_COPY_DST = 0x08;

    // biome-ignore lint/suspicious/noExplicitAny: union of shim/raw return shapes
    const unwrapBuffer = (r: any): any => {
      if (r === null || r === undefined) return undefined;
      if (typeof r === 'object' && 'ok' in r) return r.ok ? r.value : undefined;
      return r;
    };
    // biome-ignore lint/suspicious/noExplicitAny: union of shim/raw write return
    const writeOk = (r: any): boolean => {
      if (r === undefined) return true;
      if (typeof r === 'object' && 'ok' in r) return r.ok === true;
      return true;
    };

    const newVertexBytes = newVertices.byteLength;
    const indexBytesUnpadded = newIndices.byteLength;
    const newIndexBytes = ((indexBytesUnpadded + 3) >> 2) << 2;

    // M-3 / w11: read allocation bytes from the entry's vboBytes / iboBytes
    // (tracked at upload time) instead of reaching into the opaque RHI Buffer
    // for a `.size` property -- the RHI Buffer interface is spec-aligned and
    // does NOT expose `.size`; the prior code was reading through `any`.
    const existingIbo = entry.indexBuffer;
    if (
      existingIbo !== null &&
      newVertexBytes <= entry.vboBytes &&
      newIndexBytes <= entry.iboBytes
    ) {
      const vboWriteRet = device.queue.writeBuffer(entry.vertexBuffer.handle, 0, newVertices);
      if (!writeOk(vboWriteRet)) return;

      const indexSrc = new Uint8Array(newIndexBytes);
      indexSrc.set(new Uint8Array(newIndices.buffer, newIndices.byteOffset, indexBytesUnpadded));
      const iboWriteRet = device.queue.writeBuffer(existingIbo.handle, 0, indexSrc);
      if (!writeOk(iboWriteRet)) return;

      this.meshGpuHandles.set(id, {
        vertexBuffer: entry.vertexBuffer,
        indexBuffer: existingIbo,
        vboBytes: entry.vboBytes,
        iboBytes: entry.iboBytes,
        indexCount: newIndices.length,
        indexFormat: 'uint16',
        layout: '12F',
        uvSetCount: entry.uvSetCount,
        vertexCount: newVertices.length / 12,
        indexed: true,
        topology: entry.topology,
        submeshes: entry.submeshes,
      });
      return;
    }

    const vboRet = device.createBuffer({
      label: `mesh-${id}-vbo`,
      size: newVertexBytes,
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    const vbo = unwrapBuffer(vboRet);
    if (vbo === undefined || vbo === null) return;
    const iboRet = device.createBuffer({
      label: `mesh-${id}-ibo`,
      size: newIndexBytes,
      usage: GPU_BUFFER_USAGE_INDEX | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    const ibo = unwrapBuffer(iboRet);
    if (ibo === undefined || ibo === null) return;

    const vboWriteRet = device.queue.writeBuffer(vbo, 0, newVertices);
    if (!writeOk(vboWriteRet)) return;

    const indexSrc = new Uint8Array(newIndexBytes);
    indexSrc.set(new Uint8Array(newIndices.buffer, newIndices.byteOffset, indexBytesUnpadded));
    const iboWriteRet = device.queue.writeBuffer(ibo, 0, indexSrc);
    if (!writeOk(iboWriteRet)) return;

    this.meshGpuHandles.set(id, {
      vertexBuffer: this.wrapBuf(vbo as Buffer),
      indexBuffer: this.wrapBuf(ibo as Buffer),
      vboBytes: newVertexBytes,
      iboBytes: newIndexBytes,
      indexCount: newIndices.length,
      indexFormat: 'uint16',
      layout: '12F',
      uvSetCount: entry.uvSetCount,
      vertexCount: newVertices.length / 12,
      indexed: true,
      topology: entry.topology,
      submeshes: entry.submeshes,
    });

    // M-3 / w11: replace the legacy `(buf as any).destroy()` sneak path with
    // a structured `GpuBuffer.destroy()` that routes through
    // `device.destroyBuffer(handle)` (RHI shim is the lifecycle SSOT;
    // architecture-principles §1 / charter §F1). Errors are swallowed here:
    // updateMeshById is the in-place reallocation path; the structured fail
    // surfaces on subsequent buffer use rather than blocking the resize.
    entry.vertexBuffer.destroy();
    if (existingIbo !== null) existingIbo.destroy();
  }

  /**
   * Public surface for updating an existing unmanaged mesh handle's GPU buffer
   * data in-place. The handle must have been made resident.
   */
  updateMesh(
    handle: Handle<'MeshAsset', 'shared'>,
    newVertices: Float32Array,
    newIndices: Uint16Array,
  ): void {
    const id = handleSlot(handle);
    this.updateMeshById(id, newVertices, newIndices);
  }
}

/**
 * Synthesize the `DecodedImage` view the texture-upload prelude consumes from
 * a `TextureAsset` POD (the record-stage pull path holds only the POD). The
 * POD's `data` is the pixel bytes; `colorSpace` + `mipmap` drive the
 * consistency assertion + mip count.
 */
function decodedFromTexture(tex: TextureAsset): DecodedImage {
  const bytes =
    tex.data instanceof Uint8ClampedArray
      ? new Uint8Array(tex.data.buffer, tex.data.byteOffset, tex.data.byteLength)
      : tex.data;
  return {
    bytes,
    width: tex.width,
    height: tex.height,
    mime: 'image/png',
    colorSpace: tex.colorSpace,
    mipmap: tex.mipmap,
  };
}
