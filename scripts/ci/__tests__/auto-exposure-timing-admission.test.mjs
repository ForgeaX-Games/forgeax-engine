import assert from 'node:assert/strict';
// Use the named export: Bun 1.2 exposes the node:test default as a module
// object, while the named export remains the callable test registrar.
import { test } from 'node:test';
import {
  admitAutoExposureTiming,
  isRecoverableBlockedReason,
} from '../admit-auto-exposure-timing.mjs';

const HEAD = '1'.repeat(40);
const HASH = 'a'.repeat(64);
const FIXTURE = {
  id: 'auto-exposure-scene-identity-v1',
  asset: 'fixture-asset-taa-bars-v1',
  camera: 'fixture-camera-taa-perspective-v1',
  light: 'fixture-light-taa-directional-d65-v1',
  input: 'fixture-input-static-v1',
};

function window(width, height, offset, { equalTicks = 0 } = {}) {
  const beginTicks = Array.from({ length: 60 }, (_, index) => String(offset + index * 10_000));
  const endTicks = beginTicks.map((value, index) =>
    index < equalTicks ? value : String(Number(value) + 1_000),
  );
  return {
    width,
    height,
    measurementSource: 'gpu-timestamp',
    captureGeneration: 'device-1:graph-2',
    firstFrame: 121,
    lastFrame: 180,
    beginTicks,
    endTicks,
    ...(equalTicks === 0
      ? {}
      : {
          timestampQuantization: {
            mode: 'equal-ticks-upper-bound',
            equalTickSamples: equalTicks,
            quantumNanoseconds: 65_536,
            source: 'renderer-receipt-timestamp',
          },
        }),
  };
}

function report(backend, { equalTicks = 0, physicalGpu = true } = {}) {
  const pass = (passName, offset) => ({
    passName,
    passIdentity: `standard-output/${passName}`,
    windows: [window(1920, 1080, offset, { equalTicks }), window(3840, 2160, offset + 1_000_000)],
  });
  return {
    schemaVersion: 'forgeax-auto-exposure-gpu-pass-timing/1',
    featureId: 'feat-20260827-auto-exposure-hdr-color-grading',
    testedRevision: HEAD,
    status: 'observation',
    qualification: { status: 'eligible-candidate' },
    source: { path: 'apps/hello/taa/src/main.ts', sha256: HASH },
    build: { path: 'apps/hello/taa/dist/index.html', sha256: 'b'.repeat(64) },
    fixture: FIXTURE,
    frame: { generation: 'device-1:graph-2', firstFrame: 121, lastFrame: 180 },
    sampling: { warmupFrames: 120, framesPerWindow: 60, quantile: 'nearest-rank-p95' },
    backend: {
      kind: 'webgpu',
      adapter: backend === 'browser' ? 'Apple M4 Pro' : 'apple-m4-pro',
      driver: backend === 'browser' ? 'Apple Metal' : 'dawn-node',
      physicalGpu,
      timestampQuery: true,
      timestampPeriodNanoseconds: 1,
      browser: backend === 'browser' ? 'chrome' : 'dawn-node',
    },
    runner: {
      kind: backend === 'browser' ? 'playwright' : 'dawn',
      id: backend,
      version: 'test-runner',
      os: 'darwin-arm64',
      channel: backend === 'browser' ? 'chrome' : 'dawn-node',
    },
    manual: { status: 'observation', zeroCost: true },
    timing: { passes: ['meter', 'lut'], logicalStages: ['clear', 'histogram', 'adapt'] },
    workloads: {
      auto: { status: 'observation', passes: [pass('meter', 1_000_000)] },
      'positive-lut': { status: 'observation', passes: [pass('lut', 5_000_000)] },
    },
  };
}

test('admits only dual-backend physical timestamp windows and keeps the conservative p95', () => {
  const artifact = admitAutoExposureTiming({
    browser: report('browser'),
    dawn: report('dawn'),
    testedRevision: HEAD,
  });
  assert.equal(artifact.sourceContract.physicalGpu, true);
  assert.equal(artifact.resolutions['1080p'].sampleCount, 60);
  assert.equal(artifact.resolutions['4K'].windowComplete, true);
});

test('accepts explicit equal-tick quantization but rejects nonphysical Dawn', () => {
  const artifact = admitAutoExposureTiming({
    browser: report('browser', { equalTicks: 4 }),
    dawn: report('dawn'),
    testedRevision: HEAD,
  });
  assert.equal(
    artifact.backends.browser.rawAdmission.passes[0].windows[0].durationsNanoseconds[0],
    65_536,
  );
  assert.throws(
    () =>
      admitAutoExposureTiming({
        browser: report('browser'),
        dawn: report('dawn', { physicalGpu: false }),
        testedRevision: HEAD,
      }),
    /dawn is not a physical GPU/,
  );
  const unboundQuantum = report('browser', { equalTicks: 4 });
  unboundQuantum.workloads.auto.passes[0].windows[0].timestampQuantization.source = 'caller';
  assert.throws(
    () =>
      admitAutoExposureTiming({
        browser: unboundQuantum,
        dawn: report('dawn'),
        testedRevision: HEAD,
      }),
    /admission-window-invalid/,
  );
});

test('rejects stale producer identity instead of re-labeling it', () => {
  const stale = report('browser');
  stale.testedRevision = '2'.repeat(40);
  assert.throws(
    () => admitAutoExposureTiming({ browser: stale, dawn: report('dawn'), testedRevision: HEAD }),
    /browser testedRevision drift/,
  );
});

test('preserves and rejects falsified raw sampling and measurement provenance', () => {
  const badSampling = report('browser');
  badSampling.sampling = { warmupFrames: 0, framesPerWindow: 60, quantile: 'mean' };
  assert.throws(
    () =>
      admitAutoExposureTiming({ browser: badSampling, dawn: report('dawn'), testedRevision: HEAD }),
    /browser sampling identity drift/,
  );
  const badMeasurement = report('browser');
  badMeasurement.workloads.auto.passes[0].windows[0].measurementSource = 'wall-time';
  assert.throws(
    () =>
      admitAutoExposureTiming({
        browser: badMeasurement,
        dawn: report('dawn'),
        testedRevision: HEAD,
      }),
    /admission-window-invalid/,
  );
});

test('requires distinct backend identities instead of trusting call-site labels', () => {
  const browser = report('browser');
  const dawn = report('browser');
  assert.throws(
    () => admitAutoExposureTiming({ browser, dawn, testedRevision: HEAD }),
    /dawn runner must be Dawn/,
  );
});

test('only explicit capability or budget observations remain blocked in the CLI adapter', () => {
  assert.equal(isRecoverableBlockedReason('browser timing candidate is not eligible'), true);
  assert.equal(isRecoverableBlockedReason('joined 1080p P95 exceeds 0.35ms'), true);
  assert.equal(isRecoverableBlockedReason('join identity testedRevision drift'), false);
  assert.equal(isRecoverableBlockedReason('invalid timing admission CI attestation schema'), false);
});
