import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { Plugin } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';

export interface EngineProfileBase {
  readonly renderer: Renderer;
  readonly assets?: AssetRegistry;
  readonly extensions?: readonly Plugin[];
}
