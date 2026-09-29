import type { RhiDevice, RhiError, Texture, TextureView } from '@forgeax/engine-rhi';
import type { RenderTargetDescriptor } from './contracts';

/** Renderer-private physical storage for one logical target generation. */
export interface RenderTargetPhysical {
  readonly device: RhiDevice;
  readonly sampledDepth?: true;
  readonly generation: number;
  readonly descriptor: RenderTargetDescriptor;
  readonly texture: Texture;
  readonly view: TextureView;
  readonly mipViews: readonly TextureView[];
  readonly colorTextures: readonly Texture[];
  readonly faceViews: readonly TextureView[];
  readonly depthTextures: readonly Texture[];
  readonly depthViews: readonly TextureView[];
  readonly resolveTexture?: Texture;
  readonly resolveView: TextureView;
  readonly resolveFaceViews: readonly TextureView[];
}

import type { RenderError } from '../errors/render';
import { RenderTargetOperationFailedError } from '../errors/render';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type { RenderResult } from '../render-contract';

function mipCount(descriptor: RenderTargetDescriptor): number {
  return descriptor.mipLevels === 1
    ? 1
    : Math.floor(Math.log2(Math.max(descriptor.width, descriptor.height))) + 1;
}

export function createRenderTargetPhysical(
  device: RhiDevice,
  descriptor: RenderTargetDescriptor,
  generation: number,
  sampledDepth = false,
): RenderResult<RenderTargetPhysical, RenderError> {
  const allocations: Texture[] = [];
  const failed = (cause: RhiError): RenderResult<never, RenderError> => {
    const failures = destroyTextures(device, allocations);
    return {
      ok: false,
      error: new RenderTargetOperationFailedError({
        operation: 'create',
        stage: 'allocation',
        generation,
        cause:
          failures.length === 0
            ? cause
            : new AggregateError([cause, ...failures], 'Render target allocation failed'),
        recovery: 'retry',
      }),
    };
  };
  const layers = descriptor.shape === 'cube' ? 6 : 1;
  const usage =
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
    (descriptor.sampled ? GPU_TEXTURE_USAGE_TEXTURE_BINDING : 0) |
    (descriptor.readback ? GPU_TEXTURE_USAGE_COPY_SRC : 0);
  const created = device.createTexture({
    label: `render-target.${generation}`,
    size: { width: descriptor.width, height: descriptor.height, depthOrArrayLayers: layers },
    format: descriptor.format,
    mipLevelCount: mipCount(descriptor),
    // WebGPU forbids multisampled array textures. The cube is always the
    // single-sample resolve destination; MSAA capture uses one depth=1 color
    // texture per face below.
    sampleCount: 1,
    dimension: '2d',
    usage,
    viewFormats: undefined,
    textureBindingViewDimension: descriptor.shape === 'cube' ? 'cube' : undefined,
  });
  if (!created.ok) return failed(created.error);
  const texture = created.value;
  allocations.push(texture);
  const view = device.createTextureView(texture, {
    dimension: descriptor.shape,
    baseMipLevel: 0,
    mipLevelCount: mipCount(descriptor),
    baseArrayLayer: 0,
    arrayLayerCount: layers,
  });
  if (!view.ok) return failed(view.error);
  const mipViews: TextureView[] = [];
  for (let mip = 0; mip < mipCount(descriptor); mip += 1) {
    const mipView = device.createTextureView(texture, {
      dimension: descriptor.shape,
      baseMipLevel: mip,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: layers,
    });
    if (!mipView.ok) return failed(mipView.error);
    mipViews.push(mipView.value);
  }
  const resolveFaceViews: TextureView[] = [];
  for (let face = 0; face < layers; face += 1) {
    const faceView = device.createTextureView(texture, {
      dimension: '2d',
      baseMipLevel: 0,
      mipLevelCount: 1,
      baseArrayLayer: face,
      arrayLayerCount: 1,
    });
    if (!faceView.ok) return failed(faceView.error);
    resolveFaceViews.push(faceView.value);
  }
  const colorTextures: Texture[] = [];
  const faceViews: TextureView[] = [];
  const depthTextures: Texture[] = [];
  const depthViews: TextureView[] = [];
  for (let face = 0; face < layers; face += 1) {
    const depth = device.createTexture({
      label: `render-target.${generation}.depth.${face}`,
      size: {
        width: descriptor.width,
        height: descriptor.height,
        depthOrArrayLayers: descriptor.sampleCount === 4 ? 1 : layers,
      },
      mipLevelCount: 1,
      sampleCount: descriptor.sampleCount,
      dimension: '2d',
      format: 'depth32float-stencil8',
      usage:
        GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
        (sampledDepth ? GPU_TEXTURE_USAGE_TEXTURE_BINDING : 0),
      viewFormats: undefined,
      textureBindingViewDimension: undefined,
    });
    if (!depth.ok) return failed(depth.error);
    allocations.push(depth.value);
    const depthView = device.createTextureView(depth.value, {
      dimension: '2d',
      baseArrayLayer: descriptor.sampleCount === 4 ? 0 : face,
      arrayLayerCount: 1,
    });
    if (!depthView.ok) return failed(depthView.error);
    depthTextures.push(depth.value);
    depthViews.push(depthView.value);
  }
  if (descriptor.sampleCount === 4) {
    for (let face = 0; face < layers; face += 1) {
      const msaa = device.createTexture({
        label: `render-target.${generation}.msaa.${face}`,
        size: { width: descriptor.width, height: descriptor.height, depthOrArrayLayers: 1 },
        format: descriptor.format,
        mipLevelCount: 1,
        sampleCount: 4,
        dimension: '2d',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        viewFormats: undefined,
        textureBindingViewDimension: undefined,
      });
      if (!msaa.ok) return failed(msaa.error);
      allocations.push(msaa.value);
      const msaaView = device.createTextureView(msaa.value, {
        dimension: '2d',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 1,
      });
      if (!msaaView.ok) return failed(msaaView.error);
      colorTextures.push(msaa.value);
      faceViews.push(msaaView.value);
    }
  } else {
    for (let face = 0; face < layers; face += 1) {
      colorTextures.push(texture);
      faceViews.push(resolveFaceViews[face] ?? view.value);
    }
  }
  return {
    ok: true,
    value: {
      device,
      ...(sampledDepth ? { sampledDepth: true as const } : {}),
      generation,
      descriptor,
      texture,
      view: view.value,
      mipViews,
      colorTextures,
      faceViews,
      depthTextures,
      depthViews,
      ...(descriptor.sampleCount === 4 ? { resolveTexture: texture } : {}),
      resolveView: view.value,
      resolveFaceViews,
    },
  };
}

export function destroyRenderTargetPhysical(
  physical: RenderTargetPhysical | undefined,
): RenderResult<void, RenderError> {
  if (physical === undefined) return { ok: true, value: undefined };
  const device = physical.device;
  const textures = new Set<Texture>();
  textures.add(physical.texture);
  if (physical.resolveTexture !== undefined) textures.add(physical.resolveTexture);
  for (const texture of physical.colorTextures) textures.add(texture);
  for (const texture of physical.depthTextures) textures.add(texture);
  const failures = destroyTextures(device, textures);
  return failures.length === 0
    ? { ok: true, value: undefined }
    : {
        ok: false,
        error: new RenderTargetOperationFailedError({
          operation: 'destroy',
          stage: 'retire',
          generation: physical.generation,
          cause: new AggregateError(failures, 'Render target retirement failed'),
          recovery: 'recover',
        }),
      };
}

/** Retire on the allocation queue and route asynchronous failures to its owner. */
export function retireRenderTargetPhysical(
  physical: RenderTargetPhysical,
  reportError: (error: RenderError) => void,
): void {
  const release = () => {
    const result = destroyRenderTargetPhysical(physical);
    if (!result.ok) reportError(result.error);
  };
  try {
    void physical.device.queue.onSubmittedWorkDone().then(release, release);
  } catch (cause) {
    release();
    reportError(
      new RenderTargetOperationFailedError({
        operation: 'destroy',
        stage: 'retire',
        generation: physical.generation,
        cause,
        recovery: 'recover',
      }),
    );
  }
}

function destroyTextures(device: RhiDevice, textures: Iterable<Texture>): unknown[] {
  const failures: unknown[] = [];
  for (const texture of textures) {
    try {
      const destroyed = device.destroyTexture(texture);
      if (!destroyed.ok) failures.push(destroyed.error);
    } catch (cause) {
      failures.push(cause);
    }
  }
  return failures;
}
