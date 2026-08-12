import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createFullMatrixManifest,
  validateFullMatrixManifest,
  validateReference,
} from '../membership-timing/full-matrix.mjs';

const sourceHead = '3c170a2e7b97ebadfd8742ec74b1724b9ee79a85';
const captureReferencesSource = readFileSync(
  new URL(
    '../../../apps/learn-render/5.advanced-lighting/8.deferred-shading/scripts/capture-membership-references.mjs',
    import.meta.url,
  ),
  'utf8',
);

test('generates the exact real full-matrix declarations', () => {
  const manifest = createFullMatrixManifest({ sourceHead });
  assert.equal(validateFullMatrixManifest(manifest).valid, true);
  assert.equal(manifest.attempts.length, 20);
  assert.equal(manifest.references.length, 32);
  assert.equal(Object.hasOwn(manifest, 'subsetOf'), false);
  assert.deepEqual(manifest.exact, {
    topLevel: 20,
    nested: 32,
    acceptedGpu: 16,
    acceptedControl: 2,
    refused: 2,
    acceptedGpuByLights: { 32: 5, 64: 5, 128: 5, 256: 1 },
    referencesByKind: { 'cpu-membership': 16, 'timing-omitted-pixel': 16 },
  });
});

test('rejects a full matrix that drops a required nested reference', () => {
  const manifest = createFullMatrixManifest({ sourceHead });
  manifest.references.pop();
  const result = validateFullMatrixManifest(manifest);
  assert.equal(result.valid, false);
  assert.match(
    result.errors.map((item) => item.message).join('\n'),
    /exactly 32|exactly two children/,
  );
});

test('isolates each captured attempt before joining the corpus', () => {
  assert.match(captureReferencesSource, /const attemptRoot = join\(outputRoot, attemptId\);/);
  assert.match(captureReferencesSource, /const recordDir = join\(attemptRoot, label\);/);
  assert.match(
    captureReferencesSource,
    /join\(attemptRoot, `\$\{attemptId\.replaceAll\('\/', '__'\)\}\.invocations\.json`\)/,
  );
});

test('keeps an independently captured CPU membership child for a refused GPU parent', () => {
  const provenance = (timestampQuery, timestampPeriodNanoseconds) => ({
    backendKind: 'webgpu',
    compute: true,
    timestampQuery,
    timestampPeriodNanoseconds,
    adapter: 'dawn-node',
    environment: 'test',
    configFingerprint: 'test',
    seed: 13,
    frameTarget: 300,
    frames: 300,
    dimensions: { width: 512, height: 512 },
    lights: 32,
    clusterGrid: { x: 16, y: 9, z: 24 },
  });
  const parent = {
    recordKind: 'attempt',
    status: 'refused',
    reason: { code: 'timestamp-write-unavailable' },
    sourceHead,
    outputHashes: { membership: null, pixel: 'pixel-hash' },
  };
  const child = {
    recordKind: 'reference',
    referenceId: 'gpu-32-01/cpu-membership',
    parentAttemptId: 'gpu-32-01',
    referenceKind: 'cpu-membership',
    terminal: { outcome: 'accepted-reference', reason: null },
    actualProducer: 'cpu',
    gpu: null,
    references: [],
    sourceHead,
    provenance: provenance(false, null),
    outputHashes: { membership: 'independent-membership-hash', pixel: null },
    profile: { status: 'complete', droppedEventCount: 0 },
  };
  const errors = [];
  validateReference(
    child,
    {
      referenceId: child.referenceId,
      parentAttemptId: child.parentAttemptId,
      referenceKind: child.referenceKind,
      expectedOutcome: 'accepted-reference',
    },
    { ...parent, provenance: provenance(true, 1) },
    errors,
  );
  assert.deepEqual(errors, []);
});
