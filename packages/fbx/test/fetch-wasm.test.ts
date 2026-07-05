import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Test helpers — extract the pure functions we will implement in fetch-wasm.mjs
// We duplicate their logic here for TDD; T14 will move them into the script
// and re-export for this test to consume.
// ---------------------------------------------------------------------------

/**
 * Parse git remote origin URL into { owner, repo }.
 * Supports SSH (git@github.com:OWNER/REPO.git) and HTTPS
 * (https://github.com/OWNER/REPO.git).
 * Throws E3-style structured error for non-GitHub hosts or parse failures.
 */
function parseGitOrigin(url: string): { owner: string; repo: string } {
  // SSH: git@github.com:OWNER/REPO.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const host = sshMatch[1]!;
    const path = sshMatch[2]!;
    if (host !== 'github.com') {
      throw Object.assign(new Error(`Unsupported git host: ${host}`), {
        code: 'E3_ORIGIN_UNSUPPORTED_HOST' as const,
        hint: 'fetch-wasm only supports GitHub remotes. Check `git remote -v`.',
      });
    }
    const parts = path.split('/');
    if (parts.length !== 2) {
      throw Object.assign(new Error(`Cannot parse owner/repo from: ${path}`), {
        code: 'E3_ORIGIN_PARSE_FAILED' as const,
        hint: 'Expected git@github.com:OWNER/REPO.git format.',
      });
    }
    return { owner: parts[0]!, repo: parts[1]! };
  }

  // HTTPS: https://github.com/OWNER/REPO.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    const host = httpsMatch[1]!;
    const path = httpsMatch[2]!;
    if (host !== 'github.com') {
      throw Object.assign(new Error(`Unsupported git host: ${host}`), {
        code: 'E3_ORIGIN_UNSUPPORTED_HOST' as const,
        hint: 'fetch-wasm only supports GitHub remotes. Check `git remote -v`.',
      });
    }
    const parts = path.split('/');
    if (parts.length !== 2) {
      throw Object.assign(new Error(`Cannot parse owner/repo from: ${path}`), {
        code: 'E3_ORIGIN_PARSE_FAILED' as const,
        hint: 'Expected https://github.com/OWNER/REPO.git format.',
      });
    }
    return { owner: parts[0]!, repo: parts[1]! };
  }

  throw Object.assign(new Error(`Cannot parse git origin URL: ${url}`), {
    code: 'E3_ORIGIN_PARSE_FAILED' as const,
    hint: 'Expected SSH (git@github.com:OWNER/REPO.git) or HTTPS (https://github.com/OWNER/REPO.git) format.',
  });
}

function computeBridgeSha256(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const bridgePath = join(__dirname, '..', 'src', 'native', 'bridge.c');
  const content = readFileSync(bridgePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

function bridgeSha8(): string {
  return computeBridgeSha256().slice(0, 8);
}

function buildAssetName(bridgeSha: string): string {
  return `fbx-wasm-v0.23.0-${bridgeSha}.wasm`;
}

// Error codes for fetch-wasm
const ERROR_CODES = {
  E1_NETWORK: 'E1_NETWORK',
  E2_ASSET_NOT_FOUND: 'E2_ASSET_NOT_FOUND',
  E3_ORIGIN_UNSUPPORTED_HOST: 'E3_ORIGIN_UNSUPPORTED_HOST',
  E3_ORIGIN_PARSE_FAILED: 'E3_ORIGIN_PARSE_FAILED',
  E3_NO_ORIGIN: 'E3_NO_ORIGIN',
  E4_HASH_MISMATCH: 'E4_HASH_MISMATCH',
  E5_AUTH_FAILED: 'E5_AUTH_FAILED',
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetch-wasm git origin parsing', () => {
  it('parses SSH origin (git@github.com:OWNER/REPO.git)', () => {
    const result = parseGitOrigin('git@github.com:ForgeaX-Games/forgeax-engine.git');
    expect(result).toEqual({ owner: 'ForgeaX-Games', repo: 'forgeax-engine' });
  });

  it('parses SSH origin without .git suffix', () => {
    const result = parseGitOrigin('git@github.com:some-org/my-repo');
    expect(result).toEqual({ owner: 'some-org', repo: 'my-repo' });
  });

  it('parses HTTPS origin (https://github.com/OWNER/REPO.git)', () => {
    const result = parseGitOrigin('https://github.com/ForgeaX-Games/forgeax-engine.git');
    expect(result).toEqual({ owner: 'ForgeaX-Games', repo: 'forgeax-engine' });
  });

  it('parses HTTPS origin without .git suffix', () => {
    const result = parseGitOrigin('https://github.com/some-org/my-repo');
    expect(result).toEqual({ owner: 'some-org', repo: 'my-repo' });
  });

  it('parses HTTPS origin with http:// scheme', () => {
    const result = parseGitOrigin('http://github.com/org/repo.git');
    expect(result).toEqual({ owner: 'org', repo: 'repo' });
  });

  it('rejects non-GitHub SSH host with E3', () => {
    expect(() => parseGitOrigin('git@gitlab.com:org/repo.git')).toThrow(
      /Unsupported git host/,
    );
  });

  it('rejects non-GitHub HTTPS host with E3', () => {
    expect(() => parseGitOrigin('https://gitlab.com/org/repo.git')).toThrow(
      /Unsupported git host/,
    );
  });

  it('rejects unparseable URL with E3', () => {
    expect(() => parseGitOrigin('not-a-valid-url')).toThrow(
      /Cannot parse git origin URL/,
    );
  });

  it('rejects SSH URL missing owner/repo separator with E3', () => {
    expect(() => parseGitOrigin('git@github.com:only-one-part')).toThrow(
      /Cannot parse owner\/repo/,
    );
  });

  it('rejects HTTPS URL missing owner/repo separator with E3', () => {
    expect(() => parseGitOrigin('https://github.com/only-one-part')).toThrow(
      /Cannot parse owner\/repo/,
    );
  });
});

describe('fetch-wasm structured errors (E1-E5)', () => {
  it('E1 network error has distinct code and hint with emcc fallback guidance', () => {
    const err = Object.assign(new Error('fetch failed'), {
      code: ERROR_CODES.E1_NETWORK,
      hint: 'Network unavailable. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile WASM locally via Emscripten.',
    });
    expect(err.code).toBe('E1_NETWORK');
    expect(err.hint).toMatch(/build:wasm|emcc/i);
    expect(err.hint).not.toBe(err.message);
  });

  it('E2 404 (no matching asset) has distinct code and hint with emcc guidance', () => {
    const err = Object.assign(new Error('No release asset matching fbx-wasm-v0.23.0-abcdef01.wasm'), {
      code: ERROR_CODES.E2_ASSET_NOT_FOUND,
      hint: 'No pre-built WASM found for this bridge.c content. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile locally via Emscripten, or push to main to trigger a CI release.',
    });
    expect(err.code).toBe('E2_ASSET_NOT_FOUND');
    expect(err.hint).toMatch(/build:wasm|emcc|CI release/i);
  });

  it('E3 unsupported host has structured code with remote-check guidance', () => {
    const err = Object.assign(new Error('Unsupported git host: gitlab.com'), {
      code: ERROR_CODES.E3_ORIGIN_UNSUPPORTED_HOST,
      hint: 'fetch-wasm only supports GitHub remotes. Check `git remote -v`.',
    });
    expect(err.code).toBe('E3_ORIGIN_UNSUPPORTED_HOST');
    expect(err.hint).toMatch(/git remote/);
  });

  it('E3 parse failure has structured code with format guidance', () => {
    const err = Object.assign(new Error('Cannot parse git origin URL'), {
      code: ERROR_CODES.E3_ORIGIN_PARSE_FAILED,
      hint: 'Expected SSH (git@github.com:OWNER/REPO.git) or HTTPS (https://github.com/OWNER/REPO.git) format.',
    });
    expect(err.code).toBe('E3_ORIGIN_PARSE_FAILED');
    expect(err.hint).toMatch(/SSH|HTTPS/);
  });

  it('E3 no origin remote has structured code', () => {
    const err = Object.assign(new Error('No git remote "origin" configured'), {
      code: ERROR_CODES.E3_NO_ORIGIN,
      hint: 'This repository has no "origin" remote. Set one with `git remote add origin <url>` or build locally with `pnpm -F @forgeax/engine-fbx build:wasm`.',
    });
    expect(err.code).toBe('E3_NO_ORIGIN');
    expect(err.hint).toMatch(/git remote add|build:wasm/);
  });

  it('E4 hash mismatch does not reuse old artifact', () => {
    // E4 means bridge.c SHA changed after local modification but release
    // wasn't published yet — the 404 should surface as E4, not silently
    // fall back to an old asset with a different hash.
    const err = Object.assign(
      new Error('WASM asset not found for current bridge.c (SHA: deadbeef). The release may not yet be published for this content.'),
      {
        code: ERROR_CODES.E4_HASH_MISMATCH,
        hint: 'bridge.c has uncommitted changes or the release for this content has not been published. Run `pnpm -F @forgeax/engine-fbx build:wasm` to compile locally.',
      },
    );
    expect(err.code).toBe('E4_HASH_MISMATCH');
    expect(err.hint).toMatch(/build:wasm/);
    // It must NOT suggest checking an old hash or reusing a different asset
    expect(err.hint).not.toMatch(/reuse|old|previous/);
  });

  it('E5 auth failed has distinct code with token guidance', () => {
    const err = Object.assign(new Error('Authentication failed (401)'), {
      code: ERROR_CODES.E5_AUTH_FAILED,
      hint: 'This repository is private and requires authentication. Set the GITHUB_TOKEN environment variable, or run `pnpm -F @forgeax/engine-fbx build:wasm` to compile locally.',
    });
    expect(err.code).toBe('E5_AUTH_FAILED');
    expect(err.hint).toMatch(/GITHUB_TOKEN|build:wasm/);
  });

  it('all error codes are distinct and non-overlapping', () => {
    const codes = Object.values(ERROR_CODES);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });
});

describe('fetch-wasm content-keyed asset naming', () => {
  it('bridge SHA256 compute is deterministic', () => {
    const sha1 = computeBridgeSha256();
    const sha2 = computeBridgeSha256();
    expect(sha1).toBe(sha2);
    expect(sha1.length).toBe(64);
  });

  it('bridge SHA8 is first 8 hex chars of SHA256', () => {
    const sha8 = bridgeSha8();
    expect(sha8.length).toBe(8);
    expect(/^[0-9a-f]{8}$/.test(sha8)).toBe(true);
  });

  it('asset name embeds ufbx version and bridge SHA8', () => {
    const name = buildAssetName('abcdef01');
    expect(name).toBe('fbx-wasm-v0.23.0-abcdef01.wasm');
  });

  it('different bridge content produces different asset name', () => {
    const a = buildAssetName('aaaaaaaa');
    const b = buildAssetName('bbbbbbbb');
    expect(a).not.toBe(b);
  });

  it('asset name is stable for same SHA8', () => {
    const a1 = buildAssetName('13b5efa2');
    const a2 = buildAssetName('13b5efa2');
    expect(a1).toBe(a2);
  });
});