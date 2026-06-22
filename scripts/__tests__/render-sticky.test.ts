// render-sticky.test.ts (M5 w22) - sticky comment renderer snapshot tests.
//
// Drives the implementation of scripts/metrics/render-sticky.mjs (M5 w22 same
// commit) via TDD. Three fixture report trees exercise the renderer state
// machine:
//
//   (i)   render-sticky-all-ok    => summary table shows only the "total: N/M"
//                                    overview row; <details> body lists every
//                                    metric entry.
//   (ii)  render-sticky-partial   => summary table lists status !== 'ok' rows
//                                    plus the overview row; <details> body
//                                    still lists every entry.
//   (iii) render-sticky-all-bad   => summary table lists every entry (all are
//                                    not ok) plus the overview row.
//
// Output contract (plan-strategy K-10 + AC-15):
//   - Title:   '### forgeax-engine metrics report'
//   - Summary table <= 30 rows (the renderer caps the table at 30 lines)
//   - <details><summary>...</summary> wraps the full matrix
//   - Full matrix <= 60 rows (5 kinds * 12 packages upper bound)
//
// Reference:
//   - requirements §AC-07 / §AC-15
//   - plan-strategy §K-10 / §4.4 / §7.4 / §7.5
//   - plan-tasks.json#w22 acceptanceCheck

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const renderer = resolve(repoRoot, 'scripts/metrics/render-sticky.mjs');
const fixturesDir = resolve(__dirname, 'fixtures');

interface RenderResult {
  status: number;
  stdout: string;
  stderr: string;
}

let tmpOut: string;

beforeEach(() => {
  tmpOut = mkdtempSync(`${tmpdir()}/forgeax-render-sticky-`);
});

afterEach(() => {
  rmSync(tmpOut, { recursive: true, force: true });
});

function runRenderer(reportRoot: string): RenderResult {
  const out = `${tmpOut}/sticky-comment.md`;
  const r = spawnSync('node', [renderer, '--report-dir', reportRoot, '--out', out, '--stdout'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

describe('scripts/metrics/render-sticky.mjs sticky comment composer (w22)', () => {
  it('(i) all-ok fixture: stdout matches snapshot', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-all-ok');
    const r = runRenderer(reportRoot);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatchSnapshot();
  });

  it('(i.a) all-ok fixture: title literal present', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-all-ok');
    const r = runRenderer(reportRoot);
    expect(r.stdout).toContain('### forgeax-engine metrics report');
  });

  it('(i.b) all-ok fixture: <details> + <summary> wraps the matrix', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-all-ok');
    const r = runRenderer(reportRoot);
    expect(r.stdout).toContain('<details>');
    expect(r.stdout).toContain('<summary>');
  });

  it('(ii) partial fixture: stdout matches snapshot', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-partial');
    const r = runRenderer(reportRoot);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatchSnapshot();
  });

  it('(ii.a) partial fixture: summary table lists the over entry', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-partial');
    const r = runRenderer(reportRoot);
    expect(r.stdout).toMatch(/engine[\s\S]*bundle-size[\s\S]*over/);
  });

  it('(iii) all-bad fixture: stdout matches snapshot', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-all-bad');
    const r = runRenderer(reportRoot);
    expect(r.status, `stderr was:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatchSnapshot();
  });

  it('(iv) summary table <= 30 lines + <details> body <= 60 lines (K-10 caps)', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-all-bad');
    const r = runRenderer(reportRoot);
    const summaryEnd = r.stdout.indexOf('<details>');
    expect(summaryEnd).toBeGreaterThan(0);
    const summaryLines = r.stdout.slice(0, summaryEnd).split('\n');
    expect(summaryLines.length).toBeLessThanOrEqual(30);
    const detailsEnd = r.stdout.indexOf('</details>');
    const detailsBlock = r.stdout.slice(summaryEnd, detailsEnd);
    const detailsLines = detailsBlock.split('\n');
    expect(detailsLines.length).toBeLessThanOrEqual(60);
  });

  it('(v) determinism: 3 reruns produce identical stdout', () => {
    const reportRoot = resolve(fixturesDir, 'render-sticky-partial');
    const a = runRenderer(reportRoot).stdout;
    const b = runRenderer(reportRoot).stdout;
    const c = runRenderer(reportRoot).stdout;
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
