import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildHelloCubeFixture } from '../../../apps/rhi-debug-viewer/fixtures/build-hello-cube-tape.mjs';
import {
  getInspectOfflineHelp,
  getSummaryHelp,
  runSummary,
} from '../../../packages/rhi-debug/src/cli.ts';
import {
  assembleReport,
  computePassOffsets,
  serializeTape,
} from '../../../packages/rhi-debug/src/index.ts';
import {
  isExpectedFalsifierFailure,
  validatePerformanceResult,
} from '../../rhi-debug-performance.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '..', 'fixtures');
const runnerPath = resolve(here, '..', '..', 'rhi-debug-performance.mjs');
const dawnSmokePath = resolve(
  here,
  '..',
  '..',
  '..',
  'apps/learn-render/2.lighting/4.lighting-maps/scripts/smoke-dawn.mjs',
);
const readFixture = (name) => JSON.parse(readFileSync(resolve(fixtureDir, name), 'utf8'));

function buildProducerBackedResult({ extraResources, extraFrames }) {
  const source = buildHelloCubeFixture();
  const parsed = JSON.parse(source.json);
  const events = [
    ...parsed.events,
    ...Array.from({ length: extraResources }, (_, index) => ({
      kind: 'createBuffer',
      handleId: `scale:buffer:${index}`,
      desc: { size: (index + 1) * 64, usage: 0x20 },
    })),
    ...Array.from({ length: extraFrames }, (_, index) => ({
      kind: 'frameMark',
      frameIdx: index + 1,
    })),
  ];
  const serialized = serializeTape({
    formatVersion: parsed.header.formatVersion,
    rhiCapsRecorded: parsed.header.rhiCapsRecorded,
    events,
    blobPool: new Map(),
  });
  const report = assembleReport({
    json: serialized.json,
    passOffsets: computePassOffsets(events),
    valid: true,
  });
  const dir = mkdtempSync(join(tmpdir(), 'rhi-debug-scale-campaign-'));
  const tapePath = resolve(dir, 'frame-0.tape.bin');
  writeFileSync(tapePath, serialized.blob);
  writeFileSync(tapePath.replace(/\.tape\.bin$/, '.report.json'), JSON.stringify(report));

  const summary = runSummary({ tapePath, lifecycleOnly: true });
  expect(summary.ok).toBe(true);
  if (!summary.ok) throw new Error('producer-backed scale tape summary failed');
  const lifecycle = JSON.parse(summary.value);
  const result = readFixture('valid-result.json');
  const reportJsonBytes = Buffer.byteLength(JSON.stringify(report));
  const tapeJsonBytes = Buffer.byteLength(serialized.json);
  const blobBytes = serialized.blob.byteLength;
  const retainedBytes = tapeJsonBytes + blobBytes + reportJsonBytes;
  const captureRunId = `producer-backed-scale-${events.length}`;
  result.identity.captureRunId = captureRunId;
  result.scaleInputs = {
    eventCount: lifecycle.eventCount,
    resourceCount: lifecycle.resourceLifecycle.counts.created,
    frameCount: events.filter((event) => event.kind === 'frameMark').length,
  };
  result.artifacts.captureRunId = captureRunId;
  result.artifacts.bytes = {
    tapeJson: tapeJsonBytes,
    blob: blobBytes,
    reportJson: reportJsonBytes,
    total: retainedBytes,
  };
  result.memory.tapeBytes.value = retainedBytes;
  result.memory.logicalResourceBytes.value = lifecycle.resourceLifecycle.bytes.knownCreated;
  return { result, events, lifecycle };
}

describe('RHI-debug performance result contract', () => {
  it('makes the telemetry contract discoverable from existing entry points', () => {
    const readme = readFileSync(
      resolve(here, '..', '..', '..', 'packages/rhi-debug/README.md'),
      'utf8',
    );
    const cliHelp = [getSummaryHelp(), getInspectOfflineHelp()].join('\n');
    const entryText = `${readme}\n${cliHelp}`;

    for (const term of [
      'packages/rhi-debug/schema/performance-result.schema.json',
      'pnpm rhi-debug-performance -- --warmup=1 --trials=1',
      'forgeax-rhi-debug summary <tapePath>',
      '`off`',
      '`idle`',
      '`capture`',
      '`finalize`',
      '`analyze`',
      '`telemetryBookkeeping`',
      '`snapshot`',
      '`queueWait`',
      '`readback`',
      '`serialization`',
      '`persistence`',
      '`cliFirstAnswer`',
      '`viewerFirstAnswer`',
      '`wallTimeMs`',
      '`remainderMs`',
      '`absoluteOverheadMs`',
      '`relativeOverheadPercent`',
      '`observed`',
      '`unavailable`',
      '`incomplete`',
      '`failed`',
      '`workload`',
      '`environment`',
      '`samplePolicy`',
      '`scope`',
      '`tapeBytes`',
      '`logicalResourceBytes`',
      '`driverAllocationBytes`',
      '`estimated`',
      '`bytes`',
      '`recoveryAction`',
    ]) {
      expect(entryText).toContain(term);
    }

    expect(readme).toContain('Rerun the existing `pnpm rhi-debug-performance` command');
    expect(cliHelp).toContain('frame-0.tape.bin + frame-0.report.json');
  });

  it('accepts one conforming sample', () => {
    const result = validatePerformanceResult(readFixture('valid-result.json'));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects the retained malformed sample', () => {
    const result = validatePerformanceResult(readFixture('malformed-result.json'));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects an unknown top-level field', () => {
    const fixture = readFixture('valid-result.json');
    fixture.unownedField = true;
    const result = validatePerformanceResult(fixture);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.errors)).toContain('unownedField');
  });

  it('exposes the exact bounded stage and child catalog', () => {
    const fixture = readFixture('valid-result.json');
    expect(fixture.schemaVersion).toBe('2.0');
    expect(Object.keys(fixture.observations)).toEqual([
      'off',
      'idle',
      'capture',
      'finalize',
      'analyze',
    ]);
    expect(Object.keys(fixture.observations.idle.children)).toEqual(['telemetryBookkeeping']);
    expect(Object.keys(fixture.observations.capture.children)).toEqual([
      'snapshot',
      'queueWait',
      'readback',
    ]);
    expect(Object.keys(fixture.observations.finalize.children)).toEqual([
      'serialization',
      'persistence',
    ]);
    expect(Object.keys(fixture.observations.analyze.children)).toEqual([
      'cliFirstAnswer',
      'viewerFirstAnswer',
    ]);

    const unknownChild = readFixture('valid-result.json');
    unknownChild.observations.capture.children.perDraw = {
      status: 'observed',
      wallTimeMs: 0,
      source: 'fixture-enabled',
      boundary: 'runtime-generated child',
      window: { startMs: 0, endMs: 0 },
    };
    expect(validatePerformanceResult(unknownChild).ok).toBe(false);

    const grandchild = readFixture('valid-result.json');
    grandchild.observations.capture.children.snapshot.children = {};
    expect(validatePerformanceResult(grandchild).ok).toBe(false);
  });

  it('keeps the observation-slot count stable across higher-activity campaigns', () => {
    const baseline = buildProducerBackedResult({ extraResources: 0, extraFrames: 0 });
    const higherActivity = buildProducerBackedResult({ extraResources: 700, extraFrames: 79 });
    expect(higherActivity.events.length).toBeGreaterThan(baseline.events.length);
    expect(higherActivity.lifecycle.eventCount).toBe(higherActivity.events.length);
    expect(higherActivity.lifecycle.resourceLifecycle.counts.created).toBeGreaterThan(
      baseline.lifecycle.resourceLifecycle.counts.created,
    );
    expect(higherActivity.result.scaleInputs.frameCount).toBeGreaterThan(
      baseline.result.scaleInputs.frameCount,
    );
    expect(higherActivity.result.artifacts.bytes.total).toBeGreaterThan(
      baseline.result.artifacts.bytes.total,
    );
    expect(higherActivity.result.memory.logicalResourceBytes.value).toBeGreaterThan(
      baseline.result.memory.logicalResourceBytes.value,
    );
    expect(higherActivity.result.observations).toEqual(baseline.result.observations);

    const slotCount = Object.values(baseline.result.observations).reduce(
      (count, observation) => count + Object.keys(observation.children ?? {}).length,
      0,
    );
    const scaledSlotCount = Object.values(higherActivity.result.observations).reduce(
      (count, observation) => count + Object.keys(observation.children ?? {}).length,
      0,
    );
    expect(scaledSlotCount).toBe(slotCount);
    expect(validatePerformanceResult(baseline.result).ok).toBe(true);
    expect(validatePerformanceResult(higherActivity.result).ok).toBe(true);
  });

  it('rejects overlapping children and incorrect parent arithmetic', () => {
    const overlap = readFixture('valid-result.json');
    overlap.observations.capture.children.queueWait.window.startMs = 1;
    expect(validatePerformanceResult(overlap).ok).toBe(false);

    const overParent = readFixture('valid-result.json');
    overParent.observations.capture.children.snapshot.wallTimeMs = 8;
    expect(validatePerformanceResult(overParent).ok).toBe(false);

    const negativeRemainder = readFixture('valid-result.json');
    negativeRemainder.observations.capture.remainderMs = -1;
    expect(validatePerformanceResult(negativeRemainder).ok).toBe(false);

    const wrongRemainder = readFixture('valid-result.json');
    wrongRemainder.observations.capture.remainderMs = 5;
    expect(validatePerformanceResult(wrongRemainder).ok).toBe(false);
  });

  it('accepts a genuine observed zero and rejects non-finite timing', () => {
    const zero = readFixture('valid-result.json');
    const capture = zero.observations.capture;
    capture.wallTimeMs = 0;
    capture.remainderMs = 0;
    capture.control.wallTimeMs = 0;
    capture.absoluteOverheadMs = 0;
    capture.relativeOverheadPercent = {
      status: 'unavailable',
      reasonCode: 'zero-denominator',
      affectedScope: 'capture overhead ratio',
      expectedPrecondition: 'The telemetry-disabled control is greater than zero.',
      recoveryAction: 'Use absolute overhead for this zero-duration control.',
    };
    for (const child of Object.values(capture.children)) {
      child.wallTimeMs = 0;
      child.window = { startMs: 0, endMs: 0 };
    }
    expect(validatePerformanceResult(zero).ok).toBe(true);

    const nonFinite = readFixture('valid-result.json');
    nonFinite.observations.capture.wallTimeMs = Number.NaN;
    expect(validatePerformanceResult(nonFinite).ok).toBe(false);
  });

  it('requires structured recovery for unavailable and incomplete values', () => {
    const missingRecovery = readFixture('valid-result.json');
    missingRecovery.observations.capture.children.readback = {
      status: 'unavailable',
    };
    expect(validatePerformanceResult(missingRecovery).ok).toBe(false);

    const incomplete = readFixture('valid-result.json');
    incomplete.observations.finalize.status = 'incomplete';
    delete incomplete.observations.finalize.wallTimeMs;
    delete incomplete.observations.finalize.source;
    delete incomplete.observations.finalize.boundary;
    incomplete.observations.finalize.reasonCode = 'timeout';
    incomplete.observations.finalize.affectedScope = 'finalize persistence';
    incomplete.observations.finalize.expectedPrecondition = 'The retained report is durable.';
    incomplete.observations.finalize.recoveryAction = 'Recapture and verify the retained report.';
    expect(validatePerformanceResult(incomplete).ok).toBe(false);
  });

  it('does not admit populated timings after a failed oracle', () => {
    const failedOracle = readFixture('valid-result.json');
    failedOracle.verdicts.appOracle = {
      status: 'fail',
      basis: 'fixture falsifier failed',
    };
    expect(validatePerformanceResult(failedOracle).ok).toBe(false);

    const diagnostic = readFixture('valid-result.json');
    diagnostic.verdicts.appOracle = {
      status: 'fail',
      basis: 'fixture falsifier failed',
    };
    diagnostic.verdicts.baselineAdmission = {
      status: 'fail',
      basis: 'app oracle failed; timings are diagnostic only',
    };
    expect(validatePerformanceResult(diagnostic).ok).toBe(true);
  });

  it('retains expected falsifier smoke failures as diagnostic campaign input', () => {
    const result = {
      code: 1,
      stdout:
        '[smoke] oracle=diffuse-specular-point-light witness=false specular-map=true falsifier=no-point-light\n',
    };
    expect(
      isExpectedFalsifierFailure(result, {
        FALSIFY_NO_LIGHT: '1',
        FALSIFY_NO_SPECULAR_MAP: '0',
      }),
    ).toBe(true);
    expect(
      isExpectedFalsifierFailure(result, {
        FALSIFY_NO_LIGHT: '0',
        FALSIFY_NO_SPECULAR_MAP: '0',
      }),
    ).toBe(false);
  });

  it('rejects a non-comparable pair and estimate-as-driver allocation', () => {
    const mismatch = readFixture('valid-result.json');
    mismatch.observations.capture.comparison.control.workload = 'different-workload';
    expect(validatePerformanceResult(mismatch).ok).toBe(false);

    const driverEstimate = readFixture('valid-result.json');
    driverEstimate.memory.driverAllocationBytes = {
      status: 'estimated',
      value: 1024,
      unit: 'bytes',
      source: 'resource-descriptors',
    };
    expect(validatePerformanceResult(driverEstimate).ok).toBe(false);
  });

  it('binds retained artifacts to the capture run authority', () => {
    const mismatch = readFixture('valid-result.json');
    mismatch.artifacts.captureRunId = 'different-capture';
    const result = validatePerformanceResult(mismatch);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.errors)).toContain('captureRunId');
  });

  it('keeps contradictory backend identity diagnostic and non-admitting', () => {
    const contradictory = readFixture('valid-result.json');
    contradictory.identity.backend = 'contradictory-backend';
    expect(validatePerformanceResult(contradictory).ok).toBe(false);

    contradictory.verdicts.baselineAdmission = {
      status: 'fail',
      basis: 'identity backend disagrees with retained backend evidence',
    };
    const diagnostic = validatePerformanceResult(contradictory);
    expect(diagnostic.ok).toBe(true);
    expect(contradictory.verdicts.baselineAdmission.status).toBe('fail');
  });

  it('recomputes matched overhead for every paired stage', () => {
    const fixture = readFixture('valid-result.json');
    for (const stageName of ['idle', 'capture', 'finalize', 'analyze']) {
      const stage = fixture.observations[stageName];
      expect(stage.comparison.scope).toBe(stageName);
      expect(stage.comparison.enabled).toEqual(stage.comparison.control);
      expect(stage.absoluteOverheadMs).toBe(Math.abs(stage.wallTimeMs - stage.control.wallTimeMs));
      expect(stage.relativeOverheadPercent).toBeCloseTo(
        (stage.absoluteOverheadMs / stage.control.wallTimeMs) * 100,
        12,
      );
    }
    expect(validatePerformanceResult(fixture).ok).toBe(true);
  });

  it('uses structured unavailable relative overhead for zero and non-comparable controls', () => {
    const zeroControl = readFixture('valid-result.json');
    for (const stageName of ['idle', 'capture', 'finalize', 'analyze']) {
      const stage = zeroControl.observations[stageName];
      stage.control.wallTimeMs = 0;
      stage.absoluteOverheadMs = stage.wallTimeMs;
      stage.relativeOverheadPercent = {
        status: 'unavailable',
        reasonCode: 'zero-denominator',
        affectedScope: `${stageName} overhead ratio`,
        expectedPrecondition: 'The telemetry-disabled control is greater than zero.',
        recoveryAction: 'Use absolute overhead for this zero-duration control.',
      };
    }
    expect(validatePerformanceResult(zeroControl).ok).toBe(true);

    const nonComparable = readFixture('valid-result.json');
    const capture = nonComparable.observations.capture;
    capture.comparison.control.environment = 'different-environment';
    capture.absoluteOverheadMs = {
      status: 'unavailable',
      reasonCode: 'non-comparable-control',
      affectedScope: 'capture overhead',
      expectedPrecondition: 'Control and enabled metadata match.',
      recoveryAction: 'Repeat both controls with the same workload and environment.',
    };
    capture.relativeOverheadPercent = {
      status: 'unavailable',
      reasonCode: 'non-comparable-control',
      affectedScope: 'capture overhead ratio',
      expectedPrecondition: 'Control and enabled metadata match.',
      recoveryAction: 'Repeat both controls with the same workload and environment.',
    };
    expect(validatePerformanceResult(nonComparable).ok).toBe(true);
  });

  it('admits the Dawn campaign evidence boundary', () => {
    const fixture = readFixture('valid-result.json');
    for (const stageName of ['off', 'idle', 'capture', 'finalize', 'analyze']) {
      const stage = fixture.observations[stageName];
      expect(stage.status).toBe('observed');
      expect(Number.isFinite(stage.wallTimeMs)).toBe(true);
      expect(stage.wallTimeMs).toBeGreaterThanOrEqual(0);
    }
    expect(Object.keys(fixture.observations.capture.children)).toEqual([
      'snapshot',
      'queueWait',
      'readback',
    ]);
    expect(Object.keys(fixture.observations.finalize.children)).toEqual([
      'serialization',
      'persistence',
    ]);
    expect(fixture.memory.tapeBytes.status).toBe('observed');
    expect(fixture.memory.logicalResourceBytes.status).toBe('estimated');
    expect(fixture.memory.driverAllocationBytes.status).toBe('unavailable');
    expect(fixture.capabilities.browserVite.status).toBeDefined();
    expect(fixture.capabilities.gpuTiming.status).toBeDefined();
    for (const verdictName of ['tapeValidity', 'replayFidelity', 'appOracle']) {
      expect(fixture.verdicts[verdictName].status).toBe('pass');
    }
    expect(fixture.verdicts.baselineAdmission.status).toBe('pass');

    const smokeSource = readFileSync(dawnSmokePath, 'utf8');
    for (const literal of [
      'stageEvidence',
      'snapshotWallMs',
      'queueWaitWallMs',
      'readbackWallMs',
      'serializationWallMs',
      'persistenceWallMs',
      'rhiDebugCapture',
      'renderer.backend',
    ]) {
      expect(smokeSource).toContain(literal);
    }
    expect(validatePerformanceResult(fixture).ok).toBe(true);
  });

  it('accepts the conventional pnpm separator before options', () => {
    const help = execFileSync(process.execPath, [runnerPath, '--', '--help'], {
      encoding: 'utf8',
    });
    expect(help).toContain('Run the admitted Lighting Maps Dawn capture path');
  });

  it('keeps the CLI first structured answer separate from later validation and viewer work', () => {
    const fixture = readFixture('valid-result.json');
    const analyze = fixture.observations.analyze;
    const cli = analyze.children.cliFirstAnswer;
    const viewer = analyze.children.viewerFirstAnswer;

    expect(cli.status).toBe('observed');
    expect(cli.boundary).toContain('CLI first answer');
    expect(viewer.status).toBe('observed');
    expect(viewer.boundary).toContain('viewer model ready');
    expect(cli.source).toBeDefined();
    expect(viewer.source).toBeDefined();
    expect(cli.window.endMs).toBeLessThanOrEqual(analyze.wallTimeMs);
    expect(viewer.window.endMs).toBeLessThanOrEqual(analyze.wallTimeMs);
    expect(analyze.remainderMs).toBeGreaterThanOrEqual(0);

    const cliFailure = structuredClone(fixture);
    cliFailure.observations.analyze.children.cliFirstAnswer = {
      status: 'failed',
      wallTimeMs: 4,
      source: 'runner-cli',
      boundary: 'first valid CLI answer',
      reasonCode: 'malformed-summary',
      affectedScope: 'CLI first answer',
      expectedPrecondition: 'summary emits a valid structured JSON answer',
      recoveryAction: 'Rerun the existing summary command against the retained tape.',
    };
    cliFailure.observations.analyze.remainderMs = 2;
    expect(validatePerformanceResult(cliFailure).ok).toBe(false);
    expect(cliFailure.observations.analyze.children.viewerFirstAnswer.status).toBe('observed');
    cliFailure.verdicts.baselineAdmission = {
      status: 'fail',
      basis: 'CLI first answer failed; timings are diagnostic only',
    };
    expect(validatePerformanceResult(cliFailure).ok).toBe(true);
  });

  it('uses existing summary and inspect entry points without folding their tail into CLI timing', () => {
    const cliSource = readFileSync(
      resolve(here, '..', '..', '..', 'packages/rhi-debug/src/cli.ts'),
      'utf8',
    );
    const runnerSource = readFileSync(runnerPath, 'utf8');

    expect(cliSource).toContain('runSummary');
    expect(cliSource).toContain('runOfflineInspectAt');
    expect(runnerSource).toContain('summaryWallTimeMs');
    expect(runnerSource).toContain('inspectWallTimeMs');
    expect(runnerSource).toContain('viewerFirstAnswer');
    expect(runnerSource).toContain('first valid CLI answer');
  });

  it('requires the existing browser smokes to report viewer readiness and isolated failures', () => {
    const browserSource = readFileSync(
      resolve(here, '..', '..', '..', 'apps/rhi-debug-viewer/scripts/smoke-browser.mjs'),
      'utf8',
    );
    const noWebGpuSource = readFileSync(
      resolve(here, '..', '..', '..', 'apps/rhi-debug-viewer/scripts/smoke-browser-no-webgpu.mjs'),
      'utf8',
    );

    for (const source of [browserSource, noWebGpuSource]) {
      expect(source).toContain('consumerAnswer=');
      expect(source).toContain("consumer: 'viewer'");
      expect(source).toContain("boundary: 'existing viewer model ready'");
      expect(source).toContain('wallTimeMs');
      expect(source).toContain('recoveryAction');
    }
    expect(browserSource).toContain('vite-start-failure');
    expect(browserSource).toContain('malformed-artifact');
    expect(browserSource).toContain('replay-failure');
    expect(noWebGpuSource).toContain("reasonCode: 'no-webgpu'");
  });

  it('reports a valid structured summary as its own CLI answer and preserves CLI failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rhi-debug-cli-answer-'));
    const tapePath = resolve(dir, 'frame-0.tape.bin');
    const reportPath = resolve(dir, 'frame-0.report.json');
    const fixture = buildHelloCubeFixture();
    writeFileSync(tapePath, fixture.blob);
    writeFileSync(reportPath, JSON.stringify(fixture.report));

    const answer = runSummary({ tapePath, lifecycleOnly: true });
    expect(answer.ok).toBe(true);
    if (answer.ok) expect(JSON.parse(answer.value).eventCount).toBeGreaterThan(0);

    writeFileSync(reportPath, '{ malformed');
    const failure = runSummary({ tapePath, lifecycleOnly: true });
    expect(failure.ok).toBe(false);
    if (!failure.ok) expect(failure.error.code).toBe('tape-format-version-mismatch');
  });

  it('assembles independent CLI and viewer answers from the same retained pair', () => {
    const runnerSource = readFileSync(runnerPath, 'utf8');
    const browserSource = readFileSync(
      resolve(here, '..', '..', '..', 'apps/rhi-debug-viewer/scripts/smoke-browser.mjs'),
      'utf8',
    );

    expect(runnerSource).toContain('parseConsumerAnswer');
    expect(runnerSource).toContain('runViewerSmoke');
    expect(runnerSource).toContain('FORGEAX_RHI_DEBUG_TAPE_PATH');
    expect(runnerSource).toContain('FORGEAX_RHI_DEBUG_REPORT_PATH');
    expect(runnerSource).toContain('makeConsumerChild');
    expect(runnerSource).toContain('retained.summaryWallTimeMs');
    expect(runnerSource).toContain('retained.inspectWallTimeMs');
    expect(browserSource).toContain('INPUT_TAPE_PATH');
    expect(browserSource).toContain('INPUT_REPORT_PATH');
  });
});
