#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_PATHS = Object.freeze([
  'packages/runtime/bench-result.json',
  'report/hello-triangle/fps.json',
  'apps/dual-impl-spike/report/texture-4x4.json',
  'apps/hello/lod-occlusion/evidence/gpu-frame-samples.json',
]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--root') args.root = argv[++index];
    else if (value === '--head-sha') args.headSha = argv[++index];
    else if (value === '--run-id') args.runId = argv[++index];
    else if (value === '--run-attempt') args.runAttempt = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function requirePositiveInteger(value, name) {
  if (!/^\d+$/.test(String(value ?? '')) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return String(value);
}

function deferredIdentity({ headSha, runId, runAttempt }) {
  if (!/^[0-9a-f]{40}$/i.test(String(headSha ?? ''))) {
    throw new Error('headSha must be a full 40-character SHA');
  }
  return {
    schemaVersion: 'forgeax-metrics-software-deferred/1',
    headSha: String(headSha),
    runId: requirePositiveInteger(runId, 'runId'),
    runAttempt: requirePositiveInteger(runAttempt, 'runAttempt'),
    executionMode: 'simulated',
    physicalGpu: false,
    status: 'deferred',
    source: 'software-runner-capability',
    reason:
      'No physical GPU is available; software rendering remains correctness evidence and is not substituted for GPU performance acceptance.',
  };
}

function lodDeferredPayload(identity) {
  const lodIdentity = {
    build: identity.headSha,
    scene: 'software-deferred',
    sourceKey: 'ci:metrics-validate-runtime:software-deferred',
    sidecarDigest: 'software-deferred',
    packDigest: 'software-deferred',
    seed: 0,
    viewport: 'software-deferred',
    adapter: 'lavapipe/software',
    backend: 'vulkan/software',
    capabilities: ['software', 'timestamp-query-unavailable'],
    fixture: { candidateScale: [1, 1, 1], occluderScale: [1, 1, 1] },
  };
  const falsification = [
    'forced-lod0',
    'all-visible',
    'occlusion-off-on',
    'page-exhaustion',
    'delayed-map',
    'world-reorder',
  ].map((caseName) => ({
    case: caseName,
    verdict: 'unavailable',
    reason: identity.reason,
    evidence: {
      protocol: {
        intervention: 'software-deferred',
        held: ['exact source HEAD', 'software provenance', 'no physical GPU claim'],
      },
    },
  }));
  return {
    schema: 'forgeax::hello-lod-occlusion::gpu-frame-samples::v2',
    identity: lodIdentity,
    warmupSubmits: 32,
    retainedSamples: 128,
    metrics: { timestampAvailable: false, reason: identity.reason },
    falsification,
    verdict: 'software-deferred',
    executionMode: identity.executionMode,
    physicalGpu: identity.physicalGpu,
    runIdentity: { runId: identity.runId, runAttempt: identity.runAttempt },
  };
}

export function writeSoftwareDeferredMetrics({ root = process.cwd(), headSha, runId, runAttempt }) {
  const outputRoot = resolve(root);
  const identity = deferredIdentity({ headSha, runId, runAttempt });
  const payloads = new Map([
    [RUNTIME_PATHS[0], { ...identity, metric: 'engine-runtime-bench' }],
    [RUNTIME_PATHS[1], { ...identity, metric: 'fps' }],
    [RUNTIME_PATHS[2], { ...identity, metric: 'dual-impl-spike' }],
    [RUNTIME_PATHS[3], lodDeferredPayload(identity)],
  ]);
  for (const [relativePath, payload] of payloads) {
    const outputPath = resolve(outputRoot, relativePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  return { identity, paths: [...payloads.keys()] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = writeSoftwareDeferredMetrics(args);
    console.log(
      `[metrics] software-deferred paths=${result.paths.length} head=${result.identity.headSha}`,
    );
  } catch (error) {
    console.error(
      `[metrics] software-deferred unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
