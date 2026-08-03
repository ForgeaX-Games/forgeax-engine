import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { Asset, Result } from '@forgeax/engine-types';
import { err, ok, toShared } from '@forgeax/engine-types';

/** Closed animation-domain failure codes for World-local asset lookup. */
export type AnimationAssetErrorCode =
  | 'animation-asset-not-found'
  | 'animation-asset-stale'
  | 'animation-asset-kind-mismatch';

/** Machine-readable cause retained from the lower-level World lookup. */
export interface AnimationAssetErrorDetail {
  readonly handle: number;
  readonly expectedKind: string;
  readonly actualKind?: string;
  /** The exact code returned by `resolveAssetHandle`, before domain mapping. */
  readonly lookupCode: string;
}

/**
 * Structured failure for an animation graph or direct clip handle.
 *
 * The domain code is intentionally smaller than the ECS/assets union: callers
 * recover by animation semantics, while `detail.lookupCode` preserves the
 * observable lower-level cause for diagnostics (including `shared-ref-stale`).
 */
export class AnimationAssetError extends Error {
  readonly code: AnimationAssetErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AnimationAssetErrorDetail;

  constructor(args: {
    code: AnimationAssetErrorCode;
    expected: string;
    hint: string;
    detail: AnimationAssetErrorDetail;
  }) {
    super(`[AnimationAssetError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'AnimationAssetError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}

/**
 * Resolve a graph or clip handle from the owning World.
 *
 * Zero is the component sentinel and returns `ok(undefined)` without touching
 * the asset store. Every non-zero handle takes the single assets-runtime
 * lookup path; misses and stale handles become structured animation errors.
 */
export function resolveAnimationAsset<T extends Asset>(
  world: World,
  raw: number,
  expectedKind: string,
): Result<T | undefined, AnimationAssetError> {
  if (raw === 0) return ok(undefined);

  const lookup = resolveAssetHandle<T>(world, toShared<string>(raw));
  if (!lookup.ok) {
    const lookupCode = lookup.error.code;
    const code: AnimationAssetErrorCode =
      lookupCode === 'shared-ref-stale' ? 'animation-asset-stale' : 'animation-asset-not-found';
    return err(
      new AnimationAssetError({
        code,
        expected: `a live shared<${expectedKind}> handle owned by this World`,
        hint:
          code === 'animation-asset-stale'
            ? 're-acquire the handle from this World after the previous allocation was released'
            : 'register or retain the animation asset in this World before evaluating it',
        detail: { handle: raw, expectedKind, lookupCode },
      }),
    );
  }

  const actualKind = lookup.value.kind;
  if (actualKind !== expectedKind) {
    return err(
      new AnimationAssetError({
        code: 'animation-asset-kind-mismatch',
        expected: `asset kind '${expectedKind}'`,
        hint: `replace handle ${raw} with a live ${expectedKind} handle`,
        detail: {
          handle: raw,
          expectedKind,
          actualKind,
          lookupCode: 'asset-kind-mismatch',
        },
      }),
    );
  }

  return ok(lookup.value);
}
