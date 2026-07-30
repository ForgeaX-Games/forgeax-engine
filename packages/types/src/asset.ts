/** Pack v2 asset-local artifact contract. */

export type ContentEncoding = 'identity' | 'zstd';

export interface AssetCodec {
  readonly name: string;
  readonly profile?: string;
  readonly version?: string;
}

export interface Integrity {
  readonly algorithm: 'sha256';
  readonly digest: string;
}

export interface ArtifactDescriptor {
  readonly path: string;
  readonly mediaType: string;
  readonly assetCodec?: AssetCodec;
  readonly contentEncoding?: ContentEncoding;
  readonly byteLength?: number;
  readonly integrity?: Integrity;
}

export interface AssetEnvelopeV2<P = unknown> {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly payload: P;
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, ArtifactDescriptor>>;
}

export interface PackV2<P = unknown> {
  readonly schemaVersion: '2.0.0';
  readonly kind: 'internal-text-package';
  readonly assets: readonly AssetEnvelopeV2<P>[];
}

export type CookStatus = 'notRequired' | 'notCooked' | 'failed' | 'ready' | 'unknown';
export type CookFreshness = 'notApplicable' | 'current' | 'stale' | 'unknown';
export type ArtifactVerificationStatus = 'notChecked' | 'passed' | 'failed';
export type RuntimeEvidenceStatus = 'ready' | 'provisional' | 'unknown' | 'notChecked';
export type CookReceiptStatus = 'loading' | 'succeeded' | 'failed';
export type CookOrigin = 'authoredPack' | 'sourceMeta';

export type {
  AssetEvidence,
  AssetEvidenceArtifact,
  AssetEvidenceInputs,
  AssetEvidenceLocator,
  AssetEvidencePackageInput,
  AssetEvidenceStatus,
  CookReceipt,
  PackageVerificationEvidence,
  SourceDeclarationEvidence,
} from './asset-evidence.js';
export { projectAssetEvidence } from './asset-evidence.js';
