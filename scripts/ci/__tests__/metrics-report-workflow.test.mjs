import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const stickyJob = workflow.split('\n  sticky-comment:\n')[1].split(/\n {2}[\w-]+:\n/)[0];
const download = stickyJob
  .split('- name: Download metrics report artifact\n')[1]
  .split(/\n {6}- name:/)[0];
const condition = download.match(/^\s+if: (.+)$/m)[1];
// Evaluate the actual checked-in condition with the job's successful prior steps.
// Hyphenated Actions job identifiers are bracket access in JavaScript.
const admits = new Function(
  'needs',
  `return ${condition.replace(/needs\.([\w-]+)\./g, (_, job) => `needs[${JSON.stringify(job)}].`)}`,
);

test('metrics download depends on its own producer and artifact, including failed unrelated gates', () => {
  for (const primary of ['success', 'failure', 'skipped']) {
    for (const portability of ['success', 'failure', 'skipped']) {
      for (const metrics of ['success', 'failure', 'skipped', 'cancelled']) {
        for (const artifact of ['123', '']) {
          const needs = {
            'primary-pnpm': { result: primary },
            'portability-bun': { result: portability },
            'metrics-validate': { result: metrics, outputs: { metrics_artifact_id: artifact } },
          };
          assert.equal(
            admits(needs),
            ['success', 'failure'].includes(metrics) && artifact !== '',
            JSON.stringify(needs),
          );
        }
      }
    }
  }
  assert.match(download, /node scripts\/ci\/download-artifact-with-retry\.mjs/);
  assert.ok(
    /node --test[^\n]*scripts\/ci\/__tests__\/metrics-report-workflow\.test\.mjs/.test(workflow),
    'Complete CI must execute the metrics reporting regression',
  );
  assert.match(
    download,
    /--artifact-ids "\$\{\{ needs\.metrics-validate\.outputs\.metrics_artifact_id \}\}"/,
  );
});

test('real reporting retains failed primary context and complete metrics, and rejects a missing successful body', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'forgeax-metrics-failed-primary-'));
  const env = {
    ...process.env,
    EXPECTED_PRODUCT_SHA: 'tested-head',
    GITHUB_SHA: 'event-head',
    GITHUB_RUN_ID: '42',
    FORGEAX_CI_NEEDS: JSON.stringify({
      'primary-pnpm': { result: 'failure', outputs: {} },
      'portability-bun': { result: 'success', outputs: {} },
      'metrics-validate': { result: 'success', outputs: { metrics_artifact_id: '123' } },
    }),
  };
  const args = [
    'scripts/metrics/render-sticky.mjs',
    '--report-dir',
    dir,
    '--out',
    resolve(dir, 'context.md'),
    '--stdout',
    '--ci-context',
  ];
  try {
    const missing = spawnSync(process.execPath, args, { encoding: 'utf8', env });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /successful metrics producer has no report body/);
    assert.match(missing.stdout, /\| primary-pnpm \| failure \|/);
    const producer = spawnSync(
      process.execPath,
      [
        'scripts/metrics/render-sticky.mjs',
        '--report-dir',
        'scripts/__tests__/fixtures/render-sticky-all-ok',
        '--out',
        resolve(dir, 'producer.md'),
        '--stdout',
      ],
      { encoding: 'utf8', env: { ...env, FORGEAX_CI_NEEDS: '' } },
    );
    assert.equal(producer.status, 0, producer.stderr);
    writeFileSync(resolve(dir, 'sticky-comment.md'), producer.stdout);
    const complete = spawnSync(process.execPath, args, { encoding: 'utf8', env });
    assert.equal(complete.status, 0, complete.stderr);
    assert.match(complete.stdout, /\| primary-pnpm \| failure \|/);
    assert.match(complete.stdout, /\| metrics-validate \| success \|/);
    assert.ok(complete.stdout.includes(producer.stdout.trim()));
    assert.match(complete.stdout, /Head: `tested-head`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
