import type { ProducerReadiness } from '@forgeax/engine-import';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { Importer, RuntimeAssetBinding } from '@forgeax/engine-types';
import type { Plugin } from 'vite';

interface AssetHostRefreshServer {
  readonly ws?: { send(payload: { type: 'full-reload' }): void } | undefined;
}

export type AssetHostRefreshPolicy = (server: AssetHostRefreshServer) => void;

/**
 * Vite Pack producer plus the host-control seam used by dynamic game hosts.
 * The runtime binding is read-only from the consumer side; `rebind` remains
 * the sole owner operation that changes the active catalog scope.
 */
export type PluginPack = Plugin & {
  readonly runtimeBinding: () => RuntimeAssetBinding | undefined;
  readonly rebind: (
    binding: RuntimeAssetBinding,
    roots: readonly string[],
    projectDdcRoot?: string,
  ) => Promise<RuntimeAssetBinding>;
};

/** Public plugin inputs; execution owners remain in engine-pack/import/ddc. */
export interface PluginPackOptions {
  readonly roots?: readonly string[] | undefined;
  readonly producerReadiness?: ProducerReadiness | undefined;
  readonly importers?: readonly Importer[] | undefined;
  readonly cookers?: readonly NativeCooker[] | undefined;
  readonly refresh?: AssetHostRefreshPolicy | undefined;
  /** Host-owned source filter shared by build and dev catalog scans. */
  readonly ignorePath?: ((path: string) => boolean) | undefined;
  readonly runtimeBinding?: RuntimeAssetBinding;
  readonly ddc?: PluginPackDdcOptions;
}

export interface PluginPackDdcOptions {
  readonly buildCacheRoot?: string | undefined;
  readonly projectDdcRoot?: string | undefined;
}

/** Internal fixture seams; the public Vite contract does not expose these owners. */
export interface PluginPackInternalOptions extends PluginPackOptions {
  readonly transportBase?: string | undefined;
}
