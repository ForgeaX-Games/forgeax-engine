import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/browser.ts', 'src/node.ts'],
  external: ['@forgeax/engine-net', '@forgeax/engine-types', 'ws'],
});
