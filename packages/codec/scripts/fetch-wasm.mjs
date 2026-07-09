#!/usr/bin/env node
// fetch-wasm.mjs — Download the pre-built basis-wasm pkg/ bundle from GitHub
// Releases so no-Emscripten consumers (Studio setup, editor standalone, CI
// typecheck) can resolve @forgeax/engine-codec without an emcc toolchain and,
// crucially, without the multi-minute -O3 basis_universal encoder compile.
//
// Like @forgeax/engine-wgpu-wasm, the codec pkg/ carries multiple files (two
// emscripten glue .mjs + two .wasm, nested one level under encode/) that cannot
// be regenerated from a single .wasm, so the release asset is the WHOLE pkg/
// packed as a content-keyed .tar.gz; this script downloads and extracts it into
// packages/codec/pkg/.
//
// The content key (see content-key.mjs) is the SSOT shared with the CI publish
// job, so producer and consumer always agree on the asset name.
//
// Usage:
//   pnpm -F @forgeax/engine-codec fetch-wasm
//   node scripts/fetch-wasm.mjs
//
// Environment:
//   GITHUB_TOKEN — optional Bearer token for private-repo auth. Anonymous
//   requests work for public repos.
//   FORGEAX_SKIP_CODEC_WASM_FETCH — if set, exit 0 immediately (used by the
//   non-fatal opt-out path when the toolchain owner wants to build locally).
//
// Exit codes: 0 on success (or skip); 1 on any FetchError. Callers that want a
// build fallback treat a non-zero exit as "release unavailable, compile via
// build:wasm" (graceful degradation: architecture-principles #9).

import { execSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PKG_ROOT, RELEASE_TAG, resolveAsset } from './content-key.mjs';

const PKG_DIR = join(PKG_ROOT, 'pkg');
const TMP_TARBALL = join(PKG_ROOT, '.pkg-fetch.tar.gz');

const BUILD_HINT =
  'compile locally with `pnpm -F @forgeax/engine-codec build:wasm` (needs the Emscripten emcc toolchain)';

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

class FetchError extends Error {
  code;
  hint;
  constructor(code, message, hint) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------
// git origin -> { owner, repo }
// ---------------------------------------------------------------------------

function getGitOrigin() {
  let url;
  try {
    url = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
  } catch {
    throw new FetchError(
      'E3_NO_ORIGIN',
      'No git remote "origin" configured.',
      `This repository has no "origin" remote. Set one with \`git remote add origin <url>\`, or ${BUILD_HINT}.`,
    );
  }
  return parseGitOrigin(url);
}

function parseGitOrigin(url) {
  // SSH: git@github.com:OWNER/REPO.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return assertGitHub(sshMatch[1], sshMatch[2], 'git@github.com:OWNER/REPO.git');
  }
  // HTTPS: https://github.com/OWNER/REPO.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return assertGitHub(httpsMatch[1], httpsMatch[2], 'https://github.com/OWNER/REPO.git');
  }
  throw new FetchError(
    'E3_ORIGIN_PARSE_FAILED',
    `Cannot parse git origin URL: ${url}.`,
    'Expected SSH (git@github.com:OWNER/REPO.git) or HTTPS (https://github.com/OWNER/REPO.git) format.',
  );
}

function assertGitHub(host, path, expected) {
  if (host !== 'github.com') {
    throw new FetchError(
      'E3_ORIGIN_UNSUPPORTED_HOST',
      `Unsupported git host: ${host}.`,
      'fetch-wasm only supports GitHub remotes. Check `git remote -v`.',
    );
  }
  const parts = path.split('/');
  if (parts.length !== 2) {
    throw new FetchError(
      'E3_ORIGIN_PARSE_FAILED',
      `Cannot parse owner/repo from: ${path}.`,
      `Expected ${expected} format.`,
    );
  }
  return { owner: parts[0], repo: parts[1] };
}

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------

function authHeaders() {
  const token = process.env.GITHUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function getReleaseByTag(owner, repo, tag) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;
  let resp;
  try {
    resp = await fetch(url, { headers: authHeaders() });
  } catch (e) {
    throw new FetchError(
      'E1_NETWORK',
      `Network request failed: ${e.message || e}`,
      `Network unavailable. ${BUILD_HINT}.`,
    );
  }
  if (resp.status === 404) {
    throw new FetchError(
      'E2_ASSET_NOT_FOUND',
      `Release tag "${tag}" not found on ${owner}/${repo}.`,
      `No pre-built basis-wasm release exists for this repository. ${BUILD_HINT}, or push to main to trigger a CI release.`,
    );
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new FetchError(
      'E5_AUTH_FAILED',
      `Authentication failed (${resp.status}) for ${owner}/${repo}.`,
      `This repository is private and requires authentication. Set GITHUB_TOKEN, or ${BUILD_HINT}.`,
    );
  }
  if (!resp.ok) {
    throw new FetchError(
      'E1_NETWORK',
      `GitHub API returned ${resp.status}: ${resp.statusText}`,
      `An unexpected error occurred. ${BUILD_HINT}.`,
    );
  }
  return resp.json();
}

async function downloadAsset(downloadUrl, destPath) {
  let resp;
  try {
    resp = await fetch(downloadUrl, {
      headers: { ...authHeaders(), Accept: 'application/octet-stream' },
      redirect: 'follow',
    });
  } catch (e) {
    throw new FetchError(
      'E1_NETWORK',
      `Network request failed while downloading: ${e.message || e}`,
      `Network unavailable. ${BUILD_HINT}.`,
    );
  }
  if (!resp.ok || !resp.body) {
    throw new FetchError(
      'E1_NETWORK',
      `Download failed with status ${resp.status}: ${resp.statusText}`,
      `An unexpected error occurred. ${BUILD_HINT}.`,
    );
  }
  await mkdir(dirname(destPath), { recursive: true });
  const fileStream = createWriteStream(destPath);
  const reader = resp.body.getReader();
  try {
    let chunk;
    while (!(chunk = await reader.read()).done) {
      await new Promise((resolve, reject) => {
        fileStream.write(chunk.value, (err) => (err ? reject(err) : resolve()));
      });
    }
  } finally {
    await new Promise((resolve) => fileStream.end(resolve));
  }
}

// ---------------------------------------------------------------------------
// Extract the tarball into pkg/ (replace, not merge — idempotency #6).
// The tarball is packed with `tar -C pkg/ .`, so its members are pkg/'s direct
// contents (including the encode/ subdir); extract with `tar -xzf ... -C pkg/`.
// ---------------------------------------------------------------------------

async function extractTarball(tarballPath, destDir) {
  // Clean the destination so a re-fetch never leaves stale members behind.
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', tarballPath, '-C', destDir], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new FetchError(
              'E6_EXTRACT_FAILED',
              `tar exited with code ${code} while extracting ${tarballPath}.`,
              `Extraction failed. ${BUILD_HINT}.`,
            ),
          ),
    );
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.FORGEAX_SKIP_CODEC_WASM_FETCH) {
    console.log('fetch-wasm: FORGEAX_SKIP_CODEC_WASM_FETCH set — skipping.');
    return;
  }

  console.log('Resolving git origin...');
  const { owner, repo } = getGitOrigin();
  console.log(`  origin: ${owner}/${repo}`);

  console.log('Computing content key (fetch-basis.mjs + build-wasm.mjs)...');
  const { sha256, assetName } = await resolveAsset();
  console.log(`  content SHA256: ${sha256}`);
  console.log(`  asset name:     ${assetName}`);

  console.log(`Fetching release tag "${RELEASE_TAG}" from ${owner}/${repo}...`);
  const release = await getReleaseByTag(owner, repo, RELEASE_TAG);

  const asset = (release.assets || []).find((a) => a.name === assetName);
  if (!asset) {
    throw new FetchError(
      'E4_HASH_MISMATCH',
      `No release asset matching "${assetName}" found on ${owner}/${repo} (tag: ${RELEASE_TAG}).`,
      `The codec build scripts have uncommitted changes, or the release for this content is not yet published. ${BUILD_HINT}, or push to main to trigger a CI release.`,
    );
  }

  console.log(`Downloading ${assetName} (${(asset.size / 1024).toFixed(0)} KB)...`);
  // Use the API asset endpoint (asset.url) + Accept: application/octet-stream, NOT
  // asset.browser_download_url: the browser URL 404s for PRIVATE repos even with a
  // Bearer token (it expects a browser session), while the API endpoint authorizes
  // via the token for both public and private repos.
  await downloadAsset(asset.url, TMP_TARBALL);

  console.log(`Extracting into ${PKG_DIR} ...`);
  await extractTarball(TMP_TARBALL, PKG_DIR);
  await rm(TMP_TARBALL, { force: true });

  const members = await readdir(PKG_DIR);
  console.log(`  pkg/ now holds: ${members.join(', ')}`);
  console.log('Done.');
}

main().catch(async (e) => {
  await rm(TMP_TARBALL, { force: true }).catch(() => {});
  if (e instanceof FetchError) {
    console.error(`\n[${e.code}] ${e.message}`);
    console.error(`Hint: ${e.hint}`);
  } else {
    console.error('\nUnexpected error:', e.message || e);
  }
  process.exit(1);
});
