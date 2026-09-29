#!/usr/bin/env node

/**
 * Project the independent Browser/Dawn workload bundles into the seven-gate
 * feature join.  This is a projection only: raw reports stay raw, the bundle
 * validator remains the sole derived verdict owner, and missing downstream
 * gates are explicit blocked artifacts rather than pass-valued defaults.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { validateFeatureEvidenceBundle } from '../../apps/hello/taa/scripts/validate-feature-evidence.mjs';
import { joinAutoExposureEvidence } from './join-auto-exposure-evidence.mjs';

const FEATURE_ID = 'feat-20260827-auto-exposure-hdr-color-grading';
const DOMAINS = Object.freeze(['linear-HDR', 'linear-LDR', 'final-sRGB']);
const WORKLOADS = Object.freeze(['manual', 'auto', 'positive-lut']);
const GATES = Object.freeze(['threeAc27', 'canonicalRoster', 'sharedProbe']);
const IDENTITY_FIELDS = Object.freeze([
  'testedRevision',
  'source',
  'build',
  'fixtureIdentity',
  'frameIdentity',
  'resolution',
]);
const CAPABILITY_VARIANT_FIELDS = new Set(['frameIdentity', 'resolution']);

function option(name, fallback) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name) {
  const value = option(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function readText(path) {
  return readFileSync(resolve(path), 'utf8');
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function writeJson(path, value) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
}

function relativePath(path) {
  const value = relative(process.cwd(), resolve(path));
  return value.length > 0 ? value : path;
}

function artifactRef(path, testedRevision, kind) {
  const text = readText(path);
  return {
    kind,
    path: relativePath(path),
    sha256: digest(text),
    testedRevision,
  };
}

function readExternalGate(path, label, testedRevision) {
  const gate = readJson(path);
  const artifact = gate?.artifact;
  if (artifact?.testedRevision !== testedRevision) {
    throw new Error(`${label} gate artifact HEAD drift`);
  }
  if (typeof artifact?.path !== 'string' || typeof artifact?.sha256 !== 'string') {
    throw new Error(`${label} gate artifact reference is incomplete`);
  }
  const artifactPath = resolve(artifact.path);
  if (!existsSync(artifactPath)) {
    throw new Error(`${label} gate artifact is missing: ${artifact.path}`);
  }
  if (digest(readText(artifactPath)) !== artifact.sha256) {
    throw new Error(`${label} gate artifact digest drift`);
  }
  return gate;
}

function reportFromBundle(bundle) {
  for (const kind of ['auto', 'positive-lut', 'manual']) {
    const report =
      bundle?.workloads?.[kind]?.report?.featureEvidence ?? bundle?.workloads?.[kind]?.report;
    if (report !== undefined) return report;
  }
  return undefined;
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

function identityFromReport(report, testedRevision) {
  if (report === undefined || report === null || typeof report !== 'object') return undefined;
  const fields = ['source', 'build', 'fixtureIdentity', 'frameIdentity', 'resolution'];
  if (fields.some((field) => report[field] === undefined || report[field] === null))
    return undefined;
  return {
    testedRevision,
    source: report.source,
    build: report.build,
    fixtureIdentity: report.fixtureIdentity,
    frameIdentity: report.frameIdentity,
    resolution: report.resolution,
  };
}

function identityMismatches(left, right) {
  return IDENTITY_FIELDS.filter(
    (field) => canonicalJson(left[field]) !== canonicalJson(right[field]),
  );
}

function verifiedDerived({ bundle, derived, label, testedRevision }) {
  if (derived?.schemaVersion !== 'hello-taa-auto-exposure-feature-validator/1') {
    throw new Error(`${label} derived schema is invalid`);
  }
  if (derived.featureId !== FEATURE_ID || derived.testedRevision !== testedRevision) {
    throw new Error(`${label} derived identity drift`);
  }
  if (derived.backend !== bundle.backend) {
    throw new Error(`${label} derived backend drift`);
  }
  const workloadEntries = bundle.workloads;
  if (
    workloadEntries === null ||
    typeof workloadEntries !== 'object' ||
    Array.isArray(workloadEntries)
  ) {
    throw new Error(`${label} bundle workload set is invalid`);
  }
  const expectedKinds = [...WORKLOADS].sort();
  const actualKinds = Object.keys(workloadEntries).sort();
  if (JSON.stringify(actualKinds) !== JSON.stringify(expectedKinds)) {
    throw new Error(`${label} bundle workload set is incomplete`);
  }
  const derivedFrom = derived.derivedFrom;
  if (derivedFrom === null || typeof derivedFrom !== 'object' || Array.isArray(derivedFrom)) {
    throw new Error(`${label} derivedFrom is missing`);
  }
  for (const kind of WORKLOADS) {
    const entry = workloadEntries[kind];
    if (entry?.testedRevision !== testedRevision) {
      throw new Error(`${label} ${kind} testedRevision drift`);
    }
    if (typeof entry?.path !== 'string' || !existsSync(resolve(entry.path))) {
      throw new Error(`${label} ${kind} raw evidence is missing`);
    }
    const rawPath = resolve(entry.path);
    const rawText = readText(rawPath);
    if (digest(rawText) !== entry.sha256) {
      throw new Error(`${label} ${kind} raw evidence digest drift`);
    }
    let rawPayload;
    try {
      rawPayload = JSON.parse(rawText);
    } catch {
      throw new Error(`${label} ${kind} raw evidence JSON is invalid`);
    }
    const rawReport = rawPayload?.featureEvidence ?? rawPayload;
    const report = entry?.report?.featureEvidence ?? entry?.report ?? entry?.featureEvidence;
    if (JSON.stringify(rawReport) !== JSON.stringify(report)) {
      throw new Error(`${label} ${kind} raw evidence payload drift`);
    }
    const rawTestedRevision = rawPayload?.testedRevision ?? rawReport?.testedRevision;
    if (rawTestedRevision !== testedRevision) {
      throw new Error(`${label} ${kind} raw evidence HEAD drift`);
    }
    if (report?.testedRevision !== undefined && report.testedRevision !== testedRevision) {
      throw new Error(`${label} ${kind} report testedRevision drift`);
    }
    if (derivedFrom[kind] !== entry?.sha256) {
      throw new Error(`${label} ${kind} derivedFrom digest drift`);
    }
  }
  const computed = validateFeatureEvidenceBundle(bundle);
  if (derived.status !== computed.status) {
    throw new Error(`${label} derived status does not match the independent validator`);
  }
  if (computed.status === 'pass' && derived.verdictSource !== 'validator') {
    throw new Error(`${label} pass verdict must come from the independent validator`);
  }
  return computed;
}

function assertBackendSlot(bundle, label, expectedBackend, expectedRunner) {
  if (bundle.backend !== expectedBackend) {
    throw new Error(`${label} backend slot does not match observed backend`);
  }
  let provenanceBackend;
  let executionMode;
  for (const kind of WORKLOADS) {
    const report =
      bundle.workloads?.[kind]?.report?.featureEvidence ?? bundle.workloads?.[kind]?.report;
    if (report?.backend !== expectedBackend) {
      throw new Error(`${label} ${kind} backend slot does not match observed backend`);
    }
    if (
      report?.runner?.kind !== expectedRunner ||
      report?.provenance?.runner?.kind !== expectedRunner
    ) {
      throw new Error(`${label} ${kind} runner slot does not match observed runner`);
    }
    if (report?.executionMode !== 'physical' && report?.executionMode !== 'simulated') {
      throw new Error(`${label} ${kind} execution mode is missing or invalid`);
    }
    if (executionMode === undefined) executionMode = report.executionMode;
    else if (executionMode !== report.executionMode)
      throw new Error(`${label} workload execution mode drift`);
    const observedProvenanceBackend = report?.provenance?.backend;
    if (observedProvenanceBackend !== undefined) {
      if (provenanceBackend === undefined) provenanceBackend = observedProvenanceBackend;
      else if (JSON.stringify(provenanceBackend) !== JSON.stringify(observedProvenanceBackend)) {
        throw new Error(`${label} ${kind} provenance backend drift`);
      }
    }
  }
  return executionMode;
}

function gateIdentity(base, backend, runner) {
  return { ...base, backend, runner };
}

function blockedArtifact(outputDir, gateId, testedRevision, reason) {
  const path = resolve(outputDir, `blocked-${gateId}.json`);
  writeJson(path, {
    schemaVersion: 'forgeax-auto-exposure-ci-blocked-gate/1',
    featureId: FEATURE_ID,
    gate: gateId,
    testedRevision,
    status: 'blocked',
    reason,
  });
  return artifactRef(path, testedRevision, `auto-exposure-${gateId}-blocked`);
}

function makeRawGate({ bundlePath, bundle, derivedStatus, base, backend, testedRevision }) {
  const report = reportFromBundle(bundle);
  const domains = report?.stages
    ?.map((stage) => stage?.domain)
    .filter((domain) => typeof domain === 'string');
  const domainHashes = Object.fromEntries(
    (report?.stages ?? []).map((stage) => [stage?.domain, stage?.readback?.rawHash]),
  );
  const status =
    derivedStatus === 'failed' ? 'failed' : derivedStatus === 'pass' ? 'observation' : 'blocked';
  const runner =
    report?.runner ??
    (backend === 'browser-webgpu'
      ? { kind: 'playwright', id: 'chrome-beta' }
      : { kind: 'dawn', id: 'dawn-node' });
  return {
    status,
    ciState: status === 'observation' ? 'success' : status === 'failed' ? 'failure' : 'blocked',
    identity: gateIdentity(base, backend, runner),
    artifact: artifactRef(bundlePath, testedRevision, `auto-exposure-${backend}-raw-bundle`),
    verdictSource: 'producer-observation',
    executionMode: report?.executionMode,
    workloads: [...WORKLOADS],
    domains: domains?.length === DOMAINS.length ? domains : [...DOMAINS],
    domainHashes,
  };
}

function makeFeatureValidatorGate({
  browserBundlePath,
  dawnBundlePath,
  browserBundle,
  dawnBundle,
  browserStatus,
  dawnStatus,
  base,
  testedRevision,
  outputDir,
}) {
  const browserRaw = artifactRef(
    browserBundlePath,
    testedRevision,
    'auto-exposure-browser-webgpu-raw-bundle',
  );
  const dawnRaw = artifactRef(dawnBundlePath, testedRevision, 'auto-exposure-dawn-node-raw-bundle');
  const status =
    browserStatus === 'failed' || dawnStatus === 'failed'
      ? 'failed'
      : browserStatus === 'pass' && dawnStatus === 'pass'
        ? 'pass'
        : 'blocked';
  const derivedPath = resolve(outputDir, 'feature-validator-derived.json');
  writeJson(derivedPath, {
    schemaVersion: 'hello-taa-auto-exposure-feature-validator-join/1',
    featureId: FEATURE_ID,
    testedRevision,
    status,
    verdictSource: 'validator',
    derivedFrom: { browser: browserRaw.sha256, dawn: dawnRaw.sha256 },
    browser: { status: browserStatus },
    dawn: { status: dawnStatus },
    sourceBundles: { browser: browserBundle?.schemaVersion, dawn: dawnBundle?.schemaVersion },
    executionMode:
      browserBundle?.workloads?.auto?.report?.featureEvidence?.executionMode ??
      browserBundle?.workloads?.auto?.report?.executionMode,
  });
  return {
    status,
    ciState: status === 'pass' ? 'success' : status === 'failed' ? 'failure' : 'blocked',
    identity: gateIdentity(base, 'feature-validator', { kind: 'validator', id: 'browser+dawn' }),
    artifact: artifactRef(derivedPath, testedRevision, 'auto-exposure-feature-validator-derived'),
    verdictSource: 'validator',
    executionMode:
      browserBundle?.workloads?.auto?.report?.featureEvidence?.executionMode ??
      browserBundle?.workloads?.auto?.report?.executionMode,
    derivedFrom: { browser: browserRaw.sha256, dawn: dawnRaw.sha256 },
  };
}

function makeMissingGate({ gateId, backend, base, testedRevision, outputDir, executionMode }) {
  if (gateId === 'qualifiedTiming' && executionMode === 'simulated') {
    const path = resolve(outputDir, 'deferred-qualifiedTiming.json');
    const reason =
      'physical GPU timing is unavailable; software execution remains correctness evidence and is not substituted for GPU timing';
    writeJson(path, {
      schemaVersion: 'forgeax-auto-exposure-timing-deferred/1',
      featureId: FEATURE_ID,
      testedRevision,
      status: 'blocked',
      executionMode: 'simulated',
      reason,
      physicalGpu: false,
      timestampQuery: false,
      source: 'renderer-gpu-pass-timing-deferred',
      identity: gateIdentity(base, backend, { kind: 'software', id: 'lavapipe-correctness' }),
    });
    return {
      status: 'blocked',
      ciState: 'blocked',
      deferred: true,
      reason,
      source: 'renderer-gpu-pass-timing-deferred',
      physicalGpu: false,
      timestampQuery: false,
      identity: gateIdentity(base, backend, { kind: 'software', id: 'lavapipe-correctness' }),
      artifact: artifactRef(path, testedRevision, 'auto-exposure-renderer-timing-deferred'),
    };
  }
  return {
    status: 'blocked',
    ciState: 'missing',
    identity: gateIdentity(base, backend, { kind: 'missing', id: gateId }),
    artifact: blockedArtifact(
      outputDir,
      gateId,
      testedRevision,
      `${gateId} gate was not supplied to this producer`,
    ),
  };
}

const testedRevision = required('head');
if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(testedRevision))
  throw new Error('--head must be a 40- or 64-character lowercase commit SHA');
const browserBundlePath = required('browser-bundle');
const dawnBundlePath = required('dawn-bundle');
const browserDerivedPath = required('browser-derived');
const dawnDerivedPath = required('dawn-derived');
const outputPath = required('output');
const outputDir = resolve(option('output-dir', dirname(outputPath)));
mkdirSync(outputDir, { recursive: true });

if (![browserBundlePath, dawnBundlePath, browserDerivedPath, dawnDerivedPath].every(existsSync)) {
  throw new Error(
    'all Browser/Dawn bundle and derived inputs are required for the exact-head join',
  );
}

const browserBundle = readJson(browserBundlePath);
const dawnBundle = readJson(dawnBundlePath);
const browserDerived = readJson(browserDerivedPath);
const dawnDerived = readJson(dawnDerivedPath);
if (browserBundle.featureId !== FEATURE_ID || dawnBundle.featureId !== FEATURE_ID)
  throw new Error('feature identity drift in workload bundle');
if (browserBundle.testedRevision !== testedRevision || dawnBundle.testedRevision !== testedRevision)
  throw new Error('workload bundle HEAD drift');
const browserExecutionMode = assertBackendSlot(
  browserBundle,
  'Browser',
  'browser-webgpu',
  'playwright',
);
const dawnExecutionMode = assertBackendSlot(dawnBundle, 'Dawn', 'dawn-node', 'dawn');
if (browserExecutionMode !== dawnExecutionMode) {
  throw new Error(
    `Browser/Dawn execution mode drift: ${browserExecutionMode} !== ${dawnExecutionMode}`,
  );
}
const browserValidation = verifiedDerived({
  bundle: browserBundle,
  derived: browserDerived,
  label: 'Browser',
  testedRevision,
});
const dawnValidation = verifiedDerived({
  bundle: dawnBundle,
  derived: dawnDerived,
  label: 'Dawn',
  testedRevision,
});

const browserReport = reportFromBundle(browserBundle);
const dawnReport = reportFromBundle(dawnBundle);
const base = identityFromReport(browserReport, testedRevision);
const dawnBase = identityFromReport(dawnReport, testedRevision);
if (base === undefined || dawnBase === undefined)
  throw new Error('Browser/Dawn workload bundles lack a complete join identity');
const identityMismatchesBetweenBackends = identityMismatches(base, dawnBase);
const capabilityBlocked =
  browserValidation.status === 'blocked' || dawnValidation.status === 'blocked';
const onlyCapabilityVariantMismatch = identityMismatchesBetweenBackends.every((field) =>
  CAPABILITY_VARIANT_FIELDS.has(field),
);
if (
  identityMismatchesBetweenBackends.length > 0 &&
  (!capabilityBlocked || !onlyCapabilityVariantMismatch)
) {
  throw new Error('Browser/Dawn workload bundle identities diverge');
}

const gates = {
  browser: makeRawGate({
    bundlePath: browserBundlePath,
    bundle: browserBundle,
    derivedStatus: browserValidation.status,
    base,
    backend: 'browser-webgpu',
    testedRevision,
  }),
  dawn: makeRawGate({
    bundlePath: dawnBundlePath,
    bundle: dawnBundle,
    derivedStatus: dawnValidation.status,
    base: dawnBase,
    backend: 'dawn-node',
    testedRevision,
  }),
  featureValidator: makeFeatureValidatorGate({
    browserBundlePath,
    dawnBundlePath,
    browserBundle,
    dawnBundle,
    browserStatus: browserValidation.status,
    dawnStatus: dawnValidation.status,
    base,
    testedRevision,
    outputDir,
  }),
};

const timingPath = option('timing-gate');
gates.qualifiedTiming = timingPath
  ? readExternalGate(timingPath, 'qualifiedTiming', testedRevision)
  : makeMissingGate({
      gateId: 'qualifiedTiming',
      backend: 'renderer-gpu-timing',
      base,
      testedRevision,
      outputDir,
      executionMode: browserExecutionMode,
    });
for (const gateId of GATES) {
  const path = option(`${gateId.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-gate`);
  gates[gateId] = path
    ? readExternalGate(path, gateId, testedRevision)
    : makeMissingGate({
        gateId,
        backend:
          gateId === 'threeAc27'
            ? 'three-r184'
            : gateId === 'canonicalRoster'
              ? 'canonical-dawn-roster'
              : 'shared-input-probe',
        base,
        testedRevision,
        outputDir,
      });
}

const joinInput = {
  schemaVersion: 'forgeax-auto-exposure-ci-join/1',
  featureId: FEATURE_ID,
  identity: base,
  gates,
};
const joinInputPath = resolve(outputDir, 'join-input.json');
writeJson(joinInputPath, joinInput);
const report = joinAutoExposureEvidence(joinInput);
writeJson(outputPath, report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
// A blocked gate is a valid outcome for a capability-limited run; malformed
// evidence is not.  Keep the report for diagnosis but fail the producer on
// any join validation error so CI cannot carry an invalid blocked envelope.
const capabilityBlockedIdentityMismatch =
  identityMismatchesBetweenBackends.length > 0 &&
  capabilityBlocked &&
  report.status === 'blocked' &&
  report.errors.length > 0 &&
  report.errors.every((entry) => entry.code === 'identity-mismatch') &&
  identityMismatchesBetweenBackends.every((field) => CAPABILITY_VARIANT_FIELDS.has(field));
if (capabilityBlockedIdentityMismatch) {
  process.stderr.write(
    `feature join remains blocked because capability-limited Browser/Dawn capture windows differ: ${identityMismatchesBetweenBackends.join(', ')}\n`,
  );
}
process.exitCode = report.errors.length > 0 && !capabilityBlockedIdentityMismatch ? 1 : 0;
