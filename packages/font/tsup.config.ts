import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/cli-font.ts', 'src/font-importer.ts'],
  external: [
    '@forgeax/engine-types',
    '@forgeax/engine-pack',
    '@forgeax/engine-console',
    '@zappar/msdf-generator',
  ],
});