import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    'externalization/index': 'src/externalization/index.ts',
    index: 'src/index.ts',
    internal: 'src/component.ts',
    'projection/index': 'src/projection/index.ts',
    shared: 'src/shared.ts',
  },
  external: ['@forgeax/engine-math', '@forgeax/engine-types'],
});
