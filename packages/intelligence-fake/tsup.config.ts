import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: { index: 'src/index.ts' },
  external: ['@forgeax/engine-intelligence', '@forgeax/engine-types'],
});
