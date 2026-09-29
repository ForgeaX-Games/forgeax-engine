/** Static plugin compilation for custom project hosts. */
export { executionWorkerEntries } from './build/execution-workers.js';
export { discoverPluginAssets, publishedPluginInventory } from './build/plugin-assets.js';
export { pluginProgramsBuild, pluginRuntimeProjection } from './build/plugin-programs.js';

import type { ImporterRegistry } from '@forgeax/engine-import';
import type { NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';

/** Build-only Context vocabulary. Import this subpath for authored build plugins. */
declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    nativeCookers?: NativeCookerRegistry;
    importers?: ImporterRegistry;
  }
}
