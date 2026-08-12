import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeMembershipEvidence } from '../membership-evidence.mjs';

const head = 'e10bdc2519b194c3f974de1ae46870e18eac8012';
const membership = {
  schemaVersion: 1,
  lightCount: 32,
  grid: { x: 16, y: 9, z: 24 },
  clusterOffsetsAndCounts: [0, 1],
  attemptedTotal: 1,
  writtenTotal: 1,
  capacity: 65536,
  overflow: false,
  lightIndexPrefix: [0],
};
const cpuTiming = {
  actualProducer: 'cpu',
  gpu: null,
  submissionToken: 'submission-1',
  dispatchId: null,
  cpu: {
    encode: { startNanoseconds: 1, endNanoseconds: 2, durationNanoseconds: 1 },
    submit: { startNanoseconds: 2, endNanoseconds: 3, durationNanoseconds: 1 },
  },
  async: { queueCompletion: null, readback: null },
};

function manifest() {
  return {
    sourceHead: head,
    attempts: [
      {
        attemptId: 'dawn-cpu-control',
        route: 'dawn-cpu-control',
        lights: 32,
        expectedStatus: 'accepted-control',
        expectedProducer: 'cpu',
        expectedReason: null,
      },
    ],
    references: [],
  };
}

function gpuManifest() {
  return {
    sourceHead: head,
    attempts: [
      {
        attemptId: 'gpu-32-01',
        route: 'dawn-gpu',
        lights: 32,
        expectedStatus: 'accepted',
        expectedProducer: 'gpu',
        expectedReason: null,
      },
    ],
    references: [
      {
        referenceId: 'gpu-32-01/cpu-membership',
        parentAttemptId: 'gpu-32-01',
        referenceKind: 'cpu-membership',
        expectedOutcome: 'accepted-reference',
      },
      {
        referenceId: 'gpu-32-01/timing-omitted-pixel',
        parentAttemptId: 'gpu-32-01',
        referenceKind: 'timing-omitted-pixel',
        expectedOutcome: 'accepted-reference',
      },
    ],
  };
}

function gpuInput(outputDir, gpu, overrides = {}) {
  return {
    outputDir,
    artifactRoot: outputDir,
    manifest: gpuManifest(),
    recordKind: 'attempt',
    attemptId: 'gpu-32-01',
    mode: 'gpu',
    sourceHead: head,
    command: ['node', 'smoke.mjs'],
    evidence: {
      backendKind: 'webgpu',
      compute: true,
      timestampQuery: true,
      timestampPeriodNanoseconds: 2,
      adapter: 'fake-dawn',
      environment: 'test',
    },
    timing: {
      actualProducer: 'gpu',
      gpu,
      submissionToken: 'submission-1',
      dispatchId: 'dispatch-1',
      cpu: {
        encode: { startNanoseconds: 1, endNanoseconds: 2, durationNanoseconds: 1 },
        submit: { startNanoseconds: 2, endNanoseconds: 3, durationNanoseconds: 1 },
      },
      async: {
        queueCompletion: { startNanoseconds: 3, endNanoseconds: 4, durationNanoseconds: 1 },
        readback: { startNanoseconds: 4, endNanoseconds: 5, durationNanoseconds: 1 },
      },
    },
    membership,
    pixels: Buffer.from([1, 2, 3, 4]),
    profile: { completeness: { status: 'complete', droppedEventCount: 0 } },
    references: ['gpu-32-01/cpu-membership', 'gpu-32-01/timing-omitted-pixel'],
    lights: 32,
    frames: 300,
    ...overrides,
  };
}

function input(outputDir, profile) {
  return {
    outputDir,
    artifactRoot: outputDir,
    manifest: manifest(),
    recordKind: 'attempt',
    attemptId: 'dawn-cpu-control',
    mode: 'cpu-control',
    sourceHead: head,
    command: ['node', 'smoke.mjs'],
    evidence: {
      backendKind: 'webgpu',
      compute: true,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      adapter: 'fake-dawn',
      environment: 'test',
    },
    timing: cpuTiming,
    membership,
    pixels: Buffer.from([1, 2, 3, 4]),
    profile,
    lights: 32,
    frames: 300,
  };
}

test('accepts only ProfileCapture completeness and ignores legacy top-level fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-membership-evidence-'));
  try {
    const result = writeMembershipEvidence(input(root, {
      status: 'incomplete',
      droppedEventCount: 99,
      completeness: { status: 'complete', droppedEventCount: 0 },
    }));
    assert.equal(result.record.status, 'accepted-control');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when ProfileCapture completeness is incomplete despite legacy fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-membership-evidence-'));
  try {
    const result = writeMembershipEvidence(input(root, {
      status: 'complete',
      droppedEventCount: 0,
      completeness: { status: 'incomplete', droppedEventCount: 0 },
    }));
    assert.equal(result.record.status, 'incomplete');
    assert.equal(result.record.reason?.code, 'profile-incomplete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not create nested records in the parent process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-membership-evidence-'));
  try {
    const parentManifest = {
      attempts: [{ attemptId: 'gpu-32-01', route: 'dawn-gpu', lights: 32, expectedStatus: 'accepted', expectedProducer: 'gpu', expectedReason: null }],
      references: [
        { referenceId: 'gpu-32-01/cpu-membership', parentAttemptId: 'gpu-32-01', referenceKind: 'cpu-membership', expectedOutcome: 'accepted-reference' },
        { referenceId: 'gpu-32-01/timing-omitted-pixel', parentAttemptId: 'gpu-32-01', referenceKind: 'timing-omitted-pixel', expectedOutcome: 'accepted-reference' },
      ],
    };
    const result = writeMembershipEvidence({
      outputDir: root,
      artifactRoot: root,
      manifest: parentManifest,
      recordKind: 'attempt',
      attemptId: 'gpu-32-01',
      mode: 'gpu',
      sourceHead: head,
      command: ['node', 'smoke.mjs'],
      evidence: { backendKind: 'webgpu', compute: true, timestampQuery: true, timestampPeriodNanoseconds: 1, adapter: 'fake-dawn', environment: 'test' },
      timing: {
        actualProducer: 'gpu',
        gpu: { rawUnit: 'ticks', rawBeginTick: '1', rawEndTick: '2', deltaTicks: '1', timestampPeriodNanoseconds: 1, durationNanoseconds: 1 },
        submissionToken: 'submission-1',
        dispatchId: 'dispatch-1',
        cpu: { encode: { startNanoseconds: 1, endNanoseconds: 2, durationNanoseconds: 1 }, submit: { startNanoseconds: 2, endNanoseconds: 3, durationNanoseconds: 1 } },
        async: { queueCompletion: { startNanoseconds: 3, endNanoseconds: 4, durationNanoseconds: 1 }, readback: { startNanoseconds: 4, endNanoseconds: 5, durationNanoseconds: 1 } },
      },
      membership,
      pixels: Buffer.from([1, 2, 3, 4]),
      profile: { completeness: { status: 'complete', droppedEventCount: 0 } },
      references: ['gpu-32-01/cpu-membership', 'gpu-32-01/timing-omitted-pixel'],
      lights: 32,
      frames: 300,
    });
    assert.equal(result.record.status, 'accepted');
    assert.deepEqual(result.children, []);
    await assert.rejects(readFile(join(root, 'gpu-32-01', 'cpu-membership', 'record.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects zero GPU timing before publishing an accepted record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-membership-evidence-'));
  try {
    const result = writeMembershipEvidence(
      gpuInput(root, {
        rawUnit: 'ticks',
        rawBeginTick: '0',
        rawEndTick: '0',
        deltaTicks: '0',
        timestampPeriodNanoseconds: 2,
        durationNanoseconds: 0,
      }),
    );
    assert.equal(result.record.status, 'incomplete');
    assert.equal(result.record.reason?.code, 'timestamp-range-invalid');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('publishes the Render timestamp refusal instead of shadowing it as incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-membership-evidence-'));
  try {
    const result = writeMembershipEvidence(
      gpuInput(root, null, {
        timing: {
          code: 'timestamp-write-unavailable',
          actualProducer: 'gpu',
          gpu: null,
          submissionToken: null,
          dispatchId: null,
          cpu: { encode: null, submit: null },
          async: { queueCompletion: null, readback: null },
        },
      }),
    );
    assert.equal(result.record.status, 'refused');
    assert.deepEqual(result.record.reason, { code: 'timestamp-write-unavailable' });
    assert.equal(result.record.gpu, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects missing real provenance instead of writing unknown identity defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-membership-evidence-'));
  try {
    const value = input(root, { completeness: { status: 'complete', droppedEventCount: 0 } });
    delete value.evidence.adapter;
    const result = writeMembershipEvidence(value);
    assert.equal(result.record.status, 'incomplete');
    assert.equal(result.record.reason?.code, 'provenance-missing');
    assert.equal(result.record.provenance.adapter, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
