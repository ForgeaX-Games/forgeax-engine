import type { Plugin } from '@forgeax/engine-plugin';
import { rendererPlugin } from '../renderer-plugin';
import { assetsWorldPlugin, rendererAssetsPlugin } from './assets-world-plugin';
import type { EngineProfileBase } from './engine-profile-common';

/** Assemble-form roots plus explicitly selected host capabilities. */
export function assembledEngineProfile(options: EngineProfileBase): Plugin[] {
  return [
    rendererPlugin(options.renderer),
    rendererAssetsPlugin(options.assets),
    assetsWorldPlugin(),
    ...(options.extensions ?? []),
  ];
}
