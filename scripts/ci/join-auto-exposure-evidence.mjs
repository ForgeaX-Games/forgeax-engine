#!/usr/bin/env node

import { readFileSync } from 'node:fs';

/**
 * Validate the CI evidence boundary for the auto-exposure feature.
 *
 * This module is intentionally a join, not a producer.  Browser/Dawn reports
 * remain raw observations, the feature validator owns a derived verdict, and
 * the remaining gates keep their own provenance.  The join only checks that
 * those independent envelopes refer to one exact execution identity; it never
 * fills a missing observation or turns an unavailable gate into a pass.
 */

export const CI_JOIN_SCHEMA_VERSION = 'forgeax-auto-exposure-ci-join/1';
export const FEATURE_ID = 'feat-20260827-auto-exposure-hdr-color-grading';
export const REQUIRED_GATE_IDS = Object.freeze([
  'browser',
  'dawn',
  'featureValidator',
  'qualifiedTiming',
  'threeAc27',
  'canonicalRoster',
  'sharedProbe',
]);
export const REQUIRED_DOMAINS = Object.freeze(['linear-HDR', 'linear-LDR', 'final-sRGB']);
export const REQUIRED_WORKLOADS = Object.freeze(['manual', 'auto', 'positive-lut']);
export const REQUIRED_TIMING_PASSES = Object.freeze(['meter', 'lut']);
export const REQUIRED_LOGICAL_STAGES = Object.freeze(['clear', 'histogram', 'adapt']);
export const TIMING_LIMITS_MS = Object.freeze({ '1080p': 0.35, '4K': 0.8 });
const JOIN_KEYS = new Set([
  'schemaVersion',
  'featureId',
  'identity',
  'gates',
  'status',
  'acceptance',
  'errors',
]);

const HASH = /^[a-f0-9]{64}$/;
const INTEGRITY = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const STATUSES = new Set(['pass', 'blocked', 'failed']);
const CI_STATES = new Set(['success', 'failure', 'blocked', 'no_checks', 'skipped', 'missing']);
const RAW_STATUSES = new Set(['observation', 'blocked', 'failed']);
const DERIVED_STATUSES = new Set(['pass', 'blocked', 'failed']);
const TIMING_STATUSES = new Set(['qualified', 'blocked', 'failed', 'ineligible']);
const THREE_STATUSES = new Set(['pass', 'blocked', 'failed', 'not-applicable']);
const EXECUTION_MODES = new Set(['physical', 'simulated']);

function issue(code, path, detail) {
  return { code, path, detail };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasHash(value) {
  return typeof value === 'string' && HASH.test(value);
}

function hasIntegrity(value) {
  return typeof value === 'string' && INTEGRITY.test(value);
}

function hasRevision(value) {
  return typeof value === 'string' && REVISION.test(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function validateDigestRef(value, path, errors) {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    !hasHash(value.sha256)
  ) {
    errors.push(
      issue('identity-invalid', path, 'path and a lowercase SHA-256 digest are required'),
    );
    return false;
  }
  return true;
}

function validateFixture(value, path, errors) {
  if (!isRecord(value)) {
    errors.push(
      issue(
        'fixture-identity-missing',
        path,
        'asset, camera, light, and input identities are required',
      ),
    );
    return false;
  }
  let valid = true;
  for (const part of ['asset', 'camera', 'light', 'input']) {
    const identity = value[part];
    if (
      !isRecord(identity) ||
      typeof identity.id !== 'string' ||
      identity.id.length === 0 ||
      !hasHash(identity.sha256)
    ) {
      errors.push(
        issue(
          'fixture-identity-invalid',
          `${path}.${part}`,
          'id and lowercase SHA-256 digest are required',
        ),
      );
      valid = false;
    }
  }
  return valid;
}

function validateFrame(value, path, errors) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.first) ||
    !Number.isSafeInteger(value.last) ||
    !Number.isSafeInteger(value.count) ||
    value.count < 1 ||
    value.last - value.first + 1 !== value.count ||
    value.contiguous !== true ||
    !hasHash(value.sequenceSha256)
  ) {
    errors.push(
      issue(
        'frame-identity-invalid',
        path,
        'a contiguous frame window and non-empty sequence digest are required',
      ),
    );
    return false;
  }
  return true;
}

function validateResolution(value, path, errors) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.width) ||
    value.width < 1 ||
    !Number.isSafeInteger(value.height) ||
    value.height < 1
  ) {
    errors.push(
      issue('resolution-invalid', path, 'positive integer width and height are required'),
    );
    return false;
  }
  return true;
}

function validateRunner(value, path, errors) {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    value.kind.length === 0 ||
    typeof value.id !== 'string' ||
    value.id.length === 0
  ) {
    errors.push(issue('runner-invalid', path, 'runner kind and id are required'));
    return false;
  }
  return true;
}

function validateIdentity(value, path, errors, { expectedBackend } = {}) {
  if (!isRecord(value)) {
    errors.push(
      issue('identity-missing', path, 'each gate must carry complete execution identity'),
    );
    return false;
  }
  let valid = true;
  if (!hasRevision(value.testedRevision)) {
    errors.push(
      issue(
        'revision-invalid',
        `${path}.testedRevision`,
        'a full 40- or 64-character lowercase commit SHA is required',
      ),
    );
    valid = false;
  }
  valid = validateDigestRef(value.source, `${path}.source`, errors) && valid;
  valid = validateDigestRef(value.build, `${path}.build`, errors) && valid;
  valid = validateFixture(value.fixtureIdentity, `${path}.fixtureIdentity`, errors) && valid;
  valid = validateFrame(value.frameIdentity, `${path}.frameIdentity`, errors) && valid;
  valid = validateResolution(value.resolution, `${path}.resolution`, errors) && valid;
  if (expectedBackend !== undefined && value.backend !== expectedBackend) {
    errors.push(
      issue('backend-identity-invalid', `${path}.backend`, `expected ${expectedBackend}`),
    );
    valid = false;
  } else if (typeof value.backend !== 'string' || value.backend.length === 0) {
    errors.push(
      issue('backend-identity-invalid', `${path}.backend`, 'backend identity is required'),
    );
    valid = false;
  }
  valid = validateRunner(value.runner, `${path}.runner`, errors) && valid;
  return valid;
}

function validateArtifact(value, path, errors, seenArtifacts) {
  if (
    !isRecord(value) ||
    typeof value.kind !== 'string' ||
    value.kind.length === 0 ||
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    !hasHash(value.sha256) ||
    !hasRevision(value.testedRevision)
  ) {
    errors.push(
      issue(
        'artifact-invalid',
        path,
        'kind, path, exact testedRevision, and lowercase SHA-256 digest are required',
      ),
    );
    return false;
  }
  if (seenArtifacts.has(value.sha256)) {
    errors.push(
      issue(
        'artifact-duplicate',
        path,
        'each independent gate must retain a distinct artifact digest',
      ),
    );
  }
  seenArtifacts.add(value.sha256);
  return true;
}

function validateGateShell(value, path, errors, seenArtifacts, expectedBackend, allowedStatuses) {
  if (!isRecord(value)) {
    errors.push(issue('gate-missing', path, 'independent gate envelope is required'));
    return false;
  }
  let valid = true;
  if (!allowedStatuses.has(value.status)) {
    errors.push(
      issue('gate-status-invalid', `${path}.status`, 'gate status is not in its closed union'),
    );
    valid = false;
  }
  if (!CI_STATES.has(value.ciState)) {
    errors.push(
      issue(
        'gate-ci-state-invalid',
        `${path}.ciState`,
        'CI state must remain explicit; no_checks/skipped/missing are not success',
      ),
    );
    valid = false;
  }
  if (value.status === 'pass' || value.status === 'qualified') {
    if (value.ciState !== 'success') {
      errors.push(
        issue(
          'gate-ci-not-success',
          `${path}.ciState`,
          'a pass/qualified verdict requires a materialized successful check',
        ),
      );
      valid = false;
    }
  } else if (value.ciState === 'success' && value.status === 'blocked') {
    errors.push(
      issue('gate-status-ci-mismatch', path, 'a blocked gate cannot claim a successful CI state'),
    );
    valid = false;
  }
  valid =
    validateIdentity(value.identity, `${path}.identity`, errors, { expectedBackend }) && valid;
  valid = validateArtifact(value.artifact, `${path}.artifact`, errors, seenArtifacts) && valid;
  return valid;
}

function compareExecutionIdentity(base, gate, path, errors) {
  if (!isRecord(base) || !isRecord(gate)) return;
  for (const field of [
    'testedRevision',
    'source',
    'build',
    'fixtureIdentity',
    'frameIdentity',
    'resolution',
  ]) {
    if (!sameJson(base[field], gate[field]))
      errors.push(
        issue(
          'identity-mismatch',
          `${path}.${field}`,
          'gate identity must equal the join execution identity',
        ),
      );
  }
}

function validateRawProducer(value, path, baseIdentity, errors, seenArtifacts, backend) {
  validateGateShell(value, path, errors, seenArtifacts, backend, RAW_STATUSES);
  if (!isRecord(value)) return;
  compareExecutionIdentity(baseIdentity, value.identity, `${path}.identity`, errors);
  if (value.verdictSource !== 'producer-observation') {
    errors.push(
      issue(
        'raw-verdict-source-invalid',
        `${path}.verdictSource`,
        'raw producers may publish observations only',
      ),
    );
  }
  if (!EXECUTION_MODES.has(value.executionMode)) {
    errors.push(
      issue(
        'execution-mode-invalid',
        `${path}.executionMode`,
        'raw feature observations must identify physical or simulated execution',
      ),
    );
  }
  if (value.status === 'pass')
    errors.push(
      issue('raw-pass-forbidden', `${path}.status`, 'raw producer reports cannot publish pass'),
    );
  if (
    !Array.isArray(value.workloads) ||
    !sameJson([...value.workloads].sort(), [...REQUIRED_WORKLOADS].sort())
  ) {
    errors.push(
      issue(
        'workload-set-invalid',
        `${path}.workloads`,
        'manual, auto, and positive-lut must all be present exactly once',
      ),
    );
  }
  if (!Array.isArray(value.domains) || !sameJson(value.domains, REQUIRED_DOMAINS)) {
    errors.push(
      issue(
        'domain-set-invalid',
        `${path}.domains`,
        'the canonical three domains are required in order',
      ),
    );
  }
  if (!isRecord(value.domainHashes)) {
    errors.push(
      issue(
        'domain-capture-missing',
        `${path}.domainHashes`,
        'one raw hash per domain is required',
      ),
    );
  } else {
    const hashes = REQUIRED_DOMAINS.map((domain) => value.domainHashes[domain]);
    if (hashes.some((hash) => !hasHash(hash)))
      errors.push(
        issue(
          'domain-capture-invalid',
          `${path}.domainHashes`,
          'every domain must carry a lowercase SHA-256 raw capture hash',
        ),
      );
    if (new Set(hashes).size !== hashes.length)
      errors.push(
        issue(
          'domain-capture-not-distinct',
          `${path}.domainHashes`,
          'linear-HDR, linear-LDR, and final-sRGB cannot reuse one capture',
        ),
      );
  }
}

function validateFeatureValidator(value, path, baseIdentity, rawGates, errors, seenArtifacts) {
  const validShell = validateGateShell(
    value,
    path,
    errors,
    seenArtifacts,
    'feature-validator',
    DERIVED_STATUSES,
  );
  if (!validShell) return;
  compareExecutionIdentity(baseIdentity, value.identity, `${path}.identity`, errors);
  if (value.verdictSource !== 'validator')
    errors.push(
      issue(
        'derived-verdict-source-invalid',
        `${path}.verdictSource`,
        'only the independent validator may publish a derived verdict',
      ),
    );
  if (
    !isRecord(value.derivedFrom) ||
    value.derivedFrom.browser !== rawGates.browser?.artifact?.sha256 ||
    value.derivedFrom.dawn !== rawGates.dawn?.artifact?.sha256
  ) {
    errors.push(
      issue(
        'derived-from-mismatch',
        `${path}.derivedFrom`,
        'validator must point to the exact Browser and Dawn raw artifact digests',
      ),
    );
  }
  if (!EXECUTION_MODES.has(value.executionMode)) {
    errors.push(
      issue(
        'execution-mode-invalid',
        `${path}.executionMode`,
        'validator execution mode is required',
      ),
    );
  }
  if (
    EXECUTION_MODES.has(value.executionMode) &&
    (rawGates.browser?.executionMode !== value.executionMode ||
      rawGates.dawn?.executionMode !== value.executionMode)
  ) {
    errors.push(
      issue(
        'execution-mode-mismatch',
        `${path}.executionMode`,
        'validator execution mode must match both raw backend observations',
      ),
    );
  }
}

function validateTiming(value, path, baseIdentity, errors, seenArtifacts) {
  const validShell = validateGateShell(
    value,
    path,
    errors,
    seenArtifacts,
    'renderer-gpu-timing',
    TIMING_STATUSES,
  );
  if (!validShell) return;
  compareExecutionIdentity(baseIdentity, value.identity, `${path}.identity`, errors);
  if (value.status === 'blocked') {
    if (value.deferred !== true || value.source !== 'renderer-gpu-pass-timing-deferred') {
      errors.push(
        issue(
          'timing-deferred-contract-invalid',
          path,
          'a blocked timing gate may be admitted only as an explicit deferred physical-performance contract',
        ),
      );
    }
    if (value.physicalGpu !== false || value.timestampQuery !== false) {
      errors.push(
        issue(
          'timing-deferred-provenance-invalid',
          path,
          'deferred timing must retain physicalGpu=false and timestampQuery=false',
        ),
      );
    }
    if (typeof value.reason !== 'string' || value.reason.length === 0) {
      errors.push(
        issue(
          'timing-deferred-reason-missing',
          `${path}.reason`,
          'deferred physical-performance timing requires an explicit reason',
        ),
      );
    }
  }
  if (value.status === 'qualified') {
    if (value.source !== 'renderer-gpu-pass-timing')
      errors.push(
        issue(
          'timing-source-invalid',
          `${path}.source`,
          'timing must come from the renderer GPU pass timing primitive',
        ),
      );
    if (!Array.isArray(value.passes) || !sameJson(value.passes, REQUIRED_TIMING_PASSES))
      errors.push(
        issue(
          'timing-pass-set-invalid',
          `${path}.passes`,
          'the fused meter and independent LUT pass timing are required in order',
        ),
      );
    if (
      !Array.isArray(value.logicalStages) ||
      !sameJson(value.logicalStages, REQUIRED_LOGICAL_STAGES)
    )
      errors.push(
        issue(
          'timing-logical-stage-set-invalid',
          `${path}.logicalStages`,
          'clear, histogram, and adapt logical stages are required in order',
        ),
      );
    if (value.physicalGpu !== true || value.timestampQuery !== true)
      errors.push(
        issue(
          'timing-provenance-invalid',
          path,
          'qualified timing requires a physical GPU and raw timestamp queries',
        ),
      );
    if (!isRecord(value.resolutions)) {
      errors.push(
        issue(
          'timing-resolution-missing',
          `${path}.resolutions`,
          '1080p and 4K timing windows are both required',
        ),
      );
    } else {
      for (const [resolution, limit] of Object.entries(TIMING_LIMITS_MS)) {
        const sample = value.resolutions[resolution];
        if (
          !isRecord(sample) ||
          !Number.isFinite(sample.p95Ms) ||
          sample.p95Ms < 0 ||
          sample.p95Ms > limit ||
          !Number.isSafeInteger(sample.sampleCount) ||
          sample.sampleCount < 1 ||
          sample.windowComplete !== true
        ) {
          errors.push(
            issue(
              'timing-resolution-invalid',
              `${path}.resolutions.${resolution}`,
              `complete nearest-rank P95 samples at or below ${limit}ms are required`,
            ),
          );
        }
      }
    }
  }
}

function validateThree(value, path, baseIdentity, errors, seenArtifacts) {
  const validShell = validateGateShell(
    value,
    path,
    errors,
    seenArtifacts,
    'three-r184',
    THREE_STATUSES,
  );
  if (!validShell) return;
  compareExecutionIdentity(baseIdentity, value.identity, `${path}.identity`, errors);
  if (value.status === 'pass') {
    if (
      value.referencePackage !== 'three' ||
      value.referenceVersion !== '0.184.0' ||
      !hasRevision(value.referenceCommit) ||
      !hasIntegrity(value.referenceIntegrity)
    ) {
      errors.push(
        issue(
          'three-provenance-invalid',
          path,
          'Three.js r184 package, reference commit, and integrity are required',
        ),
      );
    }
    if (value.overallParityClaim !== false)
      errors.push(
        issue(
          'three-overall-claim-invalid',
          `${path}.overallParityClaim`,
          'the common-stage report must not claim overall parity',
        ),
      );
    if (!Number.isFinite(value.roiEpsilon) || value.roiEpsilon < 0 || value.roiEpsilon > 0.05)
      errors.push(
        issue(
          'three-epsilon-invalid',
          `${path}.roiEpsilon`,
          'decoded-sRGB ROI delta must be finite and <= 0.05',
        ),
      );
    if (
      !Array.isArray(value.notApplicable) ||
      value.notApplicable.length === 0 ||
      value.notApplicable.some(
        (entry) =>
          !isRecord(entry) ||
          typeof entry.feature !== 'string' ||
          typeof entry.reason !== 'string' ||
          entry.reason.length === 0,
      )
    ) {
      errors.push(
        issue(
          'three-not-applicable-invalid',
          `${path}.notApplicable`,
          'non-equivalent features need explicit rationale',
        ),
      );
    }
  }
}

function validateRoster(value, path, baseIdentity, errors, seenArtifacts) {
  const validShell = validateGateShell(
    value,
    path,
    errors,
    seenArtifacts,
    'canonical-dawn-roster',
    STATUSES,
  );
  if (!validShell) return;
  compareExecutionIdentity(baseIdentity, value.identity, `${path}.identity`, errors);
  if (
    value.status === 'pass' &&
    (value.executed !== true ||
      !Number.isSafeInteger(value.entryCount) ||
      value.entryCount < 1 ||
      !hasHash(value.rosterSha256))
  ) {
    errors.push(
      issue(
        'roster-not-independent',
        path,
        'the current manifest-derived roster must execute and retain its own digest',
      ),
    );
  }
  if (value.status === 'blocked' && value.ciState === 'blocked') {
    if (value.deferred !== true || typeof value.reason !== 'string' || value.reason.length === 0) {
      errors.push(
        issue(
          'roster-deferred-contract-invalid',
          path,
          'a capability-limited Dawn roster may remain blocked only with an explicit deferred reason',
        ),
      );
    }
  }
}

function validateProbe(value, path, baseIdentity, errors, seenArtifacts) {
  const validShell = validateGateShell(
    value,
    path,
    errors,
    seenArtifacts,
    'shared-input-probe',
    STATUSES,
  );
  if (!validShell) return;
  compareExecutionIdentity(baseIdentity, value.identity, `${path}.identity`, errors);
  if (
    value.status === 'pass' &&
    (value.workflowDispatch !== true || !hasHash(value.payloadSha256))
  ) {
    errors.push(
      issue(
        'probe-not-independent',
        path,
        'shared probe must be explicitly dispatched and retain its own payload digest',
      ),
    );
  }
}

function validateBaseIdentity(value, errors) {
  if (!isRecord(value)) {
    errors.push(
      issue(
        'identity-missing',
        'identity',
        'one exact source/build/fixture/frame/resolution identity is required',
      ),
    );
    return;
  }
  if (!hasRevision(value.testedRevision))
    errors.push(
      issue('revision-invalid', 'identity.testedRevision', 'a full commit SHA is required'),
    );
  validateDigestRef(value.source, 'identity.source', errors);
  validateDigestRef(value.build, 'identity.build', errors);
  validateFixture(value.fixtureIdentity, 'identity.fixtureIdentity', errors);
  validateFrame(value.frameIdentity, 'identity.frameIdentity', errors);
  validateResolution(value.resolution, 'identity.resolution', errors);
}

function deriveStatus(gates, errors) {
  const statuses = REQUIRED_GATE_IDS.map((id) => gates?.[id]?.status);
  if (statuses.some((status) => status === 'failed' || status === 'ineligible')) return 'failed';
  if (errors.length > 0)
    return errors.some(
      (entry) => entry.code.endsWith('failed') || entry.code === 'raw-pass-forbidden',
    )
      ? 'failed'
      : 'blocked';
  const timingDeferred =
    gates?.qualifiedTiming?.status === 'blocked' && gates?.qualifiedTiming?.deferred === true;
  const rosterDeferred =
    gates?.canonicalRoster?.status === 'blocked' && gates?.canonicalRoster?.deferred === true;
  const expected = [
    'observation',
    'observation',
    'pass',
    timingDeferred ? 'blocked' : 'qualified',
    'pass',
    rosterDeferred ? 'blocked' : 'pass',
    'pass',
  ];
  return statuses.every((status, index) => status === expected[index]) ? 'pass' : 'blocked';
}

export function validateCiArtifactJoin(input) {
  const errors = [];
  if (!isRecord(input))
    return {
      status: 'blocked',
      errors: [issue('join-envelope-missing', '', 'CI artifact join must be an object')],
    };
  if (input.schemaVersion !== CI_JOIN_SCHEMA_VERSION)
    errors.push(
      issue('join-schema-version', 'schemaVersion', `expected ${CI_JOIN_SCHEMA_VERSION}`),
    );
  if (input.featureId !== FEATURE_ID)
    errors.push(issue('feature-identity-mismatch', 'featureId', `expected ${FEATURE_ID}`));
  for (const key of Object.keys(input))
    if (!JOIN_KEYS.has(key))
      errors.push(issue('join-unexpected', key, 'unknown join envelope field is not admitted'));
  validateBaseIdentity(input.identity, errors);

  const gates = input.gates;
  const seenArtifacts = new Set();
  if (!isRecord(gates)) {
    errors.push(issue('gate-set-missing', 'gates', 'all independent gate envelopes are required'));
  } else {
    for (const id of REQUIRED_GATE_IDS)
      if (!(id in gates))
        errors.push(issue('gate-missing', `gates.${id}`, 'required independent gate is absent'));
    for (const id of Object.keys(gates))
      if (!REQUIRED_GATE_IDS.includes(id))
        errors.push(
          issue(
            'gate-unexpected',
            `gates.${id}`,
            'unknown gate is not part of the admission contract',
          ),
        );
    const base = input.identity;
    validateRawProducer(
      gates.browser,
      'gates.browser',
      base,
      errors,
      seenArtifacts,
      'browser-webgpu',
    );
    validateRawProducer(gates.dawn, 'gates.dawn', base, errors, seenArtifacts, 'dawn-node');
    validateFeatureValidator(
      gates.featureValidator,
      'gates.featureValidator',
      base,
      gates,
      errors,
      seenArtifacts,
    );
    validateTiming(gates.qualifiedTiming, 'gates.qualifiedTiming', base, errors, seenArtifacts);
    validateThree(gates.threeAc27, 'gates.threeAc27', base, errors, seenArtifacts);
    validateRoster(gates.canonicalRoster, 'gates.canonicalRoster', base, errors, seenArtifacts);
    validateProbe(gates.sharedProbe, 'gates.sharedProbe', base, errors, seenArtifacts);
    if (hasRevision(base?.testedRevision)) {
      for (const id of REQUIRED_GATE_IDS) {
        const artifact = gates[id]?.artifact;
        if (
          isRecord(artifact) &&
          hasRevision(artifact.testedRevision) &&
          artifact.testedRevision !== base.testedRevision
        ) {
          errors.push(
            issue(
              'artifact-revision-mismatch',
              `gates.${id}.artifact.testedRevision`,
              'every gate artifact must be produced from the exact join revision',
            ),
          );
        }
      }
    }
  }
  const derivedStatus = deriveStatus(gates, errors);
  if (input.status !== undefined && !STATUSES.has(input.status))
    errors.push(issue('join-status-invalid', 'status', 'join status is closed'));
  if (input.status !== undefined && input.status !== derivedStatus)
    errors.push(issue('join-status-mismatch', 'status', `derived status is ${derivedStatus}`));
  const status = deriveStatus(gates, errors);
  return { status, errors };
}

/**
 * Produce a derived join report.  The input gates are retained as observations;
 * no field is synthesized when validation fails.  A valid report is still an
 * admission envelope, not a claim that the product has passed unrelated
 * release or Judgment gates.
 */
export function joinAutoExposureEvidence(input) {
  const validation = validateCiArtifactJoin(input);
  return {
    schemaVersion: CI_JOIN_SCHEMA_VERSION,
    featureId: FEATURE_ID,
    status: validation.status,
    identity: isRecord(input) ? (input.identity ?? null) : null,
    gates: isRecord(input) ? (input.gates ?? null) : null,
    errors: validation.errors,
    acceptance:
      validation.status !== 'pass'
        ? 'blocked'
        : input?.gates?.qualifiedTiming?.deferred === true
          ? 'feature-function-admitted-performance-deferred'
          : 'feature-gates-admitted',
  };
}

function parseInput(argv) {
  const path = argv[0];
  if (!path) throw new Error('usage: node scripts/ci/join-auto-exposure-evidence.mjs <join.json>');
  return JSON.parse(readFileSync(path, 'utf8'));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const input = await parseInput(process.argv.slice(2));
  const report = joinAutoExposureEvidence(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === 'pass' ? 0 : 1;
}
