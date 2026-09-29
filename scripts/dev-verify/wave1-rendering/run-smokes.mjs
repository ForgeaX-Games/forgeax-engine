#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENTRY_TIMEOUT_MS,
  hasUnavailableOrSkipped,
  parseObservedFrameReceipt,
  readRoster,
  resolveRunnableEntries,
  runAggregate,
  runShard,
  SHARD_COUNT,
  SMOKE_MIN_FRAMES,
} from '../../ci/run-dawn-smoke-roster.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const defaultRosterPath = resolve(root, 'scripts/ci/dawn-smoke-roster.json');
const defaultOutputDirectory = resolve(root, 'artifacts/wave1-rendering/dawn-smokes');

function readHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

/** Classify an independent smoke using its canonical producer receipt. */
export function classifyIndependentSmokeResult(result, receipt) {
  const output = String(result.output ?? '');
  const unavailable = /\bunavailable\b/i.test(output);
  const skipped = /\bskip(?:ped)?\b/i.test(output);
  // Optional capability diagnostics may say "unavailable" after a complete
  // frame run. A valid canonical receipt is authoritative, matching the CI
  // roster runner's policy.
  const unavailableOrSkipped = hasUnavailableOrSkipped(output, {
    hasReceipt: receipt !== null,
  });
  const status =
    result.exitCode === 0 &&
    result.signal === null &&
    !result.timedOut &&
    !unavailableOrSkipped &&
    receipt?.framesObserved >= SMOKE_MIN_FRAMES
      ? 'pass'
      : 'fail';
  return { unavailable, skipped, unavailableOrSkipped, status };
}

function rosterDigest(rosterPath) {
  return createHash('sha256').update(readFileSync(rosterPath)).digest('hex');
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function gateMetadata(roster) {
  const metadata = new Map();
  for (const entry of roster.entries) {
    for (const gate of entry.gates) {
      if (metadata.has(gate.gateId)) throw new Error(`duplicate gate metadata: ${gate.gateId}`);
      metadata.set(gate.gateId, {
        ...gate,
        package: entry.package,
        path: entry.path,
        classification: entry.classification,
      });
    }
  }
  return metadata;
}

function describeEntry(entry, metadata) {
  const gate = metadata.get(entry.gateId);
  if (!gate) throw new Error(`resolved gate metadata missing: ${entry.gateId}`);
  return {
    package: entry.package,
    path: entry.path,
    classification: entry.classification,
    gateId: entry.gateId,
    commandId: entry.commandId,
    executionClass: entry.executionClass,
    commandSource: gate.commandSource,
    script: gate.script ?? null,
    command: entry.command,
    oracle: gate.oracle,
    artifactRequirements: gate.artifactRequirements ?? null,
  };
}

function buildPlan({ roster, resolved, rosterPath }) {
  const metadata = gateMetadata(roster);
  const shardedEntries = resolved.runnable;
  const independentEntries = resolved.independent;
  const sharded = shardedEntries.map((entry) => describeEntry(entry, metadata));
  const independent = independentEntries.map((entry) => describeEntry(entry, metadata));
  const shardedFrameReceiptEntries = shardedEntries.filter(
    (entry) => metadata.get(entry.gateId).oracle.kind === 'frameReceipt',
  );
  const independentFrameReceiptEntries = independentEntries.filter(
    (entry) => metadata.get(entry.gateId).oracle.kind === 'frameReceipt',
  );
  const independentNonFrameReceipt = independent.filter(
    (entry) => entry.oracle.kind !== 'frameReceipt',
  );
  if (shardedFrameReceiptEntries.length !== shardedEntries.length) {
    throw new Error(
      `sharded roster contains non-frameReceipt gates: ${sharded
        .filter((entry) => entry.oracle.kind !== 'frameReceipt')
        .map((entry) => entry.gateId)
        .join(', ')}`,
    );
  }
  const excluded = resolved.exclusions.map((entry) => ({
    ...entry,
    gates: entry.gates.map((gate) => ({
      gateId: gate.gateId,
      commandId: gate.commandId,
      executionClass: gate.executionClass,
      commandSource: gate.commandSource,
      script: gate.script ?? null,
      oracle: gate.oracle,
      artifactRequirements: gate.artifactRequirements ?? null,
      reason: entry.reason,
    })),
  }));
  const excludedFrameReceipt = excluded.flatMap((entry) =>
    entry.gates.filter((gate) => gate.oracle.kind === 'frameReceipt'),
  );
  const plan = {
    schemaVersion: 1,
    kind: 'wave1-dawn-smoke-local-plan',
    head: readHead(),
    expectedProductSha: null,
    rosterPath: relative(root, rosterPath),
    rosterDigest: rosterDigest(rosterPath),
    framesExpected: SMOKE_MIN_FRAMES,
    shardCount: SHARD_COUNT,
    counts: {
      declaredEntries: roster.entries.length,
      declaredGates: resolved.declaredGateIds.length,
      sharded: sharded.length,
      independent: independent.length,
      independentFrameReceipt: independentFrameReceiptEntries.length,
      independentNonFrameReceipt: independentNonFrameReceipt.length,
      excludedEntries: excluded.length,
      excludedFrameReceipt: excludedFrameReceipt.length,
      runnableFrameReceipt:
        shardedFrameReceiptEntries.length + independentFrameReceiptEntries.length,
    },
    sharded,
    independentFrameReceipt: independent.filter((entry) => entry.oracle.kind === 'frameReceipt'),
    independentNonFrameReceipt,
    excluded,
  };
  return { plan, shardedEntries, independentFrameReceiptEntries };
}

function runCommand(command, env, timeoutMs) {
  return new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd: root,
      detached: true,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode, signal, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({ exitCode, signal, output, timedOut, spawnError });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // The child may have exited between the timeout and the group kill.
        }
      }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.once('error', (error) => {
      output += `\n[wave1-dawn-runner] spawn error: ${error.message}\n`;
      finish(null, null, error.message);
    });
    child.once('close', (exitCode, signal) => finish(exitCode, signal));
  });
}

function entrySlug(entry) {
  return `${entry.gateId}-${entry.commandId}`.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

async function runIndependentEntry({ entry, outputDirectory, timeoutMs }) {
  process.stdout.write(`[wave1-dawn] run independent ${entry.gateId}: ${entry.command}\n`);
  const result = await runCommand(
    entry.command,
    { ...process.env, SMOKE_MIN_FRAMES: String(SMOKE_MIN_FRAMES) },
    timeoutMs,
  );
  let receipt = null;
  let receiptFailure = null;
  try {
    receipt = parseObservedFrameReceipt(result.output, {
      gateId: entry.gateId,
      commandId: entry.commandId,
    });
  } catch (error) {
    receiptFailure = error.message;
  }
  const classification = classifyIndependentSmokeResult(result, receipt);
  const { unavailable, skipped, unavailableOrSkipped, status } = classification;
  const logPath = resolve(outputDirectory, 'logs', `independent-${entrySlug(entry)}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, result.output);
  const logBytes = Buffer.byteLength(result.output);
  const logSha256 = createHash('sha256').update(result.output).digest('hex');
  let failureReason = null;
  if (status !== 'pass') {
    if (result.timedOut) failureReason = 'timeout';
    else if (receiptFailure) failureReason = receiptFailure;
    else if (unavailableOrSkipped) failureReason = 'unavailable-or-skipped';
    else if (result.spawnError) failureReason = 'spawn-error';
    else failureReason = `exit-${result.exitCode ?? result.signal}`;
  }
  return {
    package: entry.package,
    path: entry.path,
    gateId: entry.gateId,
    commandId: entry.commandId,
    executionClass: entry.executionClass,
    commandSource: entry.commandSource,
    command: entry.command,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    unavailable,
    skipped,
    framesExpected: SMOKE_MIN_FRAMES,
    framesObserved: receipt?.framesObserved ?? null,
    status,
    result: status,
    unavailableOrSkipped,
    logPath: relative(outputDirectory, logPath),
    logSha256,
    logBytes,
    receipt,
    commandResults: [
      {
        commandId: entry.commandId,
        command: entry.command,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        status,
      },
    ],
    failureReason,
  };
}

function parseCli(argv) {
  const options = {
    mode: 'plan',
    rosterPath: defaultRosterPath,
    outputDirectory: defaultOutputDirectory,
    expectedProductSha: process.env.EXPECTED_PRODUCT_SHA,
    timeoutMs: Number(process.env.DAWN_SMOKE_ENTRY_TIMEOUT_MS ?? ENTRY_TIMEOUT_MS),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plan' || arg === '--run') options.mode = arg.slice(2);
    else if (arg === '--manifest') options.rosterPath = resolve(root, argv[++index]);
    else if (arg === '--output-dir') options.outputDirectory = resolve(root, argv[++index]);
    else if (arg === '--expected-product-sha') options.expectedProductSha = argv[++index];
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') options.mode = 'help';
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  node scripts/dev-verify/wave1-rendering/run-smokes.mjs --plan\n`);
  process.stdout.write(
    `  node scripts/dev-verify/wave1-rendering/run-smokes.mjs --run --expected-product-sha <40-hex>\n`,
  );
  process.stdout.write(`\n`);
  process.stdout.write(
    `--plan is read-only and writes the resolved roster plan; --run executes all ${SMOKE_MIN_FRAMES}-frame frameReceipt gates.\n`,
  );
  process.stdout.write(
    `The --run mode executes the official ${SHARD_COUNT} roster shards and then the independent frameReceipt gates sequentially.\n`,
  );
}

function printPlan(plan, outputPath) {
  process.stdout.write(
    `[wave1-dawn] plan sharded=${plan.counts.sharded} independent-frameReceipt=${plan.counts.independentFrameReceipt} ` +
      `independent-non-frame=${plan.counts.independentNonFrameReceipt} excluded-entries=${plan.counts.excludedEntries} ` +
      `excluded-frameReceipt=${plan.counts.excludedFrameReceipt} runnable-frameReceipt=${plan.counts.runnableFrameReceipt}\n`,
  );
  process.stdout.write(`[wave1-dawn] plan written ${relative(root, outputPath)}\n`);
}

async function execute(options, context) {
  const { plan, shardedEntries, independentFrameReceiptEntries } = context;
  const expectedProductSha = options.expectedProductSha;
  if (!/^[0-9a-f]{40}$/.test(expectedProductSha ?? ''))
    throw new Error(
      '--run requires --expected-product-sha or EXPECTED_PRODUCT_SHA with 40 lowercase hex chars',
    );
  const actualHead = readHead();
  if (actualHead !== expectedProductSha)
    throw new Error(`checked-out product head ${actualHead} does not match expectedProductSha`);
  plan.expectedProductSha = expectedProductSha;
  plan.head = actualHead;
  const planPath = resolve(options.outputDirectory, 'plan.json');
  writeJson(planPath, plan);

  const shardErrors = [];
  const shardReports = [];
  for (let shardIndex = 0; shardIndex < SHARD_COUNT; shardIndex += 1) {
    const reportPath = resolve(options.outputDirectory, `shard-${shardIndex}.json`);
    try {
      const report = await runShard({
        rosterPath: options.rosterPath,
        reportPath,
        shardIndex,
        shardCount: SHARD_COUNT,
        expectedProductSha,
        timeoutMs: options.timeoutMs,
      });
      shardReports.push({
        shardIndex,
        status: 'pass',
        reportPath: relative(root, reportPath),
        report,
      });
    } catch (error) {
      shardErrors.push({ shardIndex, message: error.message });
      shardReports.push({
        shardIndex,
        status: 'fail',
        reportPath: relative(root, reportPath),
        reportExists: existsSync(reportPath),
      });
    }
  }

  let aggregate = null;
  let aggregateError = null;
  try {
    aggregate = runAggregate({
      rosterPath: options.rosterPath,
      reportDirectory: options.outputDirectory,
      shardCount: SHARD_COUNT,
      expectedProductSha,
    });
  } catch (error) {
    aggregateError = error.message;
  }

  const independentResults = [];
  for (const entry of independentFrameReceiptEntries) {
    independentResults.push(
      await runIndependentEntry({
        entry,
        outputDirectory: options.outputDirectory,
        timeoutMs: options.timeoutMs,
      }),
    );
  }

  const summary = {
    schemaVersion: 1,
    kind: 'wave1-dawn-smoke-local',
    status:
      aggregate?.status === 'pass' &&
      shardErrors.length === 0 &&
      aggregateError === null &&
      independentResults.every((result) => result.status === 'pass')
        ? 'pass'
        : 'fail',
    head: actualHead,
    expectedProductSha,
    rosterPath: relative(root, options.rosterPath),
    rosterDigest: plan.rosterDigest,
    framesExpected: SMOKE_MIN_FRAMES,
    shardCount: SHARD_COUNT,
    coverage: {
      expectedFrameReceiptGates: plan.counts.runnableFrameReceipt,
      observedFrameReceiptGates:
        independentResults.filter((result) => result.status === 'pass').length +
        (aggregate?.runnableResults?.filter((result) => result.status === 'pass').length ?? 0),
      shardedFrameReceiptGates: shardedEntries.length,
      independentFrameReceiptGates: independentFrameReceiptEntries.length,
      independentNonFrameReceiptGates: plan.counts.independentNonFrameReceipt,
      excludedFrameReceiptGates: plan.counts.excludedFrameReceipt,
    },
    shards: shardReports.map(({ report, ...entry }) => entry),
    aggregate: {
      path: relative(root, resolve(options.outputDirectory, 'aggregate.json')),
      status: aggregate?.status ?? 'fail',
      error: aggregateError,
    },
    shardErrors,
    independentResults,
    independentNonFrameReceipt: plan.independentNonFrameReceipt,
    excluded: plan.excluded,
  };
  const summaryPath = resolve(options.outputDirectory, 'summary.json');
  writeJson(summaryPath, summary);
  process.stdout.write(
    `[wave1-dawn] ${summary.status} frameReceipt=${summary.coverage.observedFrameReceiptGates}/${summary.coverage.expectedFrameReceiptGates} ` +
      `summary=${relative(root, summaryPath)}\n`,
  );
  if (summary.status !== 'pass') throw new Error('Wave1 Dawn smoke coverage failed');
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.mode === 'help') {
    printHelp();
    return;
  }
  const roster = readRoster(options.rosterPath);
  const resolved = resolveRunnableEntries({
    repoRoot: root,
    roster,
    roots: roster.roots,
  });
  const context = buildPlan({ roster, resolved, rosterPath: options.rosterPath });
  const planPath = resolve(options.outputDirectory, 'plan.json');
  writeJson(planPath, context.plan);
  if (options.mode === 'plan') {
    printPlan(context.plan, planPath);
    return;
  }
  await execute(options, context);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`[wave1-dawn] ${error.message}`);
    process.exitCode = 1;
  }
}
