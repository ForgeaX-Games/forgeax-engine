import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    schema: 'src/schema-compiled.ts',
    guid: 'src/guid.ts',
    errors: 'src/errors.ts',
    bridge: 'src/bridge.ts',
    scanner: 'src/scanner.ts',
    name: 'src/deriveAssetName.ts',
    config: 'src/config.ts',
    'resolve-asset-source': 'src/resolve-asset-source.ts',
    'cli-asset': 'src/cli-asset.ts',
  },
  external: ['@forgeax/engine-types', 'fast-glob', 'upng-js'],
});
