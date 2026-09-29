import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../config/tsup.base';

export default defineConfig([
  {
    ...baseTsupConfig,
    platform: 'node',
    entry: { index: 'src/index.ts', 'build-process': 'src/build/build-process.ts', 'plugin-build': 'src/plugin-build.ts' },
  },
  {
    ...baseTsupConfig,
    platform: 'node',
    entry: ['src/cli.ts'],
    banner: { js: '#!/usr/bin/env node' },
  },
]);
