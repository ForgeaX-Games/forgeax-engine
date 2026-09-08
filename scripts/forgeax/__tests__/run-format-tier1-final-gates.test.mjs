import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateSupportMatrix } from '../run-format-tier1-final-gates.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceCodeSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const sourceSha256 = 'a87159400f5de776ce46304540999c2e7f84cec07defceaa661d0a0926a9c2d5';
const layers = ['importer', 'runtime', 'gpu', 'recovery', 'visual'];

function makeMatrix(status = 'supported') {
  return {
    schemaVersion: 'format-support-matrix/1',
    featureId: 'feat-20260812-format-classification-tier1',
    source: { sha256: sourceSha256, firstTierRows: [8, 18, 26] },
    formats: [8, 18, 26].map((csvRow) => ({
      csvRow,
      formatId: `format-${csvRow}`,
      sourceSha256,
      sourceCodeSha,
      overallVerdict: status,
      evidence: layers.map((layer) => ({ layer, status, verdict: status })),
    })),
  };
}

function makeMorphEvidence(status = 'supported') {
  return {
    source: { sourceCodeSha, csvSha256: sourceSha256 },
    producer: { status, verdict: status },
  };
}

test('final gate accepts only a complete supported matrix and Morph producer', () => {
  const result = validateSupportMatrix(
    makeMatrix(),
    makeMorphEvidence(),
    sourceCodeSha,
    sourceSha256,
  );
  assert.equal(result.result, 'supported');
  assert.deepEqual(result.failures, []);
});

test('final gate accepts the Dawn producer pass vocabulary', () => {
  const result = validateSupportMatrix(
    makeMatrix(),
    makeMorphEvidence('pass'),
    sourceCodeSha,
    sourceSha256,
  );
  assert.equal(result.result, 'supported');
  assert.deepEqual(result.failures, []);
});

test('final gate refuses blocked cells and producer evidence', () => {
  const result = validateSupportMatrix(
    makeMatrix('blocked'),
    makeMorphEvidence('blocked'),
    sourceCodeSha,
    sourceSha256,
  );
  assert.equal(result.result, 'blocked');
  assert.ok(
    result.failures.some(
      (failure) => failure.code === 'format-tier1-support-matrix-cell-not-supported',
    ),
  );
  assert.ok(
    result.failures.some((failure) => failure.code === 'format-tier1-morph-producer-not-supported'),
  );
});

test('final gate reports malformed matrix as structured refusal', () => {
  const result = validateSupportMatrix(null, makeMorphEvidence(), sourceCodeSha, sourceSha256);
  assert.equal(result.result, 'blocked');
  assert.deepEqual(result.failures[0], {
    code: 'format-tier1-support-matrix-malformed',
    expected: 'a JSON object with three complete format rows',
    hint: 'repair format-support-matrix.json before rerunning the final gates',
    detail: 'The support matrix is not an object.',
  });
});
