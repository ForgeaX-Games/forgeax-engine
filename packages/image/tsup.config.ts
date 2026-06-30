import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: [
    'src/index.ts',
    'src/parse-image.ts',
    'src/hdr-decoder.ts',
    'src/decode-image-from-file.ts',
    'src/image-importer.ts',
  ],
  // upng-js / jpeg-js are Node-only lazy imports inside image-decoder-node.ts.
  // Externalizing keeps the browser bundle tree-shaking the Node decoder when
  // consumers only consume the createImageBitmap (browser) path. OQ-3 picked
  // option-(b) external bootstrap (no per-entry `platform: 'node'`); main entry
  // stays `platform: 'neutral'`, and the `node` exports condition + `default: null`
  // in package.json controls which entry browser bundlers can resolve.
  external: ['@forgeax/engine-pack', '@forgeax/engine-types', 'upng-js', 'jpeg-js'],
});
