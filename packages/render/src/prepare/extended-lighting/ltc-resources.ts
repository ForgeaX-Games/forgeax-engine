// @forgeax/engine-render - DeviceScope-owned RectArea LTC resources.

import type { Result, RhiDevice, RhiError, Texture } from '@forgeax/engine-rhi';
import { LTC_TABLE_HEIGHT, LTC_TABLE_WIDTH, LTC_TABLES } from '@forgeax/engine-shader';
import { err, ok } from '@forgeax/engine-types';
import { type DeviceScope, LifecycleTransaction } from '../../device/device-scope';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../../gpu-texture-usage';
import { deriveExtendedLightingCapability, EXTENDED_LIGHTING_TOPOLOGY } from './resources';

export interface LtcResourcePlanInput {
  readonly scope: DeviceScope;
  readonly ltcAvailable: boolean;
  readonly residentGeneration?: number;
}

export interface LtcResourcePlan {
  readonly topology: typeof EXTENDED_LIGHTING_TOPOLOGY;
  readonly generation: number;
  readonly rectAdmission: 'admitted' | 'omitted';
  readonly tableCount: number;
  readonly uploadCount: number;
}

export interface LtcResourceCandidate {
  readonly topology: typeof EXTENDED_LIGHTING_TOPOLOGY;
  readonly generation: number;
  readonly scope: DeviceScope;
  readonly lambertTexture: Texture;
  readonly ggxTexture: Texture;
  readonly tableCount: 2;
  readonly uploadCount: 2;
}

export function deriveLtcResourcePlan(input: LtcResourcePlanInput): LtcResourcePlan {
  const admitted = input.ltcAvailable;
  return {
    topology: EXTENDED_LIGHTING_TOPOLOGY,
    generation: input.scope.generation,
    rectAdmission: admitted ? 'admitted' : 'omitted',
    tableCount: admitted ? 2 : 0,
    uploadCount: admitted && input.residentGeneration !== input.scope.generation ? 2 : 0,
  };
}

function failure(expected: string, actual: string): Result<never, RhiError> {
  return err({
    code: 'webgpu-runtime-error',
    expected,
    hint: 'inspect device capabilities and retry the extendedLighting candidate',
    detail: { error: { code: 'ltc-resource', message: actual } },
  } as RhiError);
}

function textureBytes(table: Uint16Array): Uint8Array {
  return new Uint8Array(table.buffer, table.byteOffset, table.byteLength);
}

/** Create both tracked tables atomically; unavailable LTC only omits Rect. */
export async function createLtcResourceCandidate(input: {
  readonly device: RhiDevice | undefined;
  readonly scope: DeviceScope;
}): Promise<Result<LtcResourceCandidate | undefined, RhiError>> {
  if (input.device === undefined) return ok(undefined);
  if (!deriveExtendedLightingCapability(input.device).admitted) return ok(undefined);
  const device = input.device;

  const transaction = new LifecycleTransaction(input.scope);
  let lambertTexture: Texture | undefined;
  let ggxTexture: Texture | undefined;
  const createTable = (label: string, table: Uint16Array): Texture => {
    const texture = device.createTexture({
      label,
      size: { width: LTC_TABLE_WIDTH, height: LTC_TABLE_HEIGHT, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 1,
      dimension: '2d',
      format: 'rgba16float',
      usage: GPU_TEXTURE_USAGE_COPY_DST | GPU_TEXTURE_USAGE_TEXTURE_BINDING,
      viewFormats: [],
      textureBindingViewDimension: undefined,
    });
    if (texture === undefined || !texture.ok) {
      throw texture?.error ?? new Error('LTC texture creation returned no result');
    }
    const write = device.queue.writeTexture(
      { texture: texture.value, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      textureBytes(table),
      { offset: 0, bytesPerRow: LTC_TABLE_WIDTH * 8, rowsPerImage: LTC_TABLE_HEIGHT },
      { width: LTC_TABLE_WIDTH, height: LTC_TABLE_HEIGHT, depthOrArrayLayers: 1 },
    );
    if (!write.ok) throw write.error;
    return texture.value;
  };

  transaction.add({
    kind: 'texture',
    create: () => {
      lambertTexture = createTable('extended-lighting-ltc-lambert', LTC_TABLES.lambert);
      return lambertTexture;
    },
    cleanup: (value) => {
      const destroyed = input.device?.destroyTexture(value);
      if (destroyed !== undefined && !destroyed.ok) throw destroyed.error;
    },
  });
  transaction.add({
    kind: 'texture',
    create: () => {
      ggxTexture = createTable('extended-lighting-ltc-ggx', LTC_TABLES.ggx);
      return ggxTexture;
    },
    cleanup: (value) => {
      const destroyed = input.device?.destroyTexture(value);
      if (destroyed !== undefined && !destroyed.ok) throw destroyed.error;
    },
  });

  const committed = await transaction.commit();
  if (!committed.ok)
    return failure(committed.error.primary.expected, committed.error.primary.message);
  if (lambertTexture === undefined || ggxTexture === undefined) {
    return failure('two LTC textures', 'the transaction committed without both tables');
  }
  return ok({
    topology: EXTENDED_LIGHTING_TOPOLOGY,
    generation: input.scope.generation,
    scope: input.scope,
    lambertTexture,
    ggxTexture,
    tableCount: 2,
    uploadCount: 2,
  });
}
