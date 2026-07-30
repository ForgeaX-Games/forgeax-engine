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

export type AssetEvidenceErrorCode =
  | 'asset-evidence-capability-missing'
  | 'asset-evidence-source-conflict'
  | 'asset-evidence-locator-conflict'
  | 'asset-evidence-receipt-conflict'
  | 'asset-evidence-digest-mismatch';

export type AssetEvidenceErrorDetail =
  | { readonly capability: string; readonly stage: string }
  | { readonly guid: string; readonly observed: string; readonly expected: string };

export interface AssetEvidenceError {
  readonly code: AssetEvidenceErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: AssetEvidenceErrorDetail;
}

export const ASSET_EVIDENCE_ERROR_HINTS: Readonly<Record<AssetEvidenceErrorCode, string>> = {
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
};
