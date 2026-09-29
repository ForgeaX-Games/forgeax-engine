import { isStandardRootModule } from '@forgeax/engine-pack';
import type { MaterialParameter, MaterialPass, StandardLayerPlan } from '@forgeax/engine-types';
import { deriveStandardLayerPlan } from '@forgeax/engine-types';

/**
 * Renderer projection of the compiler-owned Standard layer contract.
 *
 * The renderer receives the prepared parameter/pass snapshot and never keeps
 * a second parameter-name inventory. This function is intentionally pure so
 * assembly and tests observe the same mode and pass family as cooking.
 */
export function projectStandardLayerPlan(
  parameters: readonly MaterialParameter[],
  passes: readonly MaterialPass[],
): StandardLayerPlan {
  const standard = passes.some((pass) => isStandardRootModule(pass.program.module));
  return deriveStandardLayerPlan(standard ? parameters : [], standard ? passes : undefined);
}
