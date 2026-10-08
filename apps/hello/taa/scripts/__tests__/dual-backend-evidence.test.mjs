import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEATURE_ID,
  REQUIRED_DOMAINS,
  REQUIRED_LOGICAL_STAGES,
  REQUIRED_TIMING_PASSES,
  REQUIRED_WORKLOADS,
  joinAutoExposureEvidence,
} from '../../../../../scripts/ci/join-auto-exposure-evidence.mjs';
import { createBrowserFeatureObservation, createDawnFeatureObservation } from '../feature-evidence-producer.mjs';

const hash = (letter) => letter.repeat(64);
const revision = 'a'.repeat(40);
const fixtureIdentity = {
  asset: { id: 'asset-v1', sha256: hash('d') },
  camera: { id: 'camera-v1', sha256: hash('e') },
  light: { id: 'light-v1', sha256: hash('f') },
  input: { id: 'input-v1', sha256: hash('0') },
};

function rawInput(workloadKind) {
  const auto = workloadKind === 'auto';
  const lut = workloadKind === 'positive-lut';
  const stages = workloadKind === 'manual'
    ? []
    : ['linear-HDR', 'linear-LDR', 'final-sRGB'].map((domain, index) => ({
      id: ['linear-hdr', 'linear-ldr', 'final-display'][index],
      domain,
      readback: { rawHash: hash(String(index + 1)), frame: 60 },
      metadata: {
        frameId: 60,
        deviceGeneration: 1,
        graphGeneration: 2,
        textureIdentity: index + 1,
        readbackIdentity: index + 11,
        width: 200,
        height: 150,
        bytesPerRow: index < 2 ? 1600 : 800,
      },
    }));
  return {
    workloadKind,
    state: {
      backend: 'dawn-node',
      workload: {
        kind: workloadKind,
        executed: true,
        exposureMode: auto ? 'auto' : 'manual',
        colorLutStrength: lut ? 0.75 : 0,
        sourceKey: lut ? 'auto-exposure-positive-lut' : undefined,
        autoExposure: auto ? { targetGeneration: 2, receipt: { committed: true } } : undefined,
        lutReceipt: lut ? { generation: 2, committed: true } : undefined,
      },
    },
    frames: 60,
    frameIdentity: { first: 1, last: 60, count: 60, contiguous: true, sequenceSha256: hash('9') },
    stages,
    fixtureIdentity: structuredClone(fixtureIdentity),
    source: { path: 'apps/hello/taa/src/main.ts', sha256: hash('b') },
    build: { path: 'apps/hello/taa/dist/index.html', sha256: hash('c') },
    resolution: { width: 200, height: 150 },
    provenance: {
      source: { path: 'apps/hello/taa/src/main.ts', sha256: hash('b') },
      build: { path: 'apps/hello/taa/dist/index.html', sha256: hash('c') },
      fixture: 'apps/hello/taa/fixtures/auto-exposure/scene-identity.json',
      frame: { first: 1, last: 60, count: 60, contiguous: true, sequenceSha256: hash('9') },
      backend: 'dawn-node',
      adapter: { physicalGpu: false, fallbackAdapter: false },
      runner: { kind: 'dawn', id: 'smoke-dawn' },
    },
    resourceGrowth: lut || auto
      ? { stableFrames: 60, byteLengthDelta: 0, bindGroupDelta: 0, resourceCountDelta: 0, liveResourceDelta: 0, allocationCount: 3, peakLiveCount: 3, mapCount: 3, readbackCount: 3 }
      : { stableFrames: 60, byteLengthDelta: 0, bindGroupDelta: 0, resourceCountDelta: 0, liveResourceDelta: 0, allocationCount: 0, peakLiveCount: 0, mapCount: 0, readbackCount: 0 },
  };
}

function browserInput(workloadKind) {
  const input = rawInput(workloadKind);
  input.backend = 'browser-webgpu';
  input.state.backend = 'browser-webgpu';
  input.provenance.backend = 'browser-webgpu';
  input.provenance.adapter = {
    physicalGpu: true,
    fallbackAdapter: false,
    vendorId: 1,
    deviceId: 2,
    vendor: 'Apple',
    device: 'M4 Pro',
    architecture: 'metal-3',
    description: 'Apple M4 Pro GPU',
  };
  input.provenance.runner = {
    kind: 'playwright',
    id: 'chrome',
    channel: 'chrome',
    version: '152.0.0.0',
    headless: true,
    launchArgs: ['--headless'],
  };
  return input;
}

function identity(backend, runnerId, resolution = { width: 1920, height: 1080 }, fixture = fixtureIdentity) {
  return {
    testedRevision: revision,
    source: { path: 'apps/hello/taa/src/main.ts', sha256: hash('b') },
    build: { path: 'apps/hello/taa/dist/index.html', sha256: hash('c') },
    fixtureIdentity: structuredClone(fixture),
    frameIdentity: { first: 1, last: 60, count: 60, contiguous: true, sequenceSha256: hash('1') },
    resolution,
    backend,
    runner: { kind: 'ci', id: runnerId },
  };
}

function artifact(kind, letter) {
  return { kind, path: `artifacts/${kind}.json`, sha256: hash(letter), testedRevision: revision };
}

function rawGate(backend, runnerId, letter) {
  return {
    status: 'observation',
    ciState: 'success',
    verdictSource: 'producer-observation',
    executionMode: 'physical',
    identity: identity(backend, runnerId),
    artifact: artifact(`${backend}-raw`, letter),
    workloads: [...REQUIRED_WORKLOADS],
    domains: [...REQUIRED_DOMAINS],
    domainHashes: { 'linear-HDR': hash('2'), 'linear-LDR': hash('3'), 'final-sRGB': hash('4') },
  };
}

function validJoin() {
  const browser = rawGate('browser-webgpu', 'browser-run', '5');
  const dawn = rawGate('dawn-node', 'dawn-run', '6');
  return {
    schemaVersion: 'forgeax-auto-exposure-ci-join/1',
    featureId: FEATURE_ID,
    identity: {
      testedRevision: revision,
      source: browser.identity.source,
      build: browser.identity.build,
      fixtureIdentity: browser.identity.fixtureIdentity,
      frameIdentity: browser.identity.frameIdentity,
      resolution: browser.identity.resolution,
    },
    gates: {
      browser,
      dawn,
      featureValidator: {
        status: 'pass',
        ciState: 'success',
        verdictSource: 'validator',
        executionMode: 'physical',
        identity: identity('feature-validator', 'validator-run'),
        artifact: artifact('validator-derived', '7'),
        derivedFrom: { browser: browser.artifact.sha256, dawn: dawn.artifact.sha256 },
      },
      qualifiedTiming: {
        status: 'qualified',
        ciState: 'success',
        identity: identity('renderer-gpu-timing', 'timing-run'),
        artifact: artifact('gpu-timing', '8'),
        source: 'renderer-gpu-pass-timing',
        passes: [...REQUIRED_TIMING_PASSES],
        logicalStages: [...REQUIRED_LOGICAL_STAGES],
        physicalGpu: true,
        timestampQuery: true,
        resolutions: {
          '1080p': { p95Ms: 0.2, sampleCount: 100, windowComplete: true },
          '4K': { p95Ms: 0.6, sampleCount: 100, windowComplete: true },
        },
      },
      threeAc27: {
        status: 'pass',
        ciState: 'success',
        identity: identity('three-r184', 'three-run'),
        artifact: artifact('three-ac27', '9'),
        referencePackage: 'three',
        referenceVersion: '0.184.0',
        referenceCommit: revision,
        referenceIntegrity: 'sha512-wtTRjG92pM5eUg/KuUnHsqSAlPM296brTOcLgMRqEeylYTh/CdtvKUvCyyCQTzFuStieWxvZb8mVTMvdPyUpxg==',
        overallParityClaim: false,
        roiEpsilon: 0.03,
        notApplicable: [{ feature: 'auto-exposure', reason: 'Three.js has no equivalent histogram exposure stage' }],
      },
      canonicalRoster: {
        status: 'pass',
        ciState: 'success',
        identity: identity('canonical-dawn-roster', 'roster-run'),
        artifact: artifact('canonical-roster', 'a'),
        executed: true,
        entryCount: 70,
        rosterSha256: hash('c'),
      },
      sharedProbe: {
        status: 'pass',
        ciState: 'success',
        identity: identity('shared-input-probe', 'probe-run'),
        artifact: artifact('shared-probe', 'b'),
        workflowDispatch: true,
        payloadSha256: hash('d'),
      },
    },
  };
}

test('Browser and Dawn each emit workload-local raw observations without borrowing ownership', () => {
  for (const workloadKind of REQUIRED_WORKLOADS) {
    const browser = createBrowserFeatureObservation(browserInput(workloadKind));
    const dawn = createDawnFeatureObservation(rawInput(workloadKind));
    assert.equal(browser.status, 'observation');
    assert.equal(dawn.status, 'observation');
    assert.equal(browser.workloads[0].kind, workloadKind);
    assert.equal(dawn.workloads[0].kind, workloadKind);
    assert.notEqual(browser.provenance.backend, dawn.provenance.backend);
  }
});

test('generation zero and missing receipt never become a feature observation', () => {
  const auto = rawInput('auto');
  auto.state.workload.autoExposure.targetGeneration = 0;
  auto.state.workload.autoExposure.receipt = undefined;
  const report = createDawnFeatureObservation(auto);
  assert.equal(report.status, 'blocked');
  assert.ok(report.errors.some((entry) => entry.code === 'exposure-generation-missing'));
  assert.ok(report.errors.some((entry) => entry.code === 'exposure-receipt-missing'));
});

test('manual/LUT0 remains a zero-cost control and cannot become a feature pass', () => {
  const report = createDawnFeatureObservation(rawInput('manual'));
  assert.equal(report.status, 'observation');
  assert.equal(report.workloads[0].generation, 0);
  assert.equal(report.workloads[0].strength, 0);
  assert.equal(report.resourceGrowth.allocationCount, 0);
  assert.equal(report.resourceGrowth.readbackCount, 0);
});

test('join accepts only complete independent Browser and Dawn raw gate shells', () => {
  const result = joinAutoExposureEvidence(validJoin());
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.errors, []);
  assert.equal(result.gates.browser.verdictSource, 'producer-observation');
  assert.equal(result.gates.dawn.verdictSource, 'producer-observation');
});

test('missing backend and cross-backend artifact borrowing are blocked', () => {
  const missing = validJoin();
  delete missing.gates.dawn;
  let result = joinAutoExposureEvidence(missing);
  assert.equal(result.status, 'blocked');
  assert.ok(result.errors.some((entry) => entry.code === 'gate-missing'));

  const borrowed = validJoin();
  borrowed.gates.dawn.artifact = borrowed.gates.browser.artifact;
  result = joinAutoExposureEvidence(borrowed);
  assert.equal(result.status, 'blocked');
  assert.ok(result.errors.some((entry) => entry.code === 'artifact-duplicate'));
  assert.ok(result.errors.some((entry) => entry.code === 'derived-from-mismatch'));
});

test('duplicate domain, missing workload, wrong domain, and wrong fixture are fail-closed', () => {
  const input = validJoin();
  input.gates.dawn.domainHashes['linear-LDR'] = input.gates.dawn.domainHashes['linear-HDR'];
  input.gates.browser.workloads = ['manual', 'auto'];
  input.gates.dawn.domains = ['linear-HDR', 'linear-LDR', 'wrong-domain'];
  input.gates.dawn.identity.fixtureIdentity.asset.sha256 = hash('z');
  const result = joinAutoExposureEvidence(input);
  assert.equal(result.status, 'blocked');
  assert.ok(result.errors.some((entry) => entry.code === 'domain-capture-not-distinct'));
  assert.ok(result.errors.some((entry) => entry.code === 'workload-set-invalid'));
  assert.ok(result.errors.some((entry) => entry.code === 'domain-set-invalid'));
  assert.ok(result.errors.some((entry) => entry.code === 'identity-mismatch'));
});

test('nonphysical single-resolution Dawn and TAA blur timing cannot be promoted', () => {
  const input = validJoin();
  input.gates.dawn.identity.resolution = { width: 200, height: 150 };
  input.gates.qualifiedTiming.status = 'qualified';
  input.gates.qualifiedTiming.ciState = 'success';
  input.gates.qualifiedTiming.source = 'taa-motion-blur';
  input.gates.qualifiedTiming.passes = ['taa'];
  input.gates.qualifiedTiming.physicalGpu = false;
  input.gates.qualifiedTiming.timestampQuery = false;
  const result = joinAutoExposureEvidence(input);
  assert.equal(result.status, 'blocked');
  assert.ok(result.errors.some((entry) => entry.code === 'identity-mismatch'));
  assert.ok(result.errors.some((entry) => entry.code === 'timing-source-invalid'));
  assert.ok(result.errors.some((entry) => entry.code === 'timing-provenance-invalid'));
  assert.equal(input.gates.dawn.identity.resolution.width, 200);
});
