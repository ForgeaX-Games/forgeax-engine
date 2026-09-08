import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/browser.ts', 'src/mesh-bin.ts'],
  external: ['@forgeax/engine-pack', '@forgeax/engine-types'],
});
