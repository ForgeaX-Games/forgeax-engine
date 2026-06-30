import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  // index main entry re-exports the wrap helper; tsup walks the dependency graph and auto-compiles submodules.
  entry: ['src/index.ts'],
  // Same target as @forgeax/engine-shader-compiler (top-level await wasm loading, plan-strategy §S-5).
  target: 'esnext',
  external: ['@forgeax/engine-shader-compiler', '@forgeax/engine-types', 'vite', 'rollup'],
});
