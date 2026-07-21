#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}
function fail(code, detail = {}) {
  process.stdout.write(
    `${JSON.stringify({
      code,
      expected: detail.expected ?? 'compatible declared provenance',
      detail: detail.detail ?? detail,
      hint: detail.hint ?? 'Rebuild the producer artifact, then rerun provenance merge.',
      ...detail,
    })}\n`,
  );
  process.exit(1);
}

const recordsDir = resolve(argument('--records-dir') ?? 'provenance-records');
const output = resolve(argument('--out') ?? 'ci-provenance-merged.json');
const githubOutput = argument('--github-output');
const aggregateAttempt = Number(argument('--aggregate-attempt'));
const contractPath = resolve(
  argument('--contract') ?? join('scripts', 'ci', 'build-artifact-contract.json'),
);
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const producers = contract.provenance.producerRoster;
const sharedInputs =
  contract.sharedInputs ??
  (contract.provenance.payloadClasses.includes('shared-asset-pack')
    ? {
        producer: 'shared-app-inputs',
        payloadClasses: ['shared-asset-pack', 'shared-engine-shaders'],
      }
    : null);

if (!existsSync(recordsDir)) fail('ci-provenance-records-dir-missing', { recordsDir });
const candidates = [];
for (const name of readdirSync(recordsDir)) {
  if (!/^provenance-[^-]+(?:-[^-]+)*-a\d+\.json$/.test(name)) continue;
  const path = join(recordsDir, name);
  try {
    candidates.push({ path, record: JSON.parse(readFileSync(path, 'utf8')) });
  } catch {
    fail('ci-provenance-record-invalid', { path });
  }
}

const selected = new Map();
let runId = null;
let schemaVersion = null;
for (const { path, record } of candidates) {
  if (!record || !producers.includes(record.producer)) continue;
  if (
    !Number.isInteger(record.runAttempt) ||
    typeof record.runId !== 'string' ||
    !Array.isArray(record.artifacts) ||
    record.artifacts.some(
      (artifact) =>
        typeof artifact?.class !== 'string' ||
        typeof artifact?.artifactName !== 'string' ||
        typeof artifact?.artifactId !== 'string' ||
        typeof artifact?.uploadedAt !== 'string',
    )
  )
    fail('ci-provenance-record-invalid', { path, producer: record?.producer });
  if (runId === null) {
    runId = record.runId;
    schemaVersion = record.schemaVersion;
  }
  if (record.runId !== runId || record.schemaVersion !== schemaVersion)
    fail('ci-provenance-schema-mismatch', { path, producer: record.producer });
  const prior = selected.get(record.producer);
  if (prior && prior.record.runAttempt === record.runAttempt)
    fail('ci-provenance-record-duplicate', {
      producer: record.producer,
      attempt: record.runAttempt,
    });
  if (!prior || record.runAttempt > prior.record.runAttempt)
    selected.set(record.producer, { path, record });
}

for (const producer of producers)
  if (!selected.has(producer)) fail('ci-provenance-record-missing', { producer });

const shardClasses = new Set(
  contract.shardFamilies?.flatMap((family) => family.members ?? []) ?? [],
);
const shardInputClasses = new Set(sharedInputs?.payloadClasses ?? []);
const expectedByProducer = new Map(
  producers.map((producer) => [
    producer,
    contract.provenance.payloadClasses.filter((className) => {
      if (sharedInputs?.payloadClasses.includes(className)) {
        return producer === sharedInputs.producer;
      }
      if (!shardClasses.has(className)) return producer === 'core-build';
      return contract.shardFamilies?.some(
        (family) => family.producerMapping?.[className] === producer,
      );
    }),
  ]),
);
const mapped = new Map();
for (const producer of producers) {
  const { record } = selected.get(producer);
  const expected = expectedByProducer.get(producer) ?? [];
  const actual = new Set(record.artifacts.map((artifact) => artifact.class));
  if (
    actual.size !== record.artifacts.length ||
    expected.some((className) => !actual.has(className))
  )
    fail('ci-provenance-class-uncovered', { producer, expected, actual: [...actual] });
  if (producer === sharedInputs?.producer) {
    const metadata = record.sharedInputs;
    const requiredInventory = contract.sharedInputs.inventory;
    if (!metadata || typeof metadata !== 'object')
      fail('ci-provenance-shared-record-missing', {
        producer,
        expected: 'shared provenance metadata',
        hint: 'Rebuild shared-app-inputs so its provenance record includes schema, fingerprint, and inventory.',
      });
    if (metadata.schemaVersion !== contract.sharedInputs.schemaVersion)
      fail('ci-provenance-shared-schema-incompatible', {
        producer,
        expected: contract.sharedInputs.schemaVersion,
        detail: metadata.schemaVersion,
      });
    if (
      typeof metadata.inputFingerprint !== 'string' ||
      metadata.inputFingerprint.length === 0 ||
      metadata.inputFingerprint !== metadata.sourceFingerprint
    )
      fail('ci-provenance-shared-input-fingerprint-stale', {
        producer,
        expected: 'inputFingerprint equal to sourceFingerprint',
        detail: metadata,
      });
    if (
      !Array.isArray(metadata.inventory) ||
      requiredInventory.some((path) => !metadata.inventory.includes(path))
    )
      fail('ci-provenance-shared-inventory-incompatible', {
        producer,
        expected: requiredInventory,
        detail: metadata.inventory,
      });
    const production = record.sharedProduction;
    if (
      !production ||
      production.producer !== producer ||
      production.inputFingerprint !== metadata.inputFingerprint ||
      !['cold', 'warm'].includes(production.cacheState) ||
      ['sourceScanCount', 'payloadEmitCount', 'engineCompileCount', 'buildDurationSeconds'].some(
        (field) => !Number.isFinite(production[field]) || production[field] < 0,
      )
    )
      fail('ci-provenance-shared-production-invalid', {
        producer,
        expected: 'measured shared producer facts linked to the provenance fingerprint',
        detail: production,
      });
  }
  for (const artifact of record.artifacts) {
    if (!contract.provenance.payloadClasses.includes(artifact.class))
      fail('ci-provenance-undeclared-class', { producer, class: artifact.class });
    if (mapped.has(artifact.class))
      fail('ci-provenance-class-conflict', {
        class: artifact.class,
        producers: [mapped.get(artifact.class).producer, producer],
      });
    mapped.set(artifact.class, { ...artifact, producer, producerAttempt: record.runAttempt });
  }
}
for (const className of contract.provenance.payloadClasses)
  if (!mapped.has(className)) fail('ci-provenance-class-uncovered', { class: className });

const artifacts = [...mapped.values()].sort((a, b) => a.class.localeCompare(b.class));
const coreArtifactIds = artifacts
  .filter((artifact) => !shardClasses.has(artifact.class) && !shardInputClasses.has(artifact.class))
  .map((artifact) => artifact.artifactId);
const appArtifactIds = artifacts
  .filter((artifact) => shardClasses.has(artifact.class))
  .map((artifact) => artifact.artifactId);
const consumerArtifactIds = artifacts
  .filter((artifact) => !shardInputClasses.has(artifact.class))
  .map((artifact) => artifact.artifactId);
const merged = {
  schemaVersion,
  runId,
  aggregateAttempt,
  producerAttempts: Object.fromEntries(
    producers.map((producer) => [producer, selected.get(producer).record.runAttempt]),
  ),
  mergedAt: new Date().toISOString(),
  artifacts,
  sharedInputs: selected.get(sharedInputs?.producer)?.record.sharedInputs,
  sharedProduction: selected.get(sharedInputs?.producer)?.record.sharedProduction,
};
writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`);
if (githubOutput) {
  writeFileSync(
    resolve(githubOutput),
    `${[
      `artifact_ids=${[...new Set(consumerArtifactIds)].join(',')}`,
      `core_artifact_ids=${[...new Set(coreArtifactIds)].join(',')}`,
      `app_artifact_ids=${[...new Set(appArtifactIds)].join(',')}`,
    ].join('\n')}\n`,
    { flag: 'a' },
  );
}
process.stdout.write(`${JSON.stringify(merged)}\n`);
