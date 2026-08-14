#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_PACKAGE = '@forgeax/app-learn-render-2-lighting-4-lighting-maps';
const VIEWER_PACKAGE = '@forgeax/engine-rhi-debug-viewer';
const APP_RELATIVE_DIR = 'apps/learn-render/2.lighting/4.lighting-maps';
const APP_DIR = resolve(REPO_ROOT, APP_RELATIVE_DIR);
const CLI_PATH = resolve(REPO_ROOT, 'packages/rhi-debug/dist/cli.mjs');
const SCHEMA_PATH = resolve(REPO_ROOT, 'packages/rhi-debug/schema/performance-result.schema.json');
const VALID_FIXTURE_PATH = resolve(
  REPO_ROOT,
  'scripts/rhi-debug-performance/fixtures/valid-result.json',
);
const MALFORMED_FIXTURE_PATH = resolve(
  REPO_ROOT,
  'scripts/rhi-debug-performance/fixtures/malformed-result.json',
);

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  strictRequired: false,
  strictTypes: false,
});
const validateSchema = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));

const STAGE_NAMES = ['off', 'idle', 'capture', 'finalize', 'analyze'];
const CHILD_NAMES = {
  idle: ['telemetryBookkeeping'],
  capture: ['snapshot', 'queueWait', 'readback'],
  finalize: ['serialization', 'persistence'],
  analyze: ['cliFirstAnswer', 'viewerFirstAnswer'],
};
const PAIRED_STAGES = ['idle', 'capture', 'finalize', 'analyze'];

function semanticError(instancePath, message) {
  return { instancePath, keyword: 'semantic', message };
}

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nearlyEqual(left, right) {
  return Math.abs(left - right) <= 1e-9;
}

function diagnosticStatus(value) {
  return (
    value?.status === 'unavailable' || value?.status === 'incomplete' || value?.status === 'failed'
  );
}

function availableChildWallTime(child) {
  return isFiniteNonNegative(child?.wallTimeMs) ? child.wallTimeMs : 0;
}

function checkChildWindows(stageName, stage, errors) {
  const expectedNames = CHILD_NAMES[stageName];
  if (stage === undefined || stage === null || typeof stage !== 'object') {
    errors.push(semanticError(`/observations/${stageName}`, 'stage value is missing'));
    return;
  }
  const children = stage.children;
  if (children === undefined || expectedNames === undefined) return;
  if (children === null || typeof children !== 'object' || Array.isArray(children)) {
    errors.push(
      semanticError(`/observations/${stageName}/children`, 'child catalog must be an object'),
    );
    return;
  }
  const names = Object.keys(children);
  if (
    names.length !== expectedNames.length ||
    expectedNames.some((name) => !names.includes(name))
  ) {
    errors.push(
      semanticError(
        `/observations/${stageName}/children`,
        'child catalog does not match the fixed contract',
      ),
    );
    return;
  }
  let childTotal = 0;
  let previousEnd = 0;
  for (const childName of expectedNames) {
    const child = children[childName];
    if (child === undefined || child === null || typeof child !== 'object') {
      errors.push(
        semanticError(`/observations/${stageName}/children/${childName}`, 'child value is missing'),
      );
      continue;
    }
    if (child.status !== 'observed') {
      if (!diagnosticStatus(child)) {
        errors.push(
          semanticError(
            `/observations/${stageName}/children/${childName}`,
            'non-observed child lacks structured diagnostics',
          ),
        );
      }
      childTotal += availableChildWallTime(child);
      continue;
    }
    if (child.window === undefined || typeof child.window !== 'object') {
      errors.push(
        semanticError(
          `/observations/${stageName}/children/${childName}/window`,
          'observed child requires a timing window',
        ),
      );
      childTotal += availableChildWallTime(child);
      continue;
    }
    const duration = child.window.endMs - child.window.startMs;
    if (!isFiniteNonNegative(duration) || !nearlyEqual(duration, child.wallTimeMs)) {
      errors.push(
        semanticError(
          `/observations/${stageName}/children/${childName}`,
          'child window duration must equal wallTimeMs',
        ),
      );
    }
    if (child.window.startMs < previousEnd) {
      errors.push(
        semanticError(
          `/observations/${stageName}/children/${childName}`,
          'sibling windows overlap',
        ),
      );
    }
    previousEnd = Math.max(previousEnd, child.window.endMs);
    childTotal += availableChildWallTime(child);
  }
  if (stage.status === 'observed') {
    if (childTotal > stage.wallTimeMs + 1e-9) {
      errors.push(
        semanticError(
          `/observations/${stageName}/children`,
          'child wall time exceeds parent wall time',
        ),
      );
    }
    if (!nearlyEqual(stage.remainderMs, stage.wallTimeMs - childTotal)) {
      errors.push(
        semanticError(
          `/observations/${stageName}/remainderMs`,
          'remainderMs is not parent minus available children',
        ),
      );
    }
  }
}

function checkStageOverhead(stageName, stage, errors) {
  const basePath = `/observations/${stageName}`;
  if (stage.control === undefined || stage.comparison === undefined) return;
  const dimensionsMatch =
    JSON.stringify(stage.comparison.enabled) === JSON.stringify(stage.comparison.control);
  if (stage.comparison.scope !== stageName) {
    errors.push(
      semanticError(`${basePath}/comparison/scope`, 'comparison scope must name its parent stage'),
    );
  }
  const controlObserved = stage.control.status === 'observed';
  if (!dimensionsMatch) {
    if (
      !diagnosticStatus(stage.absoluteOverheadMs) ||
      !diagnosticStatus(stage.relativeOverheadPercent)
    ) {
      errors.push(
        semanticError(
          `${basePath}/comparison`,
          'non-comparable overhead must retain structured unavailable values',
        ),
      );
    }
    return;
  }
  if (stage.status !== 'observed' || !controlObserved || !dimensionsMatch) {
    if (
      typeof stage.absoluteOverheadMs === 'number' ||
      typeof stage.relativeOverheadPercent === 'number'
    ) {
      errors.push(
        semanticError(
          basePath,
          'overhead must be diagnostic when a pair is unavailable or non-comparable',
        ),
      );
    }
    return;
  }
  const absolute = Math.abs(stage.wallTimeMs - stage.control.wallTimeMs);
  if (
    typeof stage.absoluteOverheadMs !== 'number' ||
    !nearlyEqual(stage.absoluteOverheadMs, absolute)
  ) {
    errors.push(
      semanticError(
        `${basePath}/absoluteOverheadMs`,
        'absolute overhead arithmetic is inconsistent',
      ),
    );
  }
  if (stage.control.wallTimeMs === 0) {
    if (!diagnosticStatus(stage.relativeOverheadPercent)) {
      errors.push(
        semanticError(
          `${basePath}/relativeOverheadPercent`,
          'zero control denominator requires unavailable relative overhead',
        ),
      );
    }
  } else {
    const relative = (absolute / stage.control.wallTimeMs) * 100;
    if (
      typeof stage.relativeOverheadPercent !== 'number' ||
      !nearlyEqual(stage.relativeOverheadPercent, relative)
    ) {
      errors.push(
        semanticError(
          `${basePath}/relativeOverheadPercent`,
          'relative overhead arithmetic is inconsistent',
        ),
      );
    }
  }
}

function checkStage(stageName, stage, errors) {
  if (stage === undefined || stage === null || typeof stage !== 'object') {
    errors.push(semanticError(`/observations/${stageName}`, 'stage value is missing'));
    return;
  }
  if (stage.status !== 'observed' && !diagnosticStatus(stage)) {
    errors.push(semanticError(`/observations/${stageName}`, 'stage has an unknown status'));
  }
  if (stage.status === 'unavailable' && stage.wallTimeMs !== undefined) {
    errors.push(
      semanticError(`/observations/${stageName}`, 'non-observed stage cannot carry a timing value'),
    );
  }
  if (
    (stage.status === 'incomplete' || stage.status === 'failed') &&
    !isFiniteNonNegative(stage.wallTimeMs)
  ) {
    errors.push(
      semanticError(
        `/observations/${stageName}/wallTimeMs`,
        'diagnostic stage must retain a finite timing value',
      ),
    );
  }
  checkChildWindows(stageName, stage, errors);
  checkStageOverhead(stageName, stage, errors);
}

function checkMemoryAndCapabilities(value, errors) {
  if (value.memory === undefined || value.memory === null) {
    errors.push(semanticError('/memory', 'memory values are missing'));
    return;
  }
  if (value.memory.tapeBytes?.status !== 'observed') {
    errors.push(
      semanticError('/memory/tapeBytes', 'retained tape bytes must be observed storage evidence'),
    );
  }
  if (value.memory.driverAllocationBytes?.status !== 'unavailable') {
    errors.push(
      semanticError(
        '/memory/driverAllocationBytes',
        'driver allocation requires a direct source and is unavailable here',
      ),
    );
  }
  for (const name of ['browserVite', 'gpuTiming']) {
    const capability = value.capabilities?.[name];
    if (capability === undefined) {
      errors.push(semanticError(`/capabilities/${name}`, 'capability value is missing'));
      continue;
    }
    if (capability.status === 'unavailable' && !capability.recoveryAction) {
      errors.push(
        semanticError(`/capabilities/${name}`, 'unavailable capability lacks recovery guidance'),
      );
    }
  }
}

function checkAdmission(value, errors) {
  const backendMatches = value.identity?.backend === value.identity?.backendEvidence?.backend;
  const evidencePasses =
    ['tapeValidity', 'replayFidelity', 'appOracle'].every(
      (name) => value.verdicts?.[name]?.status === 'pass',
    ) && backendMatches;
  const stagesObserved = STAGE_NAMES.every((stageName) => {
    const stage = value.observations?.[stageName];
    return stage?.status === 'observed';
  });
  const consumerAnswersObserved = ['cliFirstAnswer', 'viewerFirstAnswer'].every(
    (name) => value.observations?.analyze?.children?.[name]?.status === 'observed',
  );
  const admitted = value.verdicts?.baselineAdmission?.status === 'pass';
  if (admitted !== (evidencePasses && stagesObserved && consumerAnswersObserved)) {
    errors.push(
      semanticError(
        '/verdicts/baselineAdmission',
        'baseline admission must match all required evidence verdicts',
      ),
    );
  }
}

function checkCaptureAuthority(value, errors) {
  if (value.artifacts?.captureRunId !== value.identity?.captureRunId) {
    errors.push(
      semanticError(
        '/artifacts/captureRunId',
        'retained artifacts must belong to the result capture run',
      ),
    );
  }
}

export function validatePerformanceResultSemantics(value) {
  const errors = [];
  if (value?.schemaVersion !== '2.0')
    return [semanticError('/schemaVersion', 'semantic validation requires schema version 2.0')];
  if (
    value.observations === undefined ||
    value.observations === null ||
    typeof value.observations !== 'object' ||
    JSON.stringify(Object.keys(value.observations)) !== JSON.stringify(STAGE_NAMES)
  ) {
    errors.push(
      semanticError('/observations', 'result must expose the exact five top-level stages'),
    );
  }
  for (const stageName of PAIRED_STAGES) {
    checkStage(stageName, value.observations?.[stageName], errors);
  }
  checkMemoryAndCapabilities(value, errors);
  checkCaptureAuthority(value, errors);
  checkAdmission(value, errors);
  return errors;
}

export function validatePerformanceResult(value) {
  const ok = validateSchema(value);
  if (ok !== true)
    return { ok: false, errors: (validateSchema.errors ?? []).map((error) => ({ ...error })) };
  const errors = validatePerformanceResultSemantics(value);
  return { ok: errors.length === 0, errors };
}

function parseArgs(argv) {
  const options = {
    warmup: 1,
    trials: 1,
    output: resolve(process.cwd(), 'rhi-debug-performance-result.json'),
    artifactDir: resolve(process.cwd(), '.rhi-debug-performance'),
  };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--help') return { help: true, options };
    const [key, value] = arg.split('=', 2);
    if (key === '--warmup') options.warmup = parsePositiveOrZero(value, key);
    else if (key === '--trials') options.trials = parsePositive(value, key);
    else if (key === '--output') options.output = resolve(value ?? '', '');
    else if (key === '--artifact-dir') options.artifactDir = resolve(value ?? '', '');
    else throw new Error(`unknown argument '${arg}' (use --help)`);
  }
  return { help: false, options };
}

function parsePositive(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive safe integer`);
  }
  return parsed;
}

function parsePositiveOrZero(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative safe integer`);
  }
  return parsed;
}

function help() {
  return [
    'Usage: node scripts/rhi-debug-performance.mjs [options]',
    '',
    'Run the admitted Lighting Maps Dawn capture path without Browser/Vite.',
    '',
    'Options:',
    '  --warmup=N       Dawn smoke warmups to discard (default: 1).',
    '  --trials=N       retained Dawn capture trials (default: 1).',
    '  --output=PATH    result JSON path.',
    '  --artifact-dir=PATH  command logs and retained tape directory.',
  ].join('\n');
}

function commandText(command, args) {
  return [command, ...args].map((part) => JSON.stringify(part)).join(' ');
}

function runCommand(command, args, env, logPath) {
  const started = performance.now();
  const child = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const wallTimeMs = Math.max(0, Math.round(performance.now() - started));
  const stdout = child.stdout ?? '';
  const stderr = child.stderr ?? '';
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(
    logPath,
    `command: ${commandText(command, args)}\nexit: ${String(child.status ?? 1)}\n` +
      `wallTimeMs: ${String(wallTimeMs)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  );
  return { code: child.status ?? 1, stdout, stderr, wallTimeMs };
}

function gitIdentity() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const branch = execFileSync('git', ['branch', '--show-current'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  return { commit, branch: branch || '(detached)' };
}

function parseCapture(stdout) {
  const line = stdout.match(/^\[smoke\] rhiDebugCapture=(\{.*\})$/m);
  if (line?.[1] === undefined) throw new Error('Dawn smoke did not emit rhiDebugCapture JSON');
  const capture = JSON.parse(line[1]);
  for (const key of ['tapePath', 'reportPath', 'runId']) {
    if (typeof capture[key] !== 'string' || capture[key].length === 0) {
      throw new Error(`rhiDebugCapture.${key} is missing`);
    }
  }
  return capture;
}

function parseOracle(stdout) {
  const match = stdout.match(
    /^\[smoke\] oracle=(.+?) witness=(true|false) specular-map=(true|false) falsifier=(\S+)$/m,
  );
  const pass =
    stdout.includes('[smoke] PASS - 6 criteria GREEN:') &&
    match?.[2] === 'true' &&
    match?.[3] === 'true' &&
    match?.[4] === 'none';
  return {
    pass,
    detail: match === null ? 'oracle line unavailable' : match[0],
  };
}

export function isExpectedFalsifierFailure(result, controlFlags) {
  if (result.code === 0) return false;
  const match = result.stdout.match(
    /^\[smoke\] oracle=(.+?) witness=(true|false) specular-map=(true|false) falsifier=(\S+)$/m,
  );
  if (match === null) return false;
  return (
    (controlFlags.FALSIFY_NO_LIGHT === '1' && match[2] === 'false') ||
    (controlFlags.FALSIFY_NO_SPECULAR_MAP === '1' && match[3] === 'false')
  );
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(
      `${label} did not emit JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function makeCommandFailure(commandResult, consumer, reasonCode, detail) {
  return {
    status: 'failed',
    wallTimeMs: commandResult.wallTimeMs,
    source: `${consumer}-runner`,
    boundary: `${consumer} first answer`,
    reasonCode,
    affectedScope: `${consumer} first answer`,
    expectedPrecondition: detail,
    recoveryAction: `Inspect the ${consumer} command log and rerun the retained pair.`,
  };
}

function emptyResourceLifecycle() {
  const origin = () => ({
    created: 0,
    destroyed: 0,
    live: 0,
    knownCreated: 0,
    knownDestroyed: 0,
    knownLive: 0,
    unavailableCreated: 0,
    unavailableDestroyed: 0,
    unavailableLive: 0,
  });
  return {
    scope: 'captured-tape-resource-closure',
    counts: { created: 0, destroyed: 0, live: 0, destroyEvents: 0, unknownDestroyEvents: 0 },
    bytes: {
      knownCreated: 0,
      knownDestroyed: 0,
      knownLive: 0,
      unavailableCreated: 0,
      unavailableDestroyed: 0,
      unavailableLive: 0,
    },
    originBreakdown: { engine: origin(), swapchain: origin() },
    availability: {
      destroy: 'observed-buffer-texture',
      retire: 'unavailable',
      driverAllocation: 'unavailable',
    },
    resources: [],
  };
}

function makeInvalidConsumerAnswer(answer, commandResult, consumer) {
  return {
    ...answer,
    status: 'failed',
    wallTimeMs: commandResult.wallTimeMs,
    reasonCode: 'invalid-consumer-answer',
    affectedScope: `${consumer} first answer`,
    expectedPrecondition: 'The existing consumer emits a finite first-answer timing.',
    recoveryAction: 'Inspect the consumer smoke output and rerun the retained pair.',
  };
}

function parseConsumerAnswer(output, commandResult, consumer) {
  const line = output
    .split('\n')
    .find(
      (entry) => entry.includes('consumerAnswer=') && entry.includes(`"consumer":"${consumer}"`),
    );
  if (line !== undefined) {
    const encoded = line.slice(line.indexOf('consumerAnswer=') + 'consumerAnswer='.length);
    try {
      const answer = JSON.parse(encoded);
      if (answer.status === 'observed' && !isFiniteNonNegative(answer.wallTimeMs)) {
        return makeInvalidConsumerAnswer(answer, commandResult, consumer);
      }
      return { ...answer, wallTimeMs: answer.wallTimeMs ?? commandResult.wallTimeMs };
    } catch {
      // Fall through to a structured failure below. The raw line is not retained.
    }
  }
  return {
    status: 'failed',
    wallTimeMs: commandResult.wallTimeMs,
    source: `${consumer}-smoke`,
    boundary: `${consumer} first answer`,
    reasonCode: 'consumer-answer-missing',
    affectedScope: `${consumer} first answer`,
    expectedPrecondition: 'The existing consumer emits one structured answer line.',
    recoveryAction: 'Inspect the existing consumer smoke output and rerun the retained pair.',
  };
}

function runViewerSmoke(tapePath, reportPath, env, logPath) {
  const result = runCommand(
    'pnpm',
    ['--filter', VIEWER_PACKAGE, 'smoke:browser'],
    {
      ...env,
      FORGEAX_RHI_DEBUG_TAPE_PATH: tapePath,
      FORGEAX_RHI_DEBUG_REPORT_PATH: reportPath,
    },
    logPath,
  );
  return parseConsumerAnswer(`${result.stdout}\n${result.stderr}`, result, 'viewer');
}

function browserViteCapability(viewerAnswer) {
  if (viewerAnswer.status === 'observed') {
    return { status: 'available', source: 'existing viewer browser smoke' };
  }
  return makeUnavailable(
    'environment-unavailable',
    'Browser/Vite measurement',
    'A browser dev server and WebGPU adapter are available.',
    'Run the existing Browser/Vite smoke on a WebGPU-capable host.',
  );
}

function countFrameMarks(events) {
  return events.filter((event) => event?.kind === 'frameMark').length;
}

function collectTrial(trial, trialDir, env, label) {
  let capture;
  let captureError;
  try {
    capture = parseCapture(trial.stdout);
  } catch (error) {
    captureError = error instanceof Error ? error.message : String(error);
    capture = {
      tapePath: resolve(trialDir, 'missing.tape.bin'),
      reportPath: resolve(trialDir, 'missing.report.json'),
      runId: `${label}-missing`,
      captureWallMs: trial.wallTimeMs,
      finalizeWallMs: 0,
    };
  }
  const tapePath = resolve(APP_DIR, capture.tapePath);
  const reportPath = resolve(APP_DIR, capture.reportPath);
  mkdirSync(trialDir, { recursive: true });
  const retainedTapePath = resolve(trialDir, 'frame-0.tape.bin');
  const retainedReportPath = resolve(trialDir, 'frame-0.report.json');
  if (existsSync(tapePath)) copyFileSync(tapePath, retainedTapePath);
  if (existsSync(reportPath)) copyFileSync(reportPath, retainedReportPath);

  let report = { valid: false, events: [] };
  if (existsSync(retainedReportPath)) {
    try {
      report = JSON.parse(readFileSync(retainedReportPath, 'utf8'));
    } catch (error) {
      captureError ??= `${label} retained report did not emit JSON: ${String(error)}`;
    }
  }
  const events = Array.isArray(report.events) ? report.events : [];
  const tapeJsonBytes = Buffer.byteLength(JSON.stringify({ header: report.header, events }));
  const blobBytes = existsSync(retainedTapePath) ? statSync(retainedTapePath).size : 0;
  const reportJsonBytes = existsSync(retainedReportPath) ? statSync(retainedReportPath).size : 0;
  let lifecycle = { eventCount: events.length, resourceLifecycle: emptyResourceLifecycle() };
  const summary = runCommand(
    process.execPath,
    [CLI_PATH, 'summary', retainedTapePath, '--lifecycle-only'],
    env,
    resolve(trialDir, 'summary.log'),
  );
  let summaryAnswer;
  if (summary.code !== 0) {
    summaryAnswer = makeCommandFailure(
      summary,
      'CLI',
      'summary-command-failed',
      'The existing summary command exits successfully with structured lifecycle JSON.',
    );
  } else {
    try {
      const parsedLifecycle = parseJsonOutput(summary.stdout, 'summary');
      if (parsedLifecycle?.resourceLifecycle?.bytes === undefined) {
        throw new Error('summary lifecycle projection is missing resource byte facts');
      }
      lifecycle = parsedLifecycle;
      summaryAnswer = makeObservedChild(
        summary.wallTimeMs,
        'runner-cli',
        'first valid CLI answer',
        0,
      );
    } catch (error) {
      summaryAnswer = makeCommandFailure(
        summary,
        'CLI',
        'malformed-summary',
        `The existing summary command emits JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const inspect = runCommand(
    process.execPath,
    [CLI_PATH, 'inspect-offline', retainedTapePath, '0', '--fields=bindings,drawCall,rt'],
    env,
    resolve(trialDir, 'inspect-offline.log'),
  );
  let inspectReport;
  if (inspect.code === 0) {
    try {
      inspectReport = parseJsonOutput(inspect.stdout, 'inspect-offline');
    } catch (error) {
      captureError ??= `${label} offline inspect emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    captureError ??= `${label} offline inspect failed with exit ${inspect.code}`;
  }
  const summaryWallTimeMs = summary.wallTimeMs;
  const inspectWallTimeMs = inspect.wallTimeMs;
  const analyzeWallTimeMs = summaryWallTimeMs + inspectWallTimeMs;
  const oracle = parseOracle(trial.stdout);
  const backend = trial.stdout.match(/^\[learn-render-lighting-maps\] backend=(\S+)$/m)?.[1];
  captureError ??= backend === undefined ? `${label} did not emit backend identity` : undefined;
  captureError ??=
    report.valid !== true ? `${label} capture report valid flag is not true` : undefined;
  captureError ??=
    !Number.isInteger(capture.captureWallMs) || !Number.isInteger(capture.finalizeWallMs)
      ? `${label} did not emit integer public stage observations`
      : undefined;
  return {
    capture,
    backend: backend ?? 'unavailable',
    trial,
    report,
    events,
    lifecycle,
    inspectReport,
    summaryAnswer,
    captureError,
    oracle,
    trialDir,
    retainedTapePath,
    retainedReportPath,
    tapeJsonBytes,
    blobBytes,
    reportJsonBytes,
    analyzeWallTimeMs,
    summaryWallTimeMs,
    inspectWallTimeMs,
  };
}

function makeUnavailable(reasonCode, affectedScope, expectedPrecondition, recoveryAction) {
  return {
    status: 'unavailable',
    reasonCode,
    affectedScope,
    expectedPrecondition,
    recoveryAction,
  };
}

function makeObserved(wallTimeMs, source, boundary) {
  return { status: 'observed', wallTimeMs, source, boundary };
}

function makeUnavailableChild(name) {
  return makeUnavailable(
    'boundary-unavailable',
    name,
    'The public path exposes this child boundary.',
    'Use a producer path that exposes the named boundary.',
  );
}

function makeObservedChild(wallTimeMs, source, boundary, startMs) {
  return {
    status: 'observed',
    wallTimeMs,
    source,
    boundary,
    window: { startMs, endMs: startMs + wallTimeMs },
  };
}

function makeConsumerChild(answer, consumer, startMs) {
  if (answer?.status === 'observed') {
    return makeObservedChild(answer.wallTimeMs, answer.source, answer.boundary, startMs);
  }
  return {
    status: answer?.status === 'incomplete' ? 'incomplete' : 'failed',
    wallTimeMs: answer?.wallTimeMs ?? 0,
    source: answer?.source ?? `${consumer}-smoke`,
    boundary: answer?.boundary ?? `${consumer} first answer`,
    reasonCode: answer?.reasonCode ?? 'consumer-answer-failed',
    affectedScope: answer?.affectedScope ?? `${consumer} first answer`,
    expectedPrecondition:
      answer?.expectedPrecondition ?? 'The existing consumer produces a usable first answer.',
    recoveryAction:
      answer?.recoveryAction ?? 'Inspect the existing consumer output and rerun the retained pair.',
  };
}

function makePairedStage(
  stageName,
  wallTimeMs,
  source,
  boundary,
  children,
  controlWallTimeMs,
  comparison,
) {
  const childTotal = Object.values(children).reduce(
    (total, child) => total + availableChildWallTime(child),
    0,
  );
  const absoluteOverheadMs = Math.abs(wallTimeMs - controlWallTimeMs);
  const relativeOverheadPercent =
    controlWallTimeMs > 0
      ? (absoluteOverheadMs / controlWallTimeMs) * 100
      : makeUnavailable(
          'zero-denominator',
          `${stageName} overhead ratio`,
          'The telemetry-disabled control is greater than zero.',
          'Use absolute overhead for this zero-duration control.',
        );
  return {
    status: 'observed',
    wallTimeMs,
    source,
    boundary,
    children,
    remainderMs: wallTimeMs - childTotal,
    control: makeObserved(controlWallTimeMs, 'matched-control', `${stageName} disabled control`),
    comparison: { ...comparison, scope: stageName },
    absoluteOverheadMs,
    relativeOverheadPercent,
  };
}

function resultPath(outputPath, artifactPath) {
  return relative(dirname(outputPath), artifactPath);
}

function runContractFixtureCheck() {
  const valid = validatePerformanceResult(JSON.parse(readFileSync(VALID_FIXTURE_PATH, 'utf8')));
  if (!valid.ok) throw new Error(`valid fixture rejected: ${JSON.stringify(valid.errors)}`);
  const malformed = validatePerformanceResult(
    JSON.parse(readFileSync(MALFORMED_FIXTURE_PATH, 'utf8')),
  );
  if (malformed.ok) throw new Error('malformed fixture was accepted');
  return { validSample: true, malformedRejection: malformed };
}

function main() {
  const { help: showHelp, options } = parseArgs(process.argv.slice(2));
  if (showHelp) {
    console.log(help());
    return;
  }
  mkdirSync(options.artifactDir, { recursive: true });
  mkdirSync(dirname(options.output), { recursive: true });
  const fixtureCheck = runContractFixtureCheck();
  const env = { ...process.env };
  delete env.FORGEAX_ENGINE_RHI_DEBUG;

  const build = runCommand(
    'pnpm',
    ['--filter', '@forgeax/engine-rhi-debug', 'build'],
    env,
    resolve(options.artifactDir, 'rhi-debug-build.log'),
  );
  if (build.code !== 0) throw new Error('rhi-debug package build failed; see rhi-debug-build.log');

  const smokeArgs = ['--filter', APP_PACKAGE, 'smoke:rhi-debug'];
  const runSmoke = (overrides, logPath) =>
    runCommand('pnpm', smokeArgs, { ...env, ...overrides }, logPath);
  const controlFlags = {
    FALSIFY_NO_LIGHT: process.env.FALSIFY_NO_LIGHT ?? '0',
    FALSIFY_NO_SPECULAR_MAP: process.env.FALSIFY_NO_SPECULAR_MAP ?? '0',
  };
  const requireSmokePass = (result, label) => {
    if (result.code !== 0 && !isExpectedFalsifierFailure(result, controlFlags)) {
      throw new Error(`${label} failed`);
    }
  };
  rmSync(resolve(APP_DIR, '.forgeax-debug'), { recursive: true, force: true });
  for (let index = 0; index < options.warmup; index++) {
    const warmup = runSmoke(
      {
        ...controlFlags,
        FORGEAX_RHI_DEBUG_DAWN_CAPTURE: '0',
        FORGEAX_RHI_DEBUG_DAWN_IDLE: '0',
        FORGEAX_RHI_DEBUG_STAGE_TELEMETRY: '0',
      },
      resolve(options.artifactDir, `warmup-${index + 1}.log`),
    );
    requireSmokePass(warmup, `warmup ${index + 1}`);
  }

  const offControl = runSmoke(
    {
      ...controlFlags,
      FORGEAX_RHI_DEBUG_DAWN_CAPTURE: '0',
      FORGEAX_RHI_DEBUG_DAWN_IDLE: '0',
      FORGEAX_RHI_DEBUG_STAGE_TELEMETRY: '0',
    },
    resolve(options.artifactDir, 'control-off.log'),
  );
  requireSmokePass(offControl, 'off control');
  const idleControl = runSmoke(
    {
      ...controlFlags,
      FORGEAX_RHI_DEBUG_DAWN_CAPTURE: '0',
      FORGEAX_RHI_DEBUG_DAWN_IDLE: '1',
      FORGEAX_RHI_DEBUG_STAGE_TELEMETRY: '0',
    },
    resolve(options.artifactDir, 'control-idle.log'),
  );
  requireSmokePass(idleControl, 'idle control');

  let control;
  let retained;
  try {
    const controlTrial = runSmoke(
      {
        ...controlFlags,
        FORGEAX_RHI_DEBUG_DAWN_CAPTURE: '1',
        FORGEAX_RHI_DEBUG_DAWN_IDLE: '0',
        FORGEAX_RHI_DEBUG_STAGE_TELEMETRY: '0',
      },
      resolve(options.artifactDir, 'control-capture.log'),
    );
    control = collectTrial(
      controlTrial,
      resolve(options.artifactDir, 'control-capture'),
      env,
      'capture control',
    );
    control.viewerAnswer = runViewerSmoke(
      control.retainedTapePath,
      control.retainedReportPath,
      env,
      resolve(options.artifactDir, 'control-viewer.log'),
    );
    control.analyzeWallTimeMs += control.viewerAnswer.wallTimeMs;
    rmSync(resolve(APP_DIR, '.forgeax-debug'), { recursive: true, force: true });

    for (let index = 0; index < options.trials; index++) {
      const trialLog = resolve(options.artifactDir, `trial-${index + 1}.log`);
      const trial = runSmoke(
        {
          ...controlFlags,
          FORGEAX_RHI_DEBUG_DAWN_CAPTURE: '1',
          FORGEAX_RHI_DEBUG_DAWN_IDLE: '0',
          FORGEAX_RHI_DEBUG_STAGE_TELEMETRY: '1',
        },
        trialLog,
      );
      const trialRecord = collectTrial(
        trial,
        resolve(options.artifactDir, `trial-${index + 1}`),
        env,
        `trial ${index + 1}`,
      );
      trialRecord.viewerAnswer = runViewerSmoke(
        trialRecord.retainedTapePath,
        trialRecord.retainedReportPath,
        env,
        resolve(resolve(options.artifactDir, `trial-${index + 1}`), 'viewer.log'),
      );
      trialRecord.analyzeWallTimeMs += trialRecord.viewerAnswer.wallTimeMs;
      retained = trialRecord;
      if (trial.code !== 0) break;
      if (index === options.trials - 1) break;
      rmSync(resolve(APP_DIR, '.forgeax-debug'), { recursive: true, force: true });
    }
  } finally {
    rmSync(resolve(APP_DIR, '.forgeax-debug'), { recursive: true, force: true });
  }

  if (control === undefined || retained === undefined) {
    throw new Error('matched campaign did not produce a retained diagnostic trial');
  }
  const identity = gitIdentity();
  const comparisonIdentity = (trial) => ({
    workload: `${APP_PACKAGE}:lighting-maps`,
    environment: `${process.platform}/${process.arch}/${process.version}`,
    samplePolicy: `warmup=${options.warmup};trials=${options.trials}`,
    oracle:
      trial.capture.comparisonDimensions?.oracle ??
      'diffuse-specular-point-light-plus-specular-map',
    readbackPlacement:
      trial.capture.comparisonDimensions?.readbackPlacement ?? 'after-target-frame-workload',
    persistenceBaseline:
      trial.capture.comparisonDimensions?.persistenceBaseline ??
      'finalize-plus-retained-report-and-artifact-validation',
    controlFlags: {
      ...(trial.capture.comparisonDimensions?.controlFlags ?? controlFlags),
    },
  });
  const comparison = {
    enabled: comparisonIdentity(retained),
    control: comparisonIdentity(control),
  };
  const idleChildren = { telemetryBookkeeping: makeUnavailableChild('telemetryBookkeeping') };
  const captureEvidence = retained.capture.stageEvidence?.capture;
  const finalizeEvidence = retained.capture.stageEvidence?.finalize;
  const captureStageWallMs = captureEvidence?.wallTimeMs ?? retained.capture.captureWallMs;
  const finalizeStageWallMs = finalizeEvidence?.wallTimeMs ?? retained.capture.finalizeWallMs;
  const captureChildren = captureEvidence
    ? {
        snapshot: makeObservedChild(
          captureEvidence.snapshotWallMs,
          'dawn-public-boundary',
          'snapshotAllLiveResources completion',
          0,
        ),
        queueWait: makeObservedChild(
          captureEvidence.queueWaitWallMs,
          'dawn-public-boundary',
          'queue.onSubmittedWorkDone completion',
          captureEvidence.snapshotWallMs,
        ),
        readback: makeObservedChild(
          captureEvidence.readbackWallMs,
          'dawn-public-boundary',
          'retained render-target readback completion',
          captureEvidence.snapshotWallMs + captureEvidence.queueWaitWallMs,
        ),
      }
    : {
        snapshot: makeUnavailableChild('snapshot'),
        queueWait: makeUnavailableChild('queueWait'),
        readback: makeUnavailableChild('readback'),
      };
  const finalizeChildren = finalizeEvidence
    ? {
        serialization: makeObservedChild(
          finalizeEvidence.serializationWallMs,
          'dawn-public-boundary',
          'recorder finalize serialization',
          0,
        ),
        persistence: makeObservedChild(
          finalizeEvidence.persistenceWallMs,
          'dawn-public-boundary',
          'retained tape and report validation',
          finalizeEvidence.serializationWallMs,
        ),
      }
    : {
        serialization: makeUnavailableChild('serialization'),
        persistence: makeUnavailableChild('persistence'),
      };
  const analyzeChildren = {
    cliFirstAnswer: makeConsumerChild(retained.summaryAnswer, 'CLI', 0),
    viewerFirstAnswer: makeConsumerChild(
      retained.viewerAnswer,
      'viewer',
      retained.summaryWallTimeMs + retained.inspectWallTimeMs,
    ),
  };
  const observations = {
    off: makeObserved(offControl.wallTimeMs, 'runner-control', 'capture-disabled workload window'),
    idle: makePairedStage(
      'idle',
      idleControl.wallTimeMs,
      'runner-control',
      'RHI-debug enabled without a capture request',
      idleChildren,
      offControl.wallTimeMs,
      comparison,
    ),
    capture: makePairedStage(
      'capture',
      captureStageWallMs,
      'dawn-public-boundary',
      'snapshot through retained readback',
      captureChildren,
      control.capture.captureWallMs,
      comparison,
    ),
    finalize: makePairedStage(
      'finalize',
      finalizeStageWallMs,
      'dawn-public-boundary',
      'serialization through durable evidence validation',
      finalizeChildren,
      control.capture.finalizeWallMs,
      comparison,
    ),
    analyze: makePairedStage(
      'analyze',
      retained.analyzeWallTimeMs,
      'runner-cli',
      'existing CLI analysis path',
      analyzeChildren,
      control.analyzeWallTimeMs,
      comparison,
    ),
  };
  const result = {
    schemaVersion: '2.0',
    identity: {
      engine: identity,
      app: { package: APP_PACKAGE, path: APP_RELATIVE_DIR },
      backend: retained.backend,
      backendEvidence: {
        backend: retained.backend,
        source: 'Lighting Maps smoke backend identity line',
      },
      captureRunId: retained.capture.runId,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: execFileSync('uname', ['-sr'], { encoding: 'utf8' }).trim(),
      },
    },
    experiment: {
      warmupCount: options.warmup,
      trialCount: options.trials,
      retainedTrialIndex: options.trials,
    },
    observations,
    scaleInputs: {
      eventCount: retained.events.length,
      resourceCount: retained.lifecycle.resourceLifecycle.counts.created,
      frameCount: countFrameMarks(retained.events),
    },
    artifacts: {
      captureRunId: retained.capture.runId,
      paths: {
        tape: resultPath(options.output, retained.retainedTapePath),
        report: resultPath(options.output, retained.retainedReportPath),
        inspect: resultPath(
          options.output,
          retained.inspectReport?.rt ?? retained.retainedReportPath,
        ),
      },
      bytes: {
        tapeJson: retained.tapeJsonBytes,
        blob: retained.blobBytes,
        reportJson: retained.reportJsonBytes,
        total: retained.tapeJsonBytes + retained.blobBytes + retained.reportJsonBytes,
      },
    },
    memory: {
      tapeBytes: {
        status: 'observed',
        value: retained.tapeJsonBytes + retained.blobBytes + retained.reportJsonBytes,
        unit: 'bytes',
        source: 'retained-artifacts',
      },
      logicalResourceBytes: {
        ...(retained.summaryAnswer?.status === 'observed'
          ? {
              status: 'estimated',
              value: retained.lifecycle.resourceLifecycle.bytes.knownCreated,
              unit: 'bytes',
              source: 'resource-lifecycle-descriptor-estimate',
            }
          : {
              status: 'unavailable',
              reasonCode: 'descriptor-unavailable',
              affectedScope: 'logical resource bytes',
              expectedPrecondition: 'Resource descriptor byte projections are available.',
              recoveryAction: 'Use a lifecycle projection that exposes resource descriptors.',
            }),
      },
      driverAllocationBytes: {
        status: 'unavailable',
        reasonCode: 'capability-absent',
        affectedScope: 'driver allocation',
        expectedPrecondition: 'A portable driver allocation query is available.',
        recoveryAction: 'Run on a backend that exposes driver allocation telemetry.',
      },
    },
    capabilities: {
      browserVite: browserViteCapability(retained.viewerAnswer),
      gpuTiming: {
        status: 'unavailable',
        reasonCode: 'capability-absent',
        affectedScope: 'GPU timestamp timing',
        expectedPrecondition: 'The selected device exposes timestamp-query.',
        recoveryAction: 'Use a device with timestamp-query support.',
      },
    },
    verdicts: {
      tapeValidity: {
        status:
          retained.report.valid === true && retained.captureError === undefined ? 'pass' : 'fail',
        basis:
          retained.report.valid === true && retained.captureError === undefined
            ? 'report.valid=true and retained evidence was parsed'
            : (retained.captureError ?? 'retained report valid flag is not true'),
      },
      replayFidelity: {
        status: retained.inspectReport === undefined ? 'fail' : 'pass',
        basis: 'fresh Dawn offline inspect replayed the retained tape through draw 0',
      },
      appOracle: {
        status: retained.oracle.pass ? 'pass' : 'fail',
        basis: retained.oracle.detail,
      },
      baselineAdmission: {
        status:
          retained.report.valid === true &&
          retained.inspectReport !== undefined &&
          retained.oracle.pass
            ? 'pass'
            : 'fail',
        basis:
          retained.report.valid === true &&
          retained.inspectReport !== undefined &&
          retained.oracle.pass
            ? 'retained tape, replay, backend identity, and app oracle passed'
            : 'retained evidence or app oracle failed; timings are diagnostic only',
      },
    },
    contractCheck: {
      validSample: fixtureCheck.validSample,
      malformedRejection: {
        fixture: relative(REPO_ROOT, MALFORMED_FIXTURE_PATH),
        accepted: false,
        errorCount: fixtureCheck.malformedRejection.errors.length,
      },
    },
  };
  const validation = validatePerformanceResult(result);
  if (!validation.ok)
    throw new Error(`generated result rejected: ${JSON.stringify(validation.errors)}`);
  writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(
    resolve(options.artifactDir, 'malformed-rejection.json'),
    `${JSON.stringify(fixtureCheck.malformedRejection, null, 2)}\n`,
  );
  console.log(JSON.stringify({ resultPath: options.output, ...result }, null, 2));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `[rhi-debug-performance] FAIL - ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
