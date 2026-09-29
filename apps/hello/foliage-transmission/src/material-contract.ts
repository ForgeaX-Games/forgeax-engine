import type { MaterialAsset, MaterialPass, MaterialRootAsset } from '@forgeax/engine-types';
import leaf from './leaf-diffuse-transmission.pack.json' with { type: 'json' };

/**
 * Physical Standard layers are selected by the cooked root contract, not by
 * runtime values: the shader plugin cooks this package into an alias of the
 * Engine Standard template with `DIFFUSE_TRANSMISSION_AVAILABLE` enabled. The
 * root declares the optional factor texture; an unbound slot falls back to
 * white (alpha 1), so uniform and masked leaves share one program.
 */
export const FOLIAGE_MATERIAL_PACKAGES = ['leaf-diffuse-transmission.pack.json'] as const;

const contract = leaf.assets[0]?.payload as unknown as MaterialRootAsset;
const module = contract.passes?.[0]?.program.module;
if (module === undefined) throw new Error('Foliage material package has no pass module');

/** Bind a runtime Standard material to the cooked diffuse-transmission alias. */
export function withFoliageMaterialModule(material: MaterialAsset): MaterialAsset {
  if (material.passes === undefined) throw new Error('Foliage material must have resolved passes');
  const replace = (pass: MaterialPass): MaterialPass =>
    pass.name === 'shadow-caster' || module === undefined
      ? pass
      : { ...pass, program: { ...pass.program, module } };
  const [first, ...rest] = material.passes;
  return {
    ...material,
    parameters: contract.parameters ?? [],
    passes: [replace(first), ...rest.map(replace)],
  };
}
