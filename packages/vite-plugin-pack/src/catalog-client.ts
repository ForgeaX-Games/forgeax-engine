import type { CatalogDelta, CatalogEntry } from '@forgeax/engine-types';

export const CATALOG_DELTA_EVENT = 'forgeax:catalog-delta';

export interface CatalogHotChannel {
  on(event: string, listener: (data: unknown) => void): void;
  off(event: string, listener: (data: unknown) => void): void;
}

export interface CatalogClient {
  enumerate(): Promise<readonly CatalogEntry[]>;
  subscribe(listener: (delta: CatalogDelta) => void): () => void;
}

export interface AssetHostRefreshServer {
  readonly ws?: { send(payload: { type: 'full-reload' }): void } | undefined;
}

export type AssetHostRefreshPolicy = (server: AssetHostRefreshServer) => void;

/** Returns the explicit policy used by hosts that need a full page refresh. */
export function reloadAssetHost(): AssetHostRefreshPolicy {
  return (server) => server.ws?.send({ type: 'full-reload' });
}

/** Adapts Vite's custom-event transport to the neutral catalog source shape. */
export function createCatalogClient(
  enumerate: () => Promise<readonly CatalogEntry[]>,
  hot: CatalogHotChannel | undefined,
): CatalogClient {
  return {
    enumerate,
    subscribe(listener): () => void {
      if (hot === undefined) return () => {};
      const onDelta = (data: unknown): void => {
        if (isCatalogDelta(data)) listener(data);
      };
      hot.on(CATALOG_DELTA_EVENT, onDelta);
      return () => hot.off(CATALOG_DELTA_EVENT, onDelta);
    },
  };
}

function isCatalogDelta(value: unknown): value is CatalogDelta {
  if (typeof value !== 'object' || value === null) return false;
  const delta = value as Partial<CatalogDelta>;
  return Array.isArray(delta.added) && Array.isArray(delta.changed) && Array.isArray(delta.removed);
}
