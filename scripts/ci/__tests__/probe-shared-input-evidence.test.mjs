import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregateBaseline } from '../probe-shared-input-evidence.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('shared evidence baseline is derived from measured producer records', () => {
  const baseline = aggregateBaseline([
    {
      inputFingerprint: 'same',
      sourceScanCount: 1,
      payloadEmitCount: 2,
      engineCompileCount: 1,
      buildDurationSeconds: 1.234,
    },
    {
      inputFingerprint: 'same',
      sourceScanCount: 1,
      payloadEmitCount: 2,
      engineCompileCount: 1,
      buildDurationSeconds: 2.345,
    },
  ]);
  assert.deepEqual(baseline, {
    cacheState: 'baseline',
    probePhase: 'baseline',
    runCount: 2,
    inputFingerprint: 'same',
    sourceScanCount: 2,
    payloadEmitCount: 4,
    engineCompileCount: 2,
    buildDurationSeconds: 3.579,
  });
});

test('shared evidence baseline rejects input drift', () => {
  assert.throws(
    () =>
      aggregateBaseline([
        {
          inputFingerprint: 'a',
          sourceScanCount: 1,
          payloadEmitCount: 0,
          engineCompileCount: 1,
          buildDurationSeconds: 1,
        },
        {
          inputFingerprint: 'b',
          sourceScanCount: 1,
          payloadEmitCount: 0,
          engineCompileCount: 1,
          buildDurationSeconds: 1,
        },
      ]),
    /input fingerprint changed/,
  );
});

test('shared evidence probe is opt-in and feeds cost-reporter through one job output', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /run_shared_evidence_probe:[\s\S]*?type: boolean/);
  assert.match(
    workflow,
    /shared-evidence-probe:[\s\S]*?if: github\.event_name == 'workflow_dispatch' && inputs\.run_shared_evidence_probe == true/,
  );
  assert.match(workflow, /evidence_payload: \$\{\{ steps\.encode\.outputs\.evidence_payload \}\}/);
  assert.match(workflow, /needs: \[build-artifacts,[\s\S]*shared-evidence-probe\]/);
  assert.match(workflow, /--shared-evidence ci-cost-input\/shared-evidence\.json/);
});
