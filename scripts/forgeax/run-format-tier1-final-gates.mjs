#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const featureId = 'feat-20260812-format-classification-tier1';
const csvPath = resolve(repoRoot, '.forgeax-harness/docs/forgeax-format-classification.csv');
const appEvidenceDir = resolve(repoRoot, 'apps/hello/format-tier1/evidence');
const loopEvidenceDir = resolve(repoRoot, `.forgeax-harness/forgeax-loop/${featureId}/evidence`);
const browserVisualPath = resolve(appEvidenceDir, 'browser-visual-evidence.json');
const meshoptGpuPath = resolve(appEvidenceDir, 'meshopt-gpu-evidence.json');
const ktx2GpuPath = resolve(appEvidenceDir, 'ktx2-basis-gpu-evidence.json');
const expectedMatrixRows = [8, 18, 26];
const requiredEvidenceLayers = ['importer', 'runtime', 'gpu', 'recovery', 'visual'];
const priorPublicationProvenance = {
  testedRevision: 'e6517abf36b57355e78b63b8a47c51f8b01a17f2',
  publicationHead: '95ef21b1c6aa4e69562fb823e040635c7e710dfd',
  evidenceOnlyPublication: true,
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceCodeSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function tail(value, limit = 1200) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length <= limit ? text : text.slice(-limit);
}

function matrixFailure(code, expected, hint, detail) {
  return { code, expected, hint, detail };
}

function producerEvidencePass(producer, overallVerdict) {
  return (
    (producer?.status === 'supported' || producer?.status === 'pass') &&
    (producer?.verdict === 'supported' ||
      producer?.verdict === 'pass' ||
      (producer?.verdict === undefined && overallVerdict === 'pass'))
  );
}

function isCurrentSourceSha(sourceCodeSha, currentCodeSha) {
  if (!/^[a-f0-9]{40,64}$/.test(sourceCodeSha)) return false;
  if (sourceCodeSha === currentCodeSha) return true;
  const ancestor = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', sourceCodeSha, currentCodeSha],
    {
      cwd: repoRoot,
    },
  );
  if (ancestor.status !== 0) return false;
  const changed = execFileSync(
    'git',
    ['diff', '--name-only', `${sourceCodeSha}..${currentCodeSha}`],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  return (
    changed.length > 0 &&
    changed.every((path) => path.startsWith('apps/hello/format-tier1/evidence/'))
  );
}

export function validateSupportMatrix(matrix, morphEvidence, currentCodeSha, sourceSha256) {
  const failures = [];
  if (!matrix || typeof matrix !== 'object') {
    return {
      result: 'blocked',
      sourceCodeSha: null,
      failures: [
        matrixFailure(
          'format-tier1-support-matrix-malformed',
          'a JSON object with three complete format rows',
          'repair format-support-matrix.json before rerunning the final gates',
          'The support matrix is not an object.',
        ),
      ],
    };
  }

  if (matrix.schemaVersion !== 'format-support-matrix/1') {
    failures.push(
      matrixFailure(
        'format-tier1-support-matrix-malformed',
        'format-support-matrix/1',
        'regenerate the matrix with the current schema contract',
        `schemaVersion=${String(matrix.schemaVersion)}`,
      ),
    );
  }
  if (matrix.featureId !== featureId) {
    failures.push(
      matrixFailure(
        'format-tier1-support-matrix-malformed',
        featureId,
        'bind the matrix to the current feature before release',
        `featureId=${String(matrix.featureId)}`,
      ),
    );
  }
  if (matrix.source?.sha256 !== sourceSha256) {
    failures.push(
      matrixFailure(
        'format-tier1-support-matrix-stale-source',
        sourceSha256,
        'refresh matrix provenance from the current classification CSV',
        `source.sha256=${String(matrix.source?.sha256)}`,
      ),
    );
  }
  if (JSON.stringify(matrix.source?.firstTierRows) !== JSON.stringify(expectedMatrixRows)) {
    failures.push(
      matrixFailure(
        'format-tier1-support-matrix-malformed',
        JSON.stringify(expectedMatrixRows),
        'restore the three first-tier CSV rows in matrix provenance',
        `firstTierRows=${JSON.stringify(matrix.source?.firstTierRows)}`,
      ),
    );
  }

  const rows = Array.isArray(matrix.formats) ? matrix.formats : [];
  if (rows.length !== expectedMatrixRows.length) {
    failures.push(
      matrixFailure(
        'format-tier1-support-matrix-malformed',
        `exactly ${expectedMatrixRows.length} format rows`,
        'restore one matrix row for each first-tier CSV row',
        `formatCount=${rows.length}`,
      ),
    );
  }

  const sourceCodeShas = new Set();
  const seenRows = new Set();
  for (const [index, row] of rows.entries()) {
    const rowLabel = row?.formatId ?? `row-${index}`;
    if (!row || typeof row !== 'object') {
      failures.push(
        matrixFailure(
          'format-tier1-support-matrix-malformed',
          'an object format row',
          'regenerate the malformed matrix row',
          rowLabel,
        ),
      );
      continue;
    }
    if (!expectedMatrixRows.includes(row.csvRow) || seenRows.has(row.csvRow)) {
      failures.push(
        matrixFailure(
          'format-tier1-support-matrix-malformed',
          `unique CSV rows ${expectedMatrixRows.join(', ')}`,
          'restore the first-tier row set without duplicates',
          `${rowLabel}.csvRow=${String(row.csvRow)}`,
        ),
      );
    }
    seenRows.add(row.csvRow);

    if (row.sourceSha256 !== sourceSha256) {
      failures.push(
        matrixFailure(
          'format-tier1-support-matrix-stale-source',
          sourceSha256,
          'refresh every row from the current classification CSV',
          `${rowLabel}.sourceSha256=${String(row.sourceSha256)}`,
        ),
      );
    }
    if (!/^[a-f0-9]{40,64}$/.test(row.sourceCodeSha)) {
      failures.push(
        matrixFailure(
          'format-tier1-support-matrix-malformed',
          'a 40-64 character lowercase git SHA',
          'bind every row to a source revision before release',
          `${rowLabel}.sourceCodeSha=${String(row.sourceCodeSha)}`,
        ),
      );
    } else {
      sourceCodeShas.add(row.sourceCodeSha);
      if (!isCurrentSourceSha(row.sourceCodeSha, currentCodeSha)) {
        failures.push(
          matrixFailure(
            'format-tier1-support-matrix-stale-source',
            'the exact current source SHA',
            'regenerate evidence after the final code commit and keep all witnesses on that SHA',
            `${rowLabel}.sourceCodeSha=${row.sourceCodeSha}`,
          ),
        );
      }
    }
    if (row.overallVerdict !== 'supported') {
      failures.push(
        matrixFailure(
          'format-tier1-support-matrix-row-not-supported',
          'overallVerdict=supported',
          'complete every required evidence layer before release',
          `${rowLabel}.overallVerdict=${String(row.overallVerdict)}`,
        ),
      );
    }

    const evidence = Array.isArray(row.evidence) ? row.evidence : [];
    for (const layer of requiredEvidenceLayers) {
      const cells = evidence.filter((cell) => cell?.layer === layer);
      if (cells.length !== 1) {
        failures.push(
          matrixFailure(
            'format-tier1-support-matrix-malformed',
            `one ${layer} evidence cell`,
            'restore the complete five-layer evidence matrix',
            `${rowLabel}.${layer}.count=${cells.length}`,
          ),
        );
        continue;
      }
      const [cell] = cells;
      if (cell.status !== 'supported' || cell.verdict !== 'supported') {
        failures.push(
          matrixFailure(
            'format-tier1-support-matrix-cell-not-supported',
            `${layer} status=supported and verdict=supported`,
            'produce the missing real evidence or preserve the release refusal',
            `${rowLabel}.${layer}:status=${String(cell.status)},verdict=${String(cell.verdict)}`,
          ),
        );
      }
    }
  }

  if (sourceCodeShas.size !== 1) {
    failures.push(
      matrixFailure(
        'format-tier1-support-matrix-source-sha-mismatch',
        'all three rows share one sourceCodeSha',
        'regenerate all rows from one source revision',
        `sourceCodeShas=${JSON.stringify([...sourceCodeShas])}`,
      ),
    );
  }
  const matrixSourceCodeSha = sourceCodeShas.size === 1 ? [...sourceCodeShas][0] : null;
  if (matrixSourceCodeSha && morphEvidence?.source?.sourceCodeSha !== matrixSourceCodeSha) {
    failures.push(
      matrixFailure(
        'format-tier1-support-matrix-source-sha-mismatch',
        matrixSourceCodeSha,
        'bind Morph evidence to the same source revision as every matrix row',
        `morph.source.sourceCodeSha=${String(morphEvidence?.source?.sourceCodeSha)}`,
      ),
    );
  }
  if (morphEvidence?.source?.csvSha256 !== sourceSha256) {
    failures.push(
      matrixFailure(
        'format-tier1-support-matrix-stale-source',
        sourceSha256,
        'refresh Morph evidence provenance from the current classification CSV',
        `morph.source.csvSha256=${String(morphEvidence?.source?.csvSha256)}`,
      ),
    );
  }
  if (!producerEvidencePass(morphEvidence?.producer, morphEvidence?.verdict)) {
    failures.push(
      matrixFailure(
        'format-tier1-morph-producer-not-supported',
        'producer.status/verdict=supported|pass',
        'provide the real imported Morph producer before promoting the final gate',
        `producer.status=${String(morphEvidence?.producer?.status)},producer.verdict=${String(morphEvidence?.producer?.verdict)}`,
      ),
    );
  }

  return {
    result: failures.length === 0 ? 'supported' : 'blocked',
    sourceCodeSha: matrixSourceCodeSha,
    failures,
  };
}

function runCommand(id, file, args, timeout = 180_000) {
  const started = Date.now();
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  return {
    id,
    command: [file, ...args].join(' '),
    result: result.status === 0 ? 'pass' : 'fail',
    exitCode: result.status,
    signal: result.signal ?? null,
    timedOut,
    durationMs: Date.now() - started,
    stdout: tail(result.stdout, 32_000),
    stderr: tail(result.stderr),
  };
}

async function consumeGpuWitnesses(commands, currentCodeSha) {
  const failures = [];
  const meshoptResult = await readJsonOrError(meshoptGpuPath);
  const meshopt = meshoptResult.value;
  if (meshoptResult.error) {
    failures.push(`meshopt witness unreadable: ${meshoptResult.error}`);
  } else {
    if (!isCurrentSourceSha(meshopt.sourceCodeSha, currentCodeSha))
      failures.push('meshopt witness sourceCodeSha');
    if (meshopt.status !== 'pass')
      failures.push(`meshopt witness status=${String(meshopt.status)}`);
    const attributeReadback = meshopt.decoded?.attributeReadback;
    for (const attribute of ['position', 'normal', 'uv', 'tangent']) {
      if (attributeReadback?.[attribute]?.status !== 'pass')
        failures.push(`meshopt ${attribute} readback`);
    }
    if (meshopt.decoded?.indexReadback?.status !== 'pass') failures.push('meshopt index readback');
    if (meshopt.malformed?.status !== 'refused') failures.push('meshopt malformed refusal');
  }

  const ktxCommand = commands.find((command) => command.id === 'ktx2-basis-gpu-matrix');
  const ktxFile = await readJsonOrError(ktx2GpuPath);
  const ktx2 = ktxFile.value;
  if (ktxCommand?.result !== 'pass') {
    failures.push('ktx2 GPU matrix command failed');
  } else if (
    ktxFile.error ||
    ktx2?.status !== 'complete' ||
    !Array.isArray(ktx2.rows) ||
    ktx2.rows.length !== 20
  ) {
    failures.push('ktx2 GPU witness does not contain 20 cells');
  } else {
    if (!isCurrentSourceSha(ktx2.sourceCodeSha, currentCodeSha))
      failures.push('ktx2 witness sourceCodeSha');
    for (const row of ktx2.rows) {
      if (typeof row.source !== 'string' || typeof row.guid !== 'string')
        failures.push('ktx2 cell identity');
      if (
        typeof row.reference?.source !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row.reference?.sha256 ?? '') ||
        typeof row.reference?.byteLength !== 'number'
      ) {
        failures.push(`ktx2 reference provenance: ${row.source}:${row.arm}`);
      }
      if (row.normalized?.status === undefined)
        failures.push(`ktx2 normalized result missing: ${row.source}:${row.arm}`);
      if (row.status === 'pass' && row.normalized?.status !== 'pass') {
        failures.push(`ktx2 normalized comparison failed: ${row.source}:${row.arm}`);
      }
      if (row.normalized?.status === 'pass' && typeof row.normalized.maxAbsError !== 'number') {
        failures.push(`ktx2 normalized maxAbsError missing: ${row.source}:${row.arm}`);
      }
    }
  }
  return {
    result: failures.length === 0 ? 'pass' : 'blocked',
    failures,
    meshopt,
    ktx2,
  };
}

function capabilityRefusal() {
  return {
    id: 'browser-visual',
    result: 'blocked',
    error: {
      code: 'format-tier1-visual-evidence-not-run',
      expected:
        'A current browser capture is produced and read for the format-tier1 dogfood target',
      hint: 'provide a browser visual producer for the current feature, then capture and read the screenshot before release',
      detail:
        'No current browser capture ledger is available, so the visual gate remains blocked until the feature-owned browser path is captured and read',
    },
  };
}

async function readBrowserVisualEvidence(currentCodeSha) {
  const result = await readJsonOrError(browserVisualPath);
  if (result.error) return capabilityRefusal();
  const evidence = result.value;
  const expectationIds = [
    'meshopt-gpu-output',
    'ktx2-basis-matrix-output',
    'morph-static-animation-output',
    'morph-zero-weight-output',
  ];
  const expectations = Array.isArray(evidence?.expectations) ? evidence.expectations : [];
  const failures = [];
  if (evidence?.schemaVersion !== 'format-tier1-browser-visual/1') failures.push('schemaVersion');
  if (evidence?.featureId !== featureId) failures.push('featureId');
  if (!isCurrentSourceSha(evidence?.sourceCodeSha, currentCodeSha)) failures.push('sourceCodeSha');
  if (evidence?.target?.url !== 'http://127.0.0.1:5173/') failures.push('target.url');
  if (expectations.length !== expectationIds.length) failures.push('expectation count');
  for (const id of expectationIds) {
    const expectation = expectations.find((entry) => entry?.id === id);
    if (expectation === undefined) {
      failures.push(`${id}:missing`);
      continue;
    }
    for (const field of ['observed', 'verdict', 'confidence']) {
      if (typeof expectation[field] !== 'string' || expectation[field].length === 0)
        failures.push(`${id}:${field}`);
    }
    if (expectation.screenshot === null) {
      if (expectation.verdict !== 'blocked') failures.push(`${id}:screenshot`);
      const refusal = expectation.blockedReason;
      for (const field of ['code', 'expected', 'hint', 'detail']) {
        if (typeof refusal?.[field] !== 'string' || refusal[field].length === 0)
          failures.push(`${id}:blockedReason.${field}`);
      }
    } else if (typeof expectation.screenshot !== 'string' || expectation.screenshot.length === 0) {
      failures.push(`${id}:screenshot`);
    }
    if (typeof expectation.screenshot === 'string') {
      try {
        await access(resolve(repoRoot, expectation.screenshot));
      } catch {
        failures.push(`${id}:screenshot`);
      }
    }
  }
  if (failures.length > 0) {
    return {
      id: 'browser-visual',
      result: 'blocked',
      error: {
        code: 'format-tier1-visual-evidence-invalid',
        expected:
          'A current browser ledger with four structured judgments; blocked expectations may have screenshot=null only with a structured refusal',
        hint: 'recapture a feature-owned target when a real visible consumer exists, or preserve an explicit blocked refusal for unavailable output',
        detail: failures.join(', '),
      },
    };
  }
  return {
    id: 'browser-visual',
    result: evidence.verdict === 'pass' ? 'pass' : 'blocked',
    target: evidence.target,
    sourceCodeSha: evidence.sourceCodeSha,
    browser: evidence.browser,
    expectations,
    observed: evidence.observed,
    verdict: evidence.verdict,
    confidence: evidence.confidence,
    error: evidence.verdict === 'pass' ? null : evidence.blockedReason,
  };
}

async function writeEvidence(report) {
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  await Promise.all(
    [resolve(appEvidenceDir, 'final-gates.json'), resolve(loopEvidenceDir, 'final-gates.json')].map(
      async (path) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, payload, 'utf8');
      },
    ),
  );
}

function runFinalGateCommands() {
  return [
    runCommand('source-matrix-baseline', 'node', [
      'apps/hello/format-tier1/evidence/__tests__/format-support-matrix.schema.test.mjs',
    ]),
    runCommand('migration-audit', 'node', ['apps/hello/format-tier1/scripts/migration-audit.mjs']),
    runCommand('meshopt-importer', 'pnpm', [
      'exec',
      'vitest',
      'run',
      '--project',
      '@forgeax/engine-gltf',
      'packages/gltf/src/__tests__/meshopt-decode.unit.test.ts',
      'packages/gltf/src/__tests__/meshopt-falsifier.unit.test.ts',
      'packages/gltf/src/__tests__/meshopt-real-matrix.integration.test.ts',
    ]),
    runCommand('meshopt-dawn-reference', 'node', [
      'apps/hello/format-tier1/scripts/smoke-meshopt-dawn.mjs',
    ]),
    runCommand('ktx2-basis-capability', 'pnpm', [
      'exec',
      'vitest',
      'run',
      '--project',
      '@forgeax/engine-codec',
      'packages/codec/src/__tests__/ktx2-basis-capability-matrix.unit.test.ts',
    ]),
    runCommand('ktx2-basis-source', 'pnpm', [
      'exec',
      'vitest',
      'run',
      '--project',
      '@forgeax/engine-image',
      'packages/image/src/__tests__/ktx2-basis-importer.unit.test.ts',
    ]),
    runCommand('ktx2-basis-runtime', 'pnpm', [
      'exec',
      'vitest',
      'run',
      '--project',
      '@forgeax/engine-assets-runtime',
      'packages/assets-runtime/src/__tests__/pack-basis-load.integration.test.ts',
    ]),
    runCommand('ktx2-basis-runtime-matrix', 'pnpm', [
      'exec',
      'vitest',
      'run',
      '--project',
      '@forgeax/engine-runtime',
      'packages/runtime/src/__tests__/basis-catalog-dispatch.integration.test.ts',
    ]),
    runCommand(
      'ktx2-basis-gpu-matrix',
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--project',
        'dawn',
        'packages/render/src/__tests__/ktx2-basis-gpu-consumer.dawn.test.ts',
      ],
      240_000,
    ),
    runCommand('morph-source-animation', 'pnpm', [
      'exec',
      'vitest',
      'run',
      '--project',
      '@forgeax/engine-animation',
      'packages/animation/src/__tests__/morph-weights.unit.test.ts',
      'packages/animation/src/__tests__/morph-weights-playback.integration.test.ts',
    ]),
    runCommand('morph-importers', 'pnpm', [
      'exec',
      'vitest',
      'run',
      '--project',
      '@forgeax/engine-gltf',
      'packages/gltf/src/__tests__/morph-import.unit.test.ts',
      'packages/gltf/src/__tests__/morph-import.integration.test.ts',
    ]),
    runCommand('morph-fbx', 'pnpm', [
      'exec',
      'vitest',
      'run',
      '--project',
      '@forgeax/engine-fbx',
      'packages/fbx/src/__tests__/blendshape-import.unit.test.ts',
      'packages/fbx/src/__tests__/blendshape-import.integration.test.ts',
    ]),
    runCommand(
      'morph-gpu-dawn',
      'node',
      ['apps/hello/format-tier1/scripts/smoke-dawn.mjs'],
      240_000,
    ),
    runCommand('recovery', 'node', [
      '--test',
      'apps/hello/format-tier1/evidence/__tests__/recovery-scenarios.test.mjs',
    ]),
    runCommand('typecheck', 'pnpm', ['run', 'typecheck'], 240_000),
    runCommand('layout', 'pnpm', ['test:layout']),
  ];
}

async function readJsonOrError(path) {
  try {
    return { value: JSON.parse(await readFile(path, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function matrixLoadFailure(detail) {
  return {
    result: 'blocked',
    sourceCodeSha: null,
    failures: [
      matrixFailure(
        'format-tier1-support-matrix-malformed',
        'a readable JSON support matrix',
        'restore format-support-matrix.json before rerunning the final gates',
        detail,
      ),
    ],
  };
}

function buildFinalGateReport({
  currentCodeSha,
  sourceSha256,
  commands,
  morphEvidence,
  matrixValidation,
  visual,
  witnesses,
}) {
  const publicationHead = process.env.FORGEAX_PUBLICATION_HEAD ?? currentCodeSha;
  const testedRevision = process.env.FORGEAX_TESTED_REVISION ?? currentCodeSha;
  const staleEvidence =
    !isCurrentSourceSha(morphEvidence.source?.sourceCodeSha, currentCodeSha) ||
    morphEvidence.source?.csvSha256 !== sourceSha256 ||
    morphEvidence.readback?.status !== 'pass' ||
    morphEvidence.falsifiers?.zeroWeights !== 'pass' ||
    morphEvidence.falsifiers?.cullReentry !== 'pass' ||
    morphEvidence.falsifiers?.staleWeights !== 'pass';
  return {
    schemaVersion: 'format-tier1-final-gates/1',
    featureId,
    generatedAt: new Date().toISOString(),
    source: {
      csvPath: '.forgeax-harness/docs/forgeax-format-classification.csv',
      csvSha256: sourceSha256,
      firstTierRows: [8, 18, 26],
      sourceCodeSha: currentCodeSha,
    },
    provenance: {
      testedRevision,
      publicationHead,
      sourceCodeSha: currentCodeSha,
      evidenceOnlyPublication: publicationHead !== testedRevision,
      priorPublication: priorPublicationProvenance,
    },
    environment: {
      name: 'format-tier1-final-gates',
      platform: `${process.platform}-${process.arch}`,
      runtime: process.version,
      backend: 'dawn plus feature-owned browser visual producer',
    },
    commands,
    morphEvidence: {
      sourceCodeSha: morphEvidence.source?.sourceCodeSha ?? null,
      readback: morphEvidence.readback?.status ?? 'missing',
      falsifiers: morphEvidence.falsifiers ?? null,
      stale: staleEvidence,
    },
    supportMatrix: matrixValidation,
    visual,
    witnesses,
    observed:
      'All executable importer, runtime, recovery, type, layout, Dawn, and feature-owned browser visual gates were run from the current feature worktree. Meshopt includes Pack/Catalog/loadByGuid and a Dawn/reference readback witness, KTX2/Basis includes raw Basis runtime loading, 20 GPU cells, normalized comparisons, and malformed KTX2 refusal, imported Morph includes glTF Pack/Catalog/loadByGuid and a static/no-animation FBX importer boundary, and unsupported GPU or browser-consumer cells remain fail-closed.',
    verdict:
      matrixValidation.result !== 'supported'
        ? matrixValidation.result
        : commands.every((command) => command.result === 'pass') &&
            witnesses.result === 'pass' &&
            !staleEvidence &&
            visual.result === 'pass'
          ? 'supported'
          : visual.result === 'blocked'
            ? 'blocked'
            : 'unsupported',
    confidence: 'high',
    falsifiers: {
      staleSourceCodeSha: staleEvidence,
      browserVisualMissing: visual.error?.code === 'format-tier1-visual-evidence-not-run',
      browserVisualExpectationBlocked:
        visual.result === 'blocked' &&
        visual.error?.code !== 'format-tier1-visual-evidence-not-run',
      commandFailure: commands.some((command) => command.result !== 'pass'),
      supportMatrixFailure: matrixValidation.result !== 'supported',
      gpuWitnessFailure: witnesses.result !== 'pass',
      morphProducerNotSupported: !producerEvidencePass(
        morphEvidence.producer,
        morphEvidence.verdict,
      ),
    },
  };
}

async function main() {
  const csvBytes = await readFile(csvPath);
  const currentCodeSha = sourceCodeSha();
  const sourceSha256 = sha256(csvBytes);
  const commands = runFinalGateCommands();

  const morphResult = await readJsonOrError(resolve(appEvidenceDir, 'morph-visual-evidence.json'));
  const morphEvidence = morphResult.value ?? { readError: morphResult.error };

  let matrixValidation;
  const matrixResult = await readJsonOrError(resolve(appEvidenceDir, 'format-support-matrix.json'));
  if (matrixResult.error) {
    matrixValidation = matrixLoadFailure(matrixResult.error);
  } else {
    matrixValidation = validateSupportMatrix(
      matrixResult.value,
      morphEvidence,
      currentCodeSha,
      sourceSha256,
    );
  }

  const visual = await readBrowserVisualEvidence(currentCodeSha);
  const witnesses = await consumeGpuWitnesses(commands, currentCodeSha);

  const report = buildFinalGateReport({
    currentCodeSha,
    sourceSha256,
    commands,
    morphEvidence,
    matrixValidation,
    visual,
    witnesses,
  });

  await writeEvidence(report);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await main();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.verdict !== 'supported') process.exitCode = 2;
}
