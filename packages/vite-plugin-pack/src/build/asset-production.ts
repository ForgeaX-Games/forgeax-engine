import type { ImportProduct } from '@forgeax/engine-types';
import { projectImportProductForBuild } from '../import-products.js';

export interface AssetProductionProjection {
  readonly product: Pick<ImportProduct<unknown>, 'assets'>;
  readonly logicalPackage: ReturnType<typeof projectImportProductForBuild>;
}

/** Build-time projection seam; DDC storage and Vite lifecycle stay outside it. */
export function projectAssetProduction(
  product: Pick<ImportProduct<unknown>, 'assets'>,
): AssetProductionProjection {
  return {
    product,
    logicalPackage: projectImportProductForBuild(product),
  };
}
