#!/usr/bin/env node
// @forgeax/engine-pack/src/cli-asset — `forgeax-engine-remote-asset`
// plugin bin (feat-20260516-console-dependency-inversion plan-strategy
// section 2.9). Discovered by the base bin via the kubectl 4th-path
// `forgeax-engine-remote-` prefix scanner; subcommands scan / lookup /
// verify operate offline against the pack scanner.
//
// stderr contract (plan-strategy section 2.3 weak-contract): every error
// path emits a single JSON Lines record carrying `code` / `expected` /
// `hint`; `detail` is included when the underlying error supplied one.
// Exit codes: 0 success, 1 any error.

import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runAtlas } from './atlas/run-atlas.js';
import { scan } from './scanner.js';

interface PackEntry {
  readonly guid: string;
  readonly kind: string;
  readonly sourcePath: string;
}

interface AssetCtx {
  readonly stdoutWrite: (line: string) => void;
  readonly stderrWrite: (line: string) => void;
  /** Optional cwd override (defaults to `process.cwd()`); enables hermetic tests. */
  readonly cwd?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ScanErrShape {
  code: string;
  expected: string;
  hint: string;
  detail?: unknown;
}

function emitError(ctx: AssetCtx, err: ScanErrShape): number {
  const payload: Record<string, unknown> = {
    code: err.code,
    expected: err.expected,
    hint: err.hint,
  };
  if (err.detail !== undefined) payload.detail = err.detail;
  ctx.stderrWrite(JSON.stringify(payload));
  return 1;
}

async function scanEntries(
  roots: readonly string[],
  ctx: AssetCtx,
): Promise<{ ok: true; value: PackEntry[] } | { ok: false }> {
  const result = await scan(roots);
  if (!result.ok) {
    emitError(ctx, {
      code: result.error.code,
      expected: result.error.expected,
      hint: result.error.hint,
      detail: result.error.detail,
    });
    return { ok: false };
  }
  const entries: PackEntry[] = [];
  // Two file kinds carry GUID-addressed entries (disk schema SSOT, AGENTS.md
  // §Disk schema): `.pack.json` (`internal-text-package`) holds top-level
  // `assets[]`, while every `*.meta.json` sidecar (including
  // any `*.meta.json` regardless of source extension (top-level `importer`), all of
  // kind `external-asset-package`) holds `subAssets[]`. The CLI surface
  // must enumerate both so that `scan` / `lookup` mirror what the
  // build-time catalog builder folds into `pack-index.json` (otherwise
  // the same disk schema yields different entity counts on the two
  // surfaces — observed regression in feat-20260517 sandbox T-2.B1).
  const packPaths = result.value.filter((p) => p.endsWith('.pack.json'));
  const metaPaths = result.value.filter((p) => p.endsWith('.meta.json'));
  for (const packPath of packPaths) {
    let parsed: unknown;
    try {
      const raw = await readFile(packPath, 'utf-8');
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const packObj = parsed as { assets?: { guid?: unknown; kind?: unknown }[] };
    if (!Array.isArray(packObj.assets)) continue;
    for (const asset of packObj.assets) {
      if (typeof asset.guid === 'string' && typeof asset.kind === 'string') {
        entries.push({ guid: asset.guid, kind: asset.kind, sourcePath: packPath });
      }
    }
  }
  for (const metaPath of metaPaths) {
    let parsed: unknown;
    try {
      const raw = await readFile(metaPath, 'utf-8');
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const metaObj = parsed as { subAssets?: { guid?: unknown; kind?: unknown }[] };
    if (!Array.isArray(metaObj.subAssets)) continue;
    for (const sub of metaObj.subAssets) {
      if (typeof sub.guid === 'string' && typeof sub.kind === 'string') {
        entries.push({ guid: sub.guid, kind: sub.kind, sourcePath: metaPath });
      }
    }
  }
  return { ok: true, value: entries };
}

function helpBody(): string {
  return [
    'forgeax-engine-remote-asset — offline pack scanner / lookup / verifier / atlas builder',
    '',
    'Usage:',
    '  forgeax-engine-remote-asset scan [--roots <dir>]',
    '  forgeax-engine-remote-asset lookup <guid>',
    '  forgeax-engine-remote-asset verify',
    '  forgeax-engine-remote-asset atlas --input <glob> --name <prefix> [--output <dir>] [--max-atlas-size <n>]',
    '',
  ].join('\n');
}

export async function runCliAsset(rest: string[], ctx: AssetCtx): Promise<number> {
  const [sub, ...subRest] = rest;
  if (sub === undefined || sub === '--help' || sub === '-h') {
    ctx.stdoutWrite(helpBody());
    return 0;
  }
  switch (sub) {
    case 'scan':
      return runScan(subRest, ctx);
    case 'lookup':
      return runLookup(subRest, ctx);
    case 'verify':
      return runVerify(subRest, ctx);
    case 'atlas':
      return runAtlas(subRest, ctx);
    default:
      return emitError(ctx, {
        code: 'unknown-subcommand',
        expected: 'subcommand in {scan, lookup, verify, atlas}',
        hint: "run 'forgeax-engine-remote-asset --help' for usage",
        detail: { subcommand: sub },
      });
  }
}

async function runScan(rest: string[], ctx: AssetCtx): Promise<number> {
  let roots: string[];
  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: { roots: { type: 'string', multiple: true } },
    });
    roots = (parsed.values.roots as string[] | undefined) ?? [ctx.cwd ?? process.cwd()];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax-engine-remote-asset scan [--roots <dir>]',
      hint: "run 'forgeax-engine-remote-asset --help' for usage",
      detail: { message },
    });
  }
  const result = await scanEntries(roots, ctx);
  if (!result.ok) return 1;
  ctx.stdoutWrite(JSON.stringify(result.value));
  return 0;
}

async function runLookup(rest: string[], ctx: AssetCtx): Promise<number> {
  const [guid] = rest;
  if (typeof guid !== 'string') {
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax-engine-remote-asset lookup <36-char-uuid>',
      hint: 'pass a 36-char dash-form UUID positional argument',
    });
  }
  if (!UUID_RE.test(guid)) {
    return emitError(ctx, {
      code: 'pack-guid-malformed',
      expected: '36-char RFC 4122 dash-form GUID (8-4-4-4-12 lowercase hex)',
      hint: 'use AssetGuid.random() or a UUIDv7 generator; all GUID fields must be 36-char RFC 4122 dash-form',
      detail: { raw: guid, reason: 'invalid-format' },
    });
  }
  const cwd = ctx.cwd ?? process.cwd();
  const result = await scanEntries([cwd], ctx);
  if (!result.ok) return 1;
  const normalized = guid.toLowerCase();
  const entry = result.value.find((e) => e.guid.toLowerCase() === normalized);
  if (entry === undefined) {
    return emitError(ctx, {
      code: 'asset-not-found',
      expected: 'GUID present in scan results',
      hint: 'run scan to list known GUIDs; verify the GUID came from a .meta.json sub-asset entry',
      detail: { guid: normalized },
    });
  }
  ctx.stdoutWrite(JSON.stringify(entry));
  return 0;
}

async function runVerify(rest: string[], ctx: AssetCtx): Promise<number> {
  try {
    parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {},
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax-engine-remote-asset verify',
      hint: "run 'forgeax-engine-remote-asset --help' for usage",
      detail: { message },
    });
  }
  const cwd = ctx.cwd ?? process.cwd();
  const result = await scanEntries([cwd], ctx);
  if (!result.ok) return 1;

  // Shader sidecar type-specific validation (feat-20260528-material-shader-registration-unification M1 / w5).
  // For each .meta.json with importer 'shader' (feat-20260603-asset-import-loader-injection
  // M2: the reserved shader importer key, replacing the former assetType 'shader'),
  // validate paramSchema shape:
  //   - must exist and be a non-empty array
  //   - each entry must have name + type (string) fields
  //   - type must be in PARAM_SCHEMA_TYPE_ALLOWLIST
  const PARAM_SCHEMA_TYPE_ALLOWLIST = new Set([
    'f32',
    'i32',
    'u32',
    'vec2',
    'vec3',
    'vec4',
    'color',
    'texture2d',
    'sampler',
  ]);
  const metaPaths = await (async () => {
    const { scan: scanFn } = await import('./scanner.js');
    const scanResult = await scanFn([cwd]);
    if (!scanResult.ok) return [] as string[];
    return scanResult.value.filter((p: string) => p.endsWith('.meta.json'));
  })();
  for (const metaPath of metaPaths) {
    let parsed: unknown;
    try {
      const raw = await readFile(metaPath, 'utf-8');
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const metaObj = parsed as { importer?: unknown; paramSchema?: unknown };
    if (metaObj.importer !== 'shader') continue;
    if (!Array.isArray(metaObj.paramSchema) || metaObj.paramSchema.length === 0) {
      return emitError(ctx, {
        code: 'pack-malformed-meta',
        expected: 'shader sidecar must have non-empty paramSchema array',
        hint: `add a paramSchema field to ${metaPath} with at least one {name, type} entry`,
        detail: { path: metaPath, reason: 'paramSchema missing or empty' },
      });
    }
    for (let i = 0; i < metaObj.paramSchema.length; i++) {
      const entry = metaObj.paramSchema[i] as { name?: unknown; type?: unknown };
      if (typeof entry.name !== 'string' || typeof entry.type !== 'string') {
        return emitError(ctx, {
          code: 'pack-malformed-meta',
          expected: 'paramSchema entry must have name (string) and type (string) fields',
          hint: `fix paramSchema[${i}] in ${metaPath}: each entry needs {name: string, type: string}`,
          detail: { path: metaPath, index: i, entry },
        });
      }
      if (!PARAM_SCHEMA_TYPE_ALLOWLIST.has(entry.type)) {
        const allowed = [...PARAM_SCHEMA_TYPE_ALLOWLIST].join(', ');
        return emitError(ctx, {
          code: 'pack-malformed-meta',
          expected: `paramSchema type must be one of: ${allowed}`,
          hint: `paramSchema[${i}].type '${entry.type}' in ${metaPath} is not in the allowed set`,
          detail: { path: metaPath, index: i, type: entry.type, allowed },
        });
      }
    }
  }

  const materialCount = result.value.filter((e) => e.kind === 'material').length;
  const shaderCount = result.value.filter((e) => e.kind === 'material-shader').length;
  ctx.stdoutWrite(`material-validated: ${materialCount}`);
  ctx.stdoutWrite(`shader-validated: ${shaderCount}`);
  return 0;
}

// Bin entry guard — only fires when this module is the process entry.
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
  const exitCode = await runCliAsset(process.argv.slice(2), {
    stdoutWrite: (line: string) => process.stdout.write(`${line}\n`),
    stderrWrite: (line: string) => process.stderr.write(`${line}\n`),
  });
  process.exit(exitCode);
}
