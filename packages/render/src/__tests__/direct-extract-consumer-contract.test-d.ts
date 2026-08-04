import type { World } from '@forgeax/engine-ecs';
import {
  extractFrame,
  extractFrames,
  type PreparedExtractContext,
} from '@forgeax/engine-render/internal';

declare const world: World;
declare const prepared: PreparedExtractContext;

extractFrames([world], 0);
extractFrame(world, prepared);

// Freshness belongs to extractFrames. A per-world kernel call must not compile
// without the context produced by the preparation seam.
// @ts-expect-error extractFrame requires prepared context
extractFrame(world);
// @ts-expect-error null is not a prepared context
extractFrame(world, null);
