// packages/rhi-wgpu/src/adapter.ts — RhiAdapter / RhiCanvasContext shim
// (w16 of feat-20260511-rhi-wgpu-impl).
//
// The TS shim layer wraps the wasm-bindgen handles (`RhiWgpuAdapter` etc.,
// exported from `packages/rhi-wgpu/crate/src/lib.rs`) into the forgeax RHI
// interface shape. M2 baseline lands the structural shim — every method
// returns a Result-wrapped placeholder that mirrors the @forgeax/engine-rhi-webgpu
// behaviour. M3 / M4 (w22-w27) wires the real wasm bindings through the
// `ensureRhiWgpuReady` + `getRhiWgpuModule` lazy-load contract (w13).
//
// w16 scope:
//   - makeRhiAdapter(rawAdapter): RhiAdapter
//   - makeCanvasContext(rawContext): RhiCanvasContext (1-arg form, K-4)
//   - makeRhiDevice + makeRhiQueue + makeRhiCommandEncoder lives in
//     device.ts / queue.ts / command-encoder.ts (w17 / w18).
//
// The shim functions consume an "any-shaped raw handle" parameter typed as
// `unknown` — the caller (`index.ts` / future wgpu wasm consumers) feeds
// either a navigator.gpu raw handle (when the TS shim is exercised against
// a navigator.gpu fixture) or a `RhiWgpuAdapter` JsValue handle from the
// wasm bundle. Both shapes funnel through the same Result wrapper.
//
// Anchors: plan-strategy §6 M2 + §2 D-P3 TS shim layered structure + K-4
//          canvas context + K-5 / K-6 strict two-step path; charter
//          proposition 5 consistent abstraction.

/// <reference types="@webgpu/types" />

import {
  type CanvasConfiguration,
  type RequestDeviceOptions as ForgeaXRequestDeviceOptions,
  ok,
  type Result,
  type RhiAdapter,
  type RhiCanvasContext,
  type RhiDevice,
  type RhiError,
  type Texture,
} from '@forgeax/engine-rhi';
import { makeRhiDevice, type RawDeviceLike } from './device';
import { adapterUnavailable, webgpuRuntimeError } from './errors';

/**
 * Minimal shape of a wgpu-wasm or navigator.gpu adapter that the TS shim
 * touches. The shim only reads `features` + `limits` + calls
 * `requestDevice`; this loose typing accommodates both:
 *
 * 1. navigator.gpu `GPUAdapter` (when the dual-impl auto-select facade
 *    picks the WebGPU path but injects through the rhi-wgpu shim as an
 *    escape hatch, D-R5).
 * 2. The `RhiWgpuAdapter` wasm-bindgen handle (when the lazy-loaded wgpu
 *    wasm bundle drives the device request path).
 */
export interface RawAdapterLike {
  readonly features?: ReadonlySet<string> | { has(name: string): boolean } | undefined;
  readonly limits?: Readonly<Record<string, number>> | undefined;
  // forgeax-async-whitelist: wasm-bindgen — wgpu-wasm `Adapter.requestDevice()` raw entry
  requestDevice(opts?: unknown): Promise<RawDeviceLike>;
}

/**
 * Build a `RhiAdapter` over a raw wgpu-wasm or navigator.gpu adapter handle.
 *
 * Field projection (mirrors @forgeax/engine-rhi-webgpu/src/index.ts makeRhiAdapter):
 *   - `features` projects to `ReadonlySet<GPUFeatureName>`.
 *   - `limits`   projects to `Readonly<Record<string, number>>`.
 *   - `requestDevice` forwards to the raw handle, wraps the resulting raw
 *     device via `makeRhiDevice` and routes errors through structured
 *     RhiError factories (charter proposition 4 explicit failure).
 */
export function makeRhiAdapter(rawAdapter: RawAdapterLike): RhiAdapter {
  const rawFeatures = rawAdapter.features as unknown as ReadonlySet<GPUFeatureName> | undefined;
  const features: ReadonlySet<GPUFeatureName> =
    rawFeatures !== undefined && rawFeatures !== null
      ? new Set(rawFeatures)
      : new Set<GPUFeatureName>();
  const limitsRaw = (rawAdapter.limits as unknown as Record<string, unknown> | undefined) ?? {};
  const limits: Record<string, number> = {};
  for (const key in limitsRaw) {
    const v = limitsRaw[key];
    if (typeof v === 'number') {
      limits[key] = v;
    }
  }
  return {
    features,
    limits: limits as Readonly<Record<string, number>>,
    async requestDevice(
      opts?: ForgeaXRequestDeviceOptions | undefined,
    ): Promise<Result<RhiDevice, RhiError>> {
      try {
        const rawDevice = await rawAdapter.requestDevice(opts);
        const { device } = makeRhiDevice(rawDevice);
        return ok(device);
      } catch (e) {
        // Spec / wgpu both signal feature / limit problems as a thrown
        // OperationError; we route them through webgpuRuntimeError as a
        // safe baseline at M2. The M4 dawn-node integration (w24) narrows
        // the dispatch into feature-not-enabled / limit-exceeded by
        // keyword (mirrors rhi-webgpu's classifyRequestDeviceError).
        return webgpuRuntimeError(e);
      }
    },
  };
}

/**
 * Minimal canvas-context shape the shim consumes. The configure surface
 * only reads `device`/`format`/`usage`/`viewFormats`/`colorSpace`/
 * `toneMapping`/`alphaMode` (the 7 GPUCanvasConfiguration fields) and
 * forwards them to the raw context's `configure` method.
 */
export type GpuCanvasContextLike = {
  configure(desc: GPUCanvasConfiguration): void;
  unconfigure(): void;
  getConfiguration(): GPUCanvasConfiguration | null;
  getCurrentTexture(): unknown;
};

/**
 * Build a `RhiCanvasContext` over a raw GPUCanvasContext. The forgeax form
 * (K-4) keeps the spec method names but routes failures through `Result`:
 *
 *   - `configure` returns `Result<void, RhiError>` (spec returns void;
 *     forgeax surfaces 'webgpu-runtime-error' for spec validation failures).
 *   - `unconfigure` returns void (spec literal alignment).
 *   - `getConfiguration` returns `CanvasConfiguration | undefined` (spec
 *     returns `GPUCanvasConfiguration?`; forgeax uses `undefined`).
 *   - `getCurrentTexture` returns `Result<Texture, RhiError>` (K-4: Texture
 *     brand, NOT TextureView; AI users go two-step
 *     `device.createTextureView(canvasContext.getCurrentTexture().unwrap(),{})`).
 */
export function makeCanvasContext(
  rawContext: GpuCanvasContextLike,
  // bug-20260610 v19: optional canvas reference. The WebGPU spec form does
  // not include width/height in `GPUCanvasConfiguration` — the canvas's own
  // `.width / .height` attributes are the surface size. The wgpu-wasm shim
  // (which wraps a wgpu::Surface) cannot reach the canvas after construction,
  // so the JS shim must inject the size into the descriptor mirror. Without
  // this the RhiWgpuSurface configure deserialiser falls back to the serde
  // default of 1×1 → the GLES backbuffer is 1×1 stretched over the CSS
  // viewport (uniform-coloured rectangle, all draws collapse to single pixel).
  canvas?: HTMLCanvasElement | OffscreenCanvas,
): RhiCanvasContext {
  // bug-20260610: per-context closure stash for the previous-frame
  // SurfaceTexture wrapper — see getCurrentTexture below for the
  // auto-present hook.
  let pendingSurfaceTexture: { present: () => void } | null = null;
  return {
    configure(desc: CanvasConfiguration): Result<void, RhiError> {
      try {
        // M4 w25 integration: the forgeax CanvasConfiguration has
        // `device: RhiDevice` (D-S5); the raw context expects
        // `device: GPUDevice`. Walk the rhi-wgpu device wrapper's
        // shim-internal `_internal_raw` field (mirrors rhi-webgpu's
        // RAW_DEVICE_MAP reverse lookup pattern — the wrap form is an
        // instance field rather than a WeakMap, but the lookup intent is
        // identical, charter proposition 5 consistent abstraction).
        // Mirror only the spec-allowed CanvasConfiguration fields onto the
        // raw object so missing fields stay missing
        // (`'x' in src` feature-detection idiom).
        const mirrored: Record<string, unknown> = {};
        for (const key in desc as unknown as Record<string, unknown>) {
          mirrored[key] = (desc as unknown as Record<string, unknown>)[key];
        }
        if ('device' in mirrored) {
          const forgeaxDevice = desc.device as unknown as {
            _internal_raw?: unknown;
          };
          const rawDev = forgeaxDevice._internal_raw;
          if (rawDev !== undefined && rawDev !== null) {
            mirrored.device = rawDev;
          }
        }
        // bug-20260610 v19: inject the canvas drawing-buffer size when the
        // caller did not provide explicit width/height. The wgpu-wasm
        // SurfaceConfigurationJs serde defaults are 1×1, which collapses
        // the GLES backbuffer to a single pixel.
        if (canvas !== undefined) {
          if (mirrored.width === undefined) {
            mirrored.width = canvas.width;
          }
          if (mirrored.height === undefined) {
            mirrored.height = canvas.height;
          }
        }
        rawContext.configure(mirrored as unknown as GPUCanvasConfiguration);
        return ok(undefined);
      } catch (e) {
        return webgpuRuntimeError(e);
      }
    },
    unconfigure(): void {
      try {
        rawContext.unconfigure();
      } catch {
        // Spec-aligned silent return — unconfigure is idempotent.
      }
    },
    getConfiguration(): CanvasConfiguration | undefined {
      const c = rawContext.getConfiguration();
      return c === null ? undefined : (c as unknown as CanvasConfiguration);
    },
    getCurrentTexture(): Result<Texture, RhiError> {
      try {
        // bug-20260610: wgpu-wasm exposes the SurfaceTexture wrapper from
        // `getCurrentTexture()`; the spec-shaped GPUTexture lives one level
        // down at `.getTexture()`. Without this unwrap the engine passes a
        // `RhiWgpuSurfaceTexture` to `device.createTextureView` /
        // `commandEncoder.beginRenderPass` etc., and wasm-bindgen's
        // `_assertClass(texture, RhiWgpuTexture)` rejects.
        //
        // Auto-present hook: wgpu-wasm requires explicit
        // `surfaceTexture.present()` to release the acquired surface image
        // (browser-native WebGPU auto-presents on the next browser frame).
        // We stash the previous-frame wrapper on the closure and `present()`
        // it before acquiring the current frame — the engine never sees the
        // wrapper, the spec contract stays single-method `getCurrentTexture`,
        // and wgpu_core no longer panics with "Surface image is already
        // acquired" on frame 2 onward.
        const prev = pendingSurfaceTexture;
        pendingSurfaceTexture = null;
        if (prev !== null && typeof prev.present === 'function') {
          try {
            prev.present();
          } catch {
            // Spec-aligned silent — present is best-effort idempotent;
            // any failure surfaces in the next acquire's error path.
          }
        }
        const raw = rawContext.getCurrentTexture() as
          | { getTexture?: () => unknown; present?: () => void }
          | undefined;
        if (raw !== undefined && raw !== null && typeof raw.getTexture === 'function') {
          if (typeof raw.present === 'function') {
            pendingSurfaceTexture = raw as { present: () => void };
          }
          return ok(raw.getTexture() as unknown as Texture);
        }
        return ok(raw as unknown as Texture);
      } catch (e) {
        return webgpuRuntimeError(e);
      }
    },
  };
}

// Re-export so index.ts re-export chain stays linear.
export { adapterUnavailable };
