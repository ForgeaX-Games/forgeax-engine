import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    'cli-ecs': 'src/cli-ecs.ts',
  },
  external: ['@forgeax/engine-math', '@forgeax/engine-types'],
});
