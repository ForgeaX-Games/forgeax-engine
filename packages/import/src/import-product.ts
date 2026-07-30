import type { AssetRef, ImportedAsset, MaterialAsset, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

export interface MaterialImportRefs {
  readonly parent: readonly string[];
  readonly textures: readonly string[];
  readonly samplers: readonly string[];
  readonly modules: readonly string[];
}

export interface MaterialSourceEvidence {
  readonly inputFingerprint: string;
  readonly importerVersion: string;
}

export interface MaterialImportProductInput {
  readonly guid: string;
  readonly sourcePath: string;
  readonly material: MaterialAsset;
  readonly refs: MaterialImportRefs;
  readonly sourceEvidence: MaterialSourceEvidence;
}

export interface MaterialImportProduct {
  readonly asset: ImportedAsset<MaterialAsset>;
  readonly sourcePath: string;
  readonly sourceEvidence: MaterialSourceEvidence;
}

export interface MaterialImportProductError {
  readonly code: 'material-import-product-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly field: string };
}

function invalid(field: string): Result<never, MaterialImportProductError> {
  return err({
    code: 'material-import-product-invalid',
    expected: 'an authored MaterialAsset with complete dependency references',
    hint: 'declare every material dependency before the product enters the cook pipeline',
    detail: { field },
  });
}

function distinct(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function createMaterialImportProduct(
  input: MaterialImportProductInput,
): Result<MaterialImportProduct, MaterialImportProductError> {
  if (!input.guid || !input.sourcePath) return invalid('guid/sourcePath');
  if (input.material.kind !== 'material') return invalid('material.kind');
  if (!input.sourceEvidence.inputFingerprint || !input.sourceEvidence.importerVersion) {
    return invalid('sourceEvidence');
  }
  const refs = distinct([
    ...input.refs.parent,
    ...input.refs.textures,
    ...input.refs.samplers,
    ...input.refs.modules,
  ]);
  return ok({
    sourcePath: input.sourcePath,
    sourceEvidence: input.sourceEvidence,
    asset: {
      guid: input.guid,
      kind: 'material',
      payload: input.material,
      refs: refs.map((guid): AssetRef => ({ guid })),
      artifacts: {},
    },
  });
}

export function materialImportProductReady(
  product: MaterialImportProduct,
  availableRefs: ReadonlySet<string>,
): boolean {
  return product.asset.refs.every((reference) => availableRefs.has(reference.guid));
}
