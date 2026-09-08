import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const matrixPath = resolve(repoRoot, 'apps/hello/format-tier1/evidence/format-support-matrix.json');
const gatesPath = resolve(repoRoot, 'apps/hello/format-tier1/evidence/final-gates.json');
const morphPath = resolve(repoRoot, 'apps/hello/format-tier1/evidence/morph-visual-evidence.json');
const csvPath = resolve(repoRoot, '.forgeax-harness/docs/forgeax-format-classification.csv');
const expectedCsvSha = 'a87159400f5de776ce46304540999c2e7f84cec07defceaa661d0a0926a9c2d5';
const expectedRows = [8, 18, 26];
const expectedLayers = ['gpu', 'importer', 'recovery', 'runtime', 'visual'];
const allowedStatuses = new Set(['supported', 'unsupported', 'blocked']);

function readJson(path) {
  return readFile(path, 'utf8').then((value) => JSON.parse(value));
}

function assertEvidenceRef(ref) {
  const path = ref.split('#', 1)[0];
  if (path === 'requirements.md') return;
  assert.ok(path.length > 0, `empty evidence reference: ${ref}`);
  assert.doesNotThrow(() => execFileSync('test', ['-e', resolve(repoRoot, path)]), ref);
}

test('final support matrix is current, complete, and fail-closed', async () => {
  const [matrix, gates, morph] = await Promise.all([
    readJson(matrixPath),
    readJson(gatesPath),
    readJson(morphPath),
  ]);

  assert.equal(matrix.schemaVersion, 'format-support-matrix/1');
  assert.equal(matrix.featureId, 'feat-20260812-format-classification-tier1');
  assert.equal(matrix.source.sha256, expectedCsvSha);
  assert.deepEqual(matrix.source.firstTierRows, expectedRows);
  assert.deepEqual(matrix.formats.map((row) => row.csvRow), expectedRows);
  assert.deepEqual(matrix.statusPolicy.evidenceLayers, ['importer', 'runtime', 'gpu', 'recovery', 'visual']);
  assert.equal(gates.source.csvSha256, expectedCsvSha);
  assert.equal(gates.verdict, 'supported');
  assert.equal(gates.falsifiers.commandFailure, false);
  assert.equal(gates.visual.result, 'pass');
  assert.equal(morph.source.sourceCodeSha, matrix.formats[0].sourceCodeSha);
  assert.equal(morph.readback.status, 'pass');

  assert.doesNotThrow(() => {
    execFileSync('git', ['merge-base', '--is-ancestor', matrix.formats[0].sourceCodeSha, 'HEAD'], {
      cwd: repoRoot,
    });
  });

  for (const row of matrix.formats) {
    assert.ok(allowedStatuses.has(row.overallVerdict), row.formatId);
    assert.equal(row.sourceSha256, expectedCsvSha, row.formatId);
    assert.equal(row.sourceCodeSha, matrix.formats[0].sourceCodeSha, row.formatId);
    assert.equal(row.evidence.length, expectedLayers.length, row.formatId);
    assert.deepEqual(row.evidence.map((cell) => cell.layer).sort(), expectedLayers, row.formatId);
    assert.equal(row.overallVerdict, 'supported', row.formatId);
    for (const cell of row.evidence) {
      assert.ok(allowedStatuses.has(cell.status), `${row.formatId}:${cell.layer}`);
      assert.ok(allowedStatuses.has(cell.verdict), `${row.formatId}:${cell.layer}`);
      assert.equal(cell.status, 'supported', `${row.formatId}:${cell.layer}:status`);
      assert.equal(cell.verdict, 'supported', `${row.formatId}:${cell.layer}:verdict`);
      assert.ok(cell.observed.length > 0, `${row.formatId}:${cell.layer}`);
      assert.ok(cell.evidenceRefs.length > 0, `${row.formatId}:${cell.layer}`);
      for (const ref of cell.evidenceRefs) assertEvidenceRef(ref);
      for (const field of ['code', 'expected', 'hint', 'detail']) {
        assert.equal(typeof cell.error?.[field], 'string', `${row.formatId}:${cell.layer}:${field}`);
      }
    }
  }

  const csv = await readFile(csvPath);
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(csv).digest('hex'), expectedCsvSha);
});
