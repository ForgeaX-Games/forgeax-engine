// content-key.mjs — Single source of truth for the wgpu-wasm release asset key.
//
// The pkg/ bundle (wgpu_wasm_bg.wasm + wgpu_wasm.js glue + wgpu_wasm.d.ts +
// wgpu_wasm_bg.wasm.d.ts + package.json + README.md) is a wasm-pack build
// artifact — NOT committed to git (see packages/wgpu-wasm/.gitignore). It is
// published to the `wasm-artifacts` GitHub Release, content-keyed so a bundle is
// uploaded once per unique source state and fetched deterministically.
//
// Unlike @forgeax/engine-fbx (single bridge.c key + a lone .wasm asset), the
// wgpu-wasm pkg/ carries hand-generated wasm-bindgen glue + .d.ts that cannot be
// regenerated from the .wasm alone, so:
//   - the release asset is the WHOLE pkg/ packed as a .tar.gz, and
//   - the content key hashes every input that changes that output:
//     src/**/*.rs + Cargo.toml + Cargo.lock + rust-toolchain.toml + build.sh.
//
// Both scripts/fetch-wasm.mjs (consumer) and the CI publish job import this
// module so producer and consumer never disagree on the asset name (Pipeline
// Isolation + SSOT: architecture-principles #1, #4).

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = join(__dirname, '..');

export const RELEASE_TAG = 'wasm-artifacts';

// Recursively collect *.rs paths under src/, sorted for deterministic hashing.
async function collectRustSources(srcDir) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // __tests__/ Rust is not compiled into the shipped pkg/ bundle; skip so
        // test-only churn does not invalidate the release key.
        if (e.name === '__tests__') continue;
        await walk(full);
      } else if (e.isFile() && e.name.endsWith('.rs')) {
        out.push(full);
      }
    }
  }
  await walk(srcDir);
  return out.sort();
}

/**
 * Compute the full SHA-256 (hex) over every input that determines the pkg/
 * output. Path is included in the hash so a rename alone shifts the key.
 */
export async function computeContentSha256() {
  const inputs = [
    ...(await collectRustSources(join(PKG_ROOT, 'src'))),
    join(PKG_ROOT, 'Cargo.toml'),
    join(PKG_ROOT, 'Cargo.lock'),
    join(PKG_ROOT, 'rust-toolchain.toml'),
    join(PKG_ROOT, 'build.sh'),
  ];
  const hash = createHash('sha256');
  for (const path of inputs) {
    const rel = relative(PKG_ROOT, path).split('\\').join('/');
    const content = await readFile(path);
    hash.update(rel);
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function buildAssetName(sha8) {
  return `wgpu-wasm-pkg-${sha8}.tar.gz`;
}

/** Convenience: returns { sha256, sha8, assetName }. */
export async function resolveAsset() {
  const sha256 = await computeContentSha256();
  const sha8 = sha256.slice(0, 8);
  return { sha256, sha8, assetName: buildAssetName(sha8) };
}

// CLI: `node scripts/content-key.mjs` prints the asset name (used by CI shell).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  resolveAsset()
    .then(({ sha256, assetName }) => {
      // Two lines: full sha then asset name, so shell can pick either.
      process.stdout.write(`${sha256}\n${assetName}\n`);
    })
    .catch((e) => {
      console.error('content-key: failed to compute:', e.message || e);
      process.exit(1);
    });
}
