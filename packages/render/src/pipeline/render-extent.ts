/** Immutable dimensions shared by every Standard graph consumer. */
export interface RenderExtent {
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly internalWidth: number;
  readonly internalHeight: number;
  readonly scale: number;
  readonly generation: number;
}

export interface RenderExtentInput {
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly requestedScale: number;
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly generation: number;
}

export type RenderExtentDomain = 'internal' | 'output' | 'authoring';

/** Project the immutable extent into a graph texture descriptor size. */
export function renderExtentSize(
  extent: RenderExtent,
  domain: RenderExtentDomain,
): { readonly width: number; readonly height: number } {
  if (domain === 'internal') {
    return { width: extent.internalWidth, height: extent.internalHeight };
  }
  return { width: extent.outputWidth, height: extent.outputHeight };
}

export type StandardLightingLane = 'direct' | 'clustered' | 'cpu-webgl2';

export interface StandardExtentDomainPlan {
  readonly extent: RenderExtent;
  readonly lane: StandardLightingLane;
  readonly topologyKey: string;
  readonly dynamicDelta: 0 | 1;
  readonly domains: {
    readonly internal: { readonly width: number; readonly height: number };
    readonly output: { readonly width: number; readonly height: number };
    readonly authoring: { readonly width: number; readonly height: number };
  };
  readonly resources: readonly {
    readonly name: string;
    readonly domain: 'internal' | 'output' | 'authoring';
  }[];
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 1;
const SCALE_STEPS = 32;
const AXIS_ALIGNMENT = 8;

function alignedAxis(output: number, scale: number): number {
  return Math.max(AXIS_ALIGNMENT, Math.floor((output * scale) / AXIS_ALIGNMENT) * AXIS_ALIGNMENT);
}

function finiteDimension(value: number): number {
  return Math.max(1, Math.floor(value));
}

/** Derive the one immutable Standard extent before graph construction. */
export function deriveRenderExtent(input: RenderExtentInput): RenderExtent {
  const outputWidth = finiteDimension(input.outputWidth);
  const outputHeight = finiteDimension(input.outputHeight);
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, input.requestedScale));
  const scale = Math.max(
    input.minScale ?? MIN_SCALE,
    Math.min(input.maxScale ?? MAX_SCALE, Math.round(clamped * SCALE_STEPS) / SCALE_STEPS),
  );
  const nativeSurface = outputWidth < AXIS_ALIGNMENT || outputHeight < AXIS_ALIGNMENT;
  const internalWidth = nativeSurface ? outputWidth : alignedAxis(outputWidth, scale);
  const internalHeight = nativeSurface ? outputHeight : alignedAxis(outputHeight, scale);
  return Object.freeze({
    outputWidth,
    outputHeight,
    internalWidth,
    internalHeight,
    scale: nativeSurface ? 1 : scale,
    generation: input.generation,
  });
}

/** Describe Standard's shared internal/output/authoring domain assignment. */
export function standardExtentDomainPlan(
  extent: RenderExtent,
  lane: StandardLightingLane,
): StandardExtentDomainPlan {
  const domains = {
    internal: { width: extent.internalWidth, height: extent.internalHeight },
    output: { width: extent.outputWidth, height: extent.outputHeight },
    authoring: { width: extent.outputWidth, height: extent.outputHeight },
  } as const;
  return Object.freeze({
    extent,
    lane,
    topologyKey: `standard:${extent.internalWidth}x${extent.internalHeight}:${extent.outputWidth}x${extent.outputHeight}:g${extent.generation}`,
    dynamicDelta: extent.scale === 1 ? 0 : 1,
    domains,
    resources: Object.freeze([
      { name: 'scene', domain: 'internal' },
      { name: 'depth', domain: 'internal' },
      { name: 'g-buffer', domain: 'internal' },
      { name: 'scene-temporal', domain: 'internal' },
      { name: 'ssao', domain: 'internal' },
      { name: 'taa-history', domain: 'output' },
      { name: 'bloom', domain: 'output' },
      { name: 'output', domain: 'output' },
      { name: 'overlay', domain: 'output' },
      { name: 'observation', domain: 'output' },
      { name: 'shadow', domain: 'authoring' },
    ] satisfies StandardExtentDomainPlan['resources']),
  });
}
