import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
  },
  external: [
    '@forgeax/engine-ecs',
    '@forgeax/engine-math',
    '@forgeax/engine-types',
    '@forgeax/engine-plugin',
    // physicsPlugin dynamic-imports these on build; keep them external so the
    // interface package stays a thin shell and the rapier WASM backends load
    // lazily (D-5). Bundling them would bloat physics to several MB and defeat
    // the lazy-load contract.
    '@forgeax/engine-physics-rapier2d',
    '@forgeax/engine-physics-rapier3d',
  ],
});
