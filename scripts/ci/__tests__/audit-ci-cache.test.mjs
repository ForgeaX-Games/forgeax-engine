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
const uploadAction = join(root, '.github', 'actions', 'upload-artifact-with-retry', 'action.yml');

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

function classifyCacheOwnerFixture({ cacheHit, requestedKey, matchedKey, save }) {
  if (cacheHit === 'true' && requestedKey === matchedKey && save.outcome === 'notApplicable')
    return 'exact-hit';
  if (cacheHit === 'false' && matchedKey && requestedKey !== matchedKey) return 'prefix-hit';
  if (cacheHit === '' && matchedKey === '' && save.outcome === 'success') return 'miss+save';
  return 'invalidEvidence';
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
  if (args.includes('--slurp')) process.exit(3);
  process.stdout.write(JSON.stringify({ total_count: 2, actions_caches: [{ id: 7, key: 'ddc-app', size_in_bytes: 42 }] }));
  process.stdout.write(JSON.stringify({ total_count: 2, actions_caches: [{ id: 8, key: 'ddc-editor', size_in_bytes: 24 }] }));
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

function runLiveWithTransientCacheApiFailure() {
  const temp = mkdtempSync(join(tmpdir(), 'ci-cache-audit-retry-'));
  const bin = join(temp, 'bin');
  const gh = join(bin, 'gh');
  const state = join(temp, 'attempts');
  mkdirSync(bin);
  writeFileSync(
    gh,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.join(' ') === 'repo view --json nameWithOwner --jq .nameWithOwner') {
  process.stdout.write('ForgeaX-Games/forgeax-engine\\n');
} else if (args.at(-1) === 'repos/ForgeaX-Games/forgeax-engine/actions/caches') {
  const attempts = existsSync(process.env.CI_CACHE_AUDIT_STATE)
    ? Number(readFileSync(process.env.CI_CACHE_AUDIT_STATE, 'utf8'))
    : 0;
  writeFileSync(process.env.CI_CACHE_AUDIT_STATE, String(attempts + 1));
  if (attempts < 2) {
    process.stderr.write('gh: Server Error (HTTP 502)\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([{ total_count: 1, actions_caches: [{ id: 7, key: 'ddc-app', size_in_bytes: 42 }] }]));
} else {
  process.stderr.write(JSON.stringify(args));
  process.exit(2);
}
`,
  );
  chmodSync(gh, 0o755);
  try {
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CI_CACHE_AUDIT_STATE: state,
    };
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

test('live key shape: parses concatenated paginated GitHub cache responses', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ci-cache-audit-pages-'));
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
  process.stdout.write(
    JSON.stringify({ total_count: 2, actions_caches: [{ id: 7, key: 'ddc-app', size_in_bytes: 42 }] }) +
      JSON.stringify({ total_count: 2, actions_caches: [{ id: 8, key: 'tsbuildinfo', size_in_bytes: 8 }] }),
  );
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
    const report = JSON.parse(stdout);
    assert.equal(report.entries.length, 2);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

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

test('m2: accepts immutable DDC snapshots and reports temporary cache leaks', () => {
  const report = run({
    cachePages: [
      {
        total_count: 3,
        actions_caches: [
          { id: 1, key: 'ddc/snapshots/0/entries/aaaa', size_in_bytes: 7 },
          { id: 2, key: 'ddc/snapshots/0/staging/attempt', size_in_bytes: 3 },
          { id: 3, key: 'ddc/snapshots/0/lease/lock', size_in_bytes: 2 },
        ],
      },
    ],
    restoreSaveTimings: {},
  });
  assert.equal(report.ddcSnapshotStatus, 'fail');
  assert.deepEqual(
    report.ddcTemporaryEntries.map((entry) => entry.key),
    ['ddc/snapshots/0/staging/attempt', 'ddc/snapshots/0/lease/lock'],
  );
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

test('pressure observer: marks an over-limit snapshot without applying deletion', () => {
  const report = run({
    cachePages: [
      {
        total_count: 1,
        actions_caches: [
          {
            id: 1,
            key: 'self-hosted-linux-x64-forgeax-shard-ddc-over',
            size_in_bytes: 7_918_954_216,
          },
        ],
      },
    ],
    restoreSaveTimings: {},
  });
  assert.equal(report.thresholdStatus, 'fail');
  assert.equal(report.deletionApplied, false);
  assert.equal(report.familyStatus['merged-ddc'], 'preserved');
});

test('pressure observer: derives family bytes and keeps stale and unknown entries visible', () => {
  const report = run({
    cachePages: [
      {
        total_count: 5,
        actions_caches: [
          { id: 1, key: 'self-hosted-linux-x64-forgeax-shard-ddc-assets', size_in_bytes: 11 },
          { id: 2, key: 'self-hosted-linux-x64-tsbuildinfo-v6-current', size_in_bytes: 22 },
          { id: 3, key: 'self-hosted-linux-x64-tsbuildinfo-v5-stale', size_in_bytes: 33 },
          { id: 4, key: 'self-hosted-linux-x64-cache-from-a-future-owner', size_in_bytes: 44 },
          { id: 5, key: 'self-hosted-linux-x64-tsup-dist-runtime', size_in_bytes: 55 },
        ],
      },
    ],
    restoreSaveTimings: {},
  });
  assert.deepEqual(report.familyBytes, {
    'merged-ddc': 11,
    'tsbuildinfo-declarations': 55,
    'unclassified-cache': 44,
    'tsup-dist': 55,
  });
  assert.deepEqual(
    report.staleEntries.map((entry) => entry.key),
    ['self-hosted-linux-x64-tsbuildinfo-v5-stale'],
  );
  assert.deepEqual(
    report.unknownEntries.map((entry) => entry.key),
    ['self-hosted-linux-x64-cache-from-a-future-owner'],
  );
  assert.equal(report.familyStatus['merged-ddc'], 'preserved');
  assert.equal(report.familyStatus['tsbuildinfo-declarations'], 'stale');
  assert.equal(report.familyStatus['unclassified-cache'], 'unknown');
  assert.equal(report.deletionApplied, false);
});

test('pressure observer: API failure is fail-closed and never reports deletion', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ci-cache-audit-failure-'));
  const bin = join(temp, 'bin');
  const gh = join(bin, 'gh');
  mkdirSync(bin);
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.join(' ') === 'repo view --json nameWithOwner --jq .nameWithOwner') {
  process.stdout.write('ForgeaX-Games/forgeax-engine\\n');
} else {
  process.stderr.write('gh: Server Error (HTTP 503)\\n');
  process.exit(1);
}
`,
  );
  chmodSync(gh, 0o755);
  try {
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    delete env.GITHUB_REPOSITORY;
    assert.throws(
      () => execFileSync(process.execPath, [script], { encoding: 'utf8', env }),
      (error) => error.status === 1 && error.stdout === '',
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('local front door: infers the authenticated repository outside GitHub Actions', () => {
  const report = runLiveWithoutActionsEnvironment();
  assert.equal(report.repository, 'ForgeaX-Games/forgeax-engine');
  assert.deepEqual(
    report.entries.map((entry) => entry.key),
    ['ddc-app', 'ddc-editor'],
  );
});

test('reliability: retries transient cache API failures before failing the audit', () => {
  const report = runLiveWithTransientCacheApiFailure();
  assert.equal(report.repository, 'ForgeaX-Games/forgeax-engine');
  assert.equal(report.entries[0].key, 'ddc-app');
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
    /RESTORE_SECONDS: \$\{\{ steps\.ddc-restore-finish\.outputs\.seconds \}\}/,
  );
  assert.doesNotMatch(cacheWarm, /"(?:elapsedSeconds|warmRestoreSeconds)":\s*0/);
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

test('M2-T2: structured owner facts uniquely classify exact, prefix, miss-save, and contradictions', () => {
  const requestedKey = 'self-hosted-linux-x64-forgeax-shard-ddc-assets';
  assert.equal(
    classifyCacheOwnerFixture({
      cacheHit: 'true',
      requestedKey,
      matchedKey: requestedKey,
      save: { outcome: 'notApplicable' },
    }),
    'exact-hit',
  );
  assert.equal(
    classifyCacheOwnerFixture({
      cacheHit: 'false',
      requestedKey,
      matchedKey: 'self-hosted-linux-x64-forgeax-shard-ddc-',
      save: { outcome: 'notApplicable' },
    }),
    'prefix-hit',
  );
  assert.equal(
    classifyCacheOwnerFixture({
      cacheHit: '',
      requestedKey,
      matchedKey: '',
      save: { outcome: 'success', elapsedSeconds: 3 },
    }),
    'miss+save',
  );
  assert.equal(
    classifyCacheOwnerFixture({
      cacheHit: 'true',
      requestedKey,
      matchedKey: '',
      save: { outcome: 'success', elapsedSeconds: 0 },
    }),
    'invalidEvidence',
  );
});

test('M2-T2: cache-warm emits requested and matched keys with direct restore-save observations', () => {
  const source = readFileSync(workflow, 'utf8');
  const jobStart = source.indexOf('  cache-warm:');
  const jobEnd = source.indexOf('\n  # `primary-pnpm`', jobStart);
  const job = source.slice(jobStart, jobEnd);

  const restore = job.indexOf('name: Restore merged DDC cache');
  const saveStart = job.indexOf('name: Start merged DDC save timer');
  const save = job.indexOf('name: Save merged DDC cache on miss');
  const saveFinish = job.indexOf('name: Finish merged DDC save observation');
  const write = job.indexOf('name: Write cache timing facts');
  const encode = job.indexOf('name: Encode cache cost outputs');
  assert.ok(restore >= 0 && restore < saveStart);
  assert.ok(saveStart < save && save < saveFinish && saveFinish < write && write < encode);

  assert.match(job, /"requestedKey":\s*process\.env\.REQUESTED_KEY/);
  assert.match(job, /"matchedKey":\s*process\.env\.MATCHED_KEY/);
  assert.match(job, /"cacheHit":\s*process\.env\.CACHE_HIT/);
  assert.match(job, /"elapsedSeconds":\s*Number\(process\.env\.RESTORE_SECONDS\)/);
  assert.match(job, /"outcome":\s*process\.env\.SAVE_OUTCOME/);
  assert.match(job, /producerRunAttempt:\s*Number\(process\.env\.GITHUB_RUN_ATTEMPT\)/);
  assert.match(job, /inputFingerprint:\s*process\.env\.INPUT_FINGERPRINT/);
  assert.doesNotMatch(job, /"(?:elapsedSeconds|warmRestoreSeconds)":\s*0/);

  assert.equal(
    job.match(
      /key: \$\{\{ env\.CACHE_RUNNER_SCOPE \}\}-forgeax-shard-ddc-\$\{\{ steps\.assets-sha\.outputs\.value \}\}/g,
    )?.length,
    2,
  );
  assert.match(job, /if: steps\.cache-ddc\.outputs\.cache-hit != 'true'/);
  assert.doesNotMatch(job, /restore-keys:/);
});

test('M4-T1: cache lifecycle and artifact retry envelope stay unchanged', () => {
  const source = readFileSync(workflow, 'utf8');
  const action = readFileSync(uploadAction, 'utf8');
  const cacheStart = source.indexOf('  cache-warm:');
  const cacheEnd = source.indexOf('\n  # `primary-pnpm`', cacheStart);
  const cacheWarm = source.slice(cacheStart, cacheEnd);

  assert.equal(
    cacheWarm.match(
      /key: \$\{\{ env\.CACHE_RUNNER_SCOPE \}\}-forgeax-shard-ddc-\$\{\{ steps\.assets-sha\.outputs\.value \}\}/g,
    )?.length,
    2,
  );
  assert.equal(cacheWarm.match(/uses: actions\/cache\/restore@v5/g)?.length, 1);
  assert.equal(cacheWarm.match(/uses: actions\/cache\/save@v5/g)?.length, 1);
  assert.match(
    cacheWarm,
    /name: Save merged DDC cache on miss[\s\S]*if: steps\.cache-ddc\.outputs\.cache-hit != 'true'/,
  );
  assert.doesNotMatch(cacheWarm, /restore-keys:/);

  assert.equal(action.match(/uses: actions\/upload-artifact@v6/g)?.length, 3);
  assert.equal(action.match(/ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '60000'/g)?.length, 3);
  assert.equal(action.match(/continue-on-error: true/g)?.length, 2);
  assert.match(action, /sleep \$\(\(2 \+ RANDOM % 3\)\)/);
  assert.match(action, /sleep \$\(\(5 \+ RANDOM % 4\)\)/);
  assert.match(action, /retention-days:[\s\S]*default: 1/);
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
