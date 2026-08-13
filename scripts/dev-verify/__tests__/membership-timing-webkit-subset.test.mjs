import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FULL_MATRIX_CONTRACT,
  FULL_MATRIX_ID,
  joinWebkitSubsetCapture,
  validateWebkitSubsetManifest,
} from '../membership-timing/webkit-subset.mjs';
import { projectWebkitSubsetIdentity } from '../verify-webkit-learn-render.mjs';

const sourceHead = '3c170a2e7b97ebadfd8742ec74b1724b9ee79a85';
const timestampRefusal = 'timestamp-query-unsupported';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifest() {
  return {
    schemaVersion: 1,
    generation: 4,
    artifactKind: 'declared-subset',
    evidenceKind: 'real',
    sourceHead,
    corpusId: 'webkit-real-subset',
    subsetOf: FULL_MATRIX_ID,
    subsetKind: 'webkit-deferred-membership-control-refusal',
    attempts: [
      {
        attemptId: 'webkit-cpu-control',
        route: 'webkit-cpu-control',
        lights: 128,
        expectedStatus: 'accepted-control',
        expectedProducer: 'cpu',
        expectedReason: null,
      },
      {
        attemptId: 'webkit-gpu-refused',
        route: 'webkit-gpu-refused',
        lights: 128,
        expectedStatus: 'refused',
        expectedProducer: 'cpu',
        expectedReason: timestampRefusal,
      },
    ],
    references: [],
    exact: {
      topLevel: 2,
      nested: 0,
      acceptedGpu: 0,
      acceptedControl: 1,
      refused: 1,
      acceptedGpuByLights: { 32: 0, 64: 0, 128: 0, 256: 0 },
      referencesByKind: { 'cpu-membership': 0, 'timing-omitted-pixel': 0 },
    },
  };
}

function record(root, attemptId, status, reason) {
  const directory = join(root, attemptId);
  mkdirSync(directory, { recursive: true });
  const profileBytes = Buffer.from('{"status":"complete","droppedEventCount":0}\n');
  const membershipBytes =
    status === 'accepted-control' ? Buffer.from('{"schemaVersion":1}\n') : Buffer.alloc(0);
  const pixelBytes = Buffer.from([1, 2, 3, 4]);
  const descriptor = (name, bytes) => {
    const path = join(directory, name);
    writeFileSync(path, bytes);
    return { path: `${attemptId}/${name}`, bytes: bytes.byteLength, sha256: sha256(bytes) };
  };
  const profile = descriptor('profile.json', profileBytes);
  const membership = descriptor('membership.json', membershipBytes);
  const pixel = descriptor('frame.rgba', pixelBytes);
  const recordPayload = Buffer.from(`${attemptId}\n`);
  const recordArtifact = descriptor('record.payload.json', recordPayload);
  return {
    schemaVersion: 1,
    evidenceKind: 'real',
    sourceHead,
    command: ['webkit-driver'],
    process: {
      id: attemptId,
      pid: 1234,
      startedAt: '2026-08-11T00:00:00Z',
      finishedAt: '2026-08-11T00:05:00Z',
    },
    payloadIdentity: `payload-${attemptId}`,
    provenance: {
      backendKind: 'wgpu-webgl2',
      compute: false,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      adapter: 'WebKit WebGL2',
      environment: 'test',
      configFingerprint: 'test',
      seed: 13,
      frameTarget: 300,
      frames: 300,
      dimensions: { width: 1280, height: 720 },
      lights: 128,
      clusterGrid: { x: 16, y: 9, z: 24 },
    },
    artifacts: { record: recordArtifact, profile, membership, pixel },
    profile: { status: 'complete', droppedEventCount: 0, artifact: profile },
    timing: {
      gpu: null,
      submissionToken: null,
      dispatchId: null,
      cpu: { encode: null, submit: null },
      async: { queueCompletion: null, readback: null },
    },
    outputHashes: {
      membership: status === 'accepted-control' ? sha256(membershipBytes) : null,
      pixel: sha256(pixelBytes),
    },
    recordKind: 'attempt',
    attemptId,
    status,
    reason,
    actualProducer: 'cpu',
    gpu: null,
    membership: status === 'accepted-control' ? { schemaVersion: 1 } : null,
    references: [],
  };
}

test('tracks the exact full-matrix target while validating the WebKit subset', () => {
  assert.deepEqual(FULL_MATRIX_CONTRACT, {
    generation: 4,
    topLevel: 20,
    nested: 32,
    acceptedGpu: 16,
    acceptedControl: 2,
    refused: 2,
    acceptedGpuByLights: { 32: 5, 64: 5, 128: 5, 256: 1 },
    referencesByKind: { 'cpu-membership': 16, 'timing-omitted-pixel': 16 },
  });
  assert.equal(validateWebkitSubsetManifest(manifest()).valid, true);
});

test('projects only schema-declared identity fields for the WebKit driver', () => {
  const value = manifest();
  value.identity = projectWebkitSubsetIdentity(
    {
      carrier: { selector: 'heavy' },
      workload: {
        scenario: 'deferred-membership',
        frames: 300,
        lights: 128,
        lightCounts: [32, 64, 128, 256],
        seed: 13,
        clusterGrid: { x: 16, y: 9, z: 24 },
      },
      profile: {
        dawnEventLimit: 100000,
        webkitEventLimit: 65536,
        nestedFrameLimit: 90,
        settleMs: 25,
      },
      artifactHashes: {
        algorithm: 'sha256',
        required: ['record', 'profile', 'membership', 'pixel'],
      },
    },
    sourceHead,
  );
  assert.deepEqual(value.identity, {
    sourceHead,
    carrier: { selector: 'heavy', backendKind: 'wgpu-webgl2', adapter: 'webkit-webgl2' },
    workload: { scenario: 'deferred-membership', frames: 300, lights: 128 },
    profile: { webkitEventLimit: 65536, nestedFrameLimit: 90, settleMs: 25 },
    artifactHashes: {
      algorithm: 'sha256',
      required: ['record', 'profile', 'membership', 'pixel'],
    },
  });
  assert.equal(validateWebkitSubsetManifest(value).valid, true);
});

test('joins two real WebKit records as a declared non-complete subset', () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'forgeax-webkit-subset-'));
  const control = record(artifactRoot, 'webkit-cpu-control', 'accepted-control', null);
  const refused = record(artifactRoot, 'webkit-gpu-refused', 'refused', { code: timestampRefusal });
  const result = joinWebkitSubsetCapture({
    manifest: manifest(),
    records: [control, refused],
    artifactRoot,
    rawComparison: { pixelHashEqual: true, pixelBytesEqual: true },
  });
  assert.equal(result.valid, true);
  assert.equal(result.completeMatrixReady, false);
  assert.equal(result.aggregateTarget, FULL_MATRIX_ID);
});

test('rejects a subset that weakens the matrix target or raw comparison', () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'forgeax-webkit-subset-'));
  const invalid = manifest();
  invalid.subsetOf = 'contract-fixture';
  const result = joinWebkitSubsetCapture({
    manifest: invalid,
    records: [
      record(artifactRoot, 'webkit-cpu-control', 'accepted-control', null),
      record(artifactRoot, 'webkit-gpu-refused', 'refused', { code: timestampRefusal }),
    ],
    artifactRoot,
    rawComparison: { pixelHashEqual: false, pixelBytesEqual: true },
  });
  assert.equal(result.valid, false);
  assert.match(
    result.errors.map((item) => item.message).join('\n'),
    /subset must target|raw pixel comparison/,
  );
});

test('rejects duplicate attempt identity in a concurrent WebKit join', () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'forgeax-webkit-subset-'));
  const control = record(artifactRoot, 'webkit-cpu-control', 'accepted-control', null);
  const duplicate = record(artifactRoot, 'webkit-cpu-control', 'accepted-control', null);
  const result = joinWebkitSubsetCapture({
    manifest: manifest(),
    records: [control, duplicate],
    artifactRoot,
    rawComparison: { pixelHashEqual: true, pixelBytesEqual: true },
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.map((item) => item.message).join('\n'), /attempt IDs must be unique/);
});
