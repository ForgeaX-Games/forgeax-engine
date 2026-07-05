#!/usr/bin/env node
// fetch-wasm.mjs — Download pre-built FBX WASM from GitHub Releases.
//
// Derives the asset name from the content hash of bridge.c (ufbx v0.23.0 +
// bridge SHA256-8). Resolves the GitHub repo from `git remote get-url origin`
// (SSH or HTTPS), then fetches the matching release asset from the
// `wasm-artifacts` tag. Falls back with structured, actionable errors when
// the asset is unavailable, the network is down, or auth is required.
//
// Usage:
//   pnpm -F @forgeax/engine-fbx fetch-wasm
//   # or directly:
//   node scripts/fetch-wasm.mjs
//
// Environment:
//   GITHUB_TOKEN — optional; if set, the script passes it as a Bearer token
//   for private-repo auth. Without it the request is anonymous (works for
//   public repos).
//
// Output: packages/fbx/pkg/fbx-wasm.wasm (stable name)

import { execSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BRIDGE_PATH = join(ROOT, 'src', 'native', 'bridge.c');
const PKG_DIR = join(ROOT, 'pkg');
const DEST_FILE = join(PKG_DIR, 'fbx-wasm.wasm');

const UFBX_VERSION = 'v0.23.0';
const RELEASE_TAG = 'wasm-artifacts';

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
// git origin → { owner, repo }
// ---------------------------------------------------------------------------

function getGitOrigin() {
  let url;
  try {
    url = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
  } catch {
    throw new FetchError(
      'E3_NO_ORIGIN',
      'No git remote "origin" configured.',
      'This repository has no "origin" remote. Set one with `git remote add origin <url>` or build locally with `pnpm -F @forgeax/engine-fbx build:wasm`.',
    );
  }
  return parseGitOrigin(url);
}

function parseGitOrigin(url) {
  // SSH: git@github.com:OWNER/REPO.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const path = sshMatch[2];
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
        'Expected git@github.com:OWNER/REPO.git format.',
      );
    }
    return { owner: parts[0], repo: parts[1] };
  }

  // HTTPS: https://github.com/OWNER/REPO.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    const host = httpsMatch[1];
    const path = httpsMatch[2];
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
        'Expected https://github.com/OWNER/REPO.git format.',
      );
    }
    return { owner: parts[0], repo: parts[1] };
  }

  throw new FetchError(
    'E3_ORIGIN_PARSE_FAILED',
    `Cannot parse git origin URL: ${url}.`,
    'Expected SSH (git@github.com:OWNER/REPO.git) or HTTPS (https://github.com/OWNER/REPO.git) format.',
  );
}

// ---------------------------------------------------------------------------
// bridge.c SHA256 → asset name
// ---------------------------------------------------------------------------

async function computeBridgeSha256() {
  const content = await readFile(BRIDGE_PATH, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

function buildAssetName(sha8) {
  return `fbx-wasm-${UFBX_VERSION}-${sha8}.wasm`;
}

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------

function authHeaders() {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

/**
 * Fetch the release object for a given tag.
 * Returns null if the release does not exist (404).
 */
async function getReleaseByTag(owner, repo, tag) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;
  let resp;
  try {
    resp = await fetch(url, { headers: authHeaders() });
  } catch (e) {
    throw new FetchError(
      'E1_NETWORK',
      `Network request failed: ${e.message || e}`,
      'Network unavailable. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile WASM locally via Emscripten.',
    );
  }

  if (resp.status === 404) {
    // Release tag does not exist at all — the WASM was never published.
    throw new FetchError(
      'E2_ASSET_NOT_FOUND',
      `Release tag "${tag}" not found on ${owner}/${repo}.`,
      'No pre-built WASM release exists for this repository. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile locally via Emscripten, or push to main to trigger a CI release.',
    );
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new FetchError(
      'E5_AUTH_FAILED',
      `Authentication failed (${resp.status}) for ${owner}/${repo}.`,
      'This repository is private and requires authentication. Set the GITHUB_TOKEN environment variable, or run `pnpm -F @forgeax/engine-fbx build:wasm` to compile locally.',
    );
  }

  if (!resp.ok) {
    throw new FetchError(
      'E1_NETWORK',
      `GitHub API returned ${resp.status}: ${resp.statusText}`,
      'An unexpected error occurred. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile WASM locally via Emscripten.',
    );
  }

  return resp.json();
}

/**
 * Download an asset by its browser_download_url.
 */
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
      'Network unavailable. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile WASM locally via Emscripten.',
    );
  }

  if (resp.status === 404) {
    throw new FetchError(
      'E2_ASSET_NOT_FOUND',
      'WASM asset download returned 404.',
      'The asset URL may have expired. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile locally.',
    );
  }

  if (!resp.ok) {
    throw new FetchError(
      'E1_NETWORK',
      `Download failed with status ${resp.status}: ${resp.statusText}`,
      'An unexpected error occurred. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile WASM locally via Emscripten.',
    );
  }

  if (!resp.body) {
    throw new FetchError(
      'E1_NETWORK',
      'Download response has no body.',
      'An unexpected error occurred. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile WASM locally via Emscripten.',
    );
  }

  await mkdir(dirname(destPath), { recursive: true });
  const fileStream = createWriteStream(destPath);
  // ReadableStream from fetch is NOT a Node.js stream.Readable — we must
  // consume it via the Web Streams API and pipe each chunk manually.
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  // 1. Resolve repo from git origin
  console.log('Resolving git origin...');
  const { owner, repo } = getGitOrigin();
  console.log(`  origin: ${owner}/${repo}`);

  // 2. Compute content key from bridge.c
  console.log('Computing bridge.c content hash...');
  const bridgeSha256 = await computeBridgeSha256();
  const sha8 = bridgeSha256.slice(0, 8);
  const assetName = buildAssetName(sha8);
  console.log(`  bridge SHA256: ${bridgeSha256}`);
  console.log(`  asset name:    ${assetName}`);

  // 3. Fetch release by tag
  console.log(`Fetching release tag "${RELEASE_TAG}" from ${owner}/${repo}...`);
  const release = await getReleaseByTag(owner, repo, RELEASE_TAG);

  // 4. Find matching asset
  const assets = release.assets || [];
  const asset = assets.find((a) => a.name === assetName);

  if (!asset) {
    throw new FetchError(
      'E4_HASH_MISMATCH',
      `No release asset matching "${assetName}" found on ${owner}/${repo} (tag: ${RELEASE_TAG}). The release may not yet be published for this bridge.c content.`,
      'bridge.c has uncommitted changes or the release for this content has not been published to the "wasm-artifacts" tag. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile locally via Emscripten, or push to main to trigger a CI release.',
    );
  }

  // 5. Download
  console.log(`Downloading ${assetName} (${(asset.size / 1024).toFixed(0)} KB)...`);
  await downloadAsset(asset.browser_download_url, DEST_FILE);
  console.log(`  -> ${DEST_FILE}`);
  console.log('Done.');
}

main().catch((e) => {
  if (e instanceof FetchError) {
    console.error(`\n[${e.code}] ${e.message}`);
    console.error(`Hint: ${e.hint}`);
  } else {
    console.error('\nUnexpected error:', e.message || e);
  }
  process.exit(1);
});