import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..', '..');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const verifier = readFileSync(
  resolve(root, 'scripts/dev-verify/verify-webkit-learn-render.mjs'),
  'utf8',
);

test('WebKit deferred membership CI uses tracked source integration', () => {
  const start = workflow.indexOf(
    '      - name: Deferred membership timing WebKit/WebGL2 scenario (300 frames)',
  );
  assert.notEqual(start, -1);
  const end = workflow.indexOf('\n      - name:', start + 1);
  const step = workflow.slice(start, end === -1 ? undefined : end);
  assert.match(step, /scripts\/dev-verify\/verify-webkit-learn-render\.mjs/);
  assert.match(step, /--scenario=deferred-membership/);
  assert.match(step, /--frames=300/);
  assert.doesNotMatch(step, /\.forgeax-harness/);
  assert.match(verifier, /membership-timing\/webkit-subset\.mjs/);
  assert.match(verifier, /const DEFERRED_MEMBERSHIP_VIEWPORT = \{ width: 512, height: 512 \};/);
  assert.match(verifier, /newPage\(\{ viewport: DEFERRED_MEMBERSHIP_VIEWPORT \}\)/);
  assert.match(verifier, /dimensions: DEFERRED_MEMBERSHIP_VIEWPORT/);
  assert.doesNotMatch(
    verifier,
    /\.forgeax-harness\/forgeax-loop\/feat-20260810-deferred-gpu-membership-timing-recovery/,
  );
  assert.equal(
    existsSync(resolve(root, 'scripts/dev-verify/membership-timing/webkit-subset.schema.json')),
    true,
  );
  assert.equal(
    existsSync(resolve(root, 'scripts/dev-verify/membership-timing/full-matrix-contract.json')),
    true,
  );
});

test('full deferred membership corpus CI owns the exact real matrix', () => {
  const start = workflow.indexOf('  deferred-membership-corpus:');
  assert.notEqual(start, -1);
  const end = workflow.indexOf('\n  portability-bun:', start);
  const job = workflow.slice(start, end === -1 ? undefined : end);
  assert.match(
    job,
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "heavy"\]'\) \}\}/,
  );
  assert.match(job, /generate-deferred-membership-manifest\.mjs/);
  assert.match(job, /capture-deferred-membership-corpus\.mjs/);
  assert.match(job, /--webkit-download=webkit-evidence/);
  assert.match(job, /deferred-membership-real-corpus-generation-4/);
  assert.doesNotMatch(job, /\.forgeax-harness/);
});
