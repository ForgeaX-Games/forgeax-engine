import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    browser: 'src/browser.ts',
    index: 'src/index.ts',
    loader: 'src/loader.ts',
  },
  external: ['@forgeax/engine-ecs', '@forgeax/engine-types'],
  noExternal: ['@deepseek-ai/cordis-plugin-loader'],
});
