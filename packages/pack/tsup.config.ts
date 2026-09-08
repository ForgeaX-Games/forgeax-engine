import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: {
    index: 'src/index.ts',
    build: 'src/build.ts',
    schema: 'src/schema-compiled.ts',
    guid: 'src/guid.ts',
    builtin: 'src/builtin.ts',
    errors: 'src/errors.ts',
    bridge: 'src/bridge.ts',
    scanner: 'src/scanner.ts',
    name: 'src/deriveAssetName.ts',
    config: 'src/config.ts',
    'resolve-asset-source': 'src/resolve-asset-source.ts',
    'native-cooker': 'src/native-cooker.ts',
    'scriptable-pack': 'src/scriptable-pack.ts',
    'scriptable-pack-node': 'src/scriptable-pack-node.ts',
    'scriptable-pack-worker': 'src/scriptable-pack-worker.ts',
    'cli-asset': 'src/cli-asset.ts',
    runtime: 'src/runtime.ts',
    'artifact-path': 'src/artifact-path.ts',
    'material-cook': 'src/material-cook.ts',
    'mesh-bin-contract': 'src/mesh-bin-contract.ts',
  },
  external: ['@forgeax/engine-types', 'fast-glob', 'upng-js'],
});
