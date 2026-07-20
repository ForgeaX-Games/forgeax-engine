import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    'cli-state': 'src/cli-state.ts',
  },
  external: ['@forgeax/engine-ecs', '@forgeax/engine-types'],
});