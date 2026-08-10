import type { ImportProduct } from '@forgeax/engine-types';
import { projectSourcePackageProduct } from '../import-products.js';

export interface AssetProductionProjection {
  readonly product: Pick<ImportProduct<unknown>, 'assets'>;
  readonly logicalPackage: ReturnType<typeof projectSourcePackageProduct>;
}

/** Build-time projection seam; DDC storage and Vite lifecycle stay outside it. */
export function projectAssetProduction(
  product: Pick<ImportProduct<unknown>, 'assets'>,
): AssetProductionProjection {
  return {
    product,
    logicalPackage: projectSourcePackageProduct(product),
  };
}
