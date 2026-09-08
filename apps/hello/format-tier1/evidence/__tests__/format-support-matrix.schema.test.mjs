import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidenceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(evidenceDir, '../../../../');
const schemaPath = resolve(evidenceDir, 'format-support-matrix.schema.json');
const matrixPath = resolve(
  repoRoot,
  '.forgeax-harness/forgeax-loop/feat-20260812-format-classification-tier1/support-matrix.json',
);
const csvPath = resolve(repoRoot, '.forgeax-harness/docs/forgeax-format-classification.csv');
const EXPECTED_CSV_SHA = 'a87159400f5de776ce46304540999c2e7f84cec07defceaa661d0a0926a9c2d5';
const EXPECTED_MAIN_SHA = 'edb73c9828c8567ae23b73cf55e077d4c616e66f';
const REQUIRED_LAYERS = ['importer', 'runtime', 'gpu', 'recovery', 'visual'];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

function csvRows(csv) {
  const lines = csv.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const fields = parseCsvLine(line);
    return Object.fromEntries(header.map((key, index) => [key, fields[index] ?? '']));
  });
}

function validateMatrix(matrix) {
  const errors = [];
  if (matrix?.schemaVersion !== 'format-support-matrix/1') errors.push('schemaVersion');
  if (matrix?.featureId !== 'feat-20260812-format-classification-tier1') errors.push('featureId');
  if (!/^[a-f0-9]{40,64}$/.test(matrix?.currentMainSha ?? '')) errors.push('currentMainSha');
  const source = matrix?.source;
  if (!source || !/^[a-f0-9]{64}$/.test(source.sha256 ?? '')) errors.push('source.sha256');
  if (source?.byteCount !== 14749) errors.push('source.byteCount');
  if (source?.headerRowCount !== 1) errors.push('source.headerRowCount');
  if (source?.dataRowCount !== 56) errors.push('source.dataRowCount');
  if (JSON.stringify(source?.firstTierRows) !== JSON.stringify([8, 18, 26])) errors.push('source.firstTierRows');
  if (!source?.provenance?.requestedUrl) errors.push('source.provenance.requestedUrl');
  if (!source?.provenance?.resolvedUrl) errors.push('source.provenance.resolvedUrl');
  if (!Array.isArray(matrix?.formats) || matrix.formats.length !== 3) errors.push('formats');
  const seenRows = new Set();
  for (const [index, row] of (matrix?.formats ?? []).entries()) {
    if (!row || typeof row !== 'object') {
      errors.push(`formats[${index}]`);
      continue;
    }
    if (!Number.isInteger(row.csvRow)) errors.push(`formats[${index}].csvRow`);
    if (seenRows.has(row.csvRow)) errors.push(`formats[${index}].duplicateCsvRow`);
    seenRows.add(row.csvRow);
    if (!/^[a-f0-9]{64}$/.test(row.sourceSha256 ?? '')) errors.push(`formats[${index}].sourceSha256`);
    if (!/^[a-f0-9]{40,64}$/.test(row.sourceCodeSha ?? '')) errors.push(`formats[${index}].sourceCodeSha`);
    if (!row.fixture || !Array.isArray(row.fixture.paths)) errors.push(`formats[${index}].fixture`);
    if (!row.environment?.name || !row.environment?.platform || !row.environment?.runtime) {
      errors.push(`formats[${index}].environment`);
    }
    const evidence = row.evidence;
    if (!Array.isArray(evidence) || evidence.length !== REQUIRED_LAYERS.length) {
      errors.push(`formats[${index}].evidence`);
      continue;
    }
    const layers = new Set();
    for (const [evidenceIndex, cell] of evidence.entries()) {
      if (!REQUIRED_LAYERS.includes(cell?.layer)) errors.push(`formats[${index}].evidence[${evidenceIndex}].layer`);
      if (layers.has(cell?.layer)) errors.push(`formats[${index}].evidence[${evidenceIndex}].duplicateLayer`);
      layers.add(cell?.layer);
      for (const field of ['observed', 'verdict', 'confidence']) {
        if (typeof cell?.[field] !== 'string' || cell[field].length === 0) {
          errors.push(`formats[${index}].evidence[${evidenceIndex}].${field}`);
        }
      }
      if (!Array.isArray(cell?.evidenceRefs) || cell.evidenceRefs.length === 0) {
        errors.push(`formats[${index}].evidence[${evidenceIndex}].evidenceRefs`);
      }
      for (const field of ['code', 'expected', 'hint', 'detail']) {
        if (typeof cell?.error?.[field] !== 'string' || cell.error[field].length === 0) {
          errors.push(`formats[${index}].evidence[${evidenceIndex}].error.${field}`);
        }
      }
    }
    if (row.overallVerdict === 'supported') {
      const completeLayers = new Set(['importer', 'runtime', 'gpu', 'recovery']);
      if (evidence.some((cell) => !completeLayers.has(cell.layer) || cell.status !== 'supported')) {
        errors.push(`formats[${index}].incompleteSupportedVerdict`);
      }
    }
  }
  if (JSON.stringify([...seenRows].sort((a, b) => a - b)) !== JSON.stringify([8, 18, 26])) {
    errors.push('format row set');
  }
  return errors;
}

async function loadFixture() {
  const [schemaBytes, matrixBytes, csvBytes] = await Promise.all([
    readFile(schemaPath),
    readFile(matrixPath),
    readFile(csvPath),
  ]);
  return {
    schema: JSON.parse(schemaBytes),
    matrix: JSON.parse(matrixBytes),
    csvBytes,
    csvRows: csvRows(csvBytes),
  };
}

test('matrix schema and initial artifact preserve source provenance', async () => {
  const { schema, matrix, csvBytes, csvRows: rows } = await loadFixture();
  assert.equal(schema.$id, 'https://forgeax.dev/schemas/format-support-matrix/1');
  assert.equal(sha256(csvBytes), EXPECTED_CSV_SHA);
  assert.equal(csvBytes.length, 14749);
  assert.equal(rows.length, 56);
  assert.deepEqual(
    rows.filter((row) => [8, 18, 26].includes(Number(row['\u5e8f\u53f7']))).map((row) => Number(row['\u5e8f\u53f7'])),
    [8, 18, 26],
  );
  assert.equal(matrix.currentMainSha, EXPECTED_MAIN_SHA);
  assert.deepEqual(validateMatrix(matrix), []);
  assert.equal(matrix.source.sha256, EXPECTED_CSV_SHA);
  assert.deepEqual(matrix.source.firstTierRows, [8, 18, 26]);
  assert.equal(matrix.statusPolicy.candidateEvidenceStatus, 'audit-only');
  for (const row of matrix.formats) {
    assert.notEqual(row.overallVerdict, 'supported');
    assert.equal(row.sourceSha256, EXPECTED_CSV_SHA);
    assert.equal(row.sourceCodeSha, EXPECTED_MAIN_SHA);
    assert.deepEqual(row.evidence.map((cell) => cell.layer).sort(), [...REQUIRED_LAYERS].sort());
  }
});

test('matrix validation rejects missing provenance and evidence contract fields', async () => {
  const { matrix } = await loadFixture();
  const mutations = [
    (value) => { delete value.formats[0].sourceSha256; },
    (value) => { delete value.formats[0].sourceCodeSha; },
    (value) => { delete value.source.provenance.requestedUrl; },
    (value) => { delete value.source.provenance.resolvedUrl; },
    (value) => { delete value.formats[0].evidence[0].layer; },
    (value) => { delete value.formats[0].evidence[0].observed; },
    (value) => { delete value.formats[0].evidence[0].verdict; },
    (value) => { delete value.formats[0].evidence[0].confidence; },
    (value) => { delete value.formats[0].evidence[0].error.code; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(matrix);
    mutate(candidate);
    assert.notDeepEqual(validateMatrix(candidate), [], JSON.stringify(candidate));
  }
});

test('matrix validation rejects a supported claim without complete evidence', async () => {
  const { matrix } = await loadFixture();
  const candidate = structuredClone(matrix);
  candidate.formats[0].overallVerdict = 'supported';
  candidate.formats[0].evidence[0].status = 'supported';
  candidate.formats[0].evidence[0].verdict = 'supported';
  assert.ok(candidate.formats[0].evidence.some((cell) => cell.status !== 'supported'));
  assert.notDeepEqual(validateMatrix(candidate), [], 'incomplete supported claim must be rejected');
});
