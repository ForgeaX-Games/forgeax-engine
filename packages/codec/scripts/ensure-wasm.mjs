#!/usr/bin/env node
// ensure-wasm.mjs — postinstall best-effort hydration of the codec pkg/ WASM.
// Thin config over scripts/lib/ensure-wasm-lib.mjs (shared with -fbx, -wgpu-wasm).
//
// Why no compile fallback here (matches -wgpu-wasm + -fbx): the basis_universal
// encoder is a multi-minute -O3 emcc compile; doing it inside `bun install`
// would block every dependency install for minutes with no progress. The
// compile fallback lives in Studio's setup.ts (fetch → build:wasm, with
// progress). Bare install stays fast; a consumer with neither a release nor a
// setup.ts run gets the buildHint below.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureWasm } from '../../../scripts/lib/ensure-wasm-lib.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG = join(SCRIPT_DIR, '..', 'pkg');

process.exit(
  ensureWasm({
    pkgLabel: 'codec',
    presenceMarkers: [
      join(PKG, 'basis_transcoder.wasm'),
      join(PKG, 'encode', 'basis_encoder.wasm'),
    ],
    fetchScript: join(SCRIPT_DIR, 'fetch-wasm.mjs'),
    skipEnv: 'FORGEAX_SKIP_CODEC_WASM_FETCH',
    buildHint:
      'run Studio `bun fx setup` (fetch → compile fallback), or build locally with\n' +
      '        pnpm -F @forgeax/engine-codec build:wasm  (needs Emscripten emcc)',
  }),
);
