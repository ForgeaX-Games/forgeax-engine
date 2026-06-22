import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/cli-fbx.ts'],
  external: [
    '@forgeax/engine-types',
    '@forgeax/engine-pack',
    '@forgeax/engine-gltf',
    // Native addon is runtime-loaded — never bundle it
    '../build/Release/fbx_binding.node',
  ],
});