import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  // index re-exports parse / validate / emit_reflection + ShaderError + Result.
  entry: ['src/index.ts'],
  // top-level await + wasm-bindgen ESM loading (plan-strategy §S-5 / D-P3 ensureReady)
  // requires the esnext target.
  target: 'esnext',
  external: ['@forgeax/engine-wgpu-wasm', '@forgeax/engine-types', '@webgpu/types'],
});
