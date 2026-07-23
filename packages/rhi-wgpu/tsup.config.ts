import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts'],
  external: [
    '@forgeax/engine-rhi',
    '@forgeax/engine-types',
    '@forgeax/engine-wgpu-wasm',
    '@webgpu/types',
  ],
});
