import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/geometry/index.ts', 'src/debug-draw-glue.ts'],
  external: ['@forgeax/engine-ecs', '@forgeax/engine-math', '@forgeax/engine-pack'],
});
