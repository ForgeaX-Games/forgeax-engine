/** Closed structured error contracts for Pack v2 and asset evidence. */

export type AssetArtifactErrorCode =
  | 'asset-artifact-path-invalid'
  | 'asset-artifact-missing'
  | 'asset-artifact-integrity-mismatch'
  | 'asset-artifact-media-unsupported'
  | 'asset-artifact-codec-unsupported'
  | 'asset-artifact-encoding-unsupported'
  | 'asset-artifact-decode-failed';

export type AssetArtifactErrorDetail =
  | {
      readonly guid: string;
      readonly artifactKey: string;
      readonly observed: string;
      readonly expected: string;
    }
  | {
      readonly guid: string;
      readonly artifactKey: string;
      readonly observed: string;
      readonly expected: string;
      readonly path: string;
    };

export type AssetArtifactError =
  | {
      readonly code: 'asset-artifact-path-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: Extract<AssetArtifactErrorDetail, { readonly artifactKey: string }>;
    }
  | {
      readonly code: 'asset-artifact-missing';
      readonly expected: string;
      readonly hint: string;
      readonly detail: Extract<AssetArtifactErrorDetail, { readonly path: string }>;
    }
  | {
      readonly code: Exclude<
        AssetArtifactErrorCode,
        'asset-artifact-path-invalid' | 'asset-artifact-missing'
      >;
      readonly expected: string;
      readonly hint: string;
      readonly detail: Extract<AssetArtifactErrorDetail, { readonly artifactKey: string }>;
    };

export type PackV2ErrorCode =
  | 'pack-v2-version-unsupported'
  | 'pack-v2-envelope-invalid'
  | 'pack-v2-duplicate-guid'
  | 'pack-v2-duplicate-artifact-key'
  | 'pack-v2-artifact-descriptor-invalid';

export type PackV2ErrorDetail =
  | { readonly observed: string; readonly expected: string }
  | { readonly guid: string; readonly paths: readonly string[] }
  | { readonly guid: string; readonly artifactKey: string }
  | { readonly guid: string; readonly artifactKey: string; readonly field: string };

export interface PackV2Error {
  readonly code: PackV2ErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PackV2ErrorDetail;
}

export type AssetEvidenceErrorDetail =
  | { readonly capability: string; readonly stage: string }
  | { readonly guid: string; readonly observed: string; readonly expected: string };

export interface AssetEvidenceError {
  readonly code: AssetEvidenceErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AssetEvidenceErrorDetail;
}

export const ASSET_EVIDENCE_ERROR_HINTS = {
  'asset-evidence-capability-missing':
    'provide the missing evidence capability, then rerun asset lookup or verify',
  'asset-evidence-source-conflict':
    'keep one source declaration per GUID and rerun the offline evidence projection',
  'asset-evidence-locator-conflict':
    'keep one packageUrl per GUID and rebuild the catalog before verifying the asset',
  'asset-evidence-receipt-conflict':
    'keep one producer-owned receipt per GUID and rerun cook before verifying the asset',
  'asset-evidence-digest-mismatch':
    'recook the source or restore the package bytes, then rerun artifact verification',
} satisfies Readonly<Record<string, string>>;

export type AssetEvidenceErrorCode = keyof typeof ASSET_EVIDENCE_ERROR_HINTS;

/** Ordered author-to-runtime stages used by structured recovery errors. */
export type AssetErrorStage =
  | 'author-validation'
  | 'external-declaration'
  | 'import'
  | 'native-cook'
  | 'ddc-validation'
  | 'runtime-parse'
  | 'editor-capability';

/** AI-readable next action; it does not grant a cache or runtime write authority. */
export interface AssetStageRecovery {
  readonly action: string;
  readonly command?: string;
  readonly retryable: boolean;
}

export type AssetStageErrorDetail =
  | { readonly authoringPath: string; readonly rule: string }
  | { readonly sourceKey: string; readonly sourceIndex?: number }
  | { readonly sourcePath: string; readonly importer?: string }
  | { readonly guid: string; readonly producer: string }
  | { readonly guid: string; readonly observedDigest: string; readonly expectedDigest: string }
  | { readonly guid: string; readonly packageUrl: string }
  | { readonly capability: string; readonly assetKind: string };

export interface AssetStageErrorBase<S extends AssetErrorStage, C extends string> {
  readonly stage: S;
  readonly code: C;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AssetStageErrorDetail;
  readonly recovery: AssetStageRecovery;
}

type AssetStageErrorWithDetail<
  S extends AssetErrorStage,
  C extends string,
  D extends AssetStageErrorDetail,
> = Omit<AssetStageErrorBase<S, C>, 'detail'> & { readonly detail: D };

export type AuthorValidationError = AssetStageErrorWithDetail<
  'author-validation',
  'author-validation-failed',
  Extract<AssetStageErrorDetail, { readonly authoringPath: string }>
>;
export type ExternalDeclarationError = AssetStageErrorWithDetail<
  'external-declaration',
  'external-declaration-invalid',
  Extract<AssetStageErrorDetail, { readonly sourceKey: string }>
>;
export type ImportStageError = AssetStageErrorWithDetail<
  'import',
  'import-failed',
  Extract<AssetStageErrorDetail, { readonly sourcePath: string }>
>;
export type NativeCookError = AssetStageErrorWithDetail<
  'native-cook',
  'native-cook-failed',
  Extract<AssetStageErrorDetail, { readonly guid: string; readonly producer: string }>
>;
export type DdcValidationError = AssetStageErrorWithDetail<
  'ddc-validation',
  'ddc-validation-failed',
  Extract<AssetStageErrorDetail, { readonly observedDigest: string }>
>;
export type RuntimeParseError = AssetStageErrorWithDetail<
  'runtime-parse',
  'runtime-parse-failed',
  Extract<AssetStageErrorDetail, { readonly packageUrl: string }>
>;
export type EditorCapabilityError = AssetStageErrorWithDetail<
  'editor-capability',
  'editor-capability-unavailable',
  Extract<AssetStageErrorDetail, { readonly capability: string }>
>;

export type AssetStageError =
  | AuthorValidationError
  | ExternalDeclarationError
  | ImportStageError
  | NativeCookError
  | DdcValidationError
  | RuntimeParseError
  | EditorCapabilityError;

export type AssetStageErrorCode = AssetStageError['code'];

export const ASSET_STAGE_ERROR_HINTS: Readonly<Record<AssetStageErrorCode, string>> = {
  'author-validation-failed': 'read the authoring rule and apply the suggested recovery',
  'external-declaration-invalid': 'repair the sourceKey declaration and retry recovery',
  'import-failed': 'fix the importer input or registration, then retry recovery',
  'native-cook-failed': 'fix the native producer and rerun recovery',
  'ddc-validation-failed': 'repair the cooked artifact and rerun recovery',
  'runtime-parse-failed': 'repair the package payload and rerun recovery',
  'editor-capability-unavailable': 'register the capability and retry recovery',
};
