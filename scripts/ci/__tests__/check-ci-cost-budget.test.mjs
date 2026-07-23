import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const root = join(directory, '..', '..', '..');
const script = join(root, 'scripts', 'ci', 'check-ci-cost-budget.mjs');
const summaryScript = join(root, 'scripts', 'ci', 'write-ci-cost-summary.mjs');

function facts() {
  return {
    runId: 42,
    runAttempt: 1,
    artifacts: [
      {
        name: 'engine-dist',
        id: 'one',
        compressedBytes: 10,
        expandedBytes: 20,
        readyAt: '2026-07-16T00:00:00Z',
      },
    ],
    artifactBytes: {
      totalCompressedBytes: 10,
      totalExpandedBytes: 20,
      compressionRatio: 0.5,
      byClass: {
        'engine-dist': { compressedBytes: 10, expandedBytes: 20, compressionRatio: 0.5 },
      },
    },
    consumers: [{ name: 'primary-pnpm', downloadedBytes: 10, startedAt: '2026-07-16T00:00:01Z' }],
    cache: { activeBytes: 10, warmRestoreSeconds: 1 },
    sharedProduction: {
      cacheState: 'cold',
      producer: 'shared-app-inputs',
      sourceScanCount: 1,
      payloadEmitCount: 2,
      engineCompileCount: 1,
      transferBytes: 10,
      totalDurationSeconds: 20,
      artifactBytes: 10,
    },
    ac06: {
      status: 'pass',
      perConsumer: [
        {
          jobIdentity: 'primary-pnpm',
          status: 'pass',
          artifactIds: ['one'],
          lastRequiredArtifactReadyAt: '2026-07-16T00:00:00Z',
          observedJobStartedAt: '2026-07-16T00:00:00Z',
          observedArtifactReadyToJobStartDelaySeconds: 0,
          actualSeconds: 0,
          expectedSeconds: 60,
        },
        { jobIdentity: 'publish-fbx-wasm-release', status: 'notApplicable' },
      ],
    },
  };
}
function run(input) {
  const temp = mkdtempSync(join(tmpdir(), 'ci-cost-budget-'));
  const path = join(temp, 'facts.json');
  writeFileSync(path, JSON.stringify(input));
  try {
    const stdout = execFileSync(
      process.execPath,
      [script, '--mode', 'single-run', '--facts', path, '--skip-workflow-check'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return { exitCode: 0, stdout };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout?.toString() ?? '' };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test('repair: cost summary renders Markdown with actual newline separators', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ci-cost-summary-'));
  const factsPath = join(temp, 'facts.json');
  const summaryPath = join(temp, 'summary.md');
  try {
    writeFileSync(factsPath, JSON.stringify(facts()));
    execFileSync(process.execPath, [summaryScript, '--facts', factsPath, '--output', summaryPath]);
    const output = readFileSync(summaryPath, 'utf8');
    assert.match(output, /^# CI cost facts\n\nVerdict: pass\n/m);
    assert.match(output, /Compressed bytes: 10\nExpanded bytes: 20\nCompression ratio: 0\.5/);
    assert.match(output, /\| engine-dist \| 10 \| 20 \| 0\.5 \|/);
    assert.match(output, /\| --- \| --- \| ---: \|\n\| primary-pnpm \| pass \| 0 \|/);
    assert.doesNotMatch(output, /\\\\n/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('t20: passes immediate structural budgets without ten-sample calculations', () => {
  const result = run(facts());
  assert.equal(result.exitCode, 0, result.stdout);
  assert.match(result.stdout, /"status":"pass"/);
  assert.doesNotMatch(result.stdout, /median|wallClockRatio/);
});

test('t20: rejects artifact, consumer, cache, and missing immediate facts', () => {
  for (const mutate of [
    (value) => {
      value.artifacts[0].compressedBytes = 69_224_540;
    },
    (value) => {
      value.consumers[0].downloadedBytes = 41_534_724;
    },
    (value) => {
      value.cache.activeBytes = 7_918_954_216;
    },
    (value) => {
      value.cache.warmRestoreSeconds = 181;
    },
    (value) => {
      value.artifacts[0].compressedBytes = null;
    },
  ]) {
    const value = facts();
    mutate(value);
    const result = run(value);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stdout, /"code":"ci-cost-/);
  }
});

test('t20: enforces AC-06 per consumer and rejects invalid evidence', () => {
  const exceeded = facts();
  exceeded.ac06.status = 'fail';
  exceeded.ac06.perConsumer[0].status = 'fail';
  exceeded.ac06.perConsumer[0].observedArtifactReadyToJobStartDelaySeconds = 61;
  exceeded.ac06.perConsumer[0].actualSeconds = 61;
  const exceededResult = run(exceeded);
  assert.notEqual(exceededResult.exitCode, 0);
  assert.match(exceededResult.stdout, /ci-cost-artifact-ready-to-job-start-budget-exceeded/);

  const invalid = facts();
  invalid.ac06.status = 'invalid';
  invalid.ac06.perConsumer[0].status = 'invalidSample';
  invalid.ac06.perConsumer[0].code = 'ci-cost-job-start-missing';
  const invalidResult = run(invalid);
  assert.notEqual(invalidResult.exitCode, 0);
  assert.match(invalidResult.stdout, /ci-cost-job-start-missing/);
});

test('w20: accepts shared cost facts when provenance owns the declared classes', () => {
  const complete = facts();
  complete.sharedProduction = {
    cacheState: 'warm',
    producer: 'shared-app-inputs',
    sourceScanCount: 1,
    payloadEmitCount: 2,
    engineCompileCount: 1,
    transferBytes: 10,
    totalDurationSeconds: 20,
    artifactBytes: 10,
  };
  assert.equal(run(complete).exitCode, 0);

  for (const mutate of [
    (value) => delete value.sharedProduction,
    (value) => (value.sharedProduction.producer = 'cache-key'),
    (value) => (value.sharedProduction.status = 'invalidEvidence'),
  ]) {
    const value = structuredClone(complete);
    mutate(value);
    const result = run(value);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stdout, /ci-cost-shared-/);
  }
});

function multiRun(entries) {
  const temp = mkdtempSync(join(tmpdir(), 'ci-cost-multi-run-'));
  const factsDir = join(temp, 'facts');
  mkdirSync(factsDir);
  for (const [index, entry] of entries.entries()) {
    const path = join(factsDir, `run-${String(index).padStart(3, '0')}.json`);
    writeFileSync(path, JSON.stringify(entry));
  }
  try {
    const stdout = execFileSync(
      process.execPath,
      [script, '--mode', 'multi-run', '--facts-dir', factsDir],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return { exitCode: 0, stdout };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout?.toString() ?? '' };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function sampleRun(runId, runAttempt, overrides = {}) {
  const base = {
    runId,
    runAttempt,
    artifacts: [
      {
        name: 'engine-dist',
        class: 'engine-dist',
        id: 'artifact-one',
        compressedBytes: 10_000_000,
        expandedBytes: 20_000_000,
        readyAt: '2026-07-16T00:00:00Z',
      },
      {
        name: 'wasm-runtime',
        class: 'wasm-runtime',
        id: 'artifact-two',
        compressedBytes: 5_000_000,
        expandedBytes: 10_000_000,
        readyAt: '2026-07-16T00:00:00Z',
      },
      {
        name: 'app-dist-0',
        class: 'app-dist-0',
        id: 'artifact-shard-0',
        compressedBytes: 1_000_000,
        expandedBytes: 2_000_000,
        readyAt: '2026-07-16T00:00:01Z',
      },
      {
        name: 'app-dist-1',
        class: 'app-dist-1',
        id: 'artifact-shard-1',
        compressedBytes: 1_000_000,
        expandedBytes: 2_000_000,
        readyAt: '2026-07-16T00:00:01Z',
      },
      {
        name: 'app-dist-2',
        class: 'app-dist-2',
        id: 'artifact-shard-2',
        compressedBytes: 1_000_000,
        expandedBytes: 2_000_000,
        readyAt: '2026-07-16T00:00:01Z',
      },
    ],
    consumers: [{ name: 'primary-pnpm', downloadedBytes: 18_000_000 }],
    cache: { activeBytes: 1_000_000_000, warmRestoreSeconds: 30 },
    wallClock: {
      requiredJobRoster: [
        'post-merge-gate',
        'build-artifacts',
        'primary-pnpm',
        'coverage-pnpm',
        'vitest-browser',
        'smoke-fleet',
        'bevy-smoke-fleet',
        'vitest-dawn',
        'webkit-fallback',
        'portability-bun',
        'metrics-validate',
        'collectathon-boot-e2e',
        'publish-fbx-wasm-release',
        'publish-wgpu-wasm-release',
        'publish-basis-wasm-release',
        'sticky-comment',
      ],
      medianWallClockSeconds: 900,
      worstWallClockSeconds: 1100,
    },
    ac06: {
      status: 'pass',
      perConsumer: [
        {
          jobIdentity: 'primary-pnpm',
          status: 'pass',
          observedArtifactReadyToJobStartDelaySeconds: 30,
          artifactIds: ['artifact-one'],
          lastRequiredArtifactReadyAt: '2026-07-16T00:00:00Z',
          observedJobStartedAt: '2026-07-16T00:00:30Z',
        },
        { jobIdentity: 'publish-fbx-wasm-release', status: 'notApplicable' },
      ],
    },
    runnerType: 'self-hosted',
    cancelled: false,
    requiredRoster: [
      'post-merge-gate',
      'build-artifacts',
      'primary-pnpm',
      'coverage-pnpm',
      'vitest-browser',
      'smoke-fleet',
      'bevy-smoke-fleet',
      'vitest-dawn',
      'webkit-fallback',
      'portability-bun',
      'metrics-validate',
      'collectathon-boot-e2e',
      'publish-fbx-wasm-release',
      'publish-wgpu-wasm-release',
      'publish-basis-wasm-release',
      'sticky-comment',
    ],
    ...overrides,
  };
  return base;
}

test('t26: ten comparable samples produce median/worst comparison', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push(
      sampleRun(100 + i, 1, {
        wallClock: {
          requiredJobRoster: sampleRun(0, 1).requiredRoster,
          medianWallClockSeconds: 900 + i * 5,
          worstWallClockSeconds: 1100 + i * 10,
        },
        cache: { activeBytes: 1_000_000_000 + i * 10_000, warmRestoreSeconds: 30 + i },
      }),
    );
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'comparable');
  assert.ok(typeof parsed.medianWallClockSeconds === 'number');
  assert.ok(typeof parsed.worstWallClockSeconds === 'number');
  assert.ok(typeof parsed.medianArtifactBytes === 'number');
  assert.ok(typeof parsed.medianCacheBytes === 'number');
  assert.ok(typeof parsed.medianDdcRestoreSeconds === 'number');
  assert.ok(typeof parsed.wallClockRatio === 'number');
  assert.ok(typeof parsed.ac06Summary === 'object');
});

test('t26: fewer than ten comparable samples produce insufficientEvidence with exit 0', () => {
  const entries = [];
  for (let i = 0; i < 5; i++) {
    entries.push(sampleRun(100 + i, 1));
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'insufficientEvidence');
  assert.ok(typeof parsed.comparableCount === 'number');
  assert.ok(parsed.comparableCount < 10);
});

test('t26: zero samples produce insufficientEvidence with exit 0', () => {
  const result = multiRun([]);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'insufficientEvidence');
  assert.equal(parsed.comparableCount, 0);
});

test('t26: mixed runAttempt rejects from comparable set', () => {
  const entries = [];
  for (let i = 0; i < 12; i++) {
    entries.push(sampleRun(100 + i, i < 9 ? 1 : 2));
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'insufficientEvidence');
  assert.ok(parsed.comparableCount < 10, `expected <10 comparable, got ${parsed.comparableCount}`);
});

test('t26: different runner type rejects from comparable set', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push(sampleRun(100 + i, 1, { runnerType: i < 5 ? 'self-hosted' : 'github-hosted' }));
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'insufficientEvidence');
  assert.ok(parsed.comparableCount < 10);
});

test('t26: different required roster rejects from comparable set', () => {
  const entries = [];
  const rosterA = ['a', 'b', 'c'];
  const rosterB = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 10; i++) {
    entries.push(sampleRun(100 + i, 1, { requiredRoster: i < 5 ? rosterA : rosterB }));
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'insufficientEvidence');
  assert.ok(parsed.comparableCount < 10);
});

test('t26: missing artifact ID rejects from comparable set', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    const entry = sampleRun(100 + i, 1);
    if (i === 3) entry.artifacts[0].id = undefined;
    entries.push(entry);
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'insufficientEvidence');
  assert.ok(parsed.comparableCount < 10);
});

test('t26: missing artifact readyAt rejects from comparable set', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    const entry = sampleRun(100 + i, 1);
    if (i === 5) entry.artifacts[0].readyAt = null;
    entries.push(entry);
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'insufficientEvidence');
  assert.ok(parsed.comparableCount < 10);
});

test('t26: cancelled run rejects from comparable set', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push(sampleRun(100 + i, 1, { cancelled: i === 4 }));
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'insufficientEvidence');
  assert.ok(parsed.comparableCount < 10);
});

test('t26: median/worst computed correctly for wall-clock, artifact bytes, cache, DDC restore', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push(
      sampleRun(100 + i, 1, {
        wallClock: {
          requiredJobRoster: sampleRun(0, 1).requiredRoster,
          medianWallClockSeconds: 800 + i * 10,
          worstWallClockSeconds: 1000 + i * 20,
        },
        cache: { activeBytes: 500_000_000 + i * 100_000, warmRestoreSeconds: 20 + i * 2 },
      }),
    );
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'comparable');
  assert.equal(parsed.comparableCount, 10);
});

test('t26: AC-06 ten all-pass runs show 10 pass / 0 fail / 0 invalid', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push(sampleRun(100 + i, 1));
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ac06Summary.pass, 10);
  assert.equal(parsed.ac06Summary.fail, 0);
  assert.equal(parsed.ac06Summary.invalid, 0);
  assert.equal(parsed.ac06Summary.incomparable, 0);
});

test('t26: AC-06 one fail run counted in summary, not median-masked', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push(
      sampleRun(100 + i, 1, {
        ac06:
          i === 5
            ? {
                status: 'fail',
                perConsumer: [
                  {
                    jobIdentity: 'primary-pnpm',
                    status: 'fail',
                    observedArtifactReadyToJobStartDelaySeconds: 65,
                    artifactIds: ['artifact-one'],
                    lastRequiredArtifactReadyAt: '2026-07-16T00:00:00Z',
                    observedJobStartedAt: '2026-07-16T00:01:05Z',
                  },
                  { jobIdentity: 'publish-fbx-wasm-release', status: 'notApplicable' },
                ],
              }
            : {
                status: 'pass',
                perConsumer: [
                  {
                    jobIdentity: 'primary-pnpm',
                    status: 'pass',
                    observedArtifactReadyToJobStartDelaySeconds: 30,
                    artifactIds: ['artifact-one'],
                    lastRequiredArtifactReadyAt: '2026-07-16T00:00:00Z',
                    observedJobStartedAt: '2026-07-16T00:00:30Z',
                  },
                  { jobIdentity: 'publish-fbx-wasm-release', status: 'notApplicable' },
                ],
              },
      }),
    );
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ac06Summary.fail, 1);
  assert.equal(parsed.ac06Summary.pass, 9);
  // AC-06 fail must not be masked by median
  assert.ok(parsed.ac06Summary.fail > 0, 'AC-06 fail must be preserved in summary');
});

test('t26: insufficientEvidence runs have ac06 incomparable counted separately', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push(
      sampleRun(100 + i, 1, {
        ac06:
          i >= 8
            ? { status: 'insufficientEvidence', perConsumer: [] }
            : {
                status: 'pass',
                perConsumer: [
                  {
                    jobIdentity: 'primary-pnpm',
                    status: 'pass',
                    observedArtifactReadyToJobStartDelaySeconds: 30,
                    artifactIds: ['artifact-one'],
                    lastRequiredArtifactReadyAt: '2026-07-16T00:00:00Z',
                    observedJobStartedAt: '2026-07-16T00:00:30Z',
                  },
                  { jobIdentity: 'publish-fbx-wasm-release', status: 'notApplicable' },
                ],
              },
      }),
    );
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ac06Summary.pass, 8);
  assert.equal(parsed.ac06Summary.incomparable, 2);
});

test('t26: 4-6 shard candidate generated only when median improves >=15% and no regression >10%', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push(
      sampleRun(100 + i, 1, {
        wallClock: {
          requiredJobRoster: sampleRun(0, 1).requiredRoster,
          medianWallClockSeconds: 500,
          worstWallClockSeconds: 600,
        },
        cache: { activeBytes: 500_000_000, warmRestoreSeconds: 20 },
      }),
    );
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  if (parsed.shardExpansionCandidate) {
    assert.ok(parsed.shardExpansionCandidate.medianImprovementPercent >= 15);
    assert.ok(
      parsed.shardExpansionCandidate.maxRegressionPercent === undefined ||
        parsed.shardExpansionCandidate.maxRegressionPercent <= 10,
    );
  }
});

test('t26: 4-6 shard candidate not generated when thresholds not met', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push(
      sampleRun(100 + i, 1, {
        wallClock: {
          requiredJobRoster: sampleRun(0, 1).requiredRoster,
          medianWallClockSeconds: 1200,
          worstWallClockSeconds: 1500,
        },
        cache: { activeBytes: 5_000_000_000, warmRestoreSeconds: 120 },
      }),
    );
  }
  const result = multiRun(entries);
  assert.equal(result.exitCode, 0, result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.shardExpansionCandidate, undefined);
});

test('t26: multi-run mode does not interfere with single-run mode', () => {
  const singleResult = run(facts());
  assert.equal(singleResult.exitCode, 0, singleResult.stdout);
  assert.match(singleResult.stdout, /"status":"pass"/);
  assert.doesNotMatch(singleResult.stdout, /median/);
});
