import type { TextureFormat } from '@forgeax/engine-rhi';

/** Render-owned logical targets exposed to producer-owned RenderFeatures. */

export type RenderFeatureTargetKind = 'scene-color' | 'scene-depth';

/**
 * A logical attachment supplied by the active RenderPipeline.
 *
 * The semantic kind plus attachment facts identify the target. The active
 * pipeline supplies the graph resource, so feature authors never name an
 * internal graph key.
 */
export interface RenderFeatureTargetHandle {
  readonly kind: RenderFeatureTargetKind;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
  readonly __renderFeatureTarget: unique symbol;
}

export interface RenderFeatureTargetInput {
  readonly kind: RenderFeatureTargetKind;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
}

export function createRenderFeatureTarget(
  input: RenderFeatureTargetInput,
): RenderFeatureTargetHandle {
  return Object.freeze({ ...input }) as RenderFeatureTargetHandle;
}

export function isRenderFeatureTargetHandle(value: unknown): value is RenderFeatureTargetHandle {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<RenderFeatureTargetInput>;
  return (
    (candidate.kind === 'scene-color' || candidate.kind === 'scene-depth') &&
    typeof candidate.format === 'string' &&
    (candidate.sampleCount === 1 || candidate.sampleCount === 4)
  );
}

export function renderFeatureAttachmentResource(
  resource: string | RenderFeatureTargetHandle,
): string {
  return isRenderFeatureTargetHandle(resource) ? resource.kind : resource;
}

export function resolveStandardRenderFeatureTargets(input: {
  readonly tonemap: string;
  readonly antialias: string;
  readonly storageBuffer: boolean;
  readonly multisample: boolean;
  readonly colorAttachmentFormat: TextureFormat;
}): readonly RenderFeatureTargetHandle[] {
  const sampleCount: 1 | 4 = input.antialias === 'msaa' && input.multisample ? 4 : 1;
  const linearLdr = input.tonemap === 'none' && input.storageBuffer;
  return [
    createRenderFeatureTarget({
      kind: 'scene-color',
      format: input.tonemap !== 'none' || linearLdr ? 'rgba16float' : input.colorAttachmentFormat,
      sampleCount,
    }),
    createRenderFeatureTarget({
      kind: 'scene-depth',
      format: 'depth24plus-stencil8',
      sampleCount,
    }),
  ];
}
