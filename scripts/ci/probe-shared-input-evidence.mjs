#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const producer = join(scriptDir, 'build-shared-app-inputs.mjs');

export function aggregateBaseline(records) {
  if (!Array.isArray(records) || records.length === 0)
    throw new Error('shared evidence baseline requires at least one record');
  const first = records[0];
  if (
    !first?.inputFingerprint ||
    records.some((record) => record.inputFingerprint !== first.inputFingerprint)
  )
    throw new Error('shared evidence probe input fingerprint changed during baseline');
  return {
    cacheState: 'baseline',
    probePhase: 'baseline',
    runCount: records.length,
    inputFingerprint: first.inputFingerprint,
    sourceScanCount: records.reduce((sum, record) => sum + record.sourceScanCount, 0),
    payloadEmitCount: records.reduce((sum, record) => sum + record.payloadEmitCount, 0),
    engineCompileCount: records.reduce((sum, record) => sum + record.engineCompileCount, 0),
    buildDurationSeconds: Number(
      records.reduce((sum, record) => sum + record.buildDurationSeconds, 0).toFixed(3),
    ),
  };
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function runProducer(root, output, catalogOnly) {
  const result = spawnSync(
    process.execPath,
    [producer, '--root', root, '--out', output, ...(catalogOnly ? ['--catalog-only'] : [])],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0)
    throw new Error(`shared evidence producer failed: ${result.stderr || result.stdout}`);
  return JSON.parse(readFileSync(join(output, 'production-facts.json'), 'utf8'));
}

export function probeSharedInputEvidence(root, output) {
  const workspace = mkdtempSync(join(tmpdir(), 'forgeax-shared-evidence-'));
  try {
    const baseline = aggregateBaseline(
      [0, 1, 2].map((index) => runProducer(root, join(workspace, `baseline-${index}`), false)),
    );
    const cold = {
      ...runProducer(root, join(workspace, 'cold'), true),
      cacheState: 'cold',
      probePhase: 'catalog-only-after-baseline',
    };
    const warm = {
      ...runProducer(root, join(workspace, 'warm'), true),
      cacheState: 'warm',
      probePhase: 'ordered-repeat; cache hit is not inferred',
    };
    if (
      cold.inputFingerprint !== baseline.inputFingerprint ||
      warm.inputFingerprint !== baseline.inputFingerprint
    )
      throw new Error('shared evidence probe input fingerprint changed between phases');
    const evidence = {
      schemaVersion: 1,
      producer: 'shared-evidence-probe',
      inputFingerprint: baseline.inputFingerprint,
      baseline,
      samples: [cold, warm],
    };
    writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  const root = resolve(option('--root', '.'));
  const output = resolve(option('--out', 'shared-evidence.json'));
  probeSharedInputEvidence(root, output);
  process.stdout.write(`${output}\n`);
}
