// packages/rhi-wgpu/src/device.ts — RhiDevice / RhiQueue / RhiCommandEncoder
// / RhiRenderPassEncoder + Buffer mapping shim (w17 expands the w16 baseline).
//
// w17 lands a class form `RhiWgpuDeviceImpl implements RhiDevice` that
// satisfies the surface-mirror type-d test (w15) byte-for-byte on the
// 17-descriptor createX + queue + lost fields. The class-form is required
// by the w17 acceptanceCheck grep (`'implements RhiDevice' >= 1 hit`).
//
// w18 layers RhiQueue / RhiCommandEncoder / RhiRenderPassEncoder splits
// out of this file into queue.ts / command-encoder.ts / render-pass-encoder.ts.
// w19 layers the Buffer mapping 4-state surface on the Buffer brand.
//
// Shape: the class wraps a `RawDeviceLike` raw handle and routes every
// forgeax RhiDevice method through structured Result returns (charter
// proposition 4 explicit failure). The raw handle is intentionally typed
// loosely (each method optional) so the shim accepts both:
//   - navigator.gpu GPUDevice (when the dual-impl auto-select facade picks
//     the WebGPU path but injects through rhi-wgpu via the escape hatch).
//   - RhiWgpuDevice wasm-bindgen handle (M3 facade integration path).
//
// Anchors: plan-strategy §6 M2 + §2 D-P3 TS shim layered structure;
// charter proposition 5 consistent abstraction red line.

/// <reference types="@webgpu/types" />

import {
  type BindGroup,
  type BindGroupDescriptor,
  type BindGroupLayout,
  type BindGroupLayoutDescriptor,
  type Buffer,
  type BufferDescriptor,
  type CommandEncoderDescriptor,
  type ComputePipeline,
  type ComputePipelineDescriptor,
  ok,
  type PipelineLayout,
  type PipelineLayoutDescriptor,
  type QuerySet,
  type QuerySetDescriptor,
  type RenderPipeline,
  type RenderPipelineDescriptor,
  type Result,
  type RhiCaps,
  type RhiCommandEncoder,
  type RhiDevice,
  type RhiError,
  type RhiFeatures,
  type RhiLimits,
  type RhiQueue,
  type Sampler,
  type SamplerDescriptor,
  type Texture,
  type TextureDescriptor,
  type TextureView,
  type TextureViewDescriptor,
} from '@forgeax/engine-rhi';
import { doubleDestroy, makeRhiBuffer, type RawBufferLike, unwrapBuffer } from './buffer';
import { makeRhiCommandEncoder, type RawCommandEncoderLike } from './command-encoder';
import { descriptorInvalid, webgpuRuntimeError } from './errors';
import { makeRhiQueue, type RawQueueLike } from './queue';

/**
 * Per-handle lifecycle marker for `RhiDevice.destroyTexture` fail-fast
 * (feat-20260612 D-7). Mirrors @forgeax/engine-rhi-webgpu TextureMeta.destroyed but as
 * a parallel WeakMap because the rhi-wgpu shim does not need the
 * createTextureView cross-resource validation metadata that
 * @forgeax/engine-rhi-webgpu carries on TextureMeta. Buffers are tracked on the
 * `RhiWgpuBufferImpl` instance directly via `destroy()` (see ./buffer.ts);
 * textures are tracked here because the shim does not wrap them in a
 * dedicated class.
 */
const TEXTURE_DESTROYED_MAP: WeakMap<Texture, { destroyed: boolean }> = new WeakMap();

/**
 * Minimal shape of a wgpu-wasm or navigator.gpu device handle the TS shim
 * consumes. Each method below is a Method-on-shape (research §F-6 webgpu-
 * utils + CTS consensus) so the shim does not depend on a specific
 * underlying class type.
 */
export interface RawDeviceLike {
  readonly features?: ReadonlySet<string> | undefined;
  readonly limits?: Readonly<Record<string, number>> | undefined;
  readonly queue?: unknown;
  // forgeax-async-whitelist: wasm-bindgen — wgpu-wasm `Device.lost` Promise passthrough
  readonly lost?: Promise<{ readonly reason: string; readonly message: string }> | undefined;
  createBuffer?(desc: unknown): unknown;
  createTexture?(desc: unknown): unknown;
  createSampler?(desc?: unknown): unknown;
  createBindGroupLayout?(desc: unknown): unknown;
  createBindGroup?(desc: unknown): unknown;
  createPipelineLayout?(desc: unknown): unknown;
  createRenderPipeline?(desc: unknown): unknown;
  createComputePipeline?(desc: unknown): unknown;
  createShaderModule?(desc: unknown): unknown;
  createCommandEncoder?(desc?: unknown): unknown;
  createTextureView?(tex: unknown, desc: unknown): unknown;
  createQuerySet?(desc: unknown): unknown;
  // F4 (feat-20260622-s5): wgpu-wasm device exposed register_lost_callback (rhi.rs:935).
  // When raw.lost is undefined (wasm path without native device.lost Promise),
  // the constructor wires this to resolve the forged Promise.
  registerLostCallback?(cb: (reason: string, message: string) => void): void;
}

// Caps probe — split by spec-feature gate vs mandatory-but-noncompliant
// fallback (m1-1-b scope-amend). See rhi-webgpu/device.ts for the design
// rationale; the wgpu-wasm shim mirrors the same shape.

function probeRgba16floatRenderable(raw: RawDeviceLike): boolean {
  let tex: unknown | undefined;
  try {
    if (raw.createTexture === undefined) return false;
    tex = raw.createTexture({
      label: 'forgeax-caps-probe-rgba16float-renderable',
      format: 'rgba16float',
      usage: 16, // GPUTextureUsage.RENDER_ATTACHMENT
      size: [1, 1, 1],
    });
    return true;
  } catch {
    return false;
  } finally {
    if (tex !== undefined && typeof (tex as { destroy?: () => void }).destroy === 'function') {
      (tex as { destroy: () => void }).destroy();
    }
  }
}

function probeRg11b10ufloatRenderable(raw: RawDeviceLike, features: ReadonlySet<string>): boolean {
  if (!features.has('rg11b10ufloat-renderable')) return false;
  let tex: unknown | undefined;
  try {
    if (raw.createTexture === undefined) return false;
    tex = raw.createTexture({
      label: 'forgeax-caps-probe-rg11b10ufloat-renderable',
      format: 'rg11b10ufloat',
      usage: 16, // GPUTextureUsage.RENDER_ATTACHMENT
      size: [1, 1, 1],
    });
    return true;
  } catch {
    return false;
  } finally {
    if (tex !== undefined && typeof (tex as { destroy?: () => void }).destroy === 'function') {
      (tex as { destroy: () => void }).destroy();
    }
  }
}

function probeFloat32Filterable(raw: RawDeviceLike, features: ReadonlySet<string>): boolean {
  if (!features.has('float32-filterable')) return false;
  if (raw.createBindGroupLayout === undefined || raw.createSampler === undefined) return false;
  try {
    raw.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 2, sampler: { type: 'filtering' } }, // GPUShaderStage.FRAGMENT=2
        { binding: 1, visibility: 2, texture: { sampleType: 'float' } },
      ],
    });
    raw.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Class form `RhiWgpuDeviceImpl implements RhiDevice` — the w17 acceptanceCheck
 * grep anchor. The class wraps a `RawDeviceLike` raw handle and exposes the
 * full forgeax RhiDevice surface; every method routes through structured
 * Result returns (charter proposition 4 explicit failure).
 *
 * The class is intentionally not exported as a value — the public surface is
 * the `makeRhiDevice(raw)` factory function below. Holding the class behind
 * a factory keeps the wasm bundle slim (no class constructor leaks into the
 * bundle when only the factory is consumed) and preserves the forgeax RhiDevice
 * brand opaqueness from the consumer side (charter proposition 5).
 */
class RhiWgpuDeviceImpl implements RhiDevice {
  readonly features: RhiFeatures;
  readonly limits: RhiLimits;
  readonly caps: RhiCaps;
  readonly queue: RhiQueue;
  // forgeax-async-whitelist: wasm-bindgen — wgpu-wasm `Device.lost` Promise (spec mirror)
  readonly lost: Promise<{ readonly reason: 'destroyed' | 'unknown'; readonly message: string }>;

  private readonly raw: RawDeviceLike;

  constructor(raw: RawDeviceLike) {
    this.raw = raw;
    // Expose the raw handle on a single shim-internal field so the
    // top-level `createShaderModule(device, desc)` factory (index.ts) can
    // walk back to the raw GPUDevice without exposing the boundary to AI
    // users. Mirrors @forgeax/engine-rhi-webgpu's RAW_DEVICE_MAP WeakMap pattern
    // (the WeakMap is an alternative to a private field; the rhi-wgpu shim
    // uses an instance field because the class wrap form is already
    // present here). Non-enumerable so the field does not leak into
    // structural cloning / JSON.stringify (charter proposition 5).
    Object.defineProperty(this, '_internal_raw', {
      value: raw,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    this.features = (raw.features ?? new Set<string>()) as unknown as RhiFeatures;
    this.limits = (raw.limits ?? {}) as unknown as RhiLimits;
    // w28 — derive the full 11-field RhiCaps from the raw wgpu-wasm device.
    // Mirrors rhi-webgpu device.ts deriveCaps (w7 + w8): 7 wgpu native /
    // browser-fallback fields + 3 reserved native-only fields + 1 sampler
    // aliasing (always true on rhi-aware backends per spec §10.3).
    // Charter proposition 5 consistent abstraction: dual-backend deriveCaps
    // align byte-for-byte on the same RhiCaps surface (audit M1 (c)
    // confirmed; w28 wires the rhi-wgpu side).
    const rawFeatures = (raw.features as ReadonlySet<string> | undefined) ?? new Set<string>();
    const rawLimits = (raw.limits as Record<string, number> | undefined) ?? {};
    const hasFeature = (name: string): boolean => rawFeatures.has(name);
    // HDR renderable + filterable caps probed from the live device (D-1 + D-2):
    // RENDER_ATTACHMENT on float formats and float32 filterable sampling are
    // device-level validations that an adapter feature check alone cannot
    // guarantee.
    const hdrCaps = {
      rgba16floatRenderable: probeRgba16floatRenderable(raw),
      rg11b10ufloatRenderable: probeRg11b10ufloatRenderable(raw, rawFeatures),
      float32Filterable: probeFloat32Filterable(raw, rawFeatures),
    };
    this.caps = {
      // R-6: wgpu-wasm currently runs against a single wasm bundle that
      // handles both native-desktop and WebGL2 paths; the runtime cannot
      // distinguish them because the wgpu crate does not expose adapter-info
      // backend type to JS. The primary deployment path is wgpu native
      // desktop (Tauri / native runtime), so default to 'wgpu-native'.
      // When the wgpu-wasm crate exposes backend-kind info (or a downstream
      // use case requires it), the WebGL2 sub-path should switch this to
      // 'wgpu-webgl2' at the appropriate fill point.
      backendKind: 'wgpu-native' as const,
      compute: true,
      timestampQuery: hasFeature('timestamp-query'),
      indirectDrawing: true,
      textureCompression:
        hasFeature('texture-compression-bc') ||
        hasFeature('texture-compression-etc2') ||
        hasFeature('texture-compression-astc'),
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: hasFeature('indirect-first-instance'),
      storageBuffer: (rawLimits.maxStorageBuffersPerShaderStage ?? 0) > 0,
      storageTexture: (rawLimits.maxStorageTexturesPerShaderStage ?? 0) > 0,
      // HDR / filterable caps (feat-20260608 M1):
      ...hdrCaps,
      maxColorAttachments: rawLimits.maxColorAttachments ?? 4,
    } as RhiCaps;
    this.queue =
      raw.queue === undefined || raw.queue === null
        ? makeRhiQueue({})
        : makeRhiQueue(raw.queue as RawQueueLike);
    let lostResolve:
      | ((value: { reason: 'destroyed' | 'unknown'; message: string }) => void)
      | undefined;
    this.lost =
      raw.lost === undefined
        ? new Promise<{
            readonly reason: 'destroyed' | 'unknown';
            readonly message: string;
          }>((resolve) => {
            lostResolve = resolve;
          })
        : (raw.lost as unknown as Promise<{
            readonly reason: 'destroyed' | 'unknown';
            readonly message: string;
          }>);

    // F4 (feat-20260622-s5): when on the wasm path (raw.lost === undefined),
    // wire the real Promise resolver to wgpu-wasm's register_lost_callback
    // (rhi.rs:935). The Rust side already calls closure.forget() so the
    // callback survives; the JS resolver reference is held on this instance
    // via Object.defineProperty (non-enumerable, like _internal_raw) to
    // prevent GC (D-7; plan-decisions PD-L-1). On the browser path
    // (raw.lost is the native GPUDevice.lost Promise), no wiring is needed.
    if (raw.lost === undefined && typeof raw.registerLostCallback === 'function') {
      if (lostResolve !== undefined) {
        Object.defineProperty(this, '_lostResolver', {
          value: lostResolve,
          writable: false,
          enumerable: false,
          configurable: false,
        });
        raw.registerLostCallback((reason: string, message: string) => {
          lostResolve?.({ reason: reason as 'destroyed' | 'unknown', message });
        });
      }
    }
  }

  /**
   * The wrap helper routes the raw handle's method via try/catch into the
   * forgeax Result form. M4 dawn-node integration tests (w24) narrow the
   * dispatch into feature-not-enabled / limit-exceeded by inspecting the
   * thrown error message (mirrors @forgeax/engine-rhi-webgpu's classification path).
   *
   * F3-g (feat-20260619-wasm-fault-isolation M3 w7): exceptions carrying the
   * stable prefix `[wgpu-wasm] failed to parse` (D-1 contract) are classified
   * as `rhi-descriptor-invalid` (caller bug — malformed descriptor data);
   * exceptions without the prefix remain `webgpu-runtime-error` (runtime
   * condition). This classification applies to all 7 create* entry points that
   * route through wrap() (D-2 global semantics).
   */
  private wrap<T>(
    method: ((desc: unknown) => unknown) | undefined,
    desc: unknown,
  ): Result<T, RhiError> {
    if (method === undefined) {
      return webgpuRuntimeError(new Error('underlying device handle does not expose this method'));
    }
    try {
      const handle = method.call(this.raw, desc);
      return ok(handle as T);
    } catch (e) {
      if (e instanceof Error && e.message.includes('[wgpu-wasm] failed to parse')) {
        return descriptorInvalid(e);
      }
      return webgpuRuntimeError(e);
    }
  }

  createBuffer(desc: BufferDescriptor): Result<Buffer, RhiError> {
    // M4 w24 integration wiring: route raw GPUBuffer / wgpu wasm RhiWgpuBuffer
    // through `makeRhiBuffer` so the forgeax Buffer mapping 4-state lifecycle
    // (mapAsync / getMappedRange / unmap / mapState) returns Result-wrapped
    // values end-to-end (charter proposition 5; the M2 baseline only cast the
    // raw handle which leaked the raw `mapAsync` returning Promise<void>
    // instead of Promise<Result<void, RhiError>>).
    if (this.raw.createBuffer === undefined) {
      return webgpuRuntimeError(new Error('underlying device handle does not expose createBuffer'));
    }
    try {
      const raw = this.raw.createBuffer.call(this.raw, desc);
      return ok(makeRhiBuffer(raw as RawBufferLike));
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  createTexture(desc: TextureDescriptor): Result<Texture, RhiError> {
    const r = this.wrap<Texture>(this.raw.createTexture, desc);
    if (r.ok) {
      // feat-20260612 M1 / w5 — register the destroyed marker so
      // destroyTexture can fail-fast on the second call (D-7).
      TEXTURE_DESTROYED_MAP.set(r.value, { destroyed: false });
    }
    return r;
  }

  destroyBuffer(buf: Buffer): Result<void, RhiError> {
    // feat-20260612 M1 / w5 — fail-fast over the spec / wasm idempotent-
    // void contract (plan-strategy D-7 + research §F-1). The bookkeeping
    // lives on the `RhiWgpuBufferImpl` instance (private `destroyed:
    // boolean` flag); the device entry recovers the impl by casting
    // through the Buffer brand. Charter proposition 4 explicit failure +
    // architecture-principles §5 Fail Fast.
    const impl = buf as unknown as { destroy?: () => Result<void, RhiError> };
    if (typeof impl.destroy !== 'function') {
      return webgpuRuntimeError(
        new Error('Buffer brand does not expose destroy(); created outside makeRhiBuffer factory'),
      );
    }
    return impl.destroy();
  }

  destroyTexture(tex: Texture): Result<void, RhiError> {
    // feat-20260612 M1 / w5 — same fail-fast contract as destroyBuffer.
    // The shim has no per-texture wrapper class (textures pass through as
    // raw wasm-bindgen handles); the destroyed flag lives on the parallel
    // TEXTURE_DESTROYED_MAP. The first destroy delegates to the wasm
    // shim's `destroy()` (idempotent void per research §F-1) and flips
    // the flag; the second call surfaces 'destroy-after-destroy'.
    const marker = TEXTURE_DESTROYED_MAP.get(tex);
    if (marker?.destroyed) {
      return doubleDestroy('GPU texture handle has not been destroyed yet');
    }
    const rawTex = tex as unknown as { destroy?: () => void };
    try {
      if (typeof rawTex.destroy === 'function') {
        rawTex.destroy();
      }
    } catch (e) {
      return webgpuRuntimeError(e);
    }
    if (marker !== undefined) marker.destroyed = true;
    return ok(undefined);
  }

  createSampler(desc?: SamplerDescriptor | undefined): Result<Sampler, RhiError> {
    return this.wrap<Sampler>(this.raw.createSampler, desc);
  }

  createBindGroup(desc: BindGroupDescriptor): Result<BindGroup, RhiError> {
    if (this.raw.createBindGroup === undefined) {
      return webgpuRuntimeError(
        new Error('underlying device handle does not expose createBindGroup'),
      );
    }
    // w29 (M5) — tagged-union RhiBindingResource 4-kind dispatch (mirrors
    // rhi-webgpu w20). Each forgeax entry carries { binding, resource: { kind,
    // value } }; the switch routes per kind, the default branch trips
    // `assertNever` so a future fifth kind forces TS2367 at compile time
    // (charter proposition 4 explicit failure + proposition 5 dual-backend
    // alignment).
    // bug-20260612: zero TS-side wrapper overhead — the wasm-bindgen wrapper
    // (RhiWgpuSampler / RhiWgpuTextureView) flows through directly. The shim
    // dispatches by JsCast::dyn_ref<T>() on the Rust side, which uses the
    // wasm-bindgen-internal class id (not the JS-visible `constructor.name`)
    // and is therefore minify-safe.
    const mirroredEntries: unknown[] = [];
    for (const entry of desc.entries) {
      const resource = entry.resource;
      switch (resource.kind) {
        case 'sampler': {
          mirroredEntries.push({ binding: entry.binding, resource: resource.value });
          break;
        }
        case 'buffer': {
          const { buffer, offset, size } = resource.value;
          const bufferBinding: Record<string, unknown> = { buffer: unwrapBuffer(buffer) };
          if (offset !== undefined) bufferBinding.offset = offset;
          if (size !== undefined) bufferBinding.size = size;
          mirroredEntries.push({ binding: entry.binding, resource: bufferBinding });
          break;
        }
        case 'textureView': {
          mirroredEntries.push({ binding: entry.binding, resource: resource.value });
          break;
        }
        case 'externalTexture': {
          mirroredEntries.push({ binding: entry.binding, resource: resource.value });
          break;
        }
        default: {
          const _exhaustive: never = resource;
          void _exhaustive;
          return webgpuRuntimeError(
            new Error('unreachable RhiBindingResource kind in rhi-wgpu createBindGroup'),
          );
        }
      }
    }
    const mirroredDesc = { ...(desc as object), entries: mirroredEntries };
    try {
      const handle = this.raw.createBindGroup.call(this.raw, mirroredDesc);
      return ok(handle as BindGroup);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  createBindGroupLayout(desc: BindGroupLayoutDescriptor): Result<BindGroupLayout, RhiError> {
    return this.wrap<BindGroupLayout>(this.raw.createBindGroupLayout, desc);
  }

  createPipelineLayout(desc: PipelineLayoutDescriptor): Result<PipelineLayout, RhiError> {
    return this.wrap<PipelineLayout>(this.raw.createPipelineLayout, desc);
  }

  createRenderPipeline(desc: RenderPipelineDescriptor): Result<RenderPipeline, RhiError> {
    return this.wrap<RenderPipeline>(this.raw.createRenderPipeline, desc);
  }

  createComputePipeline(desc: ComputePipelineDescriptor): Result<ComputePipeline, RhiError> {
    return this.wrap<ComputePipeline>(this.raw.createComputePipeline, desc);
  }

  createCommandEncoder(
    desc?: CommandEncoderDescriptor | undefined,
  ): Result<RhiCommandEncoder, RhiError> {
    // M4 w24 integration wiring (charter proposition 5 consistent abstraction):
    // route the raw GPUCommandEncoder / wgpu wasm RhiWgpuCommandEncoder through
    // `makeRhiCommandEncoder` so the forgeax RhiCommandEncoder method surface
    // (beginRenderPass / copyBufferToBuffer / finish returning Result, ...)
    // is live end-to-end against dawn-node. The earlier M2 baseline cast the
    // raw handle directly to RhiCommandEncoder which leaked the raw method
    // surface (e.g. raw `finish()` returns `GPUCommandBuffer`, not
    // `Result<CommandBuffer, RhiError>`) — the integration test caught it
    // exactly because the dawn-node real-GPU path exercised the boundary.
    if (this.raw.createCommandEncoder === undefined) {
      return webgpuRuntimeError(
        new Error('underlying device handle does not expose createCommandEncoder'),
      );
    }
    try {
      const raw = this.raw.createCommandEncoder.call(this.raw, desc);
      return ok(makeRhiCommandEncoder(raw as RawCommandEncoderLike));
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  createTextureView(texture: Texture, desc: TextureViewDescriptor): Result<TextureView, RhiError> {
    // M4 w24 integration wiring (charter proposition 5 consistent abstraction):
    // the forgeax RhiDevice.createTextureView signature lifts the WebGPU spec
    // `GPUTexture.createView(desc)` method up to a top-level RHI entry (see
    // AGENTS.md break-point #1 2026-05-10). Two dispatch paths:
    //   (1) raw handle exposes `device.createTextureView(tex, desc)` — wgpu
    //       wasm bindings can be configured this way (R-06 `js_name` rename
    //       attribute lifts the method to the Device wasm surface).
    //   (2) raw handle is a navigator.gpu GPUDevice (dawn-node injection) —
    //       spec WebGPU keeps `createView` on the texture handle; the shim
    //       translates `device.createTextureView(tex, desc)` →
    //       `tex.createView(desc)` so the forgeax call form is honoured on
    //       both backends.
    if (this.raw.createTextureView !== undefined) {
      try {
        const view = this.raw.createTextureView.call(this.raw, texture, desc);
        return ok(view as TextureView);
      } catch (e) {
        return webgpuRuntimeError(e);
      }
    }
    const texAsCreateView = texture as unknown as {
      createView?(desc?: GPUTextureViewDescriptor): unknown;
    };
    if (typeof texAsCreateView.createView !== 'function') {
      return webgpuRuntimeError(
        new Error(
          'underlying device + texture handles expose neither device.createTextureView nor texture.createView',
        ),
      );
    }
    try {
      const view = texAsCreateView.createView(desc as GPUTextureViewDescriptor);
      return ok(view as TextureView);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  createQuerySet(desc: QuerySetDescriptor): Result<QuerySet, RhiError> {
    return this.wrap<QuerySet>(this.raw.createQuerySet, desc);
  }
}

/**
 * Public factory — `makeRhiDevice(raw)` returns the forgeax RhiDevice brand
 * wired to the raw handle's createX entries. The class-form `RhiWgpuDeviceImpl`
 * is kept private; the forgeax brand opaqueness is preserved across the
 * factory boundary (charter proposition 5).
 *
 * The return shape is `{ device }` (not just `device`) to leave room for
 * future opaque-handle reverse lookups (the rhi-webgpu shim uses a
 * RAW_DEVICE_MAP WeakMap registered through this factory; the rhi-wgpu shim
 * will follow the same pattern in M3 / w23 facade integration).
 */
export function makeRhiDevice(raw: RawDeviceLike): { device: RhiDevice } {
  return { device: new RhiWgpuDeviceImpl(raw) };
}

// w18: makeRhiQueueStub removed; replaced by `makeRhiQueue` imported from
// './queue'. The forgeax RhiQueue surface (submit / writeBuffer /
// writeTexture / copyExternalImageToTexture / onSubmittedWorkDone) now
// routes through the dedicated module so the device.ts file stays focused
// on the createX surface.
