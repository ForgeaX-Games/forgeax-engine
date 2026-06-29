import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: [
    'src/index.ts',
    'src/errors.ts',
    'src/adapter.ts',
    'src/capture-browser.ts',
    'src/inspect-core.ts',
    'src/inspector.ts',
    'src/rt-to-canvas.ts',
    // m4 / w25: the CLI entry. Builds to dist/cli.mjs so the package.json#bin
    // (forgeax-rhi-debug) + ./cli subpath resolve to a runnable script
    // (`node dist/cli.mjs inspect-offline <tape> 0`). Reuses '@forgeax/engine-rhi-debug'
    // node-only deps already in external below.
    'src/cli.ts',
  ],
  external: [
    '@forgeax/engine-rhi',
    '@forgeax/engine-types',
    '@webgpu/types',
    'pngjs',
    // dawn-node binding (cli.ts inspect-offline bootstrap). node-only native
    // module; keep external so the neutral-platform bundle never tries to bundle
    // its `node:module` require. Imported dynamically + guarded, like pngjs.
    'webgpu',
    // Backend packages the cli inspect-offline path imports dynamically for the
    // replay device. peerDependencies; never bundled.
    '@forgeax/engine-rhi-webgpu',
    '@forgeax/engine-rhi-wgpu',
    // Node.js builtins imported by recorder / tape-format (disk I/O + crypto hash).
    // These are unavailable in browser/neutral platform builds; the inspector
    // module is imported separately by Node.js consumers.
    'node:fs',
    'node:path',
    'node:crypto',
  ],
});