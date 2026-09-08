import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { Plugin } from '@forgeax/engine-plugin';

const ASSET_REGISTRY_RESOURCE_KEY = 'AssetRegistry' as const;

/** Project the Renderer-owned AssetRegistry as a declared dependent service. */
export function rendererAssetsPlugin(assets: AssetRegistry | undefined): Plugin {
  return {
    name: 'renderer-assets',
    inject: ['renderer'],
    provide: 'assets',
    apply(ctx) {
      if (assets !== undefined) ctx.provide('assets', assets);
    },
  };
}

/** Project the realm AssetRegistry into legacy World resource lookup reversibly. */
export function assetsWorldPlugin(): Plugin {
  return {
    name: 'assets-world',
    inject: ['world', 'assets'],
    apply(ctx) {
      if (ctx.assets === undefined) return;
      ctx.effect(() => {
        ctx.world.insertResource(ASSET_REGISTRY_RESOURCE_KEY, ctx.assets);
        return () => {
          ctx.world.removeResource(ASSET_REGISTRY_RESOURCE_KEY);
        };
      }, 'assets/world-resource');
    },
  };
}
