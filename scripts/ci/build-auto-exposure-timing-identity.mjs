#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const FEATURE_ID = 'feat-20260827-auto-exposure-hdr-color-grading';
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name) {
  const value = option(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

const inputPath = resolve(required('input'));
const outputPath = resolve(required('output'));
const head = required('head');
if (!REVISION.test(head))
  throw new Error('--head must be a 40- or 64-character lowercase commit SHA');

const bundle = JSON.parse(readFileSync(inputPath, 'utf8'));
if (bundle?.featureId !== FEATURE_ID) throw new Error('feature identity drift');
const report = bundle?.workloads?.auto?.report?.featureEvidence ?? bundle?.workloads?.auto?.report;
if (report?.featureId !== FEATURE_ID) throw new Error('auto workload report is missing');
if (report.status !== 'observation' || report.verdictSource !== undefined) {
  throw new Error('timing identity must be derived from raw observation evidence');
}
if (
  bundle.testedRevision !== head ||
  (report.testedRevision !== undefined && report.testedRevision !== head)
) {
  throw new Error('timing identity HEAD drift');
}
for (const field of ['source', 'build', 'fixtureIdentity', 'frameIdentity', 'resolution']) {
  if (report[field] === undefined || report[field] === null)
    throw new Error(`timing identity field missing: ${field}`);
}

const identity = {
  testedRevision: head,
  source: report.source,
  build: report.build,
  fixtureIdentity: report.fixtureIdentity,
  frameIdentity: report.frameIdentity,
  resolution: report.resolution,
  backend: 'renderer-gpu-timing',
  runner: { kind: 'timing-admission', id: 'browser+dawn' },
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify({ schemaVersion: 'forgeax-auto-exposure-timing-identity/1', featureId: FEATURE_ID, identity }, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ schemaVersion: 'forgeax-auto-exposure-timing-identity/1', featureId: FEATURE_ID, identity }, null, 2)}\n`,
);
