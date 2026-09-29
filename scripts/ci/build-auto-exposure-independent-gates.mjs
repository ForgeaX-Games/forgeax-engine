#!/usr/bin/env node

/**
 * Build the three independent non-renderer gates for the exact auto-exposure
 * feature join. Every input is revalidated from its producer-owned evidence;
 * an aggregate, carrier, or declaration alone is never enough to pass a gate.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  aggregateReports,
  readReports,
  readRoster,
  resolveRunnableEntries,
} from './run-dawn-smoke-roster.mjs';

const FEATURE_ID = 'feat-20260827-auto-exposure-hdr-color-grading';
const WORKLOADS = Object.freeze(['manual', 'auto', 'positive-lut']);
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const HASH = /^[a-f0-9]{64}$/;
const THREE_R184_COMMIT = 'd3b629c0c2097cec664ad16369bb6eae3b10e335';
const THREE_R184_INTEGRITY =
  'sha512-wtTRjG92pM5eUg/KuUnHsqSAlPM296brTOcLgMRqEeylYTh/CdtvKUvCyyCQTzFuStieWxvZb8mVTMvdPyUpxg==';

function option(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name) {
  const value = option(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function readText(path) {
  return readFileSync(resolve(path), 'utf8');
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

function artifact(path, testedRevision, kind) {
  const text = readText(path);
  return {
    kind,
    path: relative(process.cwd(), resolve(path)) || path,
    sha256: digest(text),
    testedRevision,
  };
}

function writeJson(path, value) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
}

function requireSafeInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${label} is invalid`);
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    });
}

function currentSharedInputFingerprint() {
  const root = process.cwd();
  const hash = createHash('sha256');
  for (const sourceRoot of [
    resolve(root, 'forgeax-engine-assets/learn-opengl'),
    resolve(root, 'packages/shader/src'),
  ]) {
    if (!statSync(sourceRoot).isDirectory())
      throw new Error(`shared input source is missing: ${sourceRoot}`);
    for (const path of sourceFiles(sourceRoot)) {
      hash.update(`${relative(root, path).replaceAll('\\', '/')}\0`);
      hash.update(readFileSync(path));
    }
  }
  return hash.digest('hex');
}

function reportFromBundle(bundle) {
  if (bundle?.featureId !== FEATURE_ID) throw new Error('feature bundle identity drift');
  if (
    !bundle?.workloads ||
    typeof bundle.workloads !== 'object' ||
    Array.isArray(bundle.workloads)
  ) {
    throw new Error('feature bundle workload set is missing');
  }
  const kinds = Object.keys(bundle.workloads).sort();
  if (JSON.stringify(kinds) !== JSON.stringify([...WORKLOADS].sort())) {
    throw new Error('feature bundle workload set is incomplete');
  }
  for (const kind of WORKLOADS) {
    const entry = bundle.workloads[kind];
    if (!entry || typeof entry !== 'object') throw new Error(`${kind} workload is missing`);
    if (entry.testedRevision === undefined) throw new Error(`${kind} workload revision is missing`);
  }
  const report = bundle.workloads.auto.report?.featureEvidence ?? bundle.workloads.auto.report;
  if (!report || typeof report !== 'object')
    throw new Error('feature bundle has no executable report');
  return report;
}

function joinIdentity(bundle, testedRevision) {
  const report = reportFromBundle(bundle);
  const identity = {
    testedRevision,
    source: report.source,
    build: report.build,
    fixtureIdentity: report.fixtureIdentity,
    frameIdentity: report.frameIdentity,
    resolution: report.resolution,
  };
  if (!REVISION.test(testedRevision)) throw new Error('invalid exact feature revision');
  if (!identity.source?.path || !HASH.test(identity.source.sha256))
    throw new Error('feature source identity is invalid');
  if (!identity.build?.path || !HASH.test(identity.build.sha256))
    throw new Error('feature build identity is invalid');
  for (const part of ['asset', 'camera', 'light', 'input']) {
    if (
      !identity.fixtureIdentity?.[part]?.id ||
      !HASH.test(identity.fixtureIdentity[part].sha256)
    ) {
      throw new Error(`feature fixture identity is invalid: ${part}`);
    }
  }
  if (
    !Number.isSafeInteger(identity.frameIdentity?.first) ||
    !Number.isSafeInteger(identity.frameIdentity?.last) ||
    !HASH.test(identity.frameIdentity?.sequenceSha256)
  ) {
    throw new Error('feature frame identity is invalid');
  }
  if (
    !Number.isSafeInteger(identity.resolution?.width) ||
    !Number.isSafeInteger(identity.resolution?.height)
  ) {
    throw new Error('feature resolution identity is invalid');
  }
  return identity;
}

function gateIdentity(identity, backend, runner) {
  return { ...identity, backend, runner };
}

function readAc27(path, testedRevision, lane) {
  const value = readJson(path);
  if (value?.status !== 'passed') throw new Error(`Three.js ${lane} report is not passed: ${path}`);
  if (value.testedRevision !== testedRevision)
    throw new Error(`Three.js ${lane} report HEAD drift`);
  if (value.referenceLane !== lane) throw new Error(`Three.js ${lane} lane drift`);
  if (!Number.isFinite(value.readback?.roiEpsilon) || value.readback.roiEpsilon > 0.05) {
    throw new Error(`Three.js ${lane} ROI epsilon exceeds 0.05`);
  }
  if (
    value.overallParityClaim !== false ||
    !Array.isArray(value.notApplicable) ||
    value.notApplicable.length === 0
  ) {
    throw new Error(`Three.js ${lane} common-stage contract is incomplete`);
  }
  if (
    value.provenance?.three?.package !== 'three' ||
    value.provenance.three.version !== '0.184.0'
  ) {
    throw new Error(`Three.js ${lane} provenance is not r184/0.184.0`);
  }
  if (!value.runner?.three || !value.runner?.forgeax)
    throw new Error(`Three.js ${lane} runner identity is missing`);
  return value;
}

function readRaw(path, { side, lane, runnerKind, testedRevision }) {
  const value = readJson(path);
  if (value?.schemaVersion !== 1 || value?.status !== 'observation') {
    throw new Error(`${side} ${lane} raw AC-27 artifact is not an observation`);
  }
  if (
    value.side !== side ||
    value.referenceLane !== lane ||
    value.testedRevision !== testedRevision
  ) {
    throw new Error(`${side} ${lane} raw AC-27 identity drift`);
  }
  if (
    value.caseId !== 'auto-exposure-three-r184' ||
    !value.runner?.id ||
    value.runner.kind !== runnerKind
  ) {
    throw new Error(`${side} ${lane} raw AC-27 runner identity is invalid`);
  }
  if (
    !value.resolution ||
    !Number.isSafeInteger(value.resolution.width) ||
    !Number.isSafeInteger(value.resolution.height)
  ) {
    throw new Error(`${side} ${lane} raw AC-27 resolution is invalid`);
  }
  if (value.overallParityClaim !== false)
    throw new Error(`${side} ${lane} raw AC-27 claims parity`);
  if (side === 'three') {
    if (
      value.kind !== 'auto-exposure-three-r184-live' ||
      value.qualification !== 'live-three-r184-webgpu-readback' ||
      value.provenance?.implementation !== 'three' ||
      value.provenance.package !== 'three' ||
      value.provenance.version !== '0.184.0' ||
      value.provenance.commit !== THREE_R184_COMMIT ||
      value.provenance.integrity !== THREE_R184_INTEGRITY ||
      value.provenance.backend !== 'webgpu'
    ) {
      throw new Error(`${side} ${lane} raw AC-27 Three r184 provenance is not pinned`);
    }
  } else if (
    value.kind !== 'auto-exposure-forgeax-live' ||
    value.qualification !== 'live-forgeax-renderer-readback' ||
    value.provenance?.implementation !== 'forgeax' ||
    value.provenance.package !== '@forgeax/engine' ||
    value.provenance.commit !== testedRevision ||
    value.provenance.backend !== runnerKind ||
    !HASH.test(value.provenance.build)
  ) {
    throw new Error(`${side} ${lane} raw AC-27 ForgeaX provenance is not exact`);
  }
  return {
    value,
    path: resolve(path),
    artifact: artifact(path, testedRevision, `auto-exposure-${side}-${runnerKind}`),
  };
}

function assertJoinMatchesRaw(report, threeRaw, forgeaxRaw, outputDir, index) {
  if (
    report.runner.three !== threeRaw.value.runner.id ||
    report.runner.forgeax !== forgeaxRaw.value.runner.id
  ) {
    throw new Error(
      `${report.referenceLane} ${threeRaw.value.runner.kind} join runner/raw mismatch`,
    );
  }
  if (
    report.resolution.width !== threeRaw.value.resolution.width ||
    report.resolution.height !== threeRaw.value.resolution.height
  ) {
    throw new Error(
      `${report.referenceLane} ${threeRaw.value.runner.kind} join resolution/raw mismatch`,
    );
  }
  for (const field of ['package', 'version', 'commit', 'integrity']) {
    if (report.provenance?.three?.[field] !== threeRaw.value.provenance?.[field]) {
      throw new Error(
        `${report.referenceLane} ${threeRaw.value.runner.kind} Three provenance/raw mismatch`,
      );
    }
  }
  if (JSON.stringify(report.provenance?.forgeax) !== JSON.stringify(forgeaxRaw.value.provenance)) {
    throw new Error(
      `${report.referenceLane} ${threeRaw.value.runner.kind} ForgeaX provenance/raw mismatch`,
    );
  }
  const recomputedPath = resolve(outputDir, `.recomputed-ac27-${index}.json`);
  try {
    execFileSync(
      process.execPath,
      [
        'scripts/ci/auto-exposure-ac27.mjs',
        'join',
        `--three=${threeRaw.path}`,
        `--forgeax=${forgeaxRaw.path}`,
        `--output=${recomputedPath}`,
      ],
      { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const recomputed = readJson(recomputedPath);
    if (JSON.stringify(recomputed) !== JSON.stringify(report)) {
      throw new Error(
        `${report.referenceLane} ${threeRaw.value.runner.kind} join does not match raw producer bytes`,
      );
    }
  } finally {
    // Keep no second evidence owner after the comparison; the raw producer
    // pair and the checked-in join report remain the authoritative artifacts.
    rmSync(recomputedPath, { force: true });
  }
}

function buildThreeGate({ outputDir, testedRevision, identity, reports, raws }) {
  const reference = reports[0];
  for (const report of reports.slice(1)) {
    for (const field of ['caseId', 'fixtureIdentity', 'rendererFields', 'stageMapping']) {
      if (JSON.stringify(report[field]) !== JSON.stringify(reference[field])) {
        throw new Error(`Three.js ${field} drift across direct/clustered or backend lanes`);
      }
    }
    if (JSON.stringify(report.provenance?.three) !== JSON.stringify(reference.provenance?.three)) {
      throw new Error('Three.js provenance drift across AC-27 lanes');
    }
  }
  const rawDigests = raws.map((raw) => raw.artifact.sha256);
  if (new Set(rawDigests).size !== rawDigests.length)
    throw new Error('AC-27 raw producer artifacts are not independent');
  const roiEpsilon = Math.max(...reports.map((report) => report.readback.roiEpsilon));
  // The live AC-27 producer names these entries by pipeline stage, while the
  // join contract deliberately names the compared feature. Project the one
  // producer-owned vocabulary into the validator SSOT here instead of leaking
  // the legacy `stage` field into the independent gate.
  const notApplicable = reference.notApplicable.map((entry) => ({
    feature: entry.feature ?? entry.stage,
    reason: entry.reason,
  }));
  if (
    notApplicable.some((entry) => typeof entry.feature !== 'string' || entry.feature.length === 0)
  ) {
    throw new Error('Three.js notApplicable entries must identify a feature');
  }
  const aggregatePath = resolve(outputDir, 'three-ac27-aggregate.json');
  const aggregate = {
    schemaVersion: 'forgeax-auto-exposure-three-ac27-aggregate/1',
    featureId: FEATURE_ID,
    testedRevision,
    referencePackage: 'three',
    referenceVersion: '0.184.0',
    referenceCommit: reference.provenance.three.commit,
    referenceIntegrity: reference.provenance.three.integrity,
    overallParityClaim: false,
    roiEpsilon,
    notApplicable,
    rawArtifacts: raws.map((raw) => raw.artifact),
    lanes: reports.map((report) => ({
      referenceLane: report.referenceLane,
      resolution: report.resolution,
      roiEpsilon: report.readback.roiEpsilon,
      rawDelta: report.readback.rawDelta,
      runner: report.runner,
    })),
    reports,
  };
  writeJson(aggregatePath, aggregate);
  return {
    status: 'pass',
    ciState: 'success',
    identity: gateIdentity(identity, 'three-r184', {
      kind: 'ac27-cross-backend',
      id: 'browser+dawn',
    }),
    artifact: artifact(aggregatePath, testedRevision, 'auto-exposure-three-r184-ac27'),
    rawArtifacts: aggregate.rawArtifacts,
    referencePackage: aggregate.referencePackage,
    referenceVersion: aggregate.referenceVersion,
    referenceCommit: aggregate.referenceCommit,
    referenceIntegrity: aggregate.referenceIntegrity,
    overallParityClaim: false,
    roiEpsilon,
    notApplicable: aggregate.notApplicable,
  };
}

function buildRosterGate({ rosterPath, testedRevision, identity, allowBlocked }) {
  const roster = readJson(rosterPath);
  if (
    roster?.kind !== 'dawn-smoke-aggregate' ||
    roster.head !== testedRevision ||
    roster.expectedProductSha !== testedRevision
  ) {
    throw new Error('canonical Dawn roster aggregate is not bound to the exact feature revision');
  }
  if (roster.status !== 'pass' && !(allowBlocked && roster.status === 'blocked'))
    throw new Error(`canonical Dawn roster is not pass: ${roster.status}`);
  const reportDirectory = dirname(resolve(rosterPath));
  const rosterDefinitionPath = resolve(process.cwd(), 'scripts/ci/dawn-smoke-roster.json');
  const currentRoster = readRoster(rosterDefinitionPath);
  const currentRosterDigest = digest(readText(rosterDefinitionPath));
  if (roster.rosterDigest !== currentRosterDigest)
    throw new Error('canonical Dawn roster definition drift');
  const resolved = resolveRunnableEntries({ repoRoot: process.cwd(), roster: currentRoster });
  const recomputed = aggregateReports({
    reports: readReports(reportDirectory),
    resolved,
    head: testedRevision,
    expectedProductSha: testedRevision,
    rosterDigest: currentRosterDigest,
    reportDirectory,
    allowBlocked: roster.status === 'blocked',
  });
  if (roster.status === 'blocked') {
    const receiptGaps = recomputed.runnableResults.filter(
      (result) =>
        result.status === 'blocked' &&
        (result.unavailableOrSkipped !== true || result.failureReason !== 'unavailable-or-skipped'),
    );
    if (receiptGaps.length > 0) {
      throw new Error(
        `canonical Dawn roster has runnable receipt gaps: ${receiptGaps.map((result) => result.gateId).join(', ')}`,
      );
    }
  }
  for (const field of [
    'schemaVersion',
    'kind',
    'status',
    'head',
    'expectedProductSha',
    'rosterDigest',
    'shardCount',
    'framesExpected',
    'declaredGateIds',
    'runnableGateIds',
    'excludedGateIds',
    'declaredEntries',
    'runnableResults',
    'exclusions',
    'assignedEntries',
  ]) {
    if (JSON.stringify(roster[field]) !== JSON.stringify(recomputed[field])) {
      throw new Error(`canonical Dawn roster aggregate drift: ${field}`);
    }
  }
  if (roster.status === 'blocked' && !allowBlocked)
    throw new Error('canonical Dawn roster blocking is not admitted for this execution');
  return {
    status: roster.status === 'blocked' ? 'blocked' : 'pass',
    ciState: roster.status === 'blocked' ? 'blocked' : 'success',
    identity: gateIdentity(identity, 'canonical-dawn-roster', {
      kind: 'dawn-roster',
      id: 'smoke-fleet',
    }),
    artifact: artifact(rosterPath, testedRevision, 'auto-exposure-canonical-dawn-roster'),
    executed: true,
    entryCount: roster.declaredEntries.length,
    rosterSha256: currentRosterDigest,
    shardCount: recomputed.shardCount,
    runnableCount: recomputed.runnableResults.length,
    ...(roster.status === 'blocked'
      ? {
          deferred: true,
          reason:
            'the canonical Dawn roster contains capability-excluded lanes; software correctness remains admitted without claiming physical GPU coverage',
        }
      : {}),
  };
}

function buildProbeGate({ probePath, testedRevision, identity }) {
  const probe = readJson(probePath);
  const fingerprint = probe?.inputFingerprint;
  if (
    probe?.schemaVersion !== 1 ||
    probe.producer !== 'shared-evidence-probe' ||
    probe.testedRevision !== testedRevision ||
    !HASH.test(fingerprint)
  ) {
    throw new Error('shared evidence probe schema, producer, or fingerprint drift');
  }
  if (fingerprint !== currentSharedInputFingerprint())
    throw new Error('shared evidence probe input does not match this checkout');
  const baseline = probe.baseline;
  if (
    baseline?.cacheState !== 'baseline' ||
    baseline.probePhase !== 'baseline' ||
    baseline.runCount !== 3 ||
    baseline.inputFingerprint !== fingerprint
  ) {
    throw new Error('shared evidence probe baseline is incomplete');
  }
  for (const field of ['sourceScanCount', 'payloadEmitCount', 'engineCompileCount']) {
    requireSafeInteger(baseline[field], `shared evidence baseline ${field}`, { minimum: 1 });
  }
  if (!Number.isFinite(baseline.buildDurationSeconds) || baseline.buildDurationSeconds < 0) {
    throw new Error('shared evidence baseline duration is invalid');
  }
  if (!Array.isArray(probe.samples) || probe.samples.length !== 2)
    throw new Error('shared evidence samples are incomplete');
  const expectedSamples = new Map([
    ['cold', 'catalog-only-after-baseline'],
    ['warm', 'ordered-repeat; cache hit is not inferred'],
  ]);
  for (const sample of probe.samples) {
    if (
      sample?.schemaVersion !== 1 ||
      sample.producer !== 'shared-app-inputs' ||
      sample.payloadMode !== 'catalog-only' ||
      sample.inputFingerprint !== fingerprint ||
      !expectedSamples.has(sample.cacheState) ||
      sample.probePhase !== expectedSamples.get(sample.cacheState)
    ) {
      throw new Error('shared evidence sample identity is incomplete');
    }
    for (const field of [
      'sourceScanCount',
      'sourceFileCount',
      'payloadEmitCount',
      'engineCompileCount',
    ]) {
      requireSafeInteger(sample[field], `shared evidence sample ${field}`);
    }
    if (!Number.isFinite(sample.buildDurationSeconds) || sample.buildDurationSeconds < 0) {
      throw new Error('shared evidence sample duration is invalid');
    }
  }
  if (expectedSamples.size !== new Set(probe.samples.map((sample) => sample.cacheState)).size) {
    throw new Error('shared evidence cold/warm sample closure is incomplete');
  }
  return {
    status: 'pass',
    ciState: 'success',
    identity: gateIdentity(identity, 'shared-input-probe', {
      kind: 'workflow-dispatch',
      id: 'shared-evidence-probe',
    }),
    artifact: artifact(probePath, testedRevision, 'auto-exposure-shared-input-probe'),
    workflowDispatch: true,
    payloadSha256: digest(readText(probePath)),
    inputFingerprint: fingerprint,
    baseline,
    samples: probe.samples,
  };
}

const testedRevision = required('head');
const outputDir = resolve(required('output-dir'));
const allowBlockedRoster = option('allow-blocked-roster', 'false') === 'true';
mkdirSync(outputDir, { recursive: true });
const identity = joinIdentity(readJson(required('browser-bundle')), testedRevision);
const reportSpecs = [
  {
    report: 'three-direct-browser',
    raw: 'three-direct-browser-raw',
    forgeaxRaw: 'forgeax-direct-browser-raw',
    lane: 'direct',
    runnerKind: 'browser-webgpu',
  },
  {
    report: 'three-direct-dawn',
    raw: 'three-direct-dawn-raw',
    forgeaxRaw: 'forgeax-direct-dawn-raw',
    lane: 'direct',
    runnerKind: 'dawn',
  },
  {
    report: 'three-clustered-browser',
    raw: 'three-clustered-browser-raw',
    forgeaxRaw: 'forgeax-clustered-browser-raw',
    lane: 'clustered',
    runnerKind: 'browser-webgpu',
  },
  {
    report: 'three-clustered-dawn',
    raw: 'three-clustered-dawn-raw',
    forgeaxRaw: 'forgeax-clustered-dawn-raw',
    lane: 'clustered',
    runnerKind: 'dawn',
  },
];
const reports = reportSpecs.map((spec) =>
  readAc27(required(spec.report), testedRevision, spec.lane),
);
const raws = reportSpecs.flatMap((spec) => [
  readRaw(required(spec.raw), {
    side: 'three',
    lane: spec.lane,
    runnerKind: spec.runnerKind,
    testedRevision,
  }),
  readRaw(required(spec.forgeaxRaw), {
    side: 'forgeax',
    lane: spec.lane,
    runnerKind: spec.runnerKind,
    testedRevision,
  }),
]);
for (let index = 0; index < reportSpecs.length; index += 1) {
  assertJoinMatchesRaw(reports[index], raws[index * 2], raws[index * 2 + 1], outputDir, index);
}
const three = buildThreeGate({ outputDir, testedRevision, identity, reports, raws });
const roster = buildRosterGate({
  rosterPath: required('roster'),
  testedRevision,
  identity,
  allowBlocked: allowBlockedRoster,
});
const probe = buildProbeGate({ probePath: required('probe'), testedRevision, identity });
writeJson(resolve(outputDir, 'three-ac27-gate.json'), three);
writeJson(resolve(outputDir, 'canonical-roster-gate.json'), roster);
writeJson(resolve(outputDir, 'shared-probe-gate.json'), probe);
process.stdout.write(`${JSON.stringify({ status: 'pass', testedRevision, outputDir }, null, 2)}\n`);
