// @forgeax/engine-runtime — SSAO per-runtime persistent GPU buffers.
//
// feat-20260612-hdrp-ssao M1 / w4.
//
// Owner of 3 SSAO GPU resources, lazily allocated per RenderSystemRuntime,
// following the getOrCreateHdrpBuffers WeakMap pattern (research F12):
//   (1) kernel SSBO  — 64 vec3 storage buffer (1024 B), label hdrp-ssao-kernel
//   (2) noise texture — 4x4 rgba32float, label hdrp-ssao-noise, NEAREST/REPEAT
//   (3) uniform UBO   — 3 mat4 + vec4 intensityPad (256 B aligned),
//                       label hdrp-ssao-uniform
//
// plan-strategy D-1: uniform carries view + projection + inverseProjection.
// plan-strategy D-C: intensity scalar carried at offset 192 (vec4 pad slot)
//   so the lighting shader can mix(1.0, ssao*ao, intensity) without a new UBO.
// plan-strategy D-4: storageBuffer=false fires structured error + returns null.
// requirements OOS-5: no UBO fallback for kernel.

import type { Buffer, Texture } from '@forgeax/engine-rhi';
import { PostProcessError } from './post-process-errors';
import type { RenderSystemRuntime } from './render-system';
import { generateSsaoKernel, generateSsaoNoise } from './ssao-data';

const KERNEL_SAMPLE_COUNT = 64;

// Each vec3<f32> in a WGSL array is 16B (12B payload + 4B padding).
// 64 samples * 16 B/sample = 1024 B.
const BYTES_PER_KERNEL_ELEMENT = 16;

// SSAO uniform layout (plan-strategy §D-1 + §D-C, M7 round-2):
//   bytes [0..63]    view              mat4x4<f32>
//   bytes [64..127]  projection        mat4x4<f32>
//   bytes [128..191] inverseProjection mat4x4<f32>
//   bytes [192..207] intensityPad      vec4<f32>  // x = intensity, y/z/w pad
//   bytes [208..255] padding           // align to 256B WebGPU UBO offset
//
// The total is rounded to 256B so the same UBO can host an additional
// shader-side scalar binding at the tail without re-allocation.
const UNIFORM_INTENSITY_OFFSET_BYTES = 192;
const UNIFORM_BYTES = 256;
export const SSAO_UNIFORM_INTENSITY_OFFSET = UNIFORM_INTENSITY_OFFSET_BYTES;
export const SSAO_UNIFORM_BYTES = UNIFORM_BYTES;

// WebGPU buffer-usage flag values (mirrors hdrp-buffers.ts constants).
const GPU_BUFFER_USAGE_STORAGE = 0x80;
const GPU_BUFFER_USAGE_UNIFORM = 0x40;
const GPU_BUFFER_USAGE_COPY_DST = 0x08;

// WebGPU texture-usage flags (matching GPUTextureUsage enum).
// GPUTextureUsage.COPY_DST = 0x02, GPUTextureUsage.TEXTURE_BINDING = 0x04.
const GPU_TEXTURE_USAGE_COPY_DST = 0x02;
const GPU_TEXTURE_USAGE_TEXTURE_BINDING = 0x04;

/**
 * SSAO GPU resources owned by this module (plan-strategy D-1, D-4).
 *
 * Fields are readonly per charter P5: one resource, one owner.
 */
export interface SsaoBuffers {
  /** 64-vec3 storage buffer for hemisphere samples. */
  readonly kernelBuffer: Buffer;
  readonly kernelBytes: number;
  /** 4x4 rgba32float noise texture for per-pixel TBN rotation. */
  readonly noiseTexture: Texture;
  /** SSAO uniform UBO: view (mat4) + projection (mat4) + inverseProjection (mat4). */
  readonly uniformBuffer: Buffer;
  readonly uniformBytes: number;
}

const cache = new WeakMap<RenderSystemRuntime, SsaoBuffers>();

// Round-2 [F-3]: warn-once tracking per-runtime so the storage-buffer
// unavailable error fires exactly once (per-frame buildGraph re-entry would
// otherwise spam errorRegistry / console). WeakSet so a disposed runtime
// stops anchoring its slot.
const storageUnavailableFired = new WeakSet<RenderSystemRuntime>();

/**
 * Lazily allocate the 3 SSAO GPU resources for `runtime`. Returns the
 * same `SsaoBuffers` object on subsequent calls (per-RenderSystem
 * stable identity, WeakMap).
 *
 * On `device.createBuffer` / `device.createTexture` failure, fires a
 * structured error on the runtime's error registry and returns `null`.
 *
 * When `runtime.device.caps.storageBuffer === false`, fires a structured
 * error with code `'ssao-storage-buffer-unavailable'` and returns `null`
 * (plan-strategy D-4; OOS-5: no UBO fallback).
 *
 * @returns SsaoBuffers on success, null if any allocation fails or
 *   storage buffer is unavailable.
 */
export function getOrCreateSsaoBuffers(runtime: RenderSystemRuntime): SsaoBuffers | null {
  const cached = cache.get(runtime);
  if (cached !== undefined) return cached;

  const device = runtime.device;

  // plan-strategy D-4 + Round-2 [F-3]: storageBuffer cap gate.
  // Returns null when storage buffers are unavailable. addSsaoPasses sees
  // null and performs a graph-level skip (no pass wiring). To honour the
  // requirements `boundary case 4` + AC-07 + charter P3 explicit-failure
  // contract (no silent-skip on cap miss), fire a structured PostProcessError to
  // runtime.errorRegistry exactly once per runtime (warn-once via
  // module-scoped WeakSet). Subsequent calls keep returning null but no
  // longer re-fire — the buildGraph re-entry path runs every frame, and
  // per-frame errorRegistry spam would drown other diagnostics.
  if (!device.caps.storageBuffer) {
    if (!storageUnavailableFired.has(runtime)) {
      storageUnavailableFired.add(runtime);
      runtime.errorRegistry.fire(
        new PostProcessError({
          code: 'ssao-storage-buffer-unavailable',
          detail: { missingCap: 'storageBuffer' },
        }),
      );
    }
    return null;
  }

  // (1) Kernel SSBO — 64 vec3 storage buffer (1024 B).
  const kernelSamples = generateSsaoKernel();
  const kernelData = new Float32Array(KERNEL_SAMPLE_COUNT * 4); // 4 floats per padded vec3
  for (let i = 0; i < KERNEL_SAMPLE_COUNT; i++) {
    const s = kernelSamples[i];
    if (s === undefined) continue;
    kernelData[i * 4 + 0] = s[0] ?? 0;
    kernelData[i * 4 + 1] = s[1] ?? 0;
    kernelData[i * 4 + 2] = s[2] ?? 0;
    // kernelData[i * 4 + 3] = 0 (padding for std140 vec3 alignment)
  }

  const kernelBufferRes = device.createBuffer({
    label: 'hdrp-ssao-kernel',
    size: KERNEL_SAMPLE_COUNT * BYTES_PER_KERNEL_ELEMENT,
    usage: GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!kernelBufferRes.ok) {
    runtime.errorRegistry.fire(kernelBufferRes.error);
    return null;
  }

  // Upload kernel data to the buffer.
  const kernelWriteRes = device.queue.writeBuffer(kernelBufferRes.value, 0, kernelData);
  if (!kernelWriteRes.ok) {
    runtime.errorRegistry.fire(kernelWriteRes.error);
    return null;
  }

  // (2) Noise texture — 4x4 rgba32float, NEAREST/REPEAT.
  const noiseData = generateSsaoNoise();
  // Pad to rgba32float: 16 texels * 4 floats = 64 floats.
  const noiseRgba = new Float32Array(16 * 4);
  for (let i = 0; i < 16; i++) {
    noiseRgba[i * 4 + 0] = noiseData[i * 3 + 0] ?? 0;
    noiseRgba[i * 4 + 1] = noiseData[i * 3 + 1] ?? 0;
    noiseRgba[i * 4 + 2] = 0;
    noiseRgba[i * 4 + 3] = 1; // alpha = 1 for rgba32float
  }

  const noiseTexRes = device.createTexture({
    label: 'hdrp-ssao-noise',
    size: { width: 4, height: 4, depthOrArrayLayers: 1 },
    mipLevelCount: 1,
    sampleCount: 1,
    dimension: '2d',
    format: 'rgba32float',
    usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    textureBindingViewDimension: undefined,
  });
  if (!noiseTexRes.ok) {
    runtime.errorRegistry.fire(noiseTexRes.error);
    return null;
  }

  // Direct CPU-to-GPU upload via writeTexture (no alignment requirement
  // unlike copyBufferToTexture; WebGPU spec §19.2). 4x4 rgba32float texture
  // = 16 texels * 4 floats * 4 bytes/float = 256 bytes.
  // The forgeax Texture brand wraps a raw GPUTexture; cast through unknown
  // follows the createRenderer.ts fallback-pixel pattern (line 4330).
  const noiseCopyRes = device.queue.writeTexture(
    {
      texture: noiseTexRes.value as unknown as GPUTexture,
      mipLevel: 0,
      origin: { x: 0, y: 0, z: 0 },
    },
    noiseRgba,
    { offset: 0, bytesPerRow: 4 * 4 * 4, rowsPerImage: 4 },
    { width: 4, height: 4, depthOrArrayLayers: 1 },
  );
  if (!noiseCopyRes.ok) {
    runtime.errorRegistry.fire(noiseCopyRes.error);
    return null;
  }

  // (3) SSAO uniform UBO — 3 mat4 (192 B).
  const uniformBufRes = device.createBuffer({
    label: 'hdrp-ssao-uniform',
    size: UNIFORM_BYTES,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!uniformBufRes.ok) {
    runtime.errorRegistry.fire(uniformBufRes.error);
    return null;
  }

  const buffers: SsaoBuffers = {
    kernelBuffer: kernelBufferRes.value,
    kernelBytes: KERNEL_SAMPLE_COUNT * BYTES_PER_KERNEL_ELEMENT,
    noiseTexture: noiseTexRes.value,
    uniformBuffer: uniformBufRes.value,
    uniformBytes: UNIFORM_BYTES,
  };

  cache.set(runtime, buffers);
  return buffers;
}
