import type { GraphExtent } from '@forgeax/engine-render-graph';

/** The one format of the shared closest-depth pyramid (linear view distance). */
export const DEPTH_PYRAMID_FORMAT = 'r32float' as const;

export interface DepthPyramidExtent {
  readonly width: number;
  readonly height: number;
}

export interface DepthPyramidLevelPlan extends DepthPyramidExtent {
  readonly level: number;
}

export interface DepthPyramidPlan {
  readonly extent: DepthPyramidExtent;
  readonly format: typeof DEPTH_PYRAMID_FORMAT;
  readonly mipLevelCount: number;
  readonly levels: readonly DepthPyramidLevelPlan[];
  readonly graphSize: GraphExtent;
}

function validExtent(extent: DepthPyramidExtent): boolean {
  return (
    Number.isInteger(extent.width) &&
    Number.isInteger(extent.height) &&
    extent.width > 0 &&
    extent.height > 0
  );
}

function requireExtent(extent: DepthPyramidExtent): void {
  if (!validExtent(extent)) {
    throw new RangeError('Depth pyramid extent must contain positive integer width and height');
  }
}

/** Derive the physical WebGPU floor-halved mip extent, clamped to one texel. */
export function nextDepthPyramidMipExtent(extent: DepthPyramidExtent): DepthPyramidExtent {
  requireExtent(extent);
  return {
    width: Math.max(1, Math.floor(extent.width / 2)),
    height: Math.max(1, Math.floor(extent.height / 2)),
  };
}

/** Derive the complete current-view depth pyramid descriptor without allocating a resource. */
export function buildDepthPyramidPlan(extent: DepthPyramidExtent): DepthPyramidPlan {
  requireExtent(extent);
  const levels: DepthPyramidLevelPlan[] = [];
  let current = { width: extent.width, height: extent.height };
  let level = 0;
  while (true) {
    levels.push({ level, ...current });
    if (current.width === 1 && current.height === 1) break;
    current = nextDepthPyramidMipExtent(current);
    level += 1;
  }
  return Object.freeze({
    extent: Object.freeze({ width: extent.width, height: extent.height }),
    format: DEPTH_PYRAMID_FORMAT,
    mipLevelCount: levels.length,
    levels: Object.freeze(levels.map((entry) => Object.freeze(entry))),
    graphSize: Object.freeze({ width: extent.width, height: extent.height }),
  });
}

/** Map an invalid or empty depth sample to the depth pyramid empty-pixel sentinel. */
export function normalizeDepthPyramidDepth(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

function depthPyramidCoverageStart(
  index: number,
  sourceSize: number,
  destinationSize: number,
): number {
  return Math.floor((index * sourceSize) / destinationSize);
}

function depthPyramidCoverageEnd(
  index: number,
  sourceSize: number,
  destinationSize: number,
): number {
  return Math.min(
    sourceSize,
    Math.floor(((index + 1) * sourceSize + destinationSize - 1) / destinationSize),
  );
}

/**
 * Reduce one mip level with the physical mip's complete coverage footprint.
 *
 * WebGPU mip dimensions are floor-halved, so a 3-wide source has a 1-wide
 * destination. The destination cells therefore use integer normalized
 * boundaries with a conservative ceil on the end boundary instead of
 * assuming a fixed 2x2 footprint. Adjacent cells overlap at odd boundaries;
 * this keeps boundary and trailing source columns/rows in the hierarchy.
 * The empty sentinel is infinity and therefore never wins over a finite
 * positive view-space depth. Invalid input samples are treated as empty so a
 * malformed depth cannot introduce NaN into the hierarchy.
 */
export function reduceDepthPyramidLevel(
  source: ArrayLike<number>,
  sourceExtent: DepthPyramidExtent,
): Float32Array {
  requireExtent(sourceExtent);
  const expectedLength = sourceExtent.width * sourceExtent.height;
  if (source.length !== expectedLength) {
    throw new RangeError(`Depth pyramid source length must equal ${expectedLength}`);
  }
  const destination = nextDepthPyramidMipExtent(sourceExtent);
  const reduced = new Float32Array(destination.width * destination.height);
  for (let y = 0; y < destination.height; y += 1) {
    for (let x = 0; x < destination.width; x += 1) {
      let minimum = Number.POSITIVE_INFINITY;
      const startY = depthPyramidCoverageStart(y, sourceExtent.height, destination.height);
      const endY = depthPyramidCoverageEnd(y, sourceExtent.height, destination.height);
      const startX = depthPyramidCoverageStart(x, sourceExtent.width, destination.width);
      const endX = depthPyramidCoverageEnd(x, sourceExtent.width, destination.width);
      for (let sampleY = startY; sampleY < endY; sampleY += 1) {
        for (let sampleX = startX; sampleX < endX; sampleX += 1) {
          const sample = normalizeDepthPyramidDepth(
            source[sampleY * sourceExtent.width + sampleX] ?? 0,
          );
          minimum = Math.min(minimum, sample);
        }
      }
      reduced[y * destination.width + x] = minimum;
    }
  }
  return reduced;
}
