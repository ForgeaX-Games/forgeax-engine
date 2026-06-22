import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

// Quad-entry bundle layout:
//   - src/index.ts  -> dist/index.mjs   thin re-export facade for `import
//                                       { InspectorError } from '@forgeax/engine-console'`
//                                       (charter proposition 1).
//   - src/errors.ts -> dist/errors.mjs  ./errors sub-path; lets callers import
//                                       the closed InspectorErrorCode union
//                                       without pulling the ws / vm runtime
//                                       surface.
//   - src/server.ts -> dist/server.mjs  ./server sub-path; in-process
//                                       WebSocket server consumed by
//                                       engine.startConsole via dynamic
//                                       import (D-P4 / AC-22).
//   - src/cli.ts    -> dist/cli.mjs     bin.forgeax CLI entry (AC-14).
//
// External pins keep dynamic imports + node built-ins from being bundled
// (AC-09 / AC-22 + plan-strategy D-P4 bundle physical isolation).
export default defineConfig({
  ...baseTsupConfig,
  entry: [
    'src/index.ts',
    'src/errors.ts',
    'src/server.ts',
    'src/cli.ts',
  ],
  external: ['@forgeax/engine-runtime', '@forgeax/engine-ecs', '@forgeax/engine-gltf', '@forgeax/engine-image', '@forgeax/engine-pack', 'ws', 'node:vm', 'node:util'],
});
