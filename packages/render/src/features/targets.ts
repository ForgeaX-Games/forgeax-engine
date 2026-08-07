/** Render-owned logical targets exposed to producer-owned RenderFeatures. */

export type RenderFeatureTargetKind = 'scene-color' | 'scene-depth';

/**
 * A logical attachment supplied by the active RenderPipeline.
 *
 * `resource` is only the graph dependency key. The record stage resolves the
 * physical view from the active frame's geometry target state, which keeps the
 * contract correct for HDR, LDR, and MSAA routes without exposing GPU handles.
 */
export interface RenderFeatureTargetHandle {
  readonly kind: RenderFeatureTargetKind;
  readonly resource: string;
  readonly format: string;
  readonly sampleCount: 1 | 4;
  readonly __renderFeatureTarget: unique symbol;
}

export interface RenderFeatureTargetInput {
  readonly kind: RenderFeatureTargetKind;
  readonly resource: string;
  readonly format: string;
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
    typeof candidate.resource === 'string' &&
    typeof candidate.format === 'string' &&
    (candidate.sampleCount === 1 || candidate.sampleCount === 4)
  );
}

export function renderFeatureAttachmentResource(
  resource: string | RenderFeatureTargetHandle,
): string {
  return isRenderFeatureTargetHandle(resource) ? resource.resource : resource;
}
