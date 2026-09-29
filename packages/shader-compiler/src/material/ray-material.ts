import {
  admitRayMaterial,
  type RayMaterialError,
  type RaySurfaceProgram,
  rayMaterialContract,
  rayMaterialFailure,
} from '@forgeax/engine-shader';
import {
  type MaterialAsset,
  type MaterialError,
  type MaterialTable,
  ok,
  type Result,
} from '@forgeax/engine-types';
import type { ShaderError } from '../errors.js';
import { compileShader } from '../index.js';
import { composeSurfaceSource, digestMaterialSourceClosure } from './compose.js';
import { lowerStandardContract, lowerStandardPhysicalBindings } from './lower-standard-contract.js';
import { generateParameterModule } from './parameter-module.js';
import { resolveMaterialAsset } from './resolve.js';
import type { MaterialSourceCatalog } from './source-catalog.js';

export interface RayMaterialCookRequest {
  readonly material: string;
  readonly table: MaterialTable;
  readonly sources: MaterialSourceCatalog;
  /** The diagnostic raster adapter evaluates the exact same Surface at matched points. */
  readonly context?: RaySurfaceProgram['context'];
}
export interface CookedRayMaterial {
  readonly asset: MaterialAsset;
  readonly program: RaySurfaceProgram;
  readonly sourceClosure: readonly string[];
}
/** Build-time derivative of the same resolved MaterialAsset; never called by the player. */
export async function cookRayMaterial(
  request: RayMaterialCookRequest,
): Promise<Result<CookedRayMaterial, MaterialError | RayMaterialError | ShaderError>> {
  const resolved = resolveMaterialAsset(request.material, request.table);
  if (!resolved.ok) return resolved;
  const asset = resolved.value.asset;
  const admitted = admitRayMaterial(asset, request.material);
  if (!admitted.ok) return admitted;
  const lowered = lowerStandardContract(asset.parameters ?? [], asset.passes, request.material);
  if (!lowered.ok) return lowered;
  const forward = asset.passes?.find((p) => p.name.toLowerCase() === 'forward');
  const context = request.context ?? 'ray-hit';
  const surfaceModule =
    forward?.program.moduleSlots?.surface ??
    asset.surface?.module ??
    'forgeax_material::default_standard_surface';
  if (context === 'card-capture' && surfaceModule !== 'forgeax_material::default_standard_surface')
    return rayMaterialFailure(
      request.material,
      surfaceModule,
      'canonical Standard card capture; custom/view-dependent capture is not qualified',
    );
  const composed = composeSurfaceSource({
    material: request.material,
    pass: 'ray-hit',
    templateModule: 'forgeax_material::ray_surface',
    sources: request.sources,
    generatedParameters: generateParameterModule(lowered.value.paramSchema),
    surfaceModule,
  });
  if (!composed.ok) return composed;
  const source = lowerStandardPhysicalBindings(composed.value.source, lowered.value.paramSchema);
  const defines = {
    ...lowered.value.defines,
    ALPHA_HASH_AVAILABLE: false,
    RAY_SURFACE_CONTEXT: context === 'ray-hit',
    CARD_SURFACE_CONTEXT: context === 'card-capture',
  };
  const compiled = await compileShader(source, {
    id: `ray-surface:${request.material}:${request.context ?? 'ray-hit'}`,
    imports: { ...composed.value.imports },
    defines,
  });
  if (!compiled.ok) return compiled;
  return ok({
    asset,
    sourceClosure: composed.value.sourceClosure,
    program: {
      context,
      wgsl: compiled.value.wgsl,
      paramSchema: lowered.value.paramSchema,
      contract: rayMaterialContract(asset),
      sourceClosureDigest: digestMaterialSourceClosure({
        ...composed.value.imports,
        source,
        context: JSON.stringify(defines),
      }),
    },
  });
}
