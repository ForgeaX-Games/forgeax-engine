#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const FEATURE_ID = 'feat-20260827-auto-exposure-hdr-color-grading';
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const HASH = /^[a-f0-9]{64}$/;

function option(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name) {
  const value = option(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function writeJson(path, value) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
}

function digestFile(path) {
  return createHash('sha256')
    .update(readFileSync(resolve(path)))
    .digest('hex');
}

const bundlePath = required('bundle');
const outputPath = required('output');
const gatePath = required('gate-output');
const testedRevision = required('head');
if (!REVISION.test(testedRevision)) throw new Error('invalid exact feature revision');
const bundle = readJson(bundlePath);
if (bundle?.featureId !== FEATURE_ID || bundle?.testedRevision !== testedRevision) {
  throw new Error('feature bundle identity drift');
}
const report = bundle?.workloads?.auto?.report?.featureEvidence ?? bundle?.workloads?.auto?.report;
if (!report || typeof report !== 'object')
  throw new Error('feature bundle lacks an auto workload report');
const identity = {
  testedRevision,
  source: report.source,
  build: report.build,
  fixtureIdentity: report.fixtureIdentity,
  frameIdentity: report.frameIdentity,
  resolution: report.resolution,
  backend: 'renderer-gpu-timing',
  runner: { kind: 'software', id: 'lavapipe-correctness' },
};
if (!identity.source?.path || !HASH.test(identity.source.sha256))
  throw new Error('source identity is invalid');
if (!identity.build?.path || !HASH.test(identity.build.sha256))
  throw new Error('build identity is invalid');
if (!identity.fixtureIdentity || !identity.frameIdentity || !identity.resolution)
  throw new Error('feature execution identity is incomplete');
const deferred = {
  schemaVersion: 'forgeax-auto-exposure-timing-deferred/1',
  featureId: FEATURE_ID,
  testedRevision,
  status: 'blocked',
  executionMode: 'simulated',
  reason:
    'physical GPU timing is unavailable; software execution is retained as correctness evidence and is not substituted for GPU timing',
  physicalGpu: false,
  timestampQuery: false,
  source: 'renderer-gpu-pass-timing-deferred',
  identity,
};
writeJson(outputPath, deferred);
const gate = {
  status: 'blocked',
  ciState: 'blocked',
  deferred: true,
  reason: deferred.reason,
  source: deferred.source,
  physicalGpu: false,
  timestampQuery: false,
  identity,
  artifact: {
    kind: 'auto-exposure-renderer-timing-deferred',
    path: outputPath,
    sha256: digestFile(outputPath),
    testedRevision,
  },
};
writeJson(gatePath, gate);
process.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
