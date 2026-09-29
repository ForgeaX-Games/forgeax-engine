import type { Buffer, Result, RhiDevice, Sampler, Texture } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import type { DeviceScope } from '../../device/device-scope';
import { LifecycleTransaction } from '../../device/lifecycle-transaction';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../../gpu-usage';

export const EXTENDED_LIGHTING_TOPOLOGY = 'extendedLighting' as const;
export const IES_SLICE_CAPACITY = 32;
export const COOKIE_SLICE_CAPACITY = 32;
export const PROBE_RECORD_CAPACITY = 64;
export const IES_SLICE_WIDTH = 256;
export const IES_SLICE_HEIGHT = 128;
export const COOKIE_SLICE_SIZE = 256;
/**
 * The light-texture array keeps a full box-filtered mip chain. Spot Cookies
 * and projectors read level 0; RectAreaLight source textures select a
 * prefiltered level from the LTC lobe footprint.
 */
export const COOKIE_MIP_LEVEL_COUNT = Math.log2(COOKIE_SLICE_SIZE) + 1;
/** Bytes of one RGBA8 slice including every mip level, level 0 first. */
export const COOKIE_SLICE_MIP_CHAIN_BYTES = cookieMipChainBytes();

function cookieMipChainBytes(): number {
  let bytes = 0;
  for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
    const size = COOKIE_SLICE_SIZE >> level;
    bytes += size * size * 4;
  }
  return bytes;
}

/** Write one slice's level-0-first RGBA8 mip chain into the light-texture array. */
export function writeCookieSliceMipChain(
  device: RhiDevice,
  texture: Texture,
  slice: number,
  data: Uint8Array,
): Result<void, RhiError> {
  let offset = 0;
  for (let level = 0; level < COOKIE_MIP_LEVEL_COUNT; level += 1) {
    const size = COOKIE_SLICE_SIZE >> level;
    const bytes = size * size * 4;
    const result = device.queue.writeTexture(
      { texture, mipLevel: level, origin: { x: 0, y: 0, z: slice } },
      data.subarray(offset, offset + bytes),
      { offset: 0, bytesPerRow: size * 4, rowsPerImage: size },
      { width: size, height: size, depthOrArrayLayers: 1 },
    );
    if (!result.ok) return result;
    offset += bytes;
  }
  return ok(undefined);
}
export const COOKIE_MATRIX_BYTES = 32 * 16 * Float32Array.BYTES_PER_ELEMENT;
/**
 * Minimum per-stage sampled-texture limit for the shared PBR + extended-
 * lighting pipeline-layout topology. The current BGL closure reserves 22
 * sampled textures for the URP path and 24 for the HDRP/Probe path after the
 * material IBL and transmission injections; WebGPU validates this pipeline-
 * layout count even when a compiled shader variant does not read every
 * optional entry.
 */
export const EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES = 24;

/**
 * Keep shader-variant selection and resource admission on one capability fact.
 * An omitted limit is treated as unavailable: a caller must not claim the
 * extended topology without a numeric device limit proving it fits.
 */
export function extendedLightingSampledTextureCapacityAvailable(
  maxSampledTexturesPerShaderStage: number | undefined,
): boolean {
  return (
    maxSampledTexturesPerShaderStage !== undefined &&
    maxSampledTexturesPerShaderStage >= EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES
  );
}

export interface ExtendedLightingCapabilityResult {
  readonly admitted: boolean;
  readonly topology: typeof EXTENDED_LIGHTING_TOPOLOGY;
  readonly reason: string | undefined;
}

export interface ExtendedLightingResourceInput {
  readonly device: RhiDevice | undefined;
  readonly scope: DeviceScope;
  readonly iesSliceCount: number;
  readonly cookieSliceCount: number;
  readonly cookieMatrices: number;
  readonly iesData?: Uint8Array | undefined;
  readonly cookieData?: Uint8Array | undefined;
  readonly cookieMatrixData?: Float32Array | undefined;
}

export interface ExtendedLightingResourceCandidate {
  readonly topology: typeof EXTENDED_LIGHTING_TOPOLOGY;
  readonly generation: number;
  readonly scope: DeviceScope;
  readonly iesSliceCount: number;
  readonly cookieSliceCount: number;
  readonly cookieMatrices: number;
  readonly sampler: Sampler;
  readonly iesTexture: Texture | undefined;
  readonly cookieTexture: Texture | undefined;
  readonly cookieMatrixBuffer: Buffer | undefined;
  readonly descriptorBytes: number;
  readonly uploadCount: number;
}

export interface ExtendedLightingResourceInspection {
  readonly topology: typeof EXTENDED_LIGHTING_TOPOLOGY;
  readonly generation: number;
  readonly status: 'empty' | 'candidate' | 'accepted';
  readonly accepted: boolean;
  readonly resourceCount: number;
  readonly descriptorBytes: number;
  readonly uploadCount: number;
  readonly blendInvalidations: number;
  readonly passCount: number;
}

function failure(expected: string, actual: string): Result<never, RhiError> {
  return err(
    new RhiError({
      code: 'webgpu-runtime-error',
      expected,
      hint: 'repair the extended lighting resource facts and retry the candidate generation',
      detail: { error: { code: 'extended-lighting-resource', message: actual } },
    }),
  );
}

function validCount(value: number, capacity: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= capacity;
}

/** Derive admission from the RHI facts; no backend-kind policy is involved. */
export function deriveExtendedLightingCapability(
  device: Pick<RhiDevice, 'caps' | 'limits'>,
): ExtendedLightingCapabilityResult {
  const maxSampledTextures = device.limits.maxSampledTexturesPerShaderStage;
  if (!extendedLightingSampledTextureCapacityAvailable(maxSampledTextures)) {
    return {
      admitted: false,
      topology: EXTENDED_LIGHTING_TOPOLOGY,
      reason: `maxSampledTexturesPerShaderStage ${maxSampledTextures ?? 0} < ${EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES}`,
    };
  }
  const maxLayers = device.limits.maxTextureArrayLayers ?? 0;
  const maxUniformBuffers = device.limits.maxUniformBuffersPerShaderStage ?? 0;
  if (maxLayers < IES_SLICE_CAPACITY) {
    return {
      admitted: false,
      topology: EXTENDED_LIGHTING_TOPOLOGY,
      reason: `maxTextureArrayLayers ${maxLayers} < ${IES_SLICE_CAPACITY}`,
    };
  }
  if (maxUniformBuffers < 1) {
    return {
      admitted: false,
      topology: EXTENDED_LIGHTING_TOPOLOGY,
      reason: `maxUniformBuffersPerShaderStage ${maxUniformBuffers} < 1`,
    };
  }
  if (
    !device.caps.storageBuffer ||
    !device.caps.rgba16floatRenderable ||
    !device.caps.samplerAliasing
  ) {
    return {
      admitted: false,
      topology: EXTENDED_LIGHTING_TOPOLOGY,
      reason: 'required storage-buffer, rgba16float, or sampler capability is unavailable',
    };
  }
  return { admitted: true, topology: EXTENDED_LIGHTING_TOPOLOGY, reason: undefined };
}

function createTexture(
  device: RhiDevice,
  label: string,
  format: 'r16float' | 'rgba8unorm',
  width: number,
  height: number,
  layers: number,
  mipLevelCount = 1,
): Result<Texture, RhiError> {
  return device.createTexture({
    label,
    size: { width, height, depthOrArrayLayers: layers },
    mipLevelCount,
    sampleCount: 1,
    dimension: '2d',
    format,
    usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
    viewFormats: [],
    textureBindingViewDimension: undefined,
  });
}

function requireResource<T>(result: Result<T, RhiError>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function writeTextureSlices(
  device: RhiDevice,
  texture: Texture,
  data: Uint8Array | undefined,
  bytesPerRow: number,
  height: number,
  layerCount: number,
  width: number,
): number {
  if (data === undefined || layerCount === 0) return 0;
  const bytesPerSlice = bytesPerRow * height;
  const requiredBytes = bytesPerSlice * layerCount;
  if (data.byteLength < requiredBytes) {
    throw new Error(`extended lighting texture upload requires ${requiredBytes} bytes`);
  }
  for (let layer = 0; layer < layerCount; layer += 1) {
    const start = layer * bytesPerSlice;
    requireResource(
      device.queue.writeTexture(
        { texture, mipLevel: 0, origin: { x: 0, y: 0, z: layer } },
        data.subarray(start, start + bytesPerSlice),
        { offset: 0, bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      ),
    );
  }
  return layerCount;
}

/** Build a complete candidate; nothing is adopted until the transaction commits. */
export async function createExtendedLightingResourceCandidate(
  input: ExtendedLightingResourceInput,
): Promise<Result<ExtendedLightingResourceCandidate, RhiError>> {
  const { device, scope } = input;
  if (device === undefined) return failure('a live RHI device is required', 'device is undefined');
  if (!validCount(input.iesSliceCount, IES_SLICE_CAPACITY)) {
    return failure(`IES slice count <= ${IES_SLICE_CAPACITY}`, String(input.iesSliceCount));
  }
  if (!validCount(input.cookieSliceCount, COOKIE_SLICE_CAPACITY)) {
    return failure(
      `Cookie slice count <= ${COOKIE_SLICE_CAPACITY}`,
      String(input.cookieSliceCount),
    );
  }
  if (!validCount(input.cookieMatrices, COOKIE_SLICE_CAPACITY)) {
    return failure(`Cookie matrix count <= ${COOKIE_SLICE_CAPACITY}`, String(input.cookieMatrices));
  }
  const capability = deriveExtendedLightingCapability(device);
  if (!capability.admitted)
    return failure('extendedLighting capability admission', capability.reason ?? 'unavailable');
  if (
    input.cookieMatrixData !== undefined &&
    input.cookieMatrixData.byteLength < input.cookieMatrices * 16 * Float32Array.BYTES_PER_ELEMENT
  ) {
    return failure(
      'cookie matrix upload payload',
      `requires ${input.cookieMatrices * 16 * Float32Array.BYTES_PER_ELEMENT} bytes`,
    );
  }

  const transaction = new LifecycleTransaction(scope);
  let iesTexture: Texture | undefined;
  let cookieTexture: Texture | undefined;
  let cookieMatrixBuffer: Buffer | undefined;
  let sampler: Sampler | undefined;
  let uploadCount = 0;
  transaction.add({
    kind: 'texture',
    create: () => {
      const created = requireResource(
        createTexture(
          device,
          'extended-lighting-ies',
          'r16float',
          IES_SLICE_WIDTH,
          IES_SLICE_HEIGHT,
          IES_SLICE_CAPACITY,
        ),
      );
      uploadCount += writeTextureSlices(
        device,
        created,
        input.iesData,
        IES_SLICE_WIDTH * 2,
        IES_SLICE_HEIGHT,
        input.iesSliceCount,
        IES_SLICE_WIDTH,
      );
      iesTexture = created;
      return created;
    },
    cleanup: (value) => {
      const destroyed = device.destroyTexture(value);
      if (!destroyed.ok) throw destroyed.error;
    },
  });
  transaction.add({
    kind: 'texture',
    create: () => {
      const created = requireResource(
        createTexture(
          device,
          'extended-lighting-cookie',
          'rgba8unorm',
          COOKIE_SLICE_SIZE,
          COOKIE_SLICE_SIZE,
          COOKIE_SLICE_CAPACITY,
          COOKIE_MIP_LEVEL_COUNT,
        ),
      );
      const cookieData = input.cookieData;
      if (cookieData !== undefined && input.cookieSliceCount > 0) {
        const requiredBytes = COOKIE_SLICE_MIP_CHAIN_BYTES * input.cookieSliceCount;
        if (cookieData.byteLength < requiredBytes) {
          throw new Error(`extended lighting texture upload requires ${requiredBytes} bytes`);
        }
        for (let slice = 0; slice < input.cookieSliceCount; slice += 1) {
          const start = slice * COOKIE_SLICE_MIP_CHAIN_BYTES;
          requireResource(
            writeCookieSliceMipChain(
              device,
              created,
              slice,
              cookieData.subarray(start, start + COOKIE_SLICE_MIP_CHAIN_BYTES),
            ),
          );
        }
        uploadCount += input.cookieSliceCount;
      }
      cookieTexture = created;
      return created;
    },
    cleanup: (value) => {
      const destroyed = device.destroyTexture(value);
      if (!destroyed.ok) throw destroyed.error;
    },
  });
  transaction.add({
    kind: 'buffer',
    create: () => {
      const created = requireResource(
        device.createBuffer({
          label: 'extended-lighting-cookie-matrices',
          size: COOKIE_MATRIX_BYTES,
          usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_UNIFORM,
          mappedAtCreation: false,
        }),
      );
      if (input.cookieMatrixData !== undefined && input.cookieMatrices > 0) {
        requireResource(device.queue.writeBuffer(created, 0, input.cookieMatrixData));
        uploadCount += 1;
      }
      cookieMatrixBuffer = created;
      return created;
    },
    cleanup: (value) => {
      const destroyed = device.destroyBuffer(value);
      if (!destroyed.ok) throw destroyed.error;
    },
  });
  transaction.add({
    // Samplers are bindable GPU resources, not host listeners. Keeping the
    // lifecycle kind aligned with the resource's actual renderer role makes
    // scope inspection and rollback receipts truthful.
    kind: 'binding',
    create: () => {
      const created = requireResource(
        device.createSampler({
          label: 'extended-lighting-clamp-linear',
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
          addressModeW: 'clamp-to-edge',
          magFilter: 'linear',
          minFilter: 'linear',
          mipmapFilter: 'nearest',
        }),
      );
      sampler = created;
      return created;
    },
    cleanup: () => undefined,
  });
  const committed = await transaction.commit();
  if (!committed.ok)
    return failure(committed.error.primary.expected, committed.error.primary.message);
  if (
    iesTexture === undefined ||
    cookieTexture === undefined ||
    cookieMatrixBuffer === undefined ||
    sampler === undefined
  ) {
    return failure(
      'complete extendedLighting candidate resources',
      'resource transaction returned an incomplete set',
    );
  }
  return ok({
    topology: EXTENDED_LIGHTING_TOPOLOGY,
    generation: scope.generation,
    scope,
    iesSliceCount: input.iesSliceCount,
    cookieSliceCount: input.cookieSliceCount,
    cookieMatrices: input.cookieMatrices,
    sampler,
    iesTexture,
    cookieTexture,
    cookieMatrixBuffer,
    descriptorBytes:
      IES_SLICE_WIDTH * IES_SLICE_HEIGHT * 2 * IES_SLICE_CAPACITY +
      COOKIE_SLICE_MIP_CHAIN_BYTES * COOKIE_SLICE_CAPACITY +
      COOKIE_MATRIX_BYTES,
    uploadCount,
  });
}

export function inspectExtendedLightingResources(
  scope: DeviceScope,
): ExtendedLightingResourceInspection {
  return {
    topology: EXTENDED_LIGHTING_TOPOLOGY,
    generation: scope.generation,
    status: 'empty',
    accepted: false,
    resourceCount: 0,
    descriptorBytes: 0,
    uploadCount: 0,
    blendInvalidations: 0,
    passCount: 0,
  };
}
