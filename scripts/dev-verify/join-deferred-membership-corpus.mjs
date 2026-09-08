#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  findShardArtifactDirectories,
  findWebkitRoot,
  mergeDirectoryContents,
} from './membership-timing/corpus-files.mjs';
import { recordsFromPath, validateRealCorpus } from './membership-timing/full-matrix.mjs';

function argument(name, fallback) {
  return (
    process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback
  );
}

const manifestArgument = argument('--manifest');
const shardRootArgument = argument('--shard-root');
const webkitDownloadArgument = argument('--webkit-download');
const outputRootArgument = argument('--output-root');
const reportArgument = argument('--report');
const shardCount = Number(argument('--shard-count', '4'));
if (
  manifestArgument === undefined ||
  shardRootArgument === undefined ||
  webkitDownloadArgument === undefined ||
  outputRootArgument === undefined ||
  reportArgument === undefined ||
  !Number.isInteger(shardCount) ||
  shardCount < 1 ||
  shardCount > 16
) {
  throw new Error(
    'usage: join-deferred-membership-corpus.mjs --manifest=<manifest.json> --shard-root=<dir> --webkit-download=<dir> --output-root=<dir> --report=<report.json> [--shard-count=4]',
  );
}

const manifestPath = resolve(manifestArgument);
const shardRoot = resolve(shardRootArgument);
const outputRoot = resolve(outputRootArgument);
const reportPath = resolve(reportArgument);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
mkdirSync(outputRoot, { recursive: true });

const shardDirectories = findShardArtifactDirectories(shardRoot, shardCount);
for (const shardDirectory of shardDirectories) mergeDirectoryContents(shardDirectory, outputRoot);

const dawnRecords = recordsFromPath(outputRoot);
const downloadedWebkitRoot = findWebkitRoot(webkitDownloadArgument);
const unifiedWebkitRoot = join(outputRoot, 'webkit-webgl2');
mergeDirectoryContents(downloadedWebkitRoot, unifiedWebkitRoot);
const webkitRecords = recordsFromPath(unifiedWebkitRoot);
const records = [...dawnRecords, ...webkitRecords];
writeFileSync(
  join(outputRoot, 'full-matrix-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const validation = validateRealCorpus({
  manifest,
  records,
  artifactRoot: outputRoot,
  artifactRootForRecord: (record) =>
    record.provenance?.backendKind === 'wgpu-webgl2' ? unifiedWebkitRoot : outputRoot,
});
const report = {
  schemaVersion: 1,
  gate: 'real-capture-join',
  sourceHead: manifest.sourceHead,
  shardCount,
  shardDirectories,
  records: records.length,
  blocker:
    validation.valid && validation.optimizationReleaseReady
      ? null
      : {
          code: 'accepted-gpu-matrix-incomplete',
          expected: 'acceptedGpu=16 with positive ticks, variance, and 256 overflow fingerprint',
          hint: 'inspect the per-attempt refusal, profile, identity, and artifact hash records before rerunning the fixed carrier route',
          acceptedGpu: validation.counts.acceptedGpu,
        },
  ...validation,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!validation.valid || !validation.optimizationReleaseReady) process.exitCode = 1;
