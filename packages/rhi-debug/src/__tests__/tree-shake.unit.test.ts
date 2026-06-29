// m3-3: tree-shake grep gate — verify FORGEAX_ENGINE_RHI_DEBUG=0 bundle does NOT
// contain 'engine-rhi-debug' string (AC-03).
//
// This test uses a static grep on dist bundles. When no dist bundles exist
// (cold worktree), the test skips with a descriptive reason; CI runs with
// the full build chain produce real coverage.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function findDistMjsFiles(rootDir: string): string[] {
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
        if (e.name === 'node_modules') continue;
        walk(full);
      } else if (e.name.endsWith('.mjs') && full.includes('/dist/assets/')) {
        results.push(full);
      }
    }
  }
  walk(rootDir);
  return results;
}

// I-14 fix-up (round 1 implement-review): the prior shape silently
// `return`ed when no dist bundles existed (cold worktree), making the
// gate look green every time without a real grep. We now compute the
// dist file list at module load time and use `it.skipIf(...)` so the
// test skip is explicit and visible in the test report rather than
// disguised as a passed assertion (memory: empty-baseline-and-empty-
// frame-falsely-pass-smoke same anti-pattern).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const DIST_FILES = findDistMjsFiles(ENGINE_ROOT);

describe('tree-shake grep gate (AC-03)', () => {
  it.skipIf(DIST_FILES.length === 0)(
    'FORGEAX_ENGINE_RHI_DEBUG=0 dist bundles do not contain engine-rhi-debug string',
    () => {
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
    },
  );
});

// M3 / w16: capture-browser subpath node-identifier grep (AC-10).
//
// The browser capture subpath (capture-browser.mjs) and its bundled import
// closure (recorder-core + tape-format are inlined by tsup) must carry zero
// Node-builtin / Node-only-dependency identifiers, so a browser bundle that
// imports `@forgeax/engine-rhi-debug/capture-browser` never drags in fs / pngjs
// / ws. The scan face is deliberately just this one dist file -- NOT the whole
// app bundle: recorder.ts keeps its legitimate node:fs / node:path through the
// barrel `wrap` path (Node-only finalize() tail), which lives outside this scan
// face. The barrel source assertion below pins the AC-10 contract that the
// capture-browser symbols are never re-exported from index.ts.

const CAPTURE_BROWSER_DIST = path.resolve(__dirname, '..', '..', 'dist', 'capture-browser.mjs');
const CAPTURE_BROWSER_DIST_EXISTS = fs.existsSync(CAPTURE_BROWSER_DIST);

const BARREL_SRC = path.resolve(__dirname, '..', 'index.ts');

describe('capture-browser subpath isolation (AC-10)', () => {
  it.skipIf(!CAPTURE_BROWSER_DIST_EXISTS)(
    'capture-browser.mjs + import closure contain no fs / pngjs / ws identifiers',
    () => {
      const content = fs.readFileSync(CAPTURE_BROWSER_DIST, 'utf-8');
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

  it('barrel index.ts does not re-export capture-browser symbols', () => {
    const barrel = fs.readFileSync(BARREL_SRC, 'utf-8');
    const leaked = [
      'capture-browser',
      'captureFramesToMemory',
      'captureAndUpload',
      'uploadTape',
    ].filter((sym) => barrel.includes(sym));
    expect(leaked).toEqual([]);
  });
});

// M4 / w11: inspect-core + rt-to-canvas subpath node-identifier grep (AC-10/AC-11).
//
// The browser-inspect subpaths (inspect-core.mjs, rt-to-canvas.mjs) and their
// bundled import closures (inlined by tsup) must carry zero Node-builtin /
// Node-only-dependency identifiers, so a browser bundle that imports either
// subpath never drags in fs / pngjs / ws. The barrel source assertion below
// pins the AC-11 contract that inspect-core/rt-to-canvas symbols are never
// re-exported from index.ts.

const INSPECT_CORE_DIST = path.resolve(__dirname, '..', '..', 'dist', 'inspect-core.mjs');
const INSPECT_CORE_DIST_EXISTS = fs.existsSync(INSPECT_CORE_DIST);

const RT_TO_CANVAS_DIST = path.resolve(__dirname, '..', '..', 'dist', 'rt-to-canvas.mjs');
const RT_TO_CANVAS_DIST_EXISTS = fs.existsSync(RT_TO_CANVAS_DIST);

const FORBIDDEN_NODE_RE: RegExp[] = [
  /\bnode:fs\b/,
  /\bnode:path\b/,
  /\bnode:crypto\b/,
  /from\s+['"]fs['"]/,
  /from\s+['"]path['"]/,
  /\bpngjs\b/,
  /from\s+['"]ws['"]/,
  /require\(\s*['"]ws['"]\s*\)/,
];

describe('inspect-core + rt-to-canvas subpath isolation (AC-10, AC-11)', () => {
  it.skipIf(!INSPECT_CORE_DIST_EXISTS)(
    'inspect-core.mjs + import closure contain no fs / pngjs / ws identifiers',
    () => {
      const content = fs.readFileSync(INSPECT_CORE_DIST, 'utf-8');
      const hits = FORBIDDEN_NODE_RE.filter((re) => re.test(content)).map((re) => re.source);
      expect(hits).toEqual([]);
    },
  );

  it.skipIf(!RT_TO_CANVAS_DIST_EXISTS)(
    'rt-to-canvas.mjs + import closure contain no fs / pngjs / ws identifiers',
    () => {
      const content = fs.readFileSync(RT_TO_CANVAS_DIST, 'utf-8');
      const hits = FORBIDDEN_NODE_RE.filter((re) => re.test(content)).map((re) => re.source);
      expect(hits).toEqual([]);
    },
  );

  it('barrel index.ts does not re-export inspect-core / rt-to-canvas symbols', () => {
    const barrel = fs.readFileSync(BARREL_SRC, 'utf-8');
    const leaked = ['inspect-core', 'rt-to-canvas', 'inspectDrawJson', 'renderRtToCanvas'].filter(
      (sym) => barrel.includes(sym),
    );
    expect(leaked).toEqual([]);
  });
});
