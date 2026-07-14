#!/usr/bin/env node
// ensure-wasm.mjs — postinstall best-effort hydration of the fbx pkg/ WASM.
// Thin config over scripts/lib/ensure-wasm-lib.mjs (shared with -codec, -wgpu-wasm).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureWasm } from '../../../scripts/lib/ensure-wasm-lib.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG = join(SCRIPT_DIR, '..', 'pkg');

process.exit(
  ensureWasm({
    pkgLabel: 'fbx',
    presenceMarkers: [join(PKG, 'fbx-wasm.mjs'), join(PKG, 'fbx-wasm.wasm')],
    fetchScript: join(SCRIPT_DIR, 'fetch-wasm.mjs'),
    skipEnv: 'FORGEAX_SKIP_FBX_WASM_FETCH',
    buildHint:
      'pnpm -F @forgeax/engine-fbx fetch-wasm  (needs network + published release)\n' +
      '        or pnpm -F @forgeax/engine-fbx build:wasm  (needs Emscripten emcc)',
  }),
);
