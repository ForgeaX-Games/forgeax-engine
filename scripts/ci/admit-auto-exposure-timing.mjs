#!/usr/bin/env bun

/**
 * Admit the renderer-owned auto-exposure timing observations.
 *
 * The Browser/Dawn producer deliberately emits observation-only reports. This
 * adapter is the separate admission owner: it projects each report into the
 * renderer pass-timing contract, validates the raw timestamp windows, joins
 * both backends on one source/build/fixture/frame identity, and writes a
 * qualified timing artifact plus the gate envelope consumed by the feature
 * join. It never edits a producer report or fills a missing window.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import jiti from 'jiti';

const load = jiti(process.cwd(), { esmResolve: true });
const { GPU_PASS_TIMING_ADMISSION_SAMPLING, validateGpuPassTimingAdmission } = await load(
  resolve('packages/render/bench/gpu-pass-timing/admission.ts'),
);

export const FEATURE_ID = 'feat-20260827-auto-exposure-hdr-color-grading';
export const TIMING_REPORT_SCHEMA = 'forgeax-auto-exposure-gpu-pass-timing/1';
export const REQUIRED_PASSES = Object.freeze(['meter', 'lut']);
export const REQUIRED_LOGICAL_STAGES = Object.freeze(['clear', 'histogram', 'adapt']);
export const TIMING_LIMITS_MS = Object.freeze({ '1080p': 0.35, '4K': 0.8 });

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function writeJson(path, value) {
  const output = resolve(path);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
}

function option(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function requiredOption(name) {
  const value = option(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const RECOVERABLE_BLOCKED_REASONS = Object.freeze([
  /timing candidate is not eligible/,
  /is not a physical GPU/,
  /has no timestamp queries/,
  /timestamp period is invalid/,
  /ineligible software\/paravirtual adapter/,
  /P95 exceeds/,
  /joined .* P95 exceeds/,
]);

export function isRecoverableBlockedReason(reason) {
  return RECOVERABLE_BLOCKED_REASONS.some((pattern) => pattern.test(String(reason)));
}

function deepEqual(left, right, label) {
  assert(JSON.stringify(left) === JSON.stringify(right), `${label} identity drift`);
}

function currentHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function assertExactSampling(report, backendName) {
  deepEqual(report.sampling, GPU_PASS_TIMING_ADMISSION_SAMPLING, `${backendName} sampling`);
}

function assertBackendRunnerIdentity(report, backendName) {
  const runner = report.runner;
  assert(
    typeof runner?.version === 'string' && runner.version.trim().length > 0,
    `${backendName} runner version is missing`,
  );
  assert(
    typeof runner?.os === 'string' && runner.os.trim().length > 0,
    `${backendName} capture OS provenance is missing`,
  );
  if (backendName === 'browser') {
    assert(runner.kind === 'playwright', 'browser runner must be Playwright');
    assert(report.backend.browser === 'chrome', 'browser backend identity must be Chrome');
  } else {
    assert(runner.kind === 'dawn', 'dawn runner must be Dawn');
    assert(report.backend.browser === 'dawn-node', 'dawn backend identity must be Dawn Node');
    assert(report.backend.driver === 'dawn-node', 'dawn backend driver identity must be Dawn Node');
  }
}

function candidateAdmission(report, backendName, testedRevision, rawSha256) {
  assert(report?.featureId === FEATURE_ID, `${backendName} feature identity drift`);
  assert(
    report?.schemaVersion === TIMING_REPORT_SCHEMA,
    `${backendName} timing report schema drift`,
  );
  // Bind the raw report to this exact source before inspecting any producer
  // qualification.  A stale report must fail as stale, never be reclassified
  // as a recoverable capability block from its old qualification field.
  assert(report.testedRevision === testedRevision, `${backendName} testedRevision drift`);
  assert(report.status === 'observation', `${backendName} report must remain an observation`);
  assert(
    report.qualification?.status === 'eligible-candidate',
    `${backendName} timing candidate is not eligible`,
  );
  assert(report.backend?.kind === 'webgpu', `${backendName} is not WebGPU`);
  assert(report.backend.physicalGpu === true, `${backendName} is not a physical GPU`);
  assert(report.backend.timestampQuery === true, `${backendName} has no timestamp queries`);
  assert(
    Number.isFinite(report.backend.timestampPeriodNanoseconds) &&
      report.backend.timestampPeriodNanoseconds > 0,
    `${backendName} timestamp period is invalid`,
  );
  const softwareTokens = [
    'swiftshader',
    'lavapipe',
    'llvmpipe',
    'rhi-null',
    'rhinull',
    'paravirtual',
  ];
  const backendIdentity = `${report.backend.adapter} ${report.backend.driver}`.toLowerCase();
  assert(
    !softwareTokens.some((token) => backendIdentity.includes(token)),
    `${backendName} uses an ineligible software/paravirtual adapter`,
  );
  assertExactSampling(report, backendName);
  assertBackendRunnerIdentity(report, backendName);
  deepEqual(report.timing?.passes, REQUIRED_PASSES, `${backendName} timing pass set`);
  deepEqual(
    report.timing?.logicalStages,
    REQUIRED_LOGICAL_STAGES,
    `${backendName} logical stage set`,
  );
  assert(
    report.manual?.status === 'observation' && report.manual.zeroCost === true,
    `${backendName} manual zero-cost control missing`,
  );

  const workloads = {};
  for (const kind of ['auto', 'positive-lut']) {
    const workload = report.workloads?.[kind];
    assert(
      workload?.status === 'observation',
      `${backendName} ${kind} workload is not an observation`,
    );
    assert(
      Array.isArray(workload.passes) && workload.passes.length === 1,
      `${backendName} ${kind} pass set is incomplete`,
    );
    const expectedPass = kind === 'auto' ? 'meter' : 'lut';
    assert(
      workload.passes[0]?.passName === expectedPass,
      `${backendName} ${kind} pass identity drift`,
    );
    workloads[kind] = workload;
  }

  const passes = Object.entries(workloads).map(([kind, workload]) => ({
    kind,
    pass: workload.passes[0],
  }));
  const admissionPasses = passes.map(({ pass }) => ({
    passName: pass.passName,
    passIdentity: pass.passIdentity,
    windows: pass.windows.map((window) => ({
      width: window.width,
      height: window.height,
      beginTicks: window.beginTicks,
      endTicks: window.endTicks,
      measurementSource: window.measurementSource,
      captureGeneration: window.captureGeneration,
      firstFrame: window.firstFrame,
      lastFrame: window.lastFrame,
      ...(window.timestampQuantization === undefined
        ? {}
        : { timestampQuantization: window.timestampQuantization }),
    })),
  }));
  const admissionInput = {
    schemaVersion: '1.0',
    source: {
      sourceHead: report.testedRevision,
      buildId: report.build.sha256,
    },
    runner: {
      name: `${report.runner?.kind ?? backendName}:${report.runner?.id ?? backendName}`,
      version: report.runner.version,
      os: report.runner.os,
      browser: report.runner?.channel ?? report.runner?.id ?? backendName,
    },
    backend: {
      kind: report.backend.kind,
      adapter: report.backend.adapter,
      driver: report.backend.driver,
      physicalGpu: report.backend.physicalGpu,
      timestampQuery: report.backend.timestampQuery,
      timestampPeriodNanoseconds: report.backend.timestampPeriodNanoseconds,
    },
    fixture: {
      id: report.fixture.id,
      asset: report.fixture.asset,
      camera: report.fixture.camera,
      light: report.fixture.light,
      input: report.fixture.input,
    },
    frame: {
      generation: report.frame.generation,
      firstFrame: report.frame.firstFrame,
      lastFrame: report.frame.lastFrame,
    },
    sampling: { ...report.sampling },
    passes: admissionPasses,
  };
  const result = validateGpuPassTimingAdmission(admissionInput);
  if (!result.ok)
    throw new Error(
      `${backendName} raw timing admission failed: ${result.error.code} ${result.error.path}`,
    );
  const meter = result.value.passes.find((pass) => pass.passName === 'meter');
  assert(meter !== undefined, `${backendName} meter result missing`);
  const byResolution = Object.fromEntries(
    meter.windows.map((window) => [
      `${window.width}x${window.height}`,
      {
        p95Ms: window.p95Nanoseconds / 1_000_000,
        sampleCount: window.durationsNanoseconds.length,
        windowComplete: true,
      },
    ]),
  );
  const resolutions = {
    '1080p': byResolution['1920x1080'],
    '4K': byResolution['3840x2160'],
  };
  for (const [name, limit] of Object.entries(TIMING_LIMITS_MS)) {
    const sample = resolutions[name];
    assert(
      sample !== undefined && sample.p95Ms <= limit,
      `${backendName} ${name} P95 exceeds ${limit}ms`,
    );
  }
  return {
    backend: report.backend,
    runner: report.runner,
    source: report.source,
    build: report.build,
    fixture: report.fixture,
    frame: report.frame,
    resolutions,
    raw: admissionInput,
    rawAdmission: result.value,
    ...(rawSha256 === undefined ? {} : { rawSha256 }),
  };
}

function identityFixtureIds(identity) {
  const fixture = identity?.fixtureIdentity;
  if (fixture === undefined) return undefined;
  return {
    asset: fixture.asset?.id,
    camera: fixture.camera?.id,
    light: fixture.light?.id,
    input: fixture.input?.id,
  };
}

function bindExecutionIdentity(identity, result, testedRevision) {
  if (identity === undefined) return;
  assert(identity?.testedRevision === testedRevision, 'join identity testedRevision drift');
  deepEqual(identity.source, result.source, 'join identity source');
  deepEqual(identity.build, result.build, 'join identity build');
  const fixtureIds = identityFixtureIds(identity);
  assert(fixtureIds !== undefined, 'join identity fixtureIdentity is missing');
  deepEqual(
    fixtureIds,
    {
      asset: result.fixture.asset,
      camera: result.fixture.camera,
      light: result.fixture.light,
      input: result.fixture.input,
    },
    'join identity fixture',
  );
  const frameIdentity = identity.frameIdentity;
  assert(frameIdentity !== undefined, 'join identity frameIdentity is missing');
  if (frameIdentity.generation !== undefined) {
    deepEqual(frameIdentity, result.frame, 'join identity frame');
  } else {
    assert(
      frameIdentity.contiguous === true &&
        frameIdentity.count === GPU_PASS_TIMING_ADMISSION_SAMPLING.framesPerWindow &&
        Number.isInteger(frameIdentity.first) &&
        Number.isInteger(frameIdentity.last) &&
        frameIdentity.last - frameIdentity.first + 1 === frameIdentity.count,
      'join identity frame window is not a contiguous 60-frame observation',
    );
  }
}

export function admitAutoExposureTiming({
  browser,
  dawn,
  testedRevision,
  browserRawSha,
  dawnRawSha,
  identity,
}) {
  if (browserRawSha !== undefined && dawnRawSha !== undefined)
    assert(browserRawSha !== dawnRawSha, 'Browser and Dawn raw artifacts must be distinct files');
  const browserResult = candidateAdmission(browser, 'browser', testedRevision, browserRawSha);
  const dawnResult = candidateAdmission(dawn, 'dawn', testedRevision, dawnRawSha);
  bindExecutionIdentity(identity, browserResult, testedRevision);
  if (browserRawSha !== undefined && dawnRawSha !== undefined) {
    assert(browserResult.rawSha256 === browserRawSha, 'Browser raw digest drift');
    assert(dawnResult.rawSha256 === dawnRawSha, 'Dawn raw digest drift');
  }
  for (const field of ['source', 'build', 'fixture', 'frame']) {
    deepEqual(browserResult[field], dawnResult[field], `Browser/Dawn ${field}`);
  }
  const resolutions = Object.fromEntries(
    Object.keys(TIMING_LIMITS_MS).map((name) => [
      name,
      {
        p95Ms: Math.max(browserResult.resolutions[name].p95Ms, dawnResult.resolutions[name].p95Ms),
        sampleCount: Math.min(
          browserResult.resolutions[name].sampleCount,
          dawnResult.resolutions[name].sampleCount,
        ),
        windowComplete:
          browserResult.resolutions[name].windowComplete &&
          dawnResult.resolutions[name].windowComplete,
      },
    ]),
  );
  for (const [name, limit] of Object.entries(TIMING_LIMITS_MS))
    assert(resolutions[name].p95Ms <= limit, `joined ${name} P95 exceeds ${limit}ms`);
  const artifact = {
    schemaVersion: 'forgeax-auto-exposure-qualified-gpu-timing/1',
    featureId: FEATURE_ID,
    testedRevision,
    source: browserResult.source,
    build: browserResult.build,
    fixture: browserResult.fixture,
    frame: browserResult.frame,
    rawInputs: {
      browserSha256: browserResult.rawSha256 ?? null,
      dawnSha256: dawnResult.rawSha256 ?? null,
    },
    sourceContract: {
      source: 'renderer-gpu-pass-timing',
      passes: [...REQUIRED_PASSES],
      logicalStages: [...REQUIRED_LOGICAL_STAGES],
      physicalGpu: true,
      timestampQuery: true,
      sampling: { ...GPU_PASS_TIMING_ADMISSION_SAMPLING },
    },
    resolutions,
    backends: {
      browser: browserResult,
      dawn: dawnResult,
    },
  };
  return artifact;
}

function blockedTimingGate({
  outputPath,
  gatePath,
  testedRevision,
  identity,
  browserPath,
  dawnPath,
  browserRawSha,
  dawnRawSha,
  reason,
}) {
  const artifact = {
    schemaVersion: 'forgeax-auto-exposure-qualified-gpu-timing/1',
    featureId: FEATURE_ID,
    testedRevision,
    status: 'blocked',
    reason,
    rawInputs: {
      browserSha256: browserRawSha ?? null,
      dawnSha256: dawnRawSha ?? null,
      browserPath: resolve(browserPath),
      dawnPath: resolve(dawnPath),
    },
  };
  const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
  const artifactPath = resolve(outputPath);
  writeJson(artifactPath, artifact);
  const gate = {
    status: 'blocked',
    ciState: 'blocked',
    identity: {
      ...(identity ?? {}),
      backend: 'renderer-gpu-timing',
      runner: { kind: 'timing-admission', id: 'browser+dawn' },
    },
    artifact: {
      kind: 'auto-exposure-qualified-gpu-timing',
      path: artifactPath,
      sha256: sha256(artifactText),
      testedRevision,
    },
    reason,
  };
  writeJson(gatePath, gate);
  return gate;
}

function failedTimingGate({
  outputPath,
  gatePath,
  testedRevision,
  identity,
  browserPath,
  dawnPath,
  browserRawSha,
  dawnRawSha,
  reason,
}) {
  const artifact = {
    schemaVersion: 'forgeax-auto-exposure-qualified-gpu-timing/1',
    featureId: FEATURE_ID,
    testedRevision,
    status: 'failed',
    reason,
    rawInputs: {
      browserSha256: browserRawSha ?? null,
      dawnSha256: dawnRawSha ?? null,
      browserPath: resolve(browserPath),
      dawnPath: resolve(dawnPath),
    },
  };
  const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
  writeJson(outputPath, artifact);
  const gate = {
    status: 'failed',
    ciState: 'failure',
    identity: {
      ...(identity ?? {}),
      backend: 'renderer-gpu-timing',
      runner: { kind: 'timing-admission', id: 'browser+dawn' },
    },
    artifact: {
      kind: 'auto-exposure-qualified-gpu-timing',
      path: resolve(outputPath),
      sha256: sha256(artifactText),
      testedRevision,
    },
    reason,
  };
  writeJson(gatePath, gate);
  return gate;
}

if (import.meta.main) {
  const browserPath = requiredOption('browser');
  const dawnPath = requiredOption('dawn');
  const identityPath = requiredOption('identity');
  const outputPath = requiredOption('output');
  const gatePath = requiredOption('gate-output');
  const testedRevision = option('head', currentHead());
  const ciState = option('ci-state', 'blocked');
  const ciAttestationPath = option('ci-attestation');
  let browserText = '';
  let dawnText = '';
  let browserRawSha;
  let dawnRawSha;
  let identity;
  try {
    assert(/^[0-9a-f]{40}$/.test(testedRevision), 'tested HEAD must be a 40-character SHA');
    assert(['success', 'blocked'].includes(ciState), 'ci-state must be success or blocked');
    browserText = readFileSync(resolve(browserPath), 'utf8');
    dawnText = readFileSync(resolve(dawnPath), 'utf8');
    const browser = JSON.parse(browserText);
    const dawn = JSON.parse(dawnText);
    const identityEnvelope = readJson(identityPath);
    identity = identityEnvelope?.identity ?? identityEnvelope;
    assert(identity?.testedRevision === testedRevision, 'join identity testedRevision drift');
    browserRawSha = sha256(browserText);
    dawnRawSha = sha256(dawnText);
    if (ciState === 'success') {
      assert(
        typeof ciAttestationPath === 'string' && ciAttestationPath.length > 0,
        'ci-state success requires --ci-attestation',
      );
      const attestation = readJson(ciAttestationPath);
      assert(
        attestation?.schemaVersion === 'forgeax-auto-exposure-timing-admission-ci/1',
        'invalid timing admission CI attestation schema',
      );
      assert(attestation.status === 'success', 'timing admission CI attestation is not successful');
      assert(
        attestation.testedRevision === testedRevision,
        'timing admission CI attestation HEAD drift',
      );
      assert(
        attestation.browser?.sha256 === browserRawSha,
        'timing admission CI Browser input digest drift',
      );
      assert(
        attestation.dawn?.sha256 === dawnRawSha,
        'timing admission CI Dawn input digest drift',
      );
    }
    const artifact = admitAutoExposureTiming({
      browser,
      dawn,
      identity,
      testedRevision,
      browserRawSha,
      dawnRawSha,
    });
    const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
    const artifactPath = resolve(outputPath);
    writeJson(artifactPath, artifact);
    const gate = {
      status: ciState === 'success' ? 'qualified' : 'blocked',
      ciState,
      identity: {
        ...identity,
        backend: 'renderer-gpu-timing',
        runner: { kind: 'timing-admission', id: 'browser+dawn' },
      },
      artifact: {
        kind: 'auto-exposure-qualified-gpu-timing',
        path: artifactPath,
        sha256: sha256(artifactText),
        testedRevision,
      },
      ...(ciState === 'success'
        ? {
            source: 'renderer-gpu-pass-timing',
            passes: [...REQUIRED_PASSES],
            logicalStages: [...REQUIRED_LOGICAL_STAGES],
            physicalGpu: true,
            timestampQuery: true,
            resolutions: artifact.resolutions,
          }
        : {}),
    };
    writeJson(gatePath, gate);
    process.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const blocked = ciState === 'blocked' && isRecoverableBlockedReason(reason);
    const gate = (blocked ? blockedTimingGate : failedTimingGate)({
      outputPath,
      gatePath,
      testedRevision,
      identity,
      browserPath,
      dawnPath,
      browserRawSha,
      dawnRawSha,
      reason,
    });
    process.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
    if (!blocked) process.exitCode = 1;
  }
}
