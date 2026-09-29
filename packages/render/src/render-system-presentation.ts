import type { RenderResourceScope } from './publication/resource-scope';
import type { RenderSystemInternals } from './record/render-context';
import type { FramePresentation } from './render-contract';
import type { DispatchEntry, RenderableSnapshot } from './render-system-extract';
import { observeMaterialResidency } from './render-system-residency';

export interface FramePresentationProjection {
  readonly renderables: readonly RenderableSnapshot[];
  readonly presentation: FramePresentation;
}

/**
 * Derive the startup presentation candidate from the current display workset.
 * Shadow-only retained rows are deliberately excluded, while material facts
 * still come from the producer-owned residency projection.
 */
export function projectFramePresentation(input: {
  readonly hasCamera: boolean;
  readonly environmentReady: boolean;
  readonly hasEnvironment: boolean;
  readonly submissionRenderables: readonly RenderableSnapshot[];
  readonly submissionDispatch: readonly DispatchEntry[];
  readonly preparedWorlds: readonly RenderResourceScope[];
  readonly internals: RenderSystemInternals;
}): FramePresentationProjection {
  const displayRenderableIndices = new Set<number>();
  for (const entry of input.submissionDispatch) {
    if (entry.renderableIndex === undefined) continue;
    if (entry.tags.LightMode !== 'ShadowCaster')
      displayRenderableIndices.add(entry.renderableIndex);
  }
  const renderables = input.submissionRenderables.filter(
    (_, index) =>
      displayRenderableIndices.has(index) &&
      input.submissionRenderables[index]?.authorVisible !== false,
  );

  let presentation: FramePresentation = 'ready';
  if (input.hasCamera && (!input.environmentReady || !input.hasEnvironment)) {
    presentation = 'pending';
  } else if (input.hasCamera) {
    for (const renderable of renderables) {
      const materialWorld = input.preparedWorlds[renderable.worldId];
      for (const material of renderable.materials) {
        if (
          observeMaterialResidency(materialWorld, material, input.internals).readiness === 'pending'
        ) {
          presentation = 'pending';
          break;
        }
      }
      if (presentation === 'pending') break;
    }
  }
  return { renderables, presentation };
}
