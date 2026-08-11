import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createFullMatrixManifest,
  validateFullMatrixManifest,
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
