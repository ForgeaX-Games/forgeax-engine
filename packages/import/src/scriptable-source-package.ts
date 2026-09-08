import { AssetGuid } from '@forgeax/engine-pack/guid';
import { projectScriptablePackMeta, type ScriptablePackError } from '@forgeax/engine-pack/source';
import type {
  AssetError,
  ImportError,
  ImportedAsset,
  ImportProduct,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import {
  type BuildScriptablePackOptions,
  buildScriptablePack,
  type ScriptablePackDomainError,
  type ScriptablePackExternalEvidence,
  type ScriptablePackStagedOutput,
} from './scriptable-pack.js';

const META_ARTIFACT_KEY = 'scriptable-pack.meta.json';

export interface ScriptableSourcePackageProduct {
  readonly anchorGuid: string;
  readonly declaredGuids: readonly string[];
  readonly product: ImportProduct<unknown>;
  readonly inputFingerprint: string;
  readonly externalEvidence: readonly ScriptablePackExternalEvidence[];
  readonly stagedOutputs: readonly ScriptablePackStagedOutput[];
}

export type ScriptableSourcePackageResult = Result<
  ScriptableSourcePackageProduct,
  ScriptablePackError | AssetError | ImportError | ScriptablePackDomainError
>;

function withPrebuiltMeta<P>(
  product: ImportProduct<P>,
  anchorGuid: string,
  meta: unknown,
): ImportProduct<P> {
  const bytes = new TextEncoder().encode(`${JSON.stringify(meta)}\n`);
  return {
    ...product,
    assets: product.assets.map(
      (asset): ImportedAsset<P> =>
        asset.guid.toLowerCase() === anchorGuid
          ? {
              ...asset,
              artifacts: {
                ...asset.artifacts,
                [META_ARTIFACT_KEY]: { mediaType: 'application/json', bytes },
              },
            }
          : asset,
    ),
  };
}

export async function produceScriptableSourcePackage(
  options: BuildScriptablePackOptions,
): Promise<ScriptableSourcePackageResult> {
  const built = await buildScriptablePack(options);
  if (!built.ok) return err(built.error);
  const declaredGuids = Object.values(options.definition.assets)
    .map((descriptor) => AssetGuid.format(descriptor.guid).toLowerCase())
    .sort();
  const anchorGuid = declaredGuids[0];
  if (anchorGuid === undefined) {
    return err({
      code: 'pack-source-output-invalid',
      expected: 'at least one declared ScriptablePack output',
      hint: 'add an output descriptor before building the package',
      detail: { missingGuids: [], unexpectedSourceKeys: [], kindMismatches: [] },
    });
  }
  const product = withPrebuiltMeta(
    built.value.product,
    anchorGuid,
    projectScriptablePackMeta(options.definition, options.sourcePath),
  );
  return ok({
    anchorGuid,
    declaredGuids,
    product,
    stagedOutputs: built.value.stagedOutputs,
    inputFingerprint: built.value.inputFingerprint,
    externalEvidence: built.value.externalEvidence,
  });
}
