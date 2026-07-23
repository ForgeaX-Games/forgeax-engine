import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';
export default defineConfig({ ...baseTsupConfig, entry: ['src/index.ts', 'src/importer/index.ts', 'src/authoring/index.ts', 'src/preview/index.ts'], external: ['@forgeax/engine-types'] });
