// @forgeax/engine-runtime — DynamicTextureStore: transient per-frame GPU
// textures for video sources (feat-20260623-world-space-video-asset M4 / w15).
//
// D-3: video frames are re-uploaded every frame — the opposite of the static
// "upload once / cache forever" semantics GpuResourceStore.ensureResident
// implements. Routing video through ensureResident would either poison its
// permanent cache (AC-08) or crash it (its `switch (pod.kind)` has no `video`
// arm). So video gets its OWN store with a transient lifecycle, exactly the way
// cube-texture upload is an eager independent path that never enters the
// ensureResident switch (research Finding 7 precedent).
//
// This store does NOT import GpuResourceStore and accepts NO static texture
// handle — it is keyed solely by the VideoAsset clip handle. Each key owns a
// single GPUTexture sized to the source video; the texture is recreated only
// when the source dimensions change (a steady-size clip allocates once and is
// re-written in place every frame via copyExternalImageToTexture). The view is
// re-fetched after each upload so the bind group always samples the latest
// frame.
//
// Charter P3: every failure returns a structured Result (never throws for an
// expected GPU failure); the per-frame caller (record stage videoTextureView)
// fires the RhiError on the engine error channel and falls back to the default
// view for that frame.

import type { Result, RhiError, Texture, TextureView } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import type { Handle } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';

/**
 * The host-owned external image the engine copies a video frame from
 * (HTMLVideoElement / VideoFrame / ImageBitmap / canvas). Mirrors the `source`
 * member of the WebGPU `GPUCopyExternalImageSourceInfo` the RHI
 * `copyExternalImageToTexture` consumes; aliased here so the store does not pull
 * the whole webgpu descriptor type into its surface.
 */
export type CopyExternalImageSource = GPUCopyExternalImageSourceInfo['source'];

/**
 * GPUTextureUsage bits a video destination texture needs: COPY_DST (the
 * copyExternalImageToTexture write target), TEXTURE_BINDING (sampled in the
 * material bind group), and RENDER_ATTACHMENT (required by the WebGPU spec for
 * a copyExternalImageToTexture destination). Mirrors the literals
 * gpu-resource-store.ts uses for its upload textures (no shared const exists to
 * import without coupling the two stores — D-3 keeps them independent).
 */
const VIDEO_TEXTURE_USAGE = 0x2 | 0x4 | 0x10;

/** rgba8unorm-srgb: a video frame decodes to sRGB; sampling returns linear. */
const VIDEO_TEXTURE_FORMAT = 'rgba8unorm-srgb' as const;

/**
 * The minimal RHI device surface DynamicTextureStore needs. Declared structurally
 * (not the full RhiDevice) so unit tests drive it with a small mock and the store
 * stays decoupled from the rest of the device surface (Pipeline Isolation).
 */
export interface DynamicTextureDevice {
  createTexture(desc: {
    readonly size: {
      readonly width: number;
      readonly height: number;
      readonly depthOrArrayLayers: number;
    };
    readonly format: typeof VIDEO_TEXTURE_FORMAT;
    readonly usage: number;
    readonly label?: string;
  }): Result<Texture, RhiError>;
  createTextureView(texture: Texture, desc: Record<string, never>): Result<TextureView, RhiError>;
  destroyTexture(texture: Texture): Result<void, RhiError>;
  readonly queue: {
    copyExternalImageToTexture(
      source: { readonly source: CopyExternalImageSource; readonly flipY?: boolean },
      destination: { readonly texture: Texture },
      copySize: {
        readonly width: number;
        readonly height: number;
        readonly depthOrArrayLayers: number;
      },
    ): Result<void, RhiError>;
  };
}

interface TransientEntry {
  texture: Texture;
  view: TextureView;
  width: number;
  height: number;
}

/**
 * Transient per-frame texture store for video sources. Independent of
 * GpuResourceStore: it neither imports nor reaches into the static residency
 * cache (AC-08 / D-3).
 */
export class DynamicTextureStore {
  private device: DynamicTextureDevice | undefined = undefined;
  private readonly entries = new Map<number, TransientEntry>();

  /**
   * Wire the GPU device the store uploads through. Called once after the
   * renderer captures its device (mirrors GpuResourceStore.configureGpuDevice).
   */
  configureGpuDevice(device: DynamicTextureDevice): void {
    this.device = device;
  }

  /**
   * Upload one video frame for `clip` from the host-owned source image
   * (HTMLVideoElement / VideoFrame / ImageBitmap), (re)allocating the transient
   * texture when its size changes, and return the current-frame view to bind.
   *
   * Returns `undefined` (not an error) when the device is not yet wired or the
   * source has no decodable dimensions yet (metadata pending) — the caller binds
   * the default view that frame. A structured RhiError surfaces only when a wired
   * device rejects the allocation or the copy (charter P3).
   */
  uploadFrame(
    clip: Handle<'VideoAsset', 'shared'>,
    source: CopyExternalImageSource,
    width: number,
    height: number,
  ): Result<TextureView, RhiError> | undefined {
    const device = this.device;
    if (device === undefined) return undefined;
    if (width <= 0 || height <= 0) return undefined;

    const id = unwrapHandle(clip);
    const ensured = this.ensureEntry(device, id, width, height);
    if (!ensured.ok) return ensured;
    const entry = ensured.value;

    const copyRes = device.queue.copyExternalImageToTexture(
      { source, flipY: true },
      { texture: entry.texture },
      { width, height, depthOrArrayLayers: 1 },
    );
    if (!copyRes.ok) return copyRes;
    return ok(entry.view);
  }

  /**
   * The current-frame view for a clip, if one has been uploaded this session,
   * else undefined. The record stage reads this when assembling the bind group
   * (a frame that has not uploaded yet falls back to the default view).
   */
  getView(clip: Handle<'VideoAsset', 'shared'>): TextureView | undefined {
    return this.entries.get(unwrapHandle(clip))?.view;
  }

  /** Destroy every transient texture + drop the map (renderer teardown). */
  destroyAll(): void {
    const device = this.device;
    for (const entry of this.entries.values()) {
      device?.destroyTexture(entry.texture);
    }
    this.entries.clear();
  }

  /**
   * Get the entry for `id`, (re)allocating its texture + view when absent or
   * when the source dimensions changed. A same-size re-upload reuses the
   * existing texture (allocate-once for a steady clip; the per-frame cost is the
   * copyExternalImageToTexture write, not a texture create).
   */
  private ensureEntry(
    device: DynamicTextureDevice,
    id: number,
    width: number,
    height: number,
  ): Result<TransientEntry, RhiError> {
    const existing = this.entries.get(id);
    if (existing !== undefined && existing.width === width && existing.height === height) {
      return ok(existing);
    }
    if (existing !== undefined) device.destroyTexture(existing.texture);

    const texRes = device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: VIDEO_TEXTURE_FORMAT,
      usage: VIDEO_TEXTURE_USAGE,
      label: `video-transient-${id}`,
    });
    if (!texRes.ok) return texRes;
    const viewRes = device.createTextureView(texRes.value, {});
    if (!viewRes.ok) {
      device.destroyTexture(texRes.value);
      return viewRes;
    }
    const entry: TransientEntry = { texture: texRes.value, view: viewRes.value, width, height };
    this.entries.set(id, entry);
    return ok(entry);
  }
}
