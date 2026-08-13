#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '../../../../../');
const SMOKE = join(HERE, 'smoke.mjs');

function argument(name, fallback) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

const attemptId = argument('--attempt-id');
const lights = argument('--lights', '32');
const frames = argument('--frames', '300');
const manifestArgument = argument('--manifest');
const outputArgument = argument('--output-root');
if (attemptId === undefined || manifestArgument === undefined || outputArgument === undefined) {
  throw new Error(
    'usage: capture-membership-references.mjs --attempt-id=<id> --manifest=<manifest.json> --output-root=<dir> [--lights=32] [--frames=300]',
  );
}
const manifestPath = resolve(manifestArgument);
const outputRoot = resolve(outputArgument);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const children = manifest.references.filter((item) => item.parentAttemptId === attemptId);
if (children.length !== 2) throw new Error(`${attemptId} must declare exactly two nested references`);
const childIds = children.map((item) => item.referenceId);
const attemptRoot = join(outputRoot, attemptId);
const sourceHead =
  process.env.FORGEAX_SOURCE_HEAD ??
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  }).trim();
if (manifest.sourceHead !== sourceHead)
  throw new Error(`manifest sourceHead ${manifest.sourceHead} differs from capture sourceHead ${sourceHead}`);

function runInvocation(label, extra) {
  const recordDir = join(attemptRoot, label);
  mkdirSync(recordDir, { recursive: true });
  const env = {
    ...process.env,
    SMOKE_MIN_FRAMES: frames,
    FORGEAX_DEFERRED_LIGHTS: lights,
    FORGEAX_MEMBERSHIP_MANIFEST: manifestPath,
    FORGEAX_MEMBERSHIP_ARTIFACT_ROOT: outputRoot,
    FORGEAX_SOURCE_HEAD: sourceHead,
    FORGEAX_PROFILE_CAPTURE_PATH: join(recordDir, 'profile.capture.json'),
    // Keep the deferred workload at 300 frames while the profile remains the
    // bounded nested attribution window used by the immutable fingerprints.
    FORGEAX_PROFILE_DETAIL: 'nested',
    FORGEAX_PROFILE_FRAME_LIMIT: '90',
    FORGEAX_PROFILE_EVENT_LIMIT: '100000',
    FORGEAX_PROFILE_SETTLE_MS: '25',
    FORGEAX_MEMBERSHIP_RECORD_DIR: recordDir,
    ...extra,
  };
  const result = spawnSync(process.execPath, [SMOKE], {
    cwd: REPOSITORY_ROOT,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`${label} invocation exited ${String(result.status ?? result.signal)}`);
  }
  return JSON.parse(readFileSync(join(recordDir, 'record.json'), 'utf8'));
}

const parent = runInvocation('parent', {
  FORGEAX_MEMBERSHIP_TIMING: 'gpu',
  FORGEAX_MEMBERSHIP_RECORD_KIND: 'attempt',
  FORGEAX_MEMBERSHIP_ATTEMPT_ID: attemptId,
  FORGEAX_MEMBERSHIP_REFERENCES: childIds.join(','),
});
const cpuReference = runInvocation(childIds[0], {
  FORGEAX_MEMBERSHIP_TIMING: 'cpu-control',
  FORGEAX_MEMBERSHIP_RECORD_KIND: 'reference',
  FORGEAX_MEMBERSHIP_REFERENCE_ID: childIds[0],
  FORGEAX_MEMBERSHIP_PARENT_ATTEMPT_ID: attemptId,
  FORGEAX_MEMBERSHIP_REFERENCE_KIND: 'cpu-membership',
});
const pixelReference = runInvocation(childIds[1], {
  FORGEAX_MEMBERSHIP_TIMING: '',
  FORGEAX_MEMBERSHIP_RECORD_KIND: 'reference',
  FORGEAX_MEMBERSHIP_REFERENCE_ID: childIds[1],
  FORGEAX_MEMBERSHIP_PARENT_ATTEMPT_ID: attemptId,
  FORGEAX_MEMBERSHIP_REFERENCE_KIND: 'timing-omitted-pixel',
});

const records = [parent, cpuReference, pixelReference];
const processIds = new Set(records.map((record) => record.process.id));
const payloadIds = new Set(records.map((record) => record.payloadIdentity));
if (processIds.size !== records.length || payloadIds.size !== records.length) {
  throw new Error('reference invocations must have unique process and payload identities');
}
writeFileSync(
  join(attemptRoot, `${attemptId.replaceAll('/', '__')}.invocations.json`),
  `${JSON.stringify({ sourceHead, attemptId, records }, null, 2)}\n`,
);
process.stdout.write(
  `[membership] fresh parent=${parent.process.pid} cpu=${cpuReference.process.pid} pixel=${pixelReference.process.pid}\n`,
);
