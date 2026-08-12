#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_PACKAGE = '@forgeax/app-learn-render-2-lighting-4-lighting-maps';
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

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));

export function validatePerformanceResult(value) {
  const ok = validateSchema(value);
  return {
    ok: ok === true,
    errors: ok === true ? [] : (validateSchema.errors ?? []).map((error) => ({ ...error })),
  };
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

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(
      `${label} did not emit JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function countFrameMarks(events) {
  return events.filter((event) => event?.kind === 'frameMark').length;
}

function makeUnavailable(reason) {
  return { status: 'unavailable', reason };
}

function makeObserved(wallTimeMs, source, boundary) {
  return { status: 'observed', wallTimeMs, source, boundary };
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

  rmSync(resolve(APP_DIR, '.forgeax-debug'), { recursive: true, force: true });
  const warmupLogs = [];
  for (let index = 0; index < options.warmup; index++) {
    const warmup = runCommand(
      'pnpm',
      ['--filter', APP_PACKAGE, 'smoke:rhi-debug'],
      { ...env, FORGEAX_RHI_DEBUG_DAWN_CAPTURE: '0' },
      resolve(options.artifactDir, `warmup-${index + 1}.log`),
    );
    warmupLogs.push(warmup);
    if (warmup.code !== 0) throw new Error(`warmup ${index + 1} failed`);
  }

  let retained;
  try {
    for (let index = 0; index < options.trials; index++) {
      const trialLog = resolve(options.artifactDir, `trial-${index + 1}.log`);
      const trial = runCommand(
        'pnpm',
        ['--filter', APP_PACKAGE, 'smoke:rhi-debug'],
        { ...env, FORGEAX_RHI_DEBUG_DAWN_CAPTURE: '1' },
        trialLog,
      );
      if (trial.code !== 0) throw new Error(`trial ${index + 1} failed`);
      const capture = parseCapture(trial.stdout);
      const tapePath = resolve(APP_DIR, capture.tapePath);
      const reportPath = resolve(APP_DIR, capture.reportPath);
      const trialDir = resolve(options.artifactDir, `trial-${index + 1}`);
      mkdirSync(trialDir, { recursive: true });
      const retainedTapePath = resolve(trialDir, 'frame-0.tape.bin');
      const retainedReportPath = resolve(trialDir, 'frame-0.report.json');
      copyFileSync(tapePath, retainedTapePath);
      copyFileSync(reportPath, retainedReportPath);

      const report = JSON.parse(readFileSync(retainedReportPath, 'utf8'));
      const events = Array.isArray(report.events) ? report.events : [];
      const tapeJsonBytes = Buffer.byteLength(JSON.stringify({ header: report.header, events }));
      const blobBytes = statSync(retainedTapePath).size;
      const reportJsonBytes = statSync(retainedReportPath).size;
      const summaryStart = performance.now();
      const summary = runCommand(
        process.execPath,
        [CLI_PATH, 'summary', retainedTapePath, '--lifecycle-only'],
        env,
        resolve(trialDir, 'summary.log'),
      );
      if (summary.code !== 0) throw new Error(`trial ${index + 1} summary failed`);
      const lifecycle = parseJsonOutput(summary.stdout, 'summary');
      const inspect = runCommand(
        process.execPath,
        [CLI_PATH, 'inspect-offline', retainedTapePath, '0', '--fields=bindings,drawCall,rt'],
        env,
        resolve(trialDir, 'inspect-offline.log'),
      );
      if (inspect.code !== 0) throw new Error(`trial ${index + 1} offline inspect failed`);
      const inspectReport = parseJsonOutput(inspect.stdout, 'inspect-offline');
      const analyzeWallTimeMs = Math.max(0, Math.round(performance.now() - summaryStart));
      const oracle = parseOracle(trial.stdout);
      const backend = trial.stdout.match(/^\[learn-render-lighting-maps\] backend=(\S+)$/m)?.[1];
      if (backend === undefined) throw new Error('Dawn smoke did not emit backend identity');
      if (report.valid !== true) throw new Error('capture report valid flag is not true');
      if (!Number.isInteger(capture.captureWallMs) || !Number.isInteger(capture.finalizeWallMs)) {
        throw new Error('capture did not emit integer public stage observations');
      }
      retained = {
        capture,
        backend,
        trial,
        report,
        events,
        lifecycle,
        inspectReport,
        oracle,
        trialDir,
        retainedTapePath,
        retainedReportPath,
        tapeJsonBytes,
        blobBytes,
        reportJsonBytes,
        analyzeWallTimeMs,
      };
      if (index === options.trials - 1) break;
      rmSync(resolve(APP_DIR, '.forgeax-debug'), { recursive: true, force: true });
    }
  } finally {
    rmSync(resolve(APP_DIR, '.forgeax-debug'), { recursive: true, force: true });
  }

  if (retained === undefined) throw new Error('no retained trial');
  const identity = gitIdentity();
  const result = {
    schemaVersion: '1.0',
    identity: {
      engine: identity,
      app: { package: APP_PACKAGE, path: APP_RELATIVE_DIR },
      backend: retained.backend,
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
    observations: {
      off: makeUnavailable('This Dawn route has no paired capture-disabled timing observation.'),
      idle: makeUnavailable('The public Dawn app path exposes no idle-state timing boundary.'),
      capture: makeObserved(
        retained.capture.captureWallMs,
        'app-public-boundary',
        'arm/snapshot/frame-end to recorder-idle',
      ),
      finalize: makeObserved(
        retained.capture.finalizeWallMs,
        'app-public-boundary',
        'public recorder finalize() call',
      ),
      analyze: makeObserved(
        retained.analyzeWallTimeMs,
        'runner-cli',
        'summary deserialize plus fresh-Dawn offline inspect',
      ),
    },
    scaleInputs: {
      eventCount: retained.events.length,
      resourceCount: retained.lifecycle.resourceLifecycle.counts.created,
      frameCount: countFrameMarks(retained.events),
    },
    artifacts: {
      paths: {
        tape: resultPath(options.output, retained.retainedTapePath),
        report: resultPath(options.output, retained.retainedReportPath),
        inspect: resultPath(options.output, retained.inspectReport.rt),
      },
      bytes: {
        tapeJson: retained.tapeJsonBytes,
        blob: retained.blobBytes,
        reportJson: retained.reportJsonBytes,
        total: retained.tapeJsonBytes + retained.blobBytes + retained.reportJsonBytes,
      },
    },
    verdicts: {
      tapeValidity: {
        status: 'pass',
        basis: 'report.valid=true and summary deserialized the retained tape/blob pair',
      },
      replayFidelity: {
        status: 'pass',
        basis: 'fresh Dawn offline inspect replayed the retained tape through draw 0',
      },
      appOracle: {
        status: retained.oracle.pass ? 'pass' : 'fail',
        basis: retained.oracle.detail,
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
