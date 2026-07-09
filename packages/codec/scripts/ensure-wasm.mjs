#!/usr/bin/env node
// ensure-wasm.mjs — postinstall best-effort provisioning of the codec pkg/ WASM.
//
// Runs on `bun install` / `pnpm install`. Its ONLY job is a fast, non-fatal
// attempt to obtain the pre-built basis-wasm bundle from the wasm-artifacts
// release. It NEVER compiles and NEVER fails the install:
//
//   - pkg/ already present  -> skip (idempotent).
//   - release fetch works   -> pkg/ populated, done in seconds.
//   - fetch fails (offline / no release / hash mismatch) -> warn and exit 0.
//
// Why no compile here (matches @forgeax/engine-wgpu-wasm + @forgeax/engine-fbx,
// which have no postinstall build at all): the basis_universal encoder is a
// multi-minute -O3 emcc compile. Doing it inside `bun install` blocks every
// dependency install for minutes with no progress signal (the exact pain this
// feature removes). The compile fallback lives in Studio's setup.ts, which runs
// fetch → build:wasm explicitly and can report progress. Bare install stays
// fast; a consumer with neither a release nor setup.ts run gets a clear hint.
//
// Env: FORGEAX_SKIP_CODEC_WASM_FETCH=1 skips the fetch entirely (opt-out).

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const TRANSCODER_WASM = join(PKG_ROOT, 'pkg', 'basis_transcoder.wasm');
const ENCODER_WASM = join(PKG_ROOT, 'pkg', 'encode', 'basis_encoder.wasm');

if (existsSync(TRANSCODER_WASM) && existsSync(ENCODER_WASM)) {
  console.log('[codec] pkg/ wasm already present — skipping fetch.');
  process.exit(0);
}

if (process.env.FORGEAX_SKIP_CODEC_WASM_FETCH) {
  console.log('[codec] FORGEAX_SKIP_CODEC_WASM_FETCH set — skipping wasm fetch.');
  process.exit(0);
}

console.log('[codec] fetching pre-built basis-wasm from release (best-effort)...');
const r = spawnSync(process.execPath, [join(__dirname, 'fetch-wasm.mjs')], {
  stdio: 'inherit',
});

if (r.status === 0) {
  process.exit(0);
}

// Non-fatal: install must never fail because a release is unavailable.
console.log(
  '[codec] basis-wasm not fetched (offline, no published release, or source changed).\n' +
    '        This is fine for a bare install. To provision it, run Studio `bun fx setup`\n' +
    '        (fetch → compile fallback), or build locally with:\n' +
    '          pnpm -F @forgeax/engine-codec build:wasm   (needs Emscripten emcc)',
);
process.exit(0);
