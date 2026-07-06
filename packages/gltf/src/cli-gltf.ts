#!/usr/bin/env node
// @forgeax/engine-gltf/src/cli-gltf — `forgeax-engine-remote-gltf` plugin
// bin (feat-20260516-console-dependency-inversion plan-strategy section
// 2.9). Discovered by the base bin via the kubectl 4th-path
// `forgeax-engine-remote-` prefix scanner.
//
// Single subcommand `import` for v1 (UX break vs the prior
// `forgeax-engine-remote-asset import`):
//
//   write mode  `forgeax-engine-remote-gltf import <gltf-or-glb>`
//                Parses the source via parseGlb / parseGltf and writes the
//                sibling `<source>.meta.json` sidecar (sorted-keys, LF line
//                ending — byte-stable so a clean reimport produces no diff).
//
//   --check     `forgeax-engine-remote-gltf import --check <dir>`
//                Dry-run: traverse <dir> reusing SCANNER_BLACKLIST from
//                @forgeax/engine-pack/scanner and surface the first orphan
//                .gltf / .glb whose `<source>.meta.json` is absent as
//                gltf-meta-missing JSON Lines on stderr.
//
// stderr contract (plan-strategy section 2.3): every error path emits a
// single JSON Lines record with code / expected / hint; detail when
// available.

import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { GLTF_ERROR_HINTS } from './errors.js';
import { parseGlb, parseGltf, toAssetPack } from './parse-gltf.js';
import { serializeMetaJson } from './serialize-meta.js';

interface AssetCtx {
  readonly stdoutWrite: (line: string) => void;
  readonly stderrWrite: (line: string) => void;
}

interface ErrShape {
  code: string;
  expected: string;
  hint: string;
  detail?: unknown;
}

function emitError(ctx: AssetCtx, err: ErrShape): number {
  const payload: Record<string, unknown> = {
    code: err.code,
    expected: err.expected,
    hint: err.hint,
  };
  if (err.detail !== undefined) payload.detail = err.detail;
  ctx.stderrWrite(JSON.stringify(payload));
  return 1;
}

function helpBody(): string {
  return [
    'forgeax-engine-remote-gltf — glTF / GLB sidecar importer (produces texture/mesh/material/scene sub-assets)',
    '',
    'Usage:',
    '  forgeax-engine-remote-gltf import <path.gltf|path.glb>',
    '  forgeax-engine-remote-gltf import --check <dir>',
    '',
    'Produces a sibling <source>.meta.json sidecar with sub-asset entries',
    'for every glTF asset category: texture, mesh, material, scene.',
    '',
  ].join('\n');
}

export async function runCliGltf(rest: string[], ctx: AssetCtx): Promise<number> {
  const [sub, ...subRest] = rest;
  if (sub === undefined || sub === '--help' || sub === '-h') {
    ctx.stdoutWrite(helpBody());
    return 0;
  }
  if (sub !== 'import') {
    return emitError(ctx, {
      code: 'unknown-subcommand',
      expected: "subcommand 'import'",
      hint: "run 'forgeax-engine-remote-gltf --help' for usage",
      detail: { subcommand: sub },
    });
  }
  return runImport(subRest, ctx);
}

async function runImport(rest: string[], ctx: AssetCtx): Promise<number> {
  let positionals: string[];
  let check = false;
  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: { check: { type: 'boolean' } },
    });
    positionals = [...parsed.positionals];
    check = parsed.values.check === true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax-engine-remote-gltf import [--check] <path>',
      hint: "run 'forgeax-engine-remote-gltf --help' for usage",
      detail: { message },
    });
  }
  const target = positionals[0];
  if (target === undefined) {
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: check
        ? 'forgeax-engine-remote-gltf import --check <dir>'
        : 'forgeax-engine-remote-gltf import <path.gltf|path.glb>',
      hint: 'pass a positional <gltf-or-glb> argument; with --check pass a directory',
    });
  }
  if (check) {
    return runCheck(target, ctx);
  }
  return runWrite(target, ctx);
}

const SCANNER_BLACKLIST_FALLBACK: ReadonlySet<string> = new Set([
  'node_modules',
  '.forgeax-harness',
  '.git',
  'dist',
  '.forgeax-asset-cache',
  'forgeax-engine-assets',
  'coverage',
]);

async function loadScannerBlacklist(): Promise<ReadonlySet<string>> {
  try {
    const mod = (await import('@forgeax/engine-pack/scanner')) as {
      SCANNER_BLACKLIST?: ReadonlySet<string>;
    };
    return mod.SCANNER_BLACKLIST ?? SCANNER_BLACKLIST_FALLBACK;
  } catch {
    return SCANNER_BLACKLIST_FALLBACK;
  }
}

async function findGltfSources(
  dir: string,
  blacklist: ReadonlySet<string>,
  out: string[],
): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (blacklist.has(entry.name)) continue;
      await findGltfSources(full, blacklist, out);
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.gltf') || lower.endsWith('.glb')) {
        out.push(full);
      }
    }
  }
}

function expectedMetaPathFor(filePath: string): string {
  // feat-20260521 unify-sidecar-meta-dispatch-by-content: sidecar is
  // `<source>.meta.json` next to the source file; dispatch is driven by
  // top-level importer in the JSON, not by the filename suffix.
  return `${filePath}.meta.json`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function runCheck(target: string, ctx: AssetCtx): Promise<number> {
  const root = resolve(target);
  let st: import('node:fs').Stats;
  try {
    st = await stat(root);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax-engine-remote-gltf import --check <dir>',
      hint: 'pass a directory that exists and is readable',
      detail: { path: target, message },
    });
  }
  const blacklist = await loadScannerBlacklist();
  const found: string[] = [];
  if (st.isDirectory()) {
    await findGltfSources(root, blacklist, found);
  } else if (st.isFile()) {
    const lower = root.toLowerCase();
    if (lower.endsWith('.gltf') || lower.endsWith('.glb')) {
      found.push(root);
    }
  }
  found.sort();
  for (const sourcePath of found) {
    const metaPath = expectedMetaPathFor(sourcePath);
    if (!(await fileExists(metaPath))) {
      return emitError(ctx, {
        code: 'gltf-meta-missing',
        expected: "sidecar <source>.meta.json (importer: 'gltf') present in same directory",
        hint: GLTF_ERROR_HINTS['gltf-meta-missing'],
        detail: { filePath: sourcePath, expectedMetaPath: metaPath },
      });
    }
  }
  return 0;
}

async function runWrite(target: string, ctx: AssetCtx): Promise<number> {
  const sourcePath = resolve(target);
  const lower = sourcePath.toLowerCase();
  const isGlb = lower.endsWith('.glb');
  const isGltf = lower.endsWith('.gltf');
  if (!isGlb && !isGltf) {
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: '<path>.gltf or <path>.glb',
      hint: 'pass a .gltf / .glb source file; for batch dry-run use --check <dir>',
      detail: { path: target },
    });
  }
  let docResult:
    | { readonly ok: true; readonly value: unknown }
    | {
        readonly ok: false;
        readonly error: { code: string; expected: string; hint: string; detail: unknown };
      };
  if (isGlb) {
    let buf: Buffer;
    try {
      buf = await readFile(sourcePath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return emitError(ctx, {
        code: 'cli-parse-error',
        expected: 'readable .glb at <path>',
        hint: 'check the file exists and the process has read access',
        detail: { path: target, message },
      });
    }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    docResult = await parseGlb(ab, sourcePath);
  } else {
    let text: string;
    try {
      text = await readFile(sourcePath, 'utf-8');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return emitError(ctx, {
        code: 'cli-parse-error',
        expected: 'readable .gltf at <path>',
        hint: 'check the file exists and the process has read access',
        detail: { path: target, message },
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return emitError(ctx, {
        code: 'gltf-malformed-header',
        expected: 'valid JSON document at the .gltf root',
        hint: GLTF_ERROR_HINTS['gltf-malformed-header'],
        detail: { filePath: sourcePath, byteOffset: 0, parseError: message },
      });
    }
    const baseDir = dirname(sourcePath);
    const externalLoader = async (uri: string): Promise<ArrayBuffer> => {
      const abs = resolve(baseDir, uri);
      const buf = await readFile(abs);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    };
    docResult = await parseGltf(json, externalLoader, sourcePath);
  }
  if (!docResult.ok) {
    return emitError(ctx, {
      code: docResult.error.code,
      expected: docResult.error.expected,
      hint: docResult.error.hint,
      detail: docResult.error.detail,
    });
  }
  const metaPath = expectedMetaPathFor(sourcePath);
  let existingMeta: unknown;
  if (await fileExists(metaPath)) {
    try {
      const raw = await readFile(metaPath, 'utf-8');
      existingMeta = JSON.parse(raw);
    } catch {
      existingMeta = undefined;
    }
  }
  const sourceRelative = sourcePath.slice(dirname(sourcePath).length + 1);
  const pack = toAssetPack(
    docResult.value as Parameters<typeof toAssetPack>[0],
    existingMeta as Parameters<typeof toAssetPack>[1],
    sourceRelative,
  );
  await writeFile(metaPath, serializeMetaJson(pack.meta), 'utf-8');
  return 0;
}

const isBinEntry = await (async (): Promise<boolean> => {
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string') return false;
  const argv1Real = await realpath(argv1).catch(() => argv1);
  const selfReal = await realpath(fileURLToPath(import.meta.url)).catch(() =>
    fileURLToPath(import.meta.url),
  );
  return argv1Real === selfReal;
})();

if (isBinEntry) {
  const exitCode = await runCliGltf(process.argv.slice(2), {
    stdoutWrite: (line: string) => process.stdout.write(`${line}\n`),
    stderrWrite: (line: string) => process.stderr.write(`${line}\n`),
  });
  process.exit(exitCode);
}
