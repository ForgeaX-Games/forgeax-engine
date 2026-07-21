#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function summary(facts) {
  const artifactBytes = facts.artifactBytes ?? {
    totalCompressedBytes: facts.artifacts.reduce(
      (sum, artifact) => sum + (artifact.compressedBytes ?? 0),
      0,
    ),
    totalExpandedBytes: facts.artifacts.reduce(
      (sum, artifact) => sum + (artifact.expandedBytes ?? 0),
      0,
    ),
    compressionRatio: null,
    byClass: {},
  };
  const artifactRows = Object.entries(artifactBytes.byClass)
    .map(
      ([className, bytes]) =>
        `| ${className} | ${bytes.compressedBytes} | ${bytes.expandedBytes} | ${bytes.compressionRatio ?? 'N/A'} |`,
    )
    .join('\n');
  const rows = facts.ac06.perConsumer
    .map(
      (consumer) =>
        `| ${consumer.jobIdentity} | ${consumer.status} | ${consumer.observedArtifactReadyToJobStartDelaySeconds ?? 'N/A'} |`,
    )
    .join('\n');
  return [
    '# CI cost facts',
    '',
    `Verdict: ${facts.ac06.status}`,
    '',
    '## Production',
    `Artifact records: ${facts.artifacts.length}`,
    `Compressed bytes: ${artifactBytes.totalCompressedBytes}`,
    `Expanded bytes: ${artifactBytes.totalExpandedBytes}`,
    `Compression ratio: ${artifactBytes.compressionRatio ?? 'N/A'}`,
    `Shared production evidence: ${facts.sharedProduction?.status ?? facts.sharedProduction?.cacheState ?? 'invalidEvidence'}`,
    `Shared producer: ${facts.sharedProduction?.producer ?? 'N/A'}`,
    `Shared source scans: ${facts.sharedProduction?.sourceScanCount ?? 'N/A'}`,
    `Shared payload emits: ${facts.sharedProduction?.payloadEmitCount ?? 'N/A'}`,
    `Shared engine compiles: ${facts.sharedProduction?.engineCompileCount ?? 'N/A'}`,
    `Shared transfer bytes: ${facts.sharedProduction?.transferBytes ?? 'N/A'}`,
    `Shared duration seconds: ${facts.sharedProduction?.totalDurationSeconds ?? 'N/A'}`,
    '',
    '### Artifact classes',
    '| Class | Compressed bytes | Expanded bytes | Compression ratio |',
    '| --- | ---: | ---: | ---: |',
    artifactRows,
    '',
    '## Transfer',
    `Consumers: ${facts.consumers.length}`,
    '',
    '## Cache',
    `Active bytes: ${facts.cache.activeBytes}`,
    '',
    '## Fan-out (AC-06)',
    '| Consumer | Status | Observed ready-to-start seconds |',
    '| --- | --- | ---: |',
    rows,
    '',
    '## Wall-clock',
    'Required roster recorded in ci-cost-facts.json',
    '',
  ].join('\n');
}

const factsPath = argument('--facts');
const outputPath = argument('--output') ?? process.env.GITHUB_STEP_SUMMARY;
if (!factsPath || !outputPath) {
  process.stderr.write('Usage: write-ci-cost-summary.mjs --facts <file> --output <file>\n');
  process.exit(2);
}

const facts = JSON.parse(readFileSync(resolve(factsPath), 'utf8'));
appendFileSync(resolve(outputPath), summary(facts));
