#!/usr/bin/env node
// run-all.mjs (M5 w19) - generic CI metrics runner.
//
// Reads forgeax-metrics.schema.json + every workspace member's
// package.json#forgeax.metrics declaration, dispatches one reporter per
// (workspace, kind) where enabled=true, writes
// report/<package>/<kind>.json (2D grouping per plan-strategy K-5), and
// fails fast (exit 1 + stderr 3-section + 'metric-status-not-ok') as soon
// as any entry comes back with status !== 'ok' (charter proposition 4
// explicit failure + user q4=A AC-09 reversal).
//
// Replaces three legacy reporters in one stroke (M5 w21):
//   - scripts/bundle-size-reporter.mjs
//   - apps/hello/triangle/scripts/fps-bench.mjs
//   - scripts/format-report-comment.mjs
// Sticky comment rendering is the sibling render-sticky.mjs script; this
// runner only produces the per-(package, kind) JSON tree.
//
// fps is intentionally NOT dispatched here (plan-strategy K-11): the
// vite preview boot does not fit the 30s run-all budget. fps is handled
// by the sibling scripts/metrics/run-fps.mjs script invoked as a
// dedicated CI step (pnpm metrics:run-fps). Keeping fps out of
// KIND_ORDER + dispatchers below is the SSOT enforcement point.
//
// Usage:
//   node scripts/metrics/run-all.mjs [--root <dir>] [--schema <path>] [--report-dir <dir>]
//   --root        default = process.cwd()
//   --schema      default = <root>/forgeax-metrics.schema.json
//   --report-dir  default = <root>/report
//
// Exit codes:
//   0 = every enabled (workspace, kind) reported status='ok'
//   1 = at least one status !== 'ok' OR a fatal precondition (schema parse,
//       workspace enumeration, missing artefact for an enabled bundle entry)
//
// Reference:
//   - requirements §AC-05 / §AC-06 / §AC-15
//   - plan-strategy §K-5 / §K-8 / §K-11 / §7.1 / §7.3 / §3 R-4

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

// MetricErrorCode mirror — string literals match `packages/types/src/index.ts`
// `export type MetricErrorCode` SSOT (M1 T-001 + T-002). This generic runner
// emits the 4 legacy members directly at the throw sites below; the 2 parity
// members 'pixel-parity-threshold-exceeded' / 'pixel-parity-capture-failed'
// are produced by `scripts/bench/pixel-parity.mjs` (M2 T-009) and then
// dispatched via this runner once M3 T-015 extends `dispatchBench` to read
// `decl.pixelDiff` (research Finding 9 §6 g9 checklist item 5).
/** @type {Readonly<('metric-not-declared' | 'metric-kind-unknown' | 'metric-status-not-ok' | 'metric-schema-malformed' | 'pixel-parity-threshold-exceeded' | 'pixel-parity-capture-failed')[]>} */
const KNOWN_METRIC_ERROR_CODES = Object.freeze([
  'metric-not-declared',
  'metric-kind-unknown',
  'metric-status-not-ok',
  'metric-schema-malformed',
  'pixel-parity-threshold-exceeded',
  'pixel-parity-capture-failed',
]);
void KNOWN_METRIC_ERROR_CODES;

function failStructured(code, expected, hint) {
  process.stderr.write(
    `[reason] ${code}: ${expected}\n[rerun]  pnpm metrics:run\n[hint]   ${hint}\n`,
  );
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// fps intentionally omitted: handled by scripts/metrics/run-fps.mjs as a
// dedicated CI step (plan-strategy K-11; doc above for full rationale).
// gate intentionally omitted: smoke tests are already executed by dedicated
// steps in primary-pnpm; re-running them here adds ~25s of duplicate work.
const KIND_ORDER = ['bundle-size', 'bench', 'spike-report'];

function statusFromBundle(value, threshold) {
  if (value === null) return 'missing';
  if (threshold === null) return 'ok';
  return value <= threshold ? 'ok' : 'over';
}

function dispatchBundleSize(_pkgName, pkgRoot, decl) {
  const path = decl.path;
  const compression = decl.compression;
  const threshold = decl.baseline?.threshold ?? null;
  const artefact = resolve(pkgRoot, path);
  if (!existsSync(artefact)) {
    return {
      kind: 'bundle-size',
      status: 'missing',
      value: null,
      threshold,
      details: { path, compression, message: `artefact missing at ${path}` },
    };
  }
  const buf = readFileSync(artefact);
  const compressed = compression === 'brotli' ? brotliCompressSync(buf) : gzipSync(buf);
  const value = compressed.byteLength;
  return {
    kind: 'bundle-size',
    status: statusFromBundle(value, threshold),
    value,
    threshold,
    details: { path, compression, raw: buf.byteLength },
  };
}

function collectBenchMedians(reportJson, suite) {
  const matches = [];
  const fallback = [];
  for (const f of reportJson?.files ?? []) {
    for (const g of f.groups ?? []) {
      const matchSuite = suite && (g.fullName?.includes(suite) || f.filepath?.includes(suite));
      for (const b of g.benchmarks ?? []) {
        const median = b.median ?? b.mean ?? null;
        if (typeof median === 'number') {
          const ns = median * 1_000_000;
          if (matchSuite) matches.push(ns);
          fallback.push(ns);
        }
      }
    }
  }
  const pool = matches.length > 0 ? matches : fallback;
  if (pool.length === 0) return null;
  return pool.reduce((a, b) => a + b, 0) / pool.length;
}

// pixelDiff branch dispatcher (feat-20260512 M3 T-015): when the bench
// declaration carries a `pixelDiff` sub-field the runner consumes
// report/pixel-parity.json (Schema-as-Contract under
// $defs.benchReportPixelParity) instead of the vitest bench JSON. Status
// derives from diffPixelCount vs pixelDiff.threshold (Layer B aggregate
// cap). The runner does NOT spawn `pnpm bench:pixel-parity` here — that
// is the CI step's responsibility (M3 T-016 ci.yml) so this dispatcher
// stays a pure consumer (architecture-principles #4 Pipeline Isolation).
export function dispatchPixelDiffBench(_pkgName, pkgRoot, decl, opts = {}) {
  const reportPath = decl.reportPath ?? 'report/pixel-parity.json';
  const pixelDiff = decl.pixelDiff;
  const threshold = pixelDiff?.threshold ?? null;
  const root = opts.root ?? process.cwd();
  const artefactCandidates = [resolve(pkgRoot, reportPath), resolve(root, reportPath)];
  const artefact = artefactCandidates.find((p) => existsSync(p)) ?? null;
  if (!artefact) {
    return {
      kind: 'bench',
      status: 'unavailable',
      value: null,
      threshold,
      details: {
        reportPath,
        pixelDiff,
        unit: 'pixels',
        message: `pixel-parity report missing at ${reportPath} (run pnpm bench:pixel-parity first)`,
      },
    };
  }
  let payload;
  try {
    payload = readJson(artefact);
  } catch (e) {
    return {
      kind: 'bench',
      status: 'unavailable',
      value: null,
      threshold,
      details: { reportPath, pixelDiff, unit: 'pixels', parseError: e.message },
    };
  }
  const diffPixelCount = payload?.diffPixelCount ?? null;
  if (typeof diffPixelCount !== 'number') {
    return {
      kind: 'bench',
      status: 'unavailable',
      value: null,
      threshold,
      details: {
        reportPath,
        pixelDiff,
        unit: 'pixels',
        message: 'pixel-parity report missing diffPixelCount integer',
      },
    };
  }
  const status = threshold === null ? 'ok' : diffPixelCount <= threshold ? 'ok' : 'over';
  return {
    kind: 'bench',
    status,
    value: diffPixelCount,
    threshold,
    details: {
      reportPath,
      pixelDiff,
      unit: 'pixels',
      verdict: payload?.verdict ?? null,
      diffPercent: payload?.diffPercent ?? null,
      maxChannelDelta: payload?.maxChannelDelta ?? null,
      perPixelThreshold: payload?.perPixelThreshold ?? null,
      ...(payload?.code ? { code: payload.code } : {}),
    },
  };
}

export function dispatchBench(_pkgName, pkgRoot, decl, opts = {}) {
  // feat-20260512 M3 T-015: extension branch — pixelDiff sub-field
  // routes to the pixel-parity report consumer instead of the legacy
  // vitest bench median path. Both branches return the same shape so
  // the runner aggregator (main()) needs no further branching.
  if (decl && typeof decl === 'object' && 'pixelDiff' in decl && decl.pixelDiff) {
    return dispatchPixelDiffBench(_pkgName, pkgRoot, decl, opts);
  }
  const reportPath = decl.reportPath ?? 'bench-result.json';
  const suite = decl.suite ?? null;
  const threshold = decl.baseline?.threshold ?? null;
  const artefact = resolve(pkgRoot, reportPath);
  const spawnFn = opts.spawnFn ?? spawnSync;
  // bench prereq autodetect (feat-20260510-ci-merge-gate-hardening K-6 + AC-09);
  // retry exactly once. Function-local counter (not module state) so concurrent
  // dispatchers never share retry budget. spawn shape mirrors plan-tasks w12
  // description: `pnpm -F @forgeax/engine-math bench:json` with shell:false (research
  // R-6: CI environment consistency requires direct argv invocation rather
  // than shell interpolation).
  let spawnDetails = null;
  if (!existsSync(artefact)) {
    let retried = 0;
    if (retried === 0) {
      retried = 1;
      const r = spawnFn('pnpm', ['-F', '@forgeax/engine-math', 'bench:json'], {
        cwd: pkgRoot,
        encoding: 'utf8',
        env: process.env,
        shell: false,
        stdio: 'inherit',
      });
      const spawnExit = r?.status ?? -1;
      const spawnStderr = r?.stderr ?? '';
      spawnDetails = {
        spawnExit,
        stderr: typeof spawnStderr === 'string' ? spawnStderr.slice(0, 4000) : '',
      };
      if (spawnExit !== 0 || !existsSync(artefact)) {
        return {
          kind: 'bench',
          status: 'unavailable',
          value: null,
          threshold,
          details: {
            reportPath,
            suite,
            message: `bench prereq spawn failed (exit=${spawnExit}) or artefact still missing at ${reportPath}`,
            ...spawnDetails,
          },
        };
      }
    }
  }
  let payload;
  try {
    payload = readJson(artefact);
  } catch (e) {
    return {
      kind: 'bench',
      status: 'unavailable',
      value: null,
      threshold,
      details: { reportPath, suite, parseError: e.message },
    };
  }
  const valueNs = collectBenchMedians(payload, suite);
  if (valueNs === null) {
    return {
      kind: 'bench',
      status: 'unavailable',
      value: null,
      threshold,
      details: { reportPath, suite, message: 'no benchmark median found' },
    };
  }
  const status = threshold === null ? 'ok' : valueNs <= threshold ? 'ok' : 'over';
  return {
    kind: 'bench',
    status,
    value: valueNs,
    threshold,
    details: {
      reportPath,
      suite,
      unit: 'ns/op',
      ...(spawnDetails ? { spawnDetails } : {}),
    },
  };
}

function dispatchGate(_pkgName, pkgRoot, decl, opts = {}) {
  const cmd = decl.command;
  const root = opts.root ?? process.cwd();
  const cwd = decl.cwd ? resolve(root, decl.cwd) : pkgRoot;
  if (!cmd) {
    return {
      kind: 'gate',
      status: 'unavailable',
      value: null,
      threshold: null,
      details: { message: 'no command specified' },
    };
  }
  const parts = cmd.split(/\s+/).filter(Boolean);
  const head = parts[0];
  const rest = parts.slice(1);
  const r = spawnSync(head, rest, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    shell: false,
  });
  const exit = r.status ?? -1;
  return {
    kind: 'gate',
    status: exit === 0 ? 'ok' : 'unavailable',
    value: exit,
    threshold: 0,
    details: { command: cmd, cwd, exit, stderr: (r.stderr ?? '').slice(0, 4000) },
  };
}

function dispatchSpikeReport(_pkgName, pkgRoot, decl, opts = {}) {
  const reportPath = decl.reportPath;
  if (!reportPath) {
    return {
      kind: 'spike-report',
      status: 'unavailable',
      value: null,
      threshold: null,
      details: { message: 'no reportPath' },
    };
  }
  const root = opts.root ?? process.cwd();
  const candidates = [resolve(pkgRoot, reportPath), resolve(root, reportPath)];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    return {
      kind: 'spike-report',
      status: 'missing',
      value: null,
      threshold: null,
      details: { reportPath, message: `spike artefact missing at ${reportPath}` },
    };
  }
  return {
    kind: 'spike-report',
    status: 'ok',
    value: 1,
    threshold: null,
    details: { reportPath, resolvedAt: found },
  };
}

const dispatchers = {
  'bundle-size': dispatchBundleSize,
  bench: dispatchBench,
  gate: dispatchGate,
  'spike-report': dispatchSpikeReport,
};

function packageNameFromMember(member, pkg) {
  const declared = pkg?.name;
  if (typeof declared === 'string' && declared.length > 0) {
    return declared.replace(/^@[^/]+\//, '');
  }
  const tail = member.split('/').pop() ?? member;
  return tail;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' && argv[i + 1]) {
      args.root = argv[++i];
    } else if (a === '--schema' && argv[i + 1]) {
      args.schema = argv[++i];
    } else if (a === '--report-dir' && argv[i + 1]) {
      args.reportDir = argv[++i];
    }
  }

  const root = resolve(args.root ?? process.cwd());
  const schemaPath = resolve(args.schema ?? `${root}/forgeax-metrics.schema.json`);
  const reportDir = resolve(args.reportDir ?? `${root}/report`);

  let schemaJson;
  try {
    schemaJson = readJson(schemaPath);
  } catch (e) {
    failStructured(
      'metric-schema-malformed',
      'forgeax-metrics.schema.json is well-formed JSON Schema 2020-12',
      `validate with: python -m json.tool forgeax-metrics.schema.json; parseError: ${e.message}`,
    );
  }
  if (!schemaJson) {
    process.exit(1);
  }

  const previousCwd = process.cwd();
  process.chdir(root);
  let workspaces;
  try {
    ({ getEquivalentWorkspaces: workspaces } = await import('../check-workspaces-equivalence.mjs'));
  } catch (e) {
    process.chdir(previousCwd);
    failStructured(
      'metric-schema-malformed',
      'scripts/check-workspaces-equivalence.mjs is importable',
      `module load error: ${e.message}`,
    );
  }
  const members = workspaces();
  process.chdir(previousCwd);

  mkdirSync(reportDir, { recursive: true });

  const failures = [];
  const startedAt = Date.now();

  for (const member of members) {
    const pkgRoot = resolve(root, member);
    let pkg;
    try {
      pkg = readJson(`${pkgRoot}/package.json`);
    } catch (e) {
      failStructured(
        'metric-not-declared',
        `${member} declares forgeax.metrics in package.json`,
        `see forgeax.metrics example in @forgeax/engine-math/package.json (read failed: ${e.message})`,
      );
    }
    const metrics = pkg?.forgeax?.metrics;
    if (!metrics || typeof metrics !== 'object') {
      failStructured(
        'metric-not-declared',
        `${member} declares forgeax.metrics in package.json`,
        'see forgeax.metrics example in @forgeax/engine-math/package.json',
      );
    }
    const pkgShortName = packageNameFromMember(member, pkg);
    const pkgReportDir = resolve(reportDir, pkgShortName);
    for (const kind of KIND_ORDER) {
      const decl = metrics[kind];
      if (!decl || decl.enabled !== true) continue;
      const dispatch = dispatchers[kind];
      if (!dispatch) continue;
      const result = dispatch(pkgShortName, pkgRoot, decl, { root });
      mkdirSync(pkgReportDir, { recursive: true });
      const entry = {
        package: pkgShortName,
        member,
        kind,
        enabled: true,
        status: result.status,
        value: result.value,
        threshold: result.threshold,
        details: result.details,
      };
      const outPath = resolve(pkgReportDir, `${kind}.json`);
      writeFileSync(outPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
      if (result.status !== 'ok') {
        failures.push({ member, pkg: pkgShortName, kind, status: result.status });
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;
  process.stdout.write(`[ok] metrics runner finished in ${elapsedMs}ms\n`);

  if (failures.length > 0) {
    const first = failures[0];
    failStructured(
      'metric-status-not-ok',
      `${first.member}.${first.kind} reports status === '${first.status}' (expected 'ok')`,
      `inspect report/${first.pkg}/${first.kind}.json for value vs threshold; rerun: pnpm metrics:run`,
    );
  }
}

// Main-module guard: when this file is invoked as `node scripts/metrics/run-all.mjs`,
// `process.argv[1]` matches `import.meta.url` and we run the runner. When the
// file is `import`-ed from a test (e.g. dispatch-bench.test.mjs) we skip the
// side-effect path and only expose `dispatchBench` + sibling helpers for unit
// test consumption (plan-strategy K-6 + AC-09 retry semantics in isolation).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
