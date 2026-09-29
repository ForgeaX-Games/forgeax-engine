#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { validateFeatureEvidenceBundle } from '../../apps/hello/taa/scripts/validate-feature-evidence.mjs';

const FEATURE_ID = 'feat-20260827-auto-exposure-hdr-color-grading';
const WORKLOADS = Object.freeze(['manual', 'auto', 'positive-lut']);

function option(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name) {
  const value = option(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function writeJson(path, value) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
}

const backend = required('backend');
if (backend !== 'browser-webgpu' && backend !== 'dawn-node')
  throw new Error(`unsupported --backend=${backend}`);
const inputDir = resolve(required('input-dir'));
const outputPath = required('output');
const derivedPath = required('derived-output');
const expectedHead = required('head');
if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(expectedHead)) {
  throw new Error(
    `invalid --head=${expectedHead}; expected a 40- or 64-character lowercase commit SHA`,
  );
}
const prefix = backend === 'browser-webgpu' ? 'browser' : 'dawn';
const workloads = {};
const inputBlocked = [];
const inputFailures = [];

for (const kind of WORKLOADS) {
  const path = resolve(inputDir, `${prefix}-${kind}-feature.json`);
  if (!existsSync(path)) {
    inputBlocked.push({ code: 'workload-missing', detail: `${kind} report is missing: ${path}` });
    continue;
  }
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    inputFailures.push({
      code: 'workload-read-failed',
      detail: `${kind}: ${error instanceof Error ? error.message : String(error)}`,
    });
    continue;
  }
  let outer;
  try {
    outer = JSON.parse(text);
  } catch (error) {
    inputFailures.push({
      code: 'workload-json-invalid',
      detail: `${kind}: ${error instanceof Error ? error.message : String(error)}`,
    });
    continue;
  }
  const report = outer?.featureEvidence ?? outer;
  const testedRevision = outer?.testedRevision ?? report?.testedRevision;
  if (expectedHead !== undefined && testedRevision !== expectedHead) {
    inputFailures.push({
      code: 'tested-revision-drift',
      detail: `${kind}: ${testedRevision ?? 'missing'} !== ${expectedHead}`,
    });
  }
  workloads[kind] = {
    path: relative(process.cwd(), path) || path,
    sha256: digest(text),
    testedRevision,
    report,
  };
}

const bundle = {
  schemaVersion: 'hello-taa-auto-exposure-evidence-bundle/1',
  featureId: FEATURE_ID,
  backend,
  testedRevision: expectedHead,
  workloads,
};
const result = validateFeatureEvidenceBundle(bundle);
const derived = {
  schemaVersion: 'hello-taa-auto-exposure-feature-validator/1',
  featureId: FEATURE_ID,
  backend,
  testedRevision: bundle.testedRevision,
  status: inputFailures.length > 0 ? 'failed' : inputBlocked.length > 0 ? 'blocked' : result.status,
  verdictSource:
    result.status === 'pass' && inputFailures.length === 0 && inputBlocked.length === 0
      ? 'validator'
      : undefined,
  derivedFrom: Object.fromEntries(
    Object.entries(workloads).map(([kind, entry]) => [kind, entry.sha256]),
  ),
  errors: [...inputFailures, ...inputBlocked, ...result.errors],
};
writeJson(outputPath, bundle);
writeJson(derivedPath, derived);
process.stdout.write(`${JSON.stringify(derived, null, 2)}\n`);
process.exitCode = derived.status === 'failed' ? 1 : 0;
