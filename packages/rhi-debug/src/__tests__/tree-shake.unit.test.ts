// m3-3: tree-shake grep gate — verify FORGEAX_ENGINE_RHI_DEBUG=0 bundle does NOT
// contain 'engine-rhi-debug' string (AC-03).
//
// This test uses a static grep on the hello-cube production bundle. The
// coverage job materializes that cold bundle before running package tests, so
// an absent dist is a real gate failure rather than an implicit pass.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function findDistFiles(rootDir: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (
        (e.name.endsWith('.mjs') || e.name.endsWith('.js')) &&
        full.includes('/dist/assets/')
      ) {
        results.push(full);
      }
    }
  }
  walk(rootDir);
  return results;
}

// I-14 fix-up (round 1 implement-review): the prior shape silently returned
// when no dist bundles existed (cold worktree), making the gate look green
// without a real grep. The explicit coverage prebuild now makes the absence
// assertion below actionable.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const COLD_DIST_ROOT = path.resolve(ENGINE_ROOT, 'apps', 'hello', 'cube', 'dist', 'assets');
const DIST_FILES = findDistFiles(COLD_DIST_ROOT);

describe('tree-shake grep gate (AC-03)', () => {
  it('hello-cube cold production dist exists and does not contain engine-rhi-debug string', () => {
    expect(DIST_FILES.length).toBeGreaterThan(0);
    // Grep each .mjs file for the forbidden string.
    const violations: string[] = [];
    for (const fp of DIST_FILES) {
      let content: string;
      try {
        content = fs.readFileSync(fp, 'utf-8');
      } catch {
        continue;
      }
      if (content.includes('engine-rhi-debug')) {
        violations.push(fp);
      }
    }

    // All demo dist bundles must be clean.
    expect(violations).toEqual([]);
  });
});

// Browser entry node-identifier grep (AC-16).
//
// The browser entry and its bundled import closure must carry zero Node-only
// dependencies. The root remains realm-neutral and is tested separately.

const BROWSER_DIST = path.resolve(__dirname, '..', '..', 'dist', 'browser.mjs');
const BROWSER_DIST_EXISTS = fs.existsSync(BROWSER_DIST);

const BARREL_SRC = path.resolve(__dirname, '..', 'index.ts');

describe('browser entry isolation (AC-16)', () => {
  it.skipIf(!BROWSER_DIST_EXISTS)(
    'browser.mjs + import closure contain no fs / pngjs / ws identifiers',
    () => {
      const content = fs.readFileSync(BROWSER_DIST, 'utf-8');
      // Match Node-builtin imports + the two Node-only deps by their import
      // shapes. recorder-core / tape-format are inlined by tsup, so a hit here
      // means the isolation broke (a node-tainted module crept into the closure).
      const forbidden: RegExp[] = [
        /\bnode:fs\b/,
        /\bnode:path\b/,
        /\bnode:crypto\b/,
        /from\s+['"]fs['"]/,
        /from\s+['"]path['"]/,
        /\bpngjs\b/,
        /from\s+['"]ws['"]/,
        /require\(\s*['"]ws['"]\s*\)/,
      ];
      const hits = forbidden.filter((re) => re.test(content)).map((re) => re.source);
      expect(hits).toEqual([]);
    },
  );

  it('barrel index.ts does not re-export browser transport symbols', () => {
    const barrel = fs.readFileSync(BARREL_SRC, 'utf-8');
    const leaked = ['captureAndUpload', 'uploadTape'].filter((sym) => barrel.includes(sym));
    expect(leaked).toEqual([]);
  });
});

describe('retained core dependency boundary (OOS-5)', () => {
  it('does not include viewer or host dependency identifiers in core production sources', () => {
    const sourceFiles = [
      'index.ts',
      'frame-model.ts',
      'protocol/codec.ts',
      'replay/session.ts',
    ].map((file) => path.resolve(__dirname, '..', file));
    const forbidden = [
      '@codemirror/',
      'dockview',
      '@forgeax/engine-naga',
      "from 'react'",
      'node:fs',
      'node:path',
    ];
    const hits = sourceFiles.flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return forbidden.filter((token) => source.includes(token)).map((token) => `${file}:${token}`);
    });
    expect(hits).toEqual([]);
  });
});

describe('v7 cold model path', () => {
  it('keeps protocol and model sources free of host-only imports', () => {
    const sourcePaths = [
      path.resolve(__dirname, '..', 'protocol', 'codec.ts'),
      path.resolve(__dirname, '..', 'protocol', 'validation.ts'),
      path.resolve(__dirname, '..', 'protocol', 'event-semantics.ts'),
      path.resolve(__dirname, '..', 'protocol', 'tape-index.ts'),
      path.resolve(__dirname, '..', 'frame-model.ts'),
    ];
    const forbidden = /^\s*(?:import|export).*\b(?:node:|pngjs|webgpu|vite|rhi-webgpu|rhi-wgpu)\b/m;
    const hits = sourcePaths.flatMap((sourcePath) => {
      const source = fs.readFileSync(sourcePath, 'utf8');
      return forbidden.test(source) ? [sourcePath] : [];
    });
    expect(hits).toEqual([]);
  });
});
