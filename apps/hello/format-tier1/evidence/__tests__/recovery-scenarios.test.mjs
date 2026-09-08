import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const runner = resolve(repoRoot, 'scripts/forgeax/run-format-tier1-recovery.mjs');

function runRecovery() {
  const result = spawnSync(process.execPath, [runner, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('format-tier1 recovery preserves identity, LKG, and structured producer actions', () => {
  const report = runRecovery();
  assert.equal(report.schemaVersion, 'format-tier1-recovery/1');
  assert.equal(report.featureId, 'feat-20260812-format-classification-tier1');
  assert.equal(report.sourceSha256, 'a87159400f5de776ce46304540999c2e7f84cec07defceaa661d0a0926a9c2d5');
  assert.deepEqual(report.firstTierRows, [8, 18, 26]);
  assert.deepEqual(
    report.scenarios.map((scenario) => scenario.formatId).sort(),
    ['ktx2-basis', 'meshopt', 'morph-target'],
  );

  for (const scenario of report.scenarios) {
    assert.match(scenario.guid, /^[0-9a-f-]{36}$/);
    assert.match(scenario.sourceKey, /^(meshopt|ktx2-basis|morph-target):/);
    assert.ok(['source', 'ddc-payload'].includes(scenario.contamination));
    assert.equal(scenario.failedInspection.state, 'failed');
    assert.match(scenario.failedInspection.currentKey, /^[a-f0-9]{64}$/);
    assert.match(scenario.failedInspection.lastKnownGoodKey, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(scenario.failure).sort(), ['code', 'detail', 'expected', 'hint']);
    assert.ok(scenario.failure.hint.includes('producer'));
    assert.equal(scenario.recovery.sameGuid, true);
    assert.equal(scenario.recovery.sameSourceKey, true);
    assert.equal(scenario.recovery.lkgPreserved, true);
    assert.equal(scenario.recovery.verified, true);
    assert.equal(scenario.recovery.inspection.state, 'current');
  }
  assert.equal(report.verdict, 'supported');
  assert.equal(report.confidence, 'high');
});
