import type { RenderError } from '../errors/render';
import {
  RenderTargetCapabilityMissingError,
  RenderTargetDescriptorInvalidError,
} from '../errors/render';
import type { RenderResult } from '../render-contract';

export type RenderTargetFormat = 'rgba16float' | 'rgba8unorm' | 'rgba8unorm-srgb';
export type RenderTargetShape = '2d' | 'cube';
export type RenderTargetMipLevels = 1 | 'full';
export type RenderTargetSampleCount = 1 | 4;
export type RenderTargetDepthFormat =
  | 'depth24plus-stencil8'
  | 'depth32float-stencil8'
  | 'depth32float';

export interface RenderTargetDescriptor {
  readonly shape: RenderTargetShape;
  readonly width: number;
  readonly height: number;
  readonly format: RenderTargetFormat;
  readonly mipLevels: RenderTargetMipLevels;
  readonly sampleCount: RenderTargetSampleCount;
  readonly depth?: RenderTargetDepthFormat;
  readonly sampled: boolean;
  readonly readback: boolean;
}

declare const RenderTargetBrand: unique symbol;
declare const RenderTargetTextureSourceBrand: unique symbol;
declare const RenderTargetReadbackTicketBrand: unique symbol;

/** Opaque logical target lease owned by one Renderer. */
export interface RenderTarget {
  readonly [RenderTargetBrand]: 'RenderTarget';
}

export type RenderTargetTextureAspect = 'color';

export interface RenderTargetTextureSourceOptions {
  readonly aspect: RenderTargetTextureAspect;
  readonly dimension: RenderTargetShape;
  readonly mipLevel: number;
}

/** Renderer-local runtime material source; it is not an asset handle. */
export interface RenderTargetTextureSource {
  readonly [RenderTargetTextureSourceBrand]: 'RenderTargetTextureSource';
}

export interface RenderTargetReadbackRequest {
  readonly mipLevel: number;
  /** Cube array layer to copy; 2D targets accept only the omitted form. */
  readonly face?: number;
}

/** One-shot readback request bound to a future matching FrameReceipt. */
export interface RenderTargetReadbackTicket {
  readonly [RenderTargetReadbackTicketBrand]: 'RenderTargetReadbackTicket';
}

/** Bytes released by observe after the ticket's matching frame completes. */
export interface RenderTargetReadbackData {
  readonly ticket: RenderTargetReadbackTicket;
  readonly bytes: Uint8Array;
  readonly frameId: number;
  readonly deviceGeneration: number;
  readonly mipLevel: number;
  readonly face?: number;
  readonly bytesPerRow: number;
  readonly byteLength: number;
}

export interface RenderTargetAdmissionLimits {
  readonly maxTextureDimension2D: number;
  readonly maxBytesPerTarget: number;
  readonly renderableFormats: readonly RenderTargetFormat[];
  readonly sampleCounts: readonly RenderTargetSampleCount[];
  readonly depthFormats: readonly RenderTargetDepthFormat[];
}

const FORMAT_BYTES: Readonly<Record<RenderTargetFormat, number>> = {
  rgba16float: 8,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
};

function mipFactor(mipLevels: RenderTargetMipLevels): number {
  return mipLevels === 'full' ? 4 / 3 : 1;
}

function estimatedBytes(descriptor: RenderTargetDescriptor): number {
  const layers = descriptor.shape === 'cube' ? 6 : 1;
  const samples = descriptor.sampleCount;
  const depthBytes =
    descriptor.depth === undefined ? 0 : descriptor.depth === 'depth32float-stencil8' ? 8 : 4;
  return Math.ceil(
    descriptor.width *
      descriptor.height *
      FORMAT_BYTES[descriptor.format] *
      layers *
      samples *
      mipFactor(descriptor.mipLevels) +
      descriptor.width *
        descriptor.height *
        depthBytes *
        layers *
        samples *
        mipFactor(descriptor.mipLevels),
  );
}

function invalid(
  field: string,
  value: unknown,
  expected: string,
): RenderResult<never, RenderError> {
  return {
    ok: false,
    error: new RenderTargetDescriptorInvalidError({ field, value, expected }),
  };
}

/** Validate descriptor facts before a renderer allocates a physical target. */
export function admitRenderTargetDescriptor(
  descriptor: RenderTargetDescriptor,
  limits: RenderTargetAdmissionLimits,
): RenderResult<RenderTargetDescriptor, RenderError> {
  if (!Number.isInteger(descriptor.width) || descriptor.width < 1) {
    return invalid('width', descriptor.width, 'an integer >= 1');
  }
  if (!Number.isInteger(descriptor.height) || descriptor.height < 1) {
    return invalid('height', descriptor.height, 'an integer >= 1');
  }
  if (
    descriptor.width > limits.maxTextureDimension2D ||
    descriptor.height > limits.maxTextureDimension2D
  ) {
    return invalid(
      'extent',
      { width: descriptor.width, height: descriptor.height },
      `width and height <= ${limits.maxTextureDimension2D}`,
    );
  }
  if (descriptor.shape === 'cube' && descriptor.width !== descriptor.height) {
    return invalid('shape', descriptor.shape, 'cube width === height');
  }
  if (!limits.renderableFormats.includes(descriptor.format)) {
    return {
      ok: false,
      error: new RenderTargetCapabilityMissingError({
        operation: 'create',
        requested: descriptor.format,
        capability: 'renderableFormats',
        actual: limits.renderableFormats.join(', '),
      }),
    };
  }
  if (!limits.sampleCounts.includes(descriptor.sampleCount)) {
    return {
      ok: false,
      error: new RenderTargetCapabilityMissingError({
        operation: 'create',
        requested: String(descriptor.sampleCount),
        capability: 'sampleCounts',
        actual: limits.sampleCounts.join(', '),
      }),
    };
  }
  if (descriptor.depth !== undefined && !limits.depthFormats.includes(descriptor.depth)) {
    return {
      ok: false,
      error: new RenderTargetCapabilityMissingError({
        operation: 'create',
        requested: descriptor.depth,
        capability: 'depthFormats',
        actual: limits.depthFormats.join(', '),
      }),
    };
  }
  const bytes = estimatedBytes(descriptor);
  if (bytes > limits.maxBytesPerTarget) {
    return invalid('bytes', bytes, `estimated allocation <= ${limits.maxBytesPerTarget}`);
  }
  return { ok: true, value: descriptor };
}
