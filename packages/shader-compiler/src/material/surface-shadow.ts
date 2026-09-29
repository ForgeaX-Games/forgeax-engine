import { isStandardRootModule } from '@forgeax/engine-pack';
import { DEFAULT_STANDARD_SURFACE_MODULE } from '@forgeax/engine-shader';
import type { MaterialAsset, MaterialPass } from '@forgeax/engine-types';

/** The Surface wrapper certifies opacity; authored pass membership remains authoritative. */
export function deriveSurfaceShadowPasses(asset: MaterialAsset): MaterialAsset {
  const passes = asset.passes;
  if (passes === undefined) return asset;
  const surfaces = passes.filter((pass) => isStandardRootModule(pass.program.module));
  const surfaceOf = (pass: MaterialPass) =>
    pass.program.moduleSlots?.surface ?? asset.surface?.module ?? DEFAULT_STANDARD_SURFACE_MODULE;
  // Forward and Deferred may share one Surface opacity owner. Independent
  // Surface modules require an explicit shadow choice.
  if (surfaces.length === 0 || new Set(surfaces.map(surfaceOf)).size !== 1) return asset;
  const firstSurface = surfaces[0];
  if (firstSurface === undefined) return asset;
  const surface = surfaceOf(firstSurface);
  const inheritSurface = (pass: MaterialPass): MaterialPass =>
    pass.program.module === 'forgeax::default-shadow-caster' &&
    pass.program.moduleSlots?.surface === undefined
      ? {
          ...pass,
          program: { ...pass.program, moduleSlots: { ...pass.program.moduleSlots, surface } },
        }
      : pass;
  // Never add a pass here: Materials.surface/standard own default pass policy,
  // including castShadow:false. The compiler supplies the missing shadow ABI.
  const [first, ...rest] = passes;
  return { ...asset, passes: [inheritSurface(first), ...rest.map(inheritSurface)] };
}
