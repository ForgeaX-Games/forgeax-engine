import { ok } from '@forgeax/engine-types';
import type {
  RenderFeatureFullscreenRead,
  RenderFeaturePlan,
  RenderFeaturePlanContext,
} from './plan';
import type { RenderFeature, RenderFeatureExtractContext } from './types';

/** Host-owned fullscreen effect declaration carried by one RenderFeature. */
export interface FullscreenRenderFeatureOptions {
  readonly identity: string;
  readonly source: string;
  readonly reads?: readonly RenderFeatureFullscreenRead[];
  readonly params?: {
    readonly byteSize: number;
    readonly defaultValue: Uint8Array;
  };
}

/**
 * Describe a fullscreen effect for the single feature host.
 * The producer returns this closed feature; GPU registration and lifetime stay
 * with the renderer host.
 */
export function createFullscreenRenderFeature(
  options: FullscreenRenderFeatureOptions,
): RenderFeature<undefined> {
  const resourceName = `fullscreen.${options.identity.replace(/[^a-z0-9.-]/gi, '-').toLowerCase()}`;
  return Object.freeze({
    identity: options.identity,
    extract: (_context: RenderFeatureExtractContext) => ok(undefined),
    plan: (_data: undefined, _context: RenderFeaturePlanContext) =>
      ok({
        resources: [
          {
            kind: 'fullscreen-program',
            name: resourceName,
            source: options.source,
            ...(options.reads === undefined ? {} : { reads: options.reads }),
            ...(options.params === undefined ? {} : { params: options.params }),
          },
        ],
        passes: [],
      } satisfies RenderFeaturePlan),
  });
}
