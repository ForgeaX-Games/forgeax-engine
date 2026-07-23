import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/catalog-client.ts'],
  target: 'esnext',
  external: ['@forgeax/engine-pack', 'vite', 'rollup'],
});
