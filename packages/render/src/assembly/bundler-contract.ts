import type { ImportTransport } from '@forgeax/engine-types';

/** Build-tool inputs forwarded from the host into renderer assembly. */
export interface BundlerOptions {
  readonly importTransport?: ImportTransport | undefined;
  readonly shaderManifestUrl?: string | undefined;
  /** Exact checkout revision emitted by the build-tool adapter. */
  readonly build?: string | undefined;
}
