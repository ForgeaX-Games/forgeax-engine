import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  FEATURE_ID,
  joinAutoExposureEvidence,
  REQUIRED_DOMAINS,
  REQUIRED_LOGICAL_STAGES,
  REQUIRED_TIMING_PASSES,
  REQUIRED_WORKLOADS,
  validateCiArtifactJoin,
} from '../join-auto-exposure-evidence.mjs';

const root = resolve(import.meta.dirname, '../../..');
const schema = JSON.parse(
  readFileSync(resolve(root, 'apps/hello/taa/evidence/feature-evidence.schema.json'), 'utf8'),
);
const hash = (letter) => letter.repeat(64);
const revision = 'a'.repeat(40);

function identity(backend, runnerId) {
  return {
    testedRevision: revision,
    source: { path: 'apps/hello/taa/src/main.ts', sha256: hash('b') },
    build: { path: 'apps/hello/taa/dist/index.html', sha256: hash('c') },
    fixtureIdentity: {
      asset: { id: 'asset-v1', sha256: hash('d') },
      camera: { id: 'camera-v1', sha256: hash('e') },
      light: { id: 'light-v1', sha256: hash('f') },
      input: { id: 'input-v1', sha256: hash('0') },
    },
    frameIdentity: {
      first: 1,
      last: 300,
      count: 300,
      contiguous: true,
      sequenceSha256: hash('1'),
    },
    resolution: { width: 1920, height: 1080 },
    backend,
    runner: { kind: 'ci', id: runnerId },
  };
}

function artifact(kind, letter) {
  return {
    kind,
    path: `artifacts/${kind}.json`,
    sha256: hash(letter),
    testedRevision: revision,
  };
}

function rawGate(backend, runnerId, artifactValue) {
  return {
    status: 'observation',
    ciState: 'success',
    verdictSource: 'producer-observation',
    executionMode: 'physical',
    identity: identity(backend, runnerId),
    artifact: artifactValue,
    workloads: [...REQUIRED_WORKLOADS],
    domains: [...REQUIRED_DOMAINS],
    domainHashes: {
      'linear-HDR': hash('2'),
      'linear-LDR': hash('3'),
      'final-sRGB': hash('4'),
    },
  };
}

function validInput() {
  const browser = rawGate('browser-webgpu', 'browser-run', artifact('browser-raw', '5'));
  const dawn = rawGate('dawn-node', 'dawn-run', artifact('dawn-raw', '6'));
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
        referenceCommit: '1'.repeat(40),
        referenceIntegrity:
          'sha512-wtTRjG92pM5eUg/KuUnHsqSAlPM296brTOcLgMRqEeylYTh/CdtvKUvCyyCQTzFuStieWxvZb8mVTMvdPyUpxg==',
        overallParityClaim: false,
        roiEpsilon: 0.03,
        notApplicable: [
          {
            feature: 'auto-exposure',
            reason: 'Three.js has no equivalent histogram exposure stage',
          },
        ],
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

test('joins only complete independent gates and preserves raw/derived ownership', () => {
  const result = joinAutoExposureEvidence(validInput());
  assert.equal(result.status, 'pass');
  assert.equal(result.acceptance, 'feature-gates-admitted');
  assert.deepEqual(result.errors, []);
  assert.equal(result.gates.featureValidator.verdictSource, 'validator');
  assert.equal(result.gates.browser.verdictSource, 'producer-observation');
});

test('execution identity object key order is semantic-neutral', () => {
  const input = validInput();
  const frame = input.identity.frameIdentity;
  input.gates.dawn.identity.frameIdentity = {
    first: frame.first,
    last: frame.last,
    count: frame.count,
    contiguous: frame.contiguous,
    sequenceSha256: frame.sequenceSha256,
  };
  const result = joinAutoExposureEvidence(input);
  assert.equal(result.status, 'pass');
  assert.deepEqual(result.errors, []);
});

test('the valid derived report conforms to the strict CI join schema', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, unevaluated: true });
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/ciArtifactJoin`);
  const report = joinAutoExposureEvidence(validInput());
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
});

test('blocked and ineligible observations remain representable without becoming pass', () => {
  const input = validInput();
  input.gates.qualifiedTiming = {
    ...input.gates.qualifiedTiming,
    status: 'blocked',
    ciState: 'blocked',
    source: 'renderer-gpu-pass-timing-deferred',
    deferred: true,
    reason: 'physical GPU unavailable',
    physicalGpu: false,
    timestampQuery: false,
  };
  input.gates.canonicalRoster = {
    ...input.gates.canonicalRoster,
    status: 'blocked',
    ciState: 'blocked',
    deferred: true,
    reason: 'software route has no physical GPU-backed full Dawn roster',
  };
  input.gates.sharedProbe = {
    ...input.gates.sharedProbe,
    status: 'blocked',
    ciState: 'blocked',
    workflowDispatch: false,
  };
  const report = joinAutoExposureEvidence(input);
  assert.equal(report.status, 'blocked');
  const ajv = new Ajv2020({ allErrors: true, strict: true, unevaluated: true });
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/ciArtifactJoin`);
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
});

test('software correctness admission can pass while physical timing remains explicitly deferred', () => {
  const input = validInput();
  input.gates.qualifiedTiming = {
    ...input.gates.qualifiedTiming,
    status: 'blocked',
    ciState: 'blocked',
    source: 'renderer-gpu-pass-timing-deferred',
    deferred: true,
    reason: 'physical GPU unavailable',
    physicalGpu: false,
    timestampQuery: false,
  };
  input.gates.canonicalRoster = {
    ...input.gates.canonicalRoster,
    status: 'blocked',
    ciState: 'blocked',
    deferred: true,
    reason: 'software route has no physical GPU-backed full Dawn roster',
  };
  const report = joinAutoExposureEvidence(input);
  assert.equal(report.status, 'pass');
  assert.equal(report.acceptance, 'feature-function-admitted-performance-deferred');
  assert.deepEqual(report.errors, []);
});

test('missing checks and a missing backend remain blocked', () => {
  const input = validInput();
  delete input.gates.dawn;
  input.gates.qualifiedTiming.ciState = 'no_checks';
  const result = validateCiArtifactJoin(input);
  assert.equal(result.status, 'blocked');
  assert.ok(result.errors.some((entry) => entry.code === 'gate-missing'));
  assert.ok(result.errors.some((entry) => entry.code === 'gate-ci-not-success'));
});

test('an explicitly missing canonical roster gate stays blocked without deferred timing metadata', () => {
  const input = validInput();
  input.gates.canonicalRoster = {
    ...input.gates.canonicalRoster,
    status: 'blocked',
    ciState: 'missing',
    identity: identity('canonical-dawn-roster', 'canonicalRoster'),
    artifact: artifact('canonical-roster-blocked', 'a'),
    executed: false,
    entryCount: undefined,
    rosterSha256: undefined,
  };
  const result = validateCiArtifactJoin(input);
  assert.equal(result.status, 'blocked');
  assert.equal(
    result.errors.some((entry) => entry.code === 'roster-deferred-contract-invalid'),
    false,
  );
  assert.deepEqual(result.errors, []);
});

test('an unknown gate cannot be ignored by the executable join', () => {
  const input = validInput();
  input.gates.unregistered = { status: 'pass' };
  const result = validateCiArtifactJoin(input);
  assert.equal(result.status, 'blocked');
  assert.ok(result.errors.some((entry) => entry.code === 'gate-unexpected'));
});

test('a forged declared status or envelope field cannot survive as pass', () => {
  const input = validInput();
  input.status = 'failed';
  input.unregistered = true;
  const result = validateCiArtifactJoin(input);
  assert.equal(result.status, 'blocked');
  assert.ok(result.errors.some((entry) => entry.code === 'join-status-mismatch'));
  assert.ok(result.errors.some((entry) => entry.code === 'join-unexpected'));
});

test('stale identity, duplicate domain capture, and producer pass are fail-closed', () => {
  const input = validInput();
  input.gates.browser.status = 'pass';
  input.gates.browser.domainHashes['linear-LDR'] = input.gates.browser.domainHashes['linear-HDR'];
  input.gates.dawn.identity.testedRevision = 'c'.repeat(40);
  input.gates.dawn.artifact.testedRevision = 'd'.repeat(40);
  const result = validateCiArtifactJoin(input);
  assert.notEqual(result.status, 'pass');
  assert.ok(
    result.errors.some(
      (entry) => entry.code === 'gate-status-invalid' || entry.code === 'raw-pass-forbidden',
    ),
  );
  assert.ok(result.errors.some((entry) => entry.code === 'domain-capture-not-distinct'));
  assert.ok(result.errors.some((entry) => entry.code === 'identity-mismatch'));
  assert.ok(result.errors.some((entry) => entry.code === 'artifact-revision-mismatch'));
});

test('TAA or wall-clock timing cannot stand in for renderer pass timing', () => {
  const input = validInput();
  input.gates.qualifiedTiming.source = 'taa-motion-blur';
  input.gates.qualifiedTiming.physicalGpu = false;
  input.gates.qualifiedTiming.timestampQuery = false;
  const result = validateCiArtifactJoin(input);
  assert.equal(result.status, 'blocked');
  assert.ok(result.errors.some((entry) => entry.code === 'timing-source-invalid'));
  assert.ok(result.errors.some((entry) => entry.code === 'timing-provenance-invalid'));
});

test('validator cannot borrow a backend artifact and Three must retain explicit N/A', () => {
  const input = validInput();
  input.gates.featureValidator.derivedFrom.dawn = input.gates.browser.artifact.sha256;
  delete input.gates.threeAc27.notApplicable;
  const result = validateCiArtifactJoin(input);
  assert.equal(result.status, 'blocked');
  assert.ok(result.errors.some((entry) => entry.code === 'derived-from-mismatch'));
  assert.ok(result.errors.some((entry) => entry.code === 'three-not-applicable-invalid'));
});

test('Three AC-27 rejects a hex digest where npm SRI provenance is required', () => {
  const input = validInput();
  input.gates.threeAc27.referenceIntegrity = hash('a');
  const result = validateCiArtifactJoin(input);
  assert.equal(result.status, 'blocked');
  assert.ok(result.errors.some((entry) => entry.code === 'three-provenance-invalid'));
});
