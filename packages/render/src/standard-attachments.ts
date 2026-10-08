import { textureFormatBlock } from '@forgeax/engine-types';

export const DEFERRED_COLOR_FORMATS = [
  'rgba16float',
  'r32uint',
  'r32uint',
  'r32uint',
  'r32uint',
  'rg32uint',
] as const satisfies readonly GPUTextureFormat[];

export const STANDARD_TEMPORAL_FORMAT = 'rgba16float' as const;
export const STANDARD_VISIBLE_SURFACE_FORMAT = 'rgba32uint' as const;

const surface = DEFERRED_COLOR_FORMATS.reduce(
  (bytes, format) => bytes + textureFormatBlock(format).bytesPerBlock,
  0,
);
const temporal = textureFormatBlock(STANDARD_TEMPORAL_FORMAT).bytesPerBlock;
const visibleSurface = textureFormatBlock(STANDARD_VISIBLE_SURFACE_FORMAT).bytesPerBlock;

// These Standard attachment costs equal their texel block sizes. The same
// formats own graph targets, device requests and merged temporal MRT admission.
export const DEFERRED_ATTACHMENT_BYTES = {
  surface,
  temporal: surface + temporal,
  visibleSurface: surface + visibleSurface,
  visibleSurfaceTemporal: surface + visibleSurface + temporal,
} as const;
