import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig([
  {
    ...baseTsupConfig,
    entry: ['src/index.ts'],
  },
  {
    ...baseTsupConfig,
    entry: ['src/cli.ts'],
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    ...baseTsupConfig,
    entry: ['src/sdk-cli.ts'],
    banner: { js: '#!/usr/bin/env node' },
  },
]);
