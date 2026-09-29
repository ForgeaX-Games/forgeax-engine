import type {
  RhiDevice,
  RhiError,
  Texture,
  TextureDescriptor,
  TextureView,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  GPU_TEXTURE_USAGE_COPY_DST,
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';

const HISTORY_USAGE =
  GPU_TEXTURE_USAGE_COPY_SRC |
  GPU_TEXTURE_USAGE_COPY_DST |
  GPU_TEXTURE_USAGE_TEXTURE_BINDING |
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT;

export interface TaaHistorySlot {
  readonly texture: Texture;
  readonly view: TextureView;
}

export interface TaaHistoryResources {
  readonly width: number;
  readonly height: number;
  readonly descriptor: TextureDescriptor;
  readonly slots: readonly [TaaHistorySlot, TaaHistorySlot];
  readonly temporalSlots: readonly [TaaHistorySlot, TaaHistorySlot];
  readonly currentIndex: 0 | 1;
  readonly previousIndex: 0 | 1;
  readonly valid: boolean;
  beginFrame(): void;
  commitFrame(): void;
  abortFrame(): void;
  dispose(): void;
}

export function createTaaHistoryResources(
  device: RhiDevice,
  width: number,
  height: number,
): Result<TaaHistoryResources, RhiError> {
  const descriptor: TextureDescriptor = {
    label: 'taa-history-rgba16float',
    size: { width, height, depthOrArrayLayers: 1 },
    format: 'rgba16float',
    usage: HISTORY_USAGE,
    sampleCount: 1,
    mipLevelCount: undefined,
    dimension: undefined,
    viewFormats: undefined,
    textureBindingViewDimension: undefined,
  };
  const createSlots = (kind: 'color' | 'temporal'): Result<TaaHistorySlot[], RhiError> => {
    const slots: TaaHistorySlot[] = [];
    for (let index = 0; index < 2; index += 1) {
      const texture = device.createTexture({
        ...descriptor,
        label: `taa-history-${kind}-rgba16float-${index}`,
      });
      if (!texture.ok) {
        for (const slot of slots) device.destroyTexture(slot.texture);
        return texture;
      }
      const view = device.createTextureView(texture.value, {
        label: `taa-history-${kind}-rgba16float-${index}.view`,
        dimension: '2d',
      });
      if (!view.ok) {
        device.destroyTexture(texture.value);
        for (const slot of slots) device.destroyTexture(slot.texture);
        return err(view.error);
      }
      slots.push({ texture: texture.value, view: view.value });
    }
    return ok(slots);
  };
  const colorSlots = createSlots('color');
  if (!colorSlots.ok) return colorSlots;
  const temporalSlots = createSlots('temporal');
  if (!temporalSlots.ok) {
    for (const slot of colorSlots.value) device.destroyTexture(slot.texture);
    return temporalSlots;
  }

  let currentIndex: 0 | 1 = 0;
  let valid = false;
  let active = false;
  let disposed = false;
  return ok({
    width,
    height,
    descriptor,
    slots: colorSlots.value as [TaaHistorySlot, TaaHistorySlot],
    temporalSlots: temporalSlots.value as [TaaHistorySlot, TaaHistorySlot],
    get currentIndex() {
      return currentIndex;
    },
    get previousIndex() {
      return currentIndex === 0 ? 1 : 0;
    },
    get valid() {
      return valid;
    },
    beginFrame() {
      active = true;
    },
    commitFrame() {
      if (!active || disposed) return;
      currentIndex = currentIndex === 0 ? 1 : 0;
      valid = true;
      active = false;
    },
    abortFrame() {
      active = false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const slot of colorSlots.value) device.destroyTexture(slot.texture);
      for (const slot of temporalSlots.value) device.destroyTexture(slot.texture);
    },
  });
}
