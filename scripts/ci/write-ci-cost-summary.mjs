#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function ratio(compressedBytes, expandedBytes) {
  return expandedBytes === 0 ? null : Number((compressedBytes / expandedBytes).toFixed(6));
}

function artifactView(facts, familyRows) {
  const validArtifacts = familyRows.filter(
    (row) => row.status === 'valid' && typeof row.artifactId === 'string',
  );
  const physicalArtifacts = [
    ...new Map(validArtifacts.map((row) => [row.artifactId, row])).values(),
  ];
  const derivedArtifactBytes = {
    totalCompressedBytes: physicalArtifacts.reduce(
      (sum, artifact) => sum + artifact.compressedArchiveBytes,
      0,
    ),
    totalExpandedBytes: physicalArtifacts.reduce(
      (sum, artifact) => sum + artifact.expandedDiskBytes,
      0,
    ),
    compressionRatio: null,
    byClass: Object.fromEntries(
      validArtifacts.map((artifact) => [
        artifact.family,
        {
          compressedBytes: artifact.compressedArchiveBytes,
          expandedBytes: artifact.expandedDiskBytes,
          compressionRatio: ratio(artifact.compressedArchiveBytes, artifact.expandedDiskBytes),
        },
      ]),
    ),
  };
  derivedArtifactBytes.compressionRatio = ratio(
    derivedArtifactBytes.totalCompressedBytes,
    derivedArtifactBytes.totalExpandedBytes,
  );
  const artifactBytes =
    familyRows.length > 0
      ? derivedArtifactBytes
      : (facts.artifactBytes ?? {
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
        });
  return { validArtifacts, artifactBytes };
}

function secondsView(value) {
  return Number.isFinite(value) ? value : 'N/A';
}

function timingProjectionSummary(projection) {
  const lines = ['## Timing attribution', `Projection: ${projection?.status ?? 'invalidEvidence'}`];
  if (projection?.status !== 'valid') {
    lines.push(
      `Reason codes: ${projection?.reasonCodes?.join(', ') || 'timing projection unavailable'}`,
      '',
    );
    return lines.join('\n');
  }
  const criticalPath = projection.criticalPath;
  const tail = projection.postCriticalReportingTail;
  const reporter = projection.costReporterDelay;
  const sticky = projection.stickySkip;
  lines.push(
    `Full-run wall: ${secondsView(projection.fullRunWall?.seconds)} seconds`,
    `Critical-path envelope: ${secondsView(criticalPath?.seconds)} seconds`,
    `Critical-path overlap: ${secondsView(criticalPath?.overlapSeconds)} seconds`,
    `Post-critical reporting tail: ${secondsView(tail?.seconds)} seconds`,
    `Cost-reporter delay after critical path: ${secondsView(reporter?.delayAfterCriticalPathSeconds)} seconds`,
    `Cost-reporter active interval: ${secondsView(reporter?.activeSeconds)} seconds`,
    `Sticky reporting: ${sticky?.status ?? 'N/A'}`,
    '',
    '### Artifact-ready delays',
    '| Consumer | Status | Delay seconds |',
    '| --- | --- | ---: |',
    ...(projection.artifactReadyDelays?.consumers ?? []).map(
      (consumer) =>
        `| ${consumer.name ?? 'N/A'} | ${consumer.status} | ${secondsView(consumer.delaySeconds)} |`,
    ),
    '',
  );
  return lines.join('\n');
}

function summary(facts) {
  const familyRows = Array.isArray(facts.returnEvidence?.families)
    ? facts.returnEvidence.families
    : [];
  const { validArtifacts, artifactBytes } = artifactView(facts, familyRows);
  const artifactRows = Object.entries(artifactBytes.byClass)
    .map(
      ([className, bytes]) =>
        `| ${className} | ${bytes.compressedBytes} | ${bytes.expandedBytes} | ${bytes.compressionRatio ?? 'N/A'} |`,
    )
    .join('\n');
  const rows = (facts.ac06?.perConsumer ?? [])
    .map(
      (consumer) =>
        `| ${consumer.jobIdentity} | ${consumer.status} | ${consumer.unattributedStartDelaySeconds ?? consumer.observedArtifactReadyToJobStartDelaySeconds ?? 'N/A'} |`,
    )
    .join('\n');
  const evidenceRows = familyRows
    .map((row) => `| ${row.family} | ${row.status} | ${row.code ?? 'N/A'} | ${row.hint ?? 'N/A'} |`)
    .join('\n');
  const jobRows = (facts.jobs ?? [])
    .map(
      (job) =>
        `| ${job.name} | ${job.status ?? 'invalidEvidence'} | ${job.pool ?? 'N/A'} | ${job.createdAt ?? 'N/A'} | ${job.startedAt ?? 'N/A'} | ${job.completedAt ?? 'N/A'} | ${job.queueWaitSeconds ?? 'N/A'} | ${job.activeSeconds ?? 'N/A'} | ${job.totalSeconds ?? 'N/A'} | ${job.code ?? 'N/A'} |`,
    )
    .join('\n');
  const invalidCount = familyRows.filter(({ status }) => status === 'invalidEvidence').length;
  const validCount = familyRows.filter(({ status }) => status === 'valid').length;
  return [
    '# CI cost facts',
    '',
    `Verdict: ${facts.ac06?.status ?? (invalidCount > 0 ? 'invalidEvidence' : 'observed')}`,
    `Return evidence: ${validCount} valid / ${invalidCount} invalid`,
    '',
    '## Return evidence families',
    '| Family | Status | Code | Recovery |',
    '| --- | --- | --- | --- |',
    evidenceRows,
    '',
    '## Production',
    `Artifact records: ${validArtifacts.length || facts.artifacts.length}`,
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
    timingProjectionSummary(facts.timingProjection),
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
    '| Consumer | Status | Effective ready-to-start seconds |',
    '| --- | --- | ---: |',
    rows,
    '',
    '## Wall-clock',
    'Required roster recorded in ci-cost-facts.json',
    '',
    '## Job timing',
    '| Job | Status | Pool | Created at | Started at | Completed at | Queue wait seconds | Active seconds | Total seconds | Evidence |',
    '| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |',
    jobRows,
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
