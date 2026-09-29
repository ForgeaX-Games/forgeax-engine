import type { MaterialAsset, MaterialPass, MaterialRootAsset } from '@forgeax/engine-types';
import scalar from './standard-clearcoat.pack.json' with { type: 'json' };
import factor from './standard-clearcoat-factor-r.pack.json' with { type: 'json' };
import roughness from './standard-clearcoat-roughness-g.pack.json' with { type: 'json' };
import normal from './standard-clearcoat-normal-rg.pack.json' with { type: 'json' };
import full from './standard-full-physical.pack.json' with { type: 'json' };
import skinFactor from './skin-clearcoat-factor-r.pack.json' with { type: 'json' };
import skinRoughness from './skin-clearcoat-roughness-g.pack.json' with { type: 'json' };
import skinNormal from './skin-clearcoat-normal-rg.pack.json' with { type: 'json' };
import skinFull from './skin-full-physical.pack.json' with { type: 'json' };

const contracts = new Map(
  [scalar, factor, roughness, normal, full, skinFactor, skinRoughness, skinNormal, skinFull].map(
    (pack) => {
      const material = pack.assets[0]!.payload as unknown as MaterialRootAsset;
      if (material.passes === undefined) throw new Error('Physical shader package has no passes');
      return [material.passes[0]!.program.module, material] as const;
    },
  ),
);

/** Use the same parameter ABI as the shader package, not the default root ABI. */
export function withPhysicalMaterialModule(material: MaterialAsset, module: string): MaterialAsset {
  const contract = contracts.get(
    module === 'physical-material::standard-clearcoat-mutant'
      ? 'physical-material::standard-clearcoat'
      : module,
  );
  if (contract === undefined) throw new Error(`Unknown physical material contract: ${module}`);
  if (material.passes === undefined) throw new Error('Physical material must have resolved passes');
  const replace = (pass: MaterialPass): MaterialPass =>
    pass.name === 'shadow-caster'
      ? pass
      : { ...pass, program: { ...pass.program, module } };
  const [first, ...rest] = material.passes;
  return {
    ...material,
    parameters: contract.parameters ?? [],
    passes: [replace(first), ...rest.map(replace)],
  };
}
