import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { mergeMetricsEvidence, stageMetricsEvidence } from '../merge-metrics-evidence.mjs';

const IDENTITY = {
  runId: '42',
  runAttempt: '3',
  headSha: 'a'.repeat(40),
};

function fixtureRoot() {
  return mkdtempSync(join('/tmp', 'metrics-evidence-'));
}

function writeFixture(root, relativePath, value = '{}') {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, value);
}

test('stages only the owner paths and records a complete identity manifest', () => {
  const root = fixtureRoot();
  writeFixture(root, 'report/color-lighting-browser.json');
  writeFixture(root, 'report/pixel-parity.json');
  writeFixture(root, 'report/pixel-parity-standard-lanes.json');
  writeFixture(root, 'report/color-lighting-parity/status-index.json');
  writeFixture(root, 'report/color-lighting-parity/cases/direct.json');
  writeFixture(root, 'report/unowned.json');

  const output = join(root, 'browser-evidence');
  const manifest = stageMetricsEvidence({ root, output, producer: 'browser', ...IDENTITY });

  assert.deepEqual(manifest.presentPaths, [
    'report/color-lighting-browser.json',
    'report/color-lighting-parity',
    'report/pixel-parity.json',
    'report/pixel-parity-standard-lanes.json',
  ]);
  assert.equal(JSON.parse(readFileSync(join(output, 'manifest.json'))).headSha, IDENTITY.headSha);
  assert.equal(existsSync(join(output, 'report/unowned.json')), false);
});

test('joins both producers only when identity and required paths match', () => {
  const root = fixtureRoot();
  writeFixture(root, 'report/color-lighting-browser.json');
  writeFixture(root, 'report/pixel-parity.json');
  writeFixture(root, 'report/pixel-parity-standard-lanes.json');
  writeFixture(root, 'report/color-lighting-parity/status-index.json');
  writeFixture(root, 'packages/runtime/bench-result.json');
  writeFixture(root, 'report/hello-triangle/fps.json');
  writeFixture(root, 'apps/dual-impl-spike/report/texture-4x4.json');

  const browser = join(root, 'browser-evidence');
  const runtime = join(root, 'runtime-evidence');
  stageMetricsEvidence({ root, output: browser, producer: 'browser', ...IDENTITY });
  stageMetricsEvidence({ root, output: runtime, producer: 'runtime', ...IDENTITY });

  const output = join(root, 'joined');
  const result = mergeMetricsEvidence({
    browser,
    runtime,
    output: '.',
    root: output,
    ...IDENTITY,
  });
  assert.deepEqual(
    result.producers.map(({ producer }) => producer),
    ['browser', 'runtime'],
  );
  assert.equal(readFileSync(join(output, 'report/pixel-parity.json'), 'utf8'), '{}');
  assert.equal(
    JSON.parse(readFileSync(join(output, 'report/metrics-producer-join.json'))).headSha,
    IDENTITY.headSha,
  );
});

test('rejects an identity mismatch before copying evidence', () => {
  const root = fixtureRoot();
  writeFixture(root, 'report/color-lighting-browser.json');
  writeFixture(root, 'report/pixel-parity.json');
  writeFixture(root, 'report/pixel-parity-standard-lanes.json');
  writeFixture(root, 'report/color-lighting-parity/status-index.json');
  writeFixture(root, 'packages/runtime/bench-result.json');
  writeFixture(root, 'report/hello-triangle/fps.json');
  writeFixture(root, 'apps/dual-impl-spike/report/texture-4x4.json');

  const browser = join(root, 'browser-evidence');
  const runtime = join(root, 'runtime-evidence');
  stageMetricsEvidence({ root, output: browser, producer: 'browser', ...IDENTITY });
  stageMetricsEvidence({
    root,
    output: runtime,
    producer: 'runtime',
    ...IDENTITY,
    headSha: 'b'.repeat(40),
  });

  assert.throws(
    () => mergeMetricsEvidence({ browser, runtime, root: join(root, 'joined'), ...IDENTITY }),
    /runtime: headSha mismatch/,
  );
});

test('accepts earlier producer attempts during a failed-job retry', () => {
  const root = fixtureRoot();
  writeFixture(root, 'report/color-lighting-browser.json');
  writeFixture(root, 'report/pixel-parity.json');
  writeFixture(root, 'report/pixel-parity-standard-lanes.json');
  writeFixture(root, 'report/color-lighting-parity/status-index.json');
  writeFixture(root, 'packages/runtime/bench-result.json');
  writeFixture(root, 'report/hello-triangle/fps.json');
  writeFixture(root, 'apps/dual-impl-spike/report/texture-4x4.json');

  const browser = join(root, 'browser-evidence');
  const runtime = join(root, 'runtime-evidence');
  stageMetricsEvidence({
    root,
    output: browser,
    producer: 'browser',
    ...IDENTITY,
    runAttempt: '1',
  });
  stageMetricsEvidence({
    root,
    output: runtime,
    producer: 'runtime',
    ...IDENTITY,
    runAttempt: '1',
  });

  const output = join(root, 'joined');
  const result = mergeMetricsEvidence({
    browser,
    runtime,
    output: '.',
    root: output,
    allowEarlierAttempt: true,
    ...IDENTITY,
  });
  assert.deepEqual(
    result.producers.map(({ producer, producerRunAttempt }) => [producer, producerRunAttempt]),
    [
      ['browser', '1'],
      ['runtime', '1'],
    ],
  );
});

test('rejects a future producer attempt even when earlier attempts are allowed', () => {
  const root = fixtureRoot();
  writeFixture(root, 'report/color-lighting-browser.json');
  writeFixture(root, 'report/pixel-parity.json');
  writeFixture(root, 'report/pixel-parity-standard-lanes.json');
  writeFixture(root, 'report/color-lighting-parity/status-index.json');
  writeFixture(root, 'packages/runtime/bench-result.json');
  writeFixture(root, 'report/hello-triangle/fps.json');
  writeFixture(root, 'apps/dual-impl-spike/report/texture-4x4.json');

  const browser = join(root, 'browser-evidence');
  const runtime = join(root, 'runtime-evidence');
  stageMetricsEvidence({
    root,
    output: browser,
    producer: 'browser',
    ...IDENTITY,
    runAttempt: '4',
  });
  stageMetricsEvidence({
    root,
    output: runtime,
    producer: 'runtime',
    ...IDENTITY,
    runAttempt: '1',
  });

  assert.throws(
    () =>
      mergeMetricsEvidence({
        browser,
        runtime,
        allowEarlierAttempt: true,
        ...IDENTITY,
      }),
    /browser: runAttempt mismatch/,
  );
});
