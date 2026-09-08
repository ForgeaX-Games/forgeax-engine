import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig([
  {
    ...baseTsupConfig,
    platform: 'node',
    entry: ['src/index.ts'],
  },
  {
    ...baseTsupConfig,
    platform: 'node',
    entry: ['src/cli.ts'],
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    ...baseTsupConfig,
    platform: 'node',
    entry: ['src/sdk-cli.ts'],
    banner: { js: '#!/usr/bin/env node' },
    noExternal: [/^@forgeax\/engine-/, 'zod'],
  },
]);
