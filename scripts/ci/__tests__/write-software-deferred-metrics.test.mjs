import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeSoftwareDeferredMetrics } from '../write-software-deferred-metrics.mjs';

const HEAD = 'a'.repeat(40);

test('writes exact-head software-deferred runtime evidence without physical GPU claims', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-software-deferred-'));
  const result = writeSoftwareDeferredMetrics({
    root,
    headSha: HEAD,
    runId: '42',
    runAttempt: '3',
  });

  assert.equal(result.paths.length, 4);
  for (const relativePath of result.paths) {
    const payload = JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
    assert.equal(payload.headSha ?? payload.identity?.build, HEAD);
    assert.equal(payload.executionMode, 'simulated');
    assert.equal(payload.physicalGpu, false);
    assert.equal(
      payload.verdict ?? payload.status,
      payload.verdict === undefined ? 'deferred' : 'software-deferred',
    );
  }

  const lod = JSON.parse(readFileSync(join(root, result.paths[3]), 'utf8'));
  assert.equal(lod.metrics.timestampAvailable, false);
  assert.equal(lod.falsification.length, 6);
});
