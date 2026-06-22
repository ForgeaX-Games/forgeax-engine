// M3 / w19: PassSelector matching logic
// (feat-20260526-material-asset-multipass-renderstate)
//
// Pure-function helpers for matching MaterialPassDescriptor tags against
// a PassSelector. Plan-strategy D-4: Tags free Record + PassSelector
// Record<string, string[]>. Requirements AC-05.

import type { MaterialPassDescriptor, PassSelector } from '@forgeax/engine-types';

/**
 * Test whether a pass's tags match a {@link PassSelector}.
 *
 * Matching rule (AC-05): every key in the selector must exist in the pass's
 * `tags` and the pass's tag value must be in the selector's value list for
 * that key. An empty selector matches every pass.
 *
 * @param tags The pass-level tags (free key-value pairs)
 * @param selector The selector to match against
 */
export function matchPass(tags: Record<string, string>, selector: PassSelector): boolean {
  if (Object.keys(selector).length === 0) return true;
  for (const [key, allowedValues] of Object.entries(selector)) {
    const passValue = tags[key];
    if (passValue === undefined) return false;
    if ((allowedValues as readonly string[]).length === 0) return false;
    if (!(allowedValues as readonly string[]).includes(passValue)) return false;
  }
  return true;
}

/**
 * Filter passes whose tags match the given {@link PassSelector}.
 *
 * An empty selector matches all passes (returns the input array reference).
 * Otherwise each pass is checked via {@link matchPass}.
 *
 * @param passes The material's pass descriptors
 * @param selector The pass selector
 * @returns Filtered array of matching passes
 */
export function selectPasses(
  passes: readonly MaterialPassDescriptor[],
  selector: PassSelector,
): readonly MaterialPassDescriptor[] {
  if (Object.keys(selector).length === 0) return passes;
  return passes.filter((p) => matchPass(p.tags ?? {}, selector));
}
