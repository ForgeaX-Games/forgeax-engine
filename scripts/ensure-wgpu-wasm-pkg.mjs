#!/usr/bin/env node
// ensure-wgpu-wasm-pkg.mjs — hydrate packages/wgpu-wasm/pkg/ on install.
//
// pkg/ is a wasm-pack build artifact, no longer committed (ufbx-style release;
// see packages/wgpu-wasm/.gitignore). But @forgeax/engine-wgpu-wasm's TS entry
// STATICALLY imports pkg/wgpu_wasm.js (`import init, * as wasm from
// '../pkg/wgpu_wasm.js'`), so a no-Rust clone with an empty pkg/ fails to
// typecheck. This script fills that gap at install time:
//
//   - pkg/ already populated  -> no-op (toolchain owners who ran build:wasm,
//     and CI which builds pkg/ before typecheck, are untouched).
//   - pkg/ missing            -> run `fetch-wasm` to download the content-keyed
//     tarball from the wasm-artifacts release.
//
// Failure policy (graceful degradation, architecture-principles #9): a failed
// fetch NEVER breaks `pnpm install`. It warns with the fetch-wasm self-help
// hint (offline / private repo / not-yet-published) and exits 0. The build /
// typecheck that actually needs pkg/ will fail later with a clear error, and
// the developer runs build:wasm or fetch-wasm explicitly.
//
// Wired into root `postinstall` alongside sync-harness. Skip with
// FORGEAX_SKIP_WGPU_WASM_FETCH (also honoured by fetch-wasm.mjs itself).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const PKG_JS = resolve(root, 'packages/wgpu-wasm/pkg/wgpu_wasm.js');
const FETCH_SCRIPT = resolve(root, 'packages/wgpu-wasm/scripts/fetch-wasm.mjs');

function log(msg) {
  process.stdout.write(`[wgpu-wasm:ensure] ${msg}\n`);
}

if (process.env.FORGEAX_SKIP_WGPU_WASM_FETCH) {
  log('FORGEAX_SKIP_WGPU_WASM_FETCH set — skipped');
  process.exit(0);
}

// Already hydrated (build:wasm ran, CI built pkg/, or a prior fetch succeeded).
if (existsSync(PKG_JS)) {
  log('pkg/ already present — skipped');
  process.exit(0);
}

log('pkg/ missing — fetching prebuilt bundle from wasm-artifacts release...');
const r = spawnSync('node', [FETCH_SCRIPT], { cwd: root, stdio: 'inherit' });

if (r.status === 0) {
  log('pkg/ hydrated via fetch-wasm');
  process.exit(0);
}

// Non-fatal: install continues. fetch-wasm already printed its structured
// [CODE] message + hint; add one line pointing at explicit recovery.
log(
  'could not fetch pkg/ (see above). Non-fatal — install continues. ' +
    'Before building, run `pnpm -F @forgeax/engine-wgpu-wasm fetch-wasm` ' +
    '(needs network + published release) or `build:wasm` (needs Rust + wasm-pack).',
);
process.exit(0);
