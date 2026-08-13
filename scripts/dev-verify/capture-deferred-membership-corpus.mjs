#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordsFromPath, validateRealCorpus } from './membership-timing/full-matrix.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SMOKE = join(
  ROOT,
  'apps/learn-render/5.advanced-lighting/8.deferred-shading/scripts/smoke.mjs',
);
const REFERENCES = join(
  ROOT,
  'apps/learn-render/5.advanced-lighting/8.deferred-shading/scripts/capture-membership-references.mjs',
);
const RHINULL = join(HERE, 'capture-rhinull-membership-refusal.mjs');

function argument(name, fallback) {
  return (
    process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback
  );
}

function run(label, command, args, environment) {
  process.stdout.write(`[membership] ${label}\n`);
  const result = spawnSync(process.execPath, [command, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...environment },
    stdio: 'inherit',
  });
  if (result.status !== 0)
    throw new Error(`${label} exited with ${String(result.status ?? result.signal)}`);
}

function findWebkitRoot(root) {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs'); const path=require('node:path');
       function walk(root) { for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
         const candidate=path.join(root, entry.name);
         if (entry.isFile() && entry.name === 'real-capture-manifest.json') { console.log(path.dirname(candidate)); return true; }
         if (entry.isDirectory() && walk(candidate)) return true;
       } return false; }
       if (!walk(process.argv[1])) process.exit(1);`,
      root,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0 || result.stdout.trim().length === 0)
    throw new Error(`WebKit artifact has no real-capture-manifest.json under ${root}`);
  return result.stdout.trim().split('\n').at(-1);
}

const manifestPathArgument = argument('--manifest');
const outputRootArgument = argument('--output-root');
const webkitDownloadArgument = argument('--webkit-download');
if (
  manifestPathArgument === undefined ||
  outputRootArgument === undefined ||
  webkitDownloadArgument === undefined
) {
  throw new Error(
    'usage: capture-deferred-membership-corpus.mjs --manifest=<manifest.json> --output-root=<dir> --webkit-download=<dir> [--report=<report.json>]',
  );
}

const manifestPath = resolve(manifestPathArgument);
const outputRoot = resolve(outputRootArgument);
const webkitDownload = resolve(webkitDownloadArgument);
const reportPath = resolve(argument('--report', join(outputRoot, 'real-capture-report.json')));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const sourceHead = manifest.sourceHead;
mkdirSync(outputRoot, { recursive: true });

for (const declaration of manifest.attempts) {
  if (declaration.route !== 'dawn-gpu') continue;
  run(
    `Dawn GPU ${declaration.attemptId}`,
    REFERENCES,
    [
      `--attempt-id=${declaration.attemptId}`,
      `--lights=${declaration.lights}`,
      '--frames=300',
      `--manifest=${manifestPath}`,
      `--output-root=${outputRoot}`,
    ],
    { FORGEAX_SOURCE_HEAD: sourceHead },
  );
}

const controlAttempt = manifest.attempts.find((item) => item.route === 'dawn-cpu-control');
if (controlAttempt === undefined) throw new Error('dawn-cpu-control declaration is missing');
const controlRoot = join(outputRoot, controlAttempt.attemptId);
mkdirSync(controlRoot, { recursive: true });
run('Dawn CPU control', SMOKE, [], {
  SMOKE_MIN_FRAMES: '300',
  FORGEAX_DEFERRED_LIGHTS: String(controlAttempt.lights),
  FORGEAX_MEMBERSHIP_TIMING: 'cpu-control',
  FORGEAX_MEMBERSHIP_MANIFEST: manifestPath,
  FORGEAX_MEMBERSHIP_ARTIFACT_ROOT: outputRoot,
  FORGEAX_SOURCE_HEAD: sourceHead,
  FORGEAX_PROFILE_CAPTURE_PATH: join(controlRoot, 'profile.capture.json'),
  FORGEAX_PROFILE_DETAIL: 'nested',
  FORGEAX_PROFILE_FRAME_LIMIT: '90',
  FORGEAX_PROFILE_EVENT_LIMIT: '100000',
  FORGEAX_PROFILE_SETTLE_MS: '25',
  FORGEAX_MEMBERSHIP_RECORD_DIR: controlRoot,
  FORGEAX_MEMBERSHIP_RECORD_KIND: 'attempt',
  FORGEAX_MEMBERSHIP_ATTEMPT_ID: controlAttempt.attemptId,
});

run('RhiNull GPU refusal', RHINULL, [`--manifest=${manifestPath}`, `--output-root=${outputRoot}`], {
  FORGEAX_SOURCE_HEAD: sourceHead,
});

const dawnRecords = recordsFromPath(outputRoot);
const downloadedWebkitRoot = findWebkitRoot(webkitDownload);
const unifiedWebkitRoot = join(outputRoot, 'webkit-webgl2');
cpSync(downloadedWebkitRoot, unifiedWebkitRoot, { recursive: true });
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
  sourceHead,
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
