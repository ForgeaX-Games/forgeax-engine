import type { Asset, ImportError, ImportedAsset } from './index.js';

/** A normalized filesystem path observed by an importer read attempt. */
export type SourceDependency = string;

/** A build artifact emitted alongside the imported asset payload. */
export interface ImportedArtifact {
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** Generic import output shared by every importer and transport. */
export interface ImportProduct<P = Asset> {
  readonly assets: readonly ImportedAsset<P>[];
  readonly artifacts: readonly ImportedArtifact[];
  readonly sourceDependencies: readonly SourceDependency[];
}

/** Structured result returned by an importer. */
export type ImportResult<P = Asset> =
  | { readonly ok: true; readonly value: ImportProduct<P> }
  | { readonly ok: false; readonly error: ImportError };
