// @forgeax/engine-rhi-wgpu-native - the RHI over native wgpu in Node.
//
// `createGpu()` returns a W3C-shaped `GPU` over the opt-in native addon (Vulkan on
// Linux/Windows, Metal on macOS) with wgpu's Ray Query extension, and `rhi` is the
// `@forgeax/engine-rhi-webgpu` shim over it, so `caps.rayQuery` is derived from the real
// adapter. A missing addon is `adapter-unavailable`, never a crash.

import {
  RAY_QUERY_FEATURE,
  type RequestAdapterOptions,
  type RhiAdapter,
  type RhiError,
  type RhiInstance,
} from '@forgeax/engine-rhi';
import { type GpuLike, requestAdapterFrom, rhi as webgpuRhi } from '@forgeax/engine-rhi-webgpu';
import { err, ok, type Result } from '@forgeax/engine-types';
import { loadNativeBinding } from './binding';
import {
  GPUBufferUsageFlags,
  GPUColorWriteFlags,
  GPUInternalError,
  GPUMapModeFlags,
  GPUOutOfMemoryError,
  GPUPipelineError,
  GPUShaderStageFlags,
  GPUTextureUsageFlags,
  GPUUncapturedErrorEvent,
  GPUValidationError,
  NativeGPU,
} from './gpu';

export { NATIVE_ADDON_PATH } from './binding';
export type { NativeGPU, NativeGPUAdapter, NativeGPUDevice } from './gpu';

let gpu: Result<NativeGPU, RhiError> | undefined;

/**
 * The process-wide native `GPU`; `adapter-unavailable` when the addon is not built.
 * `FORGEAX_WGPU_NATIVE_RAY_QUERY=off` withholds `wgpu-ray-query` from its adapters, so
 * the same device can run the non-ray-query lanes for comparison.
 */
export function createGpu(): Result<NativeGPU, RhiError> {
  if (gpu !== undefined) return gpu;
  const binding = loadNativeBinding();
  const hidden = new Set(
    process.env.FORGEAX_WGPU_NATIVE_RAY_QUERY === 'off' ? [RAY_QUERY_FEATURE] : [],
  );
  gpu = binding.ok ? ok(new NativeGPU(binding.value, hidden)) : err(binding.error);
  return gpu;
}

/**
 * Install the native `GPU` as `navigator.gpu` with the W3C globals, the Node shape
 * `webgpu` (dawn.node) consumers use. Returns the installed `GPU`.
 */
export function installNavigatorGpu(): Result<NativeGPU, RhiError> {
  const native = createGpu();
  if (!native.ok) return native;
  Object.assign(globalThis as Record<string, unknown>, globals);
  if (!('navigator' in globalThis) || globalThis.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
  }
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: native.value,
    configurable: true,
    writable: true,
  });
  return native;
}

/** The wgpu release the addon was built from, or `null` without the addon. */
export function nativeWgpuVersion(): string | null {
  const binding = loadNativeBinding();
  return binding.ok ? binding.value.wgpuVersion() : null;
}

/** W3C global constants and classes a WebGPU consumer may read from `globalThis`. */
export const globals = {
  GPUBufferUsage: GPUBufferUsageFlags,
  GPUTextureUsage: GPUTextureUsageFlags,
  GPUMapMode: GPUMapModeFlags,
  GPUShaderStage: GPUShaderStageFlags,
  GPUColorWrite: GPUColorWriteFlags,
  GPUValidationError,
  GPUOutOfMemoryError,
  GPUInternalError,
  GPUPipelineError,
  GPUUncapturedErrorEvent,
} as const;

async function requestAdapter(
  options?: RequestAdapterOptions,
): Promise<Result<RhiAdapter, RhiError>> {
  const native = createGpu();
  if (!native.ok) return native;
  return requestAdapterFrom(native.value as unknown as GpuLike, options);
}

/** The RHI instance: the WebGPU shim with adapters from the native `GPU`. */
export const rhi: typeof webgpuRhi & RhiInstance = { ...webgpuRhi, requestAdapter };
