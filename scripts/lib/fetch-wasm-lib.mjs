// fetch-wasm-lib.mjs — Shared GitHub Release fetch helpers for the three
// per-package fetch-wasm.mjs scripts (wgpu-wasm, codec, fbx).
//
// SSOT for: FetchError, parseGitOrigin, getGitOrigin, authHeaders (with
// `gh auth token` fallback), getReleaseByTag, downloadAsset, extractTarball.
//
// Architecture-principles #1 (SSOT), #4 (Pipeline Isolation): each per-package
// fetch-wasm.mjs provides its own content-key computation + main() orchestration;
// this module provides the GitHub API surface that is identical across all three.

import { execSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

export class FetchError extends Error {
  /** @readonly */ code;
  /** @readonly */ hint;
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

/**
 * Parse a git remote URL into { owner, repo }.
 * Supports SSH (git@github.com:OWNER/REPO.git) and HTTPS
 * (https://github.com/OWNER/REPO.git), including HTTPS URLs that embed
 * credentials (https://TOKEN@github.com/OWNER/REPO.git or
 * https://USER:PASS@github.com/...) as written by git credential helpers /
 * Windows Git Credential Manager. Throws FetchError for non-GitHub hosts or
 * unparseable URLs.
 */
export function parseGitOrigin(url) {
  // SSH: git@github.com:OWNER/REPO.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return assertGitHub(sshMatch[1], sshMatch[2]);
  }
  // HTTPS: https://github.com/OWNER/REPO.git — the optional (?:[^@]+@)?
  // non-capturing group skips embedded credentials (TOKEN@ or USER:PASS@)
  // so the host capture is the bare hostname, not "TOKEN@github.com".
  const httpsMatch = url.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return assertGitHub(httpsMatch[1], httpsMatch[2]);
  }
  throw new FetchError(
    'E3_ORIGIN_PARSE_FAILED',
    `Cannot parse git origin URL: ${url}.`,
    'Expected SSH (git@github.com:OWNER/REPO.git) or HTTPS (https://github.com/OWNER/REPO.git) format.',
  );
}

function assertGitHub(host, path) {
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
      'Expected git@github.com:OWNER/REPO.git or https://github.com/OWNER/REPO.git format.',
    );
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Read the git remote "origin" URL and parse it into { owner, repo }.
 * Throws FetchError if there is no origin remote configured.
 */
export function getGitOrigin() {
  let url;
  try {
    url = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
  } catch {
    throw new FetchError(
      'E3_NO_ORIGIN',
      'No git remote "origin" configured.',
      'This repository has no "origin" remote. Set one with `git remote add origin <url>`.',
    );
  }
  return parseGitOrigin(url);
}

// ---------------------------------------------------------------------------
// GitHub authentication
// ---------------------------------------------------------------------------

/**
 * Build the Authorization header for GitHub API requests.
 * Prefers GITHUB_TOKEN, then GH_TOKEN (the name the official `gh` CLI and many
 * CI systems set), then falls back to `gh auth token` CLI.
 */
export function authHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || resolveGhCliToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Fallback to `gh auth token` when GITHUB_TOKEN env var is not set. */
function resolveGhCliToken() {
  try {
    const out = execSync('gh auth token', { encoding: 'utf-8' }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the release object for a given tag.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} tag - e.g. "wasm-artifacts"
 * @param {{ pkgLabel: string, buildHint: string }} opts
 *        pkgLabel — human-readable name for error messages (e.g. "wgpu-wasm")
 *        buildHint — local build fallback command for error messages
 */
export async function getReleaseByTag(owner, repo, tag, opts) {
  const { pkgLabel, buildHint } = opts;
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`;
  let resp;
  try {
    resp = await fetch(url, { headers: authHeaders() });
  } catch (e) {
    throw new FetchError(
      'E1_NETWORK',
      `Network request failed: ${e.message || e}`,
      `Network unavailable. ${buildHint}.`,
    );
  }
  if (resp.status === 404) {
    throw new FetchError(
      'E2_ASSET_NOT_FOUND',
      `Release tag "${tag}" not found on ${owner}/${repo}.`,
      `No pre-built ${pkgLabel} release exists for this repository. ${buildHint}, or push to main to trigger a CI release.`,
    );
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new FetchError(
      'E5_AUTH_FAILED',
      `Authentication failed (${resp.status}) for ${owner}/${repo}.`,
      `This repository is private and requires authentication. Set GITHUB_TOKEN, run \`gh auth login\`, or ${buildHint}.`,
    );
  }
  if (!resp.ok) {
    throw new FetchError(
      'E1_NETWORK',
      `GitHub API returned ${resp.status}: ${resp.statusText}`,
      `An unexpected error occurred. ${buildHint}.`,
    );
  }
  return resp.json();
}

/**
 * Download a release asset via the API asset endpoint (asset.url) with
 * Accept: application/octet-stream — works for public and private repos.
 *
 * Uses the API asset endpoint (asset.url) NOT asset.browser_download_url:
 * the browser URL 404s for PRIVATE repos even with a Bearer token (it expects
 * a browser session), while the API endpoint authorizes via the token for both
 * public and private repos.
 */
export async function downloadAsset(downloadUrl, destPath) {
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
      `Network unavailable.`,
    );
  }
  if (!resp.ok || !resp.body) {
    throw new FetchError(
      'E1_NETWORK',
      `Download failed with status ${resp.status}: ${resp.statusText}`,
      `An unexpected error occurred.`,
    );
  }
  await mkdir(dirname(destPath), { recursive: true });
  const fileStream = createWriteStream(destPath);
  const reader = resp.body.getReader();
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      await new Promise((resolve, reject) => {
        fileStream.write(chunk.value, (err) => (err ? reject(err) : resolve()));
      });
      chunk = await reader.read();
    }
  } finally {
    await new Promise((resolve) => fileStream.end(resolve));
  }
}

/**
 * Extract a .tar.gz tarball into destDir (replace, not merge — idempotency #6).
 * Cleans destDir before extracting so a re-fetch never leaves stale members.
 */
export async function extractTarball(tarballPath, destDir) {
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
              `Extraction failed.`,
            ),
          ),
    );
  });
}
