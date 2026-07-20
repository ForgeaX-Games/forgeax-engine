#!/usr/bin/env node
// render-sticky.mjs (M5 w22) - sticky comment composer for the CI metrics
// report tree produced by scripts/metrics/run-all.mjs (M5 w19).
//
// Layout (plan-strategy K-10 + AC-15):
//   - Title literal '### forgeax-engine metrics report' on the first line.
//   - Summary table (only rows where status !== 'ok' + an overview line
//     'total: N/M packages x kinds passed') capped at 30 lines.
//   - <details><summary>complete metrics details (<count> entries)</summary>
//     full matrix listing every (package, kind, value, threshold, status)
//     row, capped at 60 lines.
//   - The body is markdown only (no images, no emoji, no colour codes) so
//     the same text is consumable by AI users, pipes, and humans alike
//     (charter proposition 3 machine-readable union > prose).
//
// Usage:
//   node scripts/metrics/render-sticky.mjs [--report-dir <dir>] [--out <path>] [--stdout]
//   --report-dir default = <repo-root>/report
//   --out        default = <report-dir>/sticky-comment.md (mkdir -p as needed)
//   --stdout     also echo the rendered markdown to process.stdout
//
// Reference:
//   - requirements §AC-07 / §AC-15
//   - plan-strategy §K-10 / §7.4 / §7.5

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, '..', '..');

const argv = process.argv.slice(2);
const args = { stdout: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--report-dir' && argv[i + 1]) {
    args.reportDir = argv[++i];
  } else if (a === '--out' && argv[i + 1]) {
    args.out = argv[++i];
  } else if (a === '--stdout') {
    args.stdout = true;
  }
}

const reportDir = resolve(args.reportDir ?? `${defaultRepoRoot}/report`);
const outPath = resolve(args.out ?? `${reportDir}/sticky-comment.md`);

const KIND_ORDER = ['bundle-size', 'fps', 'bench', 'gate', 'spike-report'];
const SUMMARY_CAP = 30;
const DETAILS_CAP = 60;

function listEntries(rootDir) {
  if (!existsSync(rootDir)) return [];
  const entries = [];
  for (const pkg of readdirSync(rootDir).sort()) {
    const pkgDir = `${rootDir}/${pkg}`;
    if (!statSync(pkgDir).isDirectory()) continue;
    for (const file of readdirSync(pkgDir).sort()) {
      if (!file.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(readFileSync(`${pkgDir}/${file}`, 'utf8'));
        entries.push(entry);
      } catch {
        entries.push({
          package: pkg,
          kind: file.replace(/\.json$/, ''),
          status: 'unavailable',
          value: null,
          threshold: null,
          details: { message: 'malformed report json' },
        });
      }
    }
  }
  entries.sort((a, b) => {
    const pa = a.package ?? '';
    const pb = b.package ?? '';
    if (pa !== pb) return pa.localeCompare(pb);
    return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
  });
  return entries;
}

// pixelDiff bench detection: feat-20260512 M3 T-015 introduces a second
// flavour of MetricKind 'bench' whose dispatcher returns details.unit
// === 'pixels' (Layer B aggregate cap). This helper centralises the
// branch so both formatValue + formatThreshold stay aligned (Schema as
// Contract: details.unit is the discriminator anchor).
function isPixelDiffBench(entry) {
  return entry.kind === 'bench' && entry.details?.unit === 'pixels';
}

function formatValue(entry) {
  if (entry.value === null || entry.value === undefined) return 'n/a';
  const v = entry.value;
  if (entry.kind === 'bundle-size') {
    const kb = (v / 1024).toFixed(2);
    return `${v} bytes (${kb} KB)`;
  }
  if (isPixelDiffBench(entry)) {
    const pp = entry.details?.perPixelThreshold;
    const ppFragment = typeof pp === 'number' ? `, perPixel=${pp}` : '';
    return `pixelDiff: ${v} pixels${ppFragment}`;
  }
  if (entry.kind === 'bench') {
    return `${typeof v === 'number' ? v.toFixed(2) : v} ns/op`;
  }
  if (entry.kind === 'fps') {
    return `${typeof v === 'number' ? v.toFixed(2) : v} fps`;
  }
  return String(v);
}

function formatThreshold(entry) {
  if (entry.threshold === null || entry.threshold === undefined) return 'n/a';
  if (entry.kind === 'bundle-size') {
    const kb = (entry.threshold / 1024).toFixed(2);
    return `<= ${entry.threshold} bytes (${kb} KB)`;
  }
  if (isPixelDiffBench(entry)) return `<= ${entry.threshold} pixels`;
  if (entry.kind === 'bench') return `<= ${entry.threshold} ns/op`;
  if (entry.kind === 'fps') return `>= ${entry.threshold} fps`;
  return String(entry.threshold);
}

function tableHeader() {
  return ['| package | kind | value | target | status |', '| --- | --- | --- | --- | --- |'];
}

function tableRow(entry) {
  return `| ${entry.package} | ${entry.kind} | ${formatValue(entry)} | ${formatThreshold(entry)} | ${entry.status} |`;
}

function trimToCap(lines, cap, more) {
  if (lines.length <= cap) return lines;
  const kept = lines.slice(0, cap - 1);
  kept.push(`| ... | ... | ... | ... | (${more} more, see <details>) |`);
  return kept;
}

function render(entries) {
  const okEntries = entries.filter((e) => e.status === 'ok');
  const failed = entries.filter((e) => e.status !== 'ok');
  const total = entries.length;
  const passed = okEntries.length;

  const lines = [];
  lines.push('### forgeax-engine metrics report');
  lines.push('');
  if (total === 0) {
    lines.push('_no metrics report files found under report/. Did `pnpm metrics:run` run?_');
    lines.push('');
  } else if (failed.length === 0) {
    lines.push(`total: ${passed}/${total} (package x kind) entries passed (all status=ok)`);
    lines.push('');
  } else {
    lines.push(...tableHeader());
    const failedRows = failed.map(tableRow);
    const summaryHeaderLines = 5;
    const overviewLine = `total: ${passed}/${total} (package x kind) entries passed`;
    const trimmed = trimToCap(failedRows, SUMMARY_CAP - summaryHeaderLines - 1, failed.length);
    lines.push(...trimmed);
    lines.push(overviewLine);
    lines.push('');
  }

  const detailsLines = [];
  detailsLines.push('<details>');
  detailsLines.push(`<summary>complete metrics details (${total} entries)</summary>`);
  detailsLines.push('');
  detailsLines.push(...tableHeader());
  const detailsBudget = DETAILS_CAP - 5;
  const allRows = entries.map(tableRow);
  const detailsTrimmed = trimToCap(allRows, detailsBudget, allRows.length);
  detailsLines.push(...detailsTrimmed);
  detailsLines.push('');
  detailsLines.push('</details>');
  lines.push(...detailsLines);
  lines.push('');

  return lines.join('\n');
}

const entries = listEntries(reportDir);
const markdown = render(entries);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
if (args.stdout) {
  process.stdout.write(markdown.endsWith('\n') ? markdown : `${markdown}\n`);
}
