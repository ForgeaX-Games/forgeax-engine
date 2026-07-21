import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const root = join(directory, '..', '..', '..');
const script = join(root, 'scripts', 'ci', 'audit-ci-cache.mjs');
const workflow = join(root, '.github', 'workflows', 'ci.yml');

function run(input) {
  const temp = mkdtempSync(join(tmpdir(), 'ci-cache-audit-'));
  const path = join(temp, 'cache.json');
  writeFileSync(path, JSON.stringify(input));
  try {
    const stdout = execFileSync(process.execPath, [script, '--input', path], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function runLiveWithoutActionsEnvironment() {
  const temp = mkdtempSync(join(tmpdir(), 'ci-cache-audit-live-'));
  const bin = join(temp, 'bin');
  const gh = join(bin, 'gh');
  mkdirSync(bin);
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(' ') === 'repo view --json nameWithOwner --jq .nameWithOwner') {
  process.stdout.write('ForgeaX-Games/forgeax-engine\\n');
} else if (args.at(-1) === 'repos/ForgeaX-Games/forgeax-engine/actions/caches') {
  process.stdout.write(JSON.stringify([{ total_count: 1, actions_caches: [{ id: 7, key: 'ddc-app', size_in_bytes: 42 }] }]));
} else {
  process.stderr.write(JSON.stringify(args));
  process.exit(2);
}
`,
  );
  chmodSync(gh, 0o755);
  try {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    delete env.GITHUB_REPOSITORY;
    const stdout = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test('t21: enumerates cache pages and computes before and after active bytes', () => {
  const report = run({
    cachePages: [
      {
        total_count: 3,
        actions_caches: [
          {
            id: 1,
            key: 'tsup-dist-runtime',
            size_in_bytes: 30,
            last_accessed_at: '2026-07-01T00:00:00Z',
          },
        ],
      },
      {
        total_count: 3,
        actions_caches: [
          { id: 2, key: 'ddc-app', size_in_bytes: 20, last_accessed_at: '2026-07-16T00:00:00Z' },
          {
            id: 3,
            key: 'tsbuildinfo',
            size_in_bytes: 10,
            last_accessed_at: '2026-07-16T00:00:00Z',
          },
        ],
      },
    ],
    restoreSaveTimings: { 'ddc-app': { restoreSeconds: 4, saveSeconds: 5 } },
  });
  assert.equal(report.activeBytesBefore, 60);
  assert.equal(report.activeBytesAfter, 30);
  assert.deepEqual(
    report.lowValueCaches.map((cache) => cache.key),
    ['tsup-dist-runtime'],
  );
  assert.equal(report.entries.find((entry) => entry.key === 'ddc-app').restoreSeconds, 4);
});

test('t21: retains DDC cold-path insurance and reports AC-08 threshold status', () => {
  const report = run({
    cachePages: [
      {
        total_count: 2,
        actions_caches: [
          { id: 1, key: 'ddc-app', size_in_bytes: 7_918_954_215 },
          { id: 2, key: 'tsup-dist-old', size_in_bytes: 10 },
        ],
      },
    ],
    restoreSaveTimings: {},
  });
  assert.equal(report.lowValueCaches[0].key, 'tsup-dist-old');
  assert.equal(report.thresholdStatus, 'pass');
});

test('live key shape: runner-prefixed tsup dist entries are classified as low value', () => {
  const report = run({
    cachePages: [
      {
        total_count: 1,
        actions_caches: [
          {
            id: 1,
            key: 'self-hosted-linux-x64-tsup-dist-runtime-v2-content',
            size_in_bytes: 12,
          },
        ],
      },
    ],
    restoreSaveTimings: {},
  });
  assert.deepEqual(
    report.lowValueCaches.map((cache) => cache.key),
    ['self-hosted-linux-x64-tsup-dist-runtime-v2-content'],
  );
  assert.equal(report.activeBytesAfter, 0);
});

test('local front door: infers the authenticated repository outside GitHub Actions', () => {
  const report = runLiveWithoutActionsEnvironment();
  assert.equal(report.repository, 'ForgeaX-Games/forgeax-engine');
  assert.deepEqual(
    report.entries.map((entry) => entry.key),
    ['ddc-app'],
  );
});

test('repair: cache audit has read-only cache and repository permissions', () => {
  const source = readFileSync(workflow, 'utf8');
  const jobStart = source.indexOf('  cache-warm:');
  const jobEnd = source.indexOf('\n  # `primary-pnpm`', jobStart);
  const job = source.slice(jobStart, jobEnd);

  assert.match(job, /^ {4}permissions:\n {6}actions: read\n {6}contents: read$/m);
});

test('repair: cache-warm measures restore time and cost-reporter collects its current attempt facts', () => {
  const source = readFileSync(workflow, 'utf8');
  const cacheWarmStart = source.indexOf('  cache-warm:');
  const cacheWarmEnd = source.indexOf('\n  # `primary-pnpm`', cacheWarmStart);
  const cacheWarm = source.slice(cacheWarmStart, cacheWarmEnd);
  const reporterStart = source.indexOf('  cost-reporter:');
  const reporterEnd = source.indexOf('\n  # L2 split-job', reporterStart);
  const reporter = source.slice(reporterStart, reporterEnd);

  const restoreStart = cacheWarm.indexOf('name: Start merged DDC restore timer');
  const restore = cacheWarm.indexOf('name: Restore merged DDC cache');
  const restoreFinish = cacheWarm.indexOf('name: Finish merged DDC restore timer');
  assert.ok(restoreStart >= 0 && restoreStart < restore);
  assert.ok(
    restoreFinish > restore &&
      restoreFinish < cacheWarm.indexOf('name: Download shard transfer artifacts'),
  );
  assert.match(
    cacheWarm,
    /warmRestoreSeconds":\$\{\{ steps\.ddc-restore-finish\.outputs\.seconds \}\}/,
  );
  assert.doesNotMatch(cacheWarm, /"warmRestoreSeconds":0/);
  assert.match(
    reporter,
    /name: Decode cost inputs[\s\S]*needs\.cache-warm\.outputs\.timing_payload[\s\S]*needs\.cache-warm\.outputs\.audit_payload/,
  );
  assert.match(
    reporter,
    /--cache-audit ci-cost-input\/cache\/ci-cache-audit\.json[\s\S]*--cache-timing ci-cost-input\/cache\/ci-cache-timing\.json/,
  );
  assert.match(
    reporter,
    /name: Collect cost facts[\s\S]*collect-ci-cost-monitor\.mjs/,
    'cost fact collection must record unavailable evidence without blocking CI',
  );
  assert.match(
    reporter,
    /name: Check single-run cost budgets[\s\S]*report-ci-cost-monitor\.mjs[\s\S]*name: Write cost summary/,
    'the monitor must preserve its summary after a strict budget violation',
  );
  assert.doesNotMatch(reporter, /continue-on-error/);
});

test('core build: package JavaScript is produced once without per-package transfer actions', () => {
  const source = readFileSync(workflow, 'utf8');
  const jobStart = source.indexOf('  core-build:');
  const jobEnd = source.indexOf('\n  cache-warm:', jobStart);
  const job = source.slice(jobStart, jobEnd);

  assert.doesNotMatch(job, /Cache tsup-dist-|cache-tsup-/);
  assert.doesNotMatch(job, /Reverse guard — cache hit sanity/);
  assert.match(
    job,
    /name: Build package JavaScript once[\s\S]*run: pnpm --filter '\.\/packages\/\*\*' -r --workspace-concurrency=4 --if-present build/,
  );
  assert.equal(job.match(/name: Build package JavaScript once/g)?.length, 1);
});
