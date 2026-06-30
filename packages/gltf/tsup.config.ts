import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/cli-gltf.ts', 'src/node-file-entry.ts'],
  external: ['@forgeax/engine-math', '@forgeax/engine-pack', '@forgeax/engine-types'],
});
