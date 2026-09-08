#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { coverageGroupConcurrency, runnerResources } from '../lib/runner-resources.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../..');
const defaultGroupSize = 4;
const defaultMaxWorkers = 1;
const maxGroupConcurrency = 3;
const maxChildOutputBytes = 64 * 1024 * 1024;
const coverageThresholds = [
  '--coverage.thresholds.lines=0',
  '--coverage.thresholds.functions=0',
  '--coverage.thresholds.branches=0',
  '--coverage.thresholds.statements=0',
];
const reportCounters = [
  'numTotalTestSuites',
  'numPassedTestSuites',
  'numFailedTestSuites',
  'numPendingTestSuites',
  'numTotalTests',
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTodoTests',
];

function parsePositiveInt(value, name, { max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}, got ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const valueOptions = new Set([
    '--project',
    '--group-size',
    '--group-concurrency',
    '--max-workers',
    '--coverage-dir',
    '--output-file',
  ]);
  const options = {
    coverage: true,
    coverageDir: 'coverage',
    dryRun: false,
    groupSize: defaultGroupSize,
    groupConcurrency: 1,
    maxWorkers: defaultMaxWorkers,
    outputFile: 'vitest-coverage-out.json',
    projects: [],
    vitestArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--non-coverage') {
      options.coverage = false;
      continue;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const [key, inlineValue] = argument.split('=', 2);
    const value = inlineValue ?? (valueOptions.has(key) ? argv[++index] : undefined);
    if (key === '--project') {
      if (options.coverage) {
        if (!value) throw new Error('--project requires a value');
        options.projects.push(value);
      } else {
        options.vitestArgs.push(argument);
        if (inlineValue === undefined && value !== undefined) options.vitestArgs.push(value);
      }
    } else if (key === '--group-size') {
      options.groupSize = parsePositiveInt(value, '--group-size', { max: 12 });
    } else if (key === '--group-concurrency') {
      options.groupConcurrency =
        value === 'auto'
          ? 'auto'
          : parsePositiveInt(value, '--group-concurrency', { max: maxGroupConcurrency });
    } else if (key === '--max-workers') {
      options.maxWorkers = parsePositiveInt(value, '--max-workers', { max: 6 });
    } else if (key === '--coverage-dir') {
      if (!value) throw new Error('--coverage-dir requires a value');
      options.coverageDir = value;
    } else if (key === '--output-file') {
      if (!value) throw new Error('--output-file requires a value');
      options.outputFile = value;
    } else if (options.coverage) {
      throw new Error(`unknown argument: ${argument}`);
    } else {
      options.vitestArgs.push(argument);
    }
  }
  return options;
}

function packageProjectNames() {
  return readdirSync(path.join(rootDir, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, 'packages', entry.name, 'package.json'))
    .filter((manifestPath) => existsSync(manifestPath))
    .map((manifestPath) => JSON.parse(readFileSync(manifestPath, 'utf8')).name)
    .filter((name) => typeof name === 'string' && name.startsWith('@forgeax/'))
    .sort();
}

export function allProjectNames() {
  return [...packageProjectNames(), '@forgeax/hello-triangle', 'unit'];
}

function chunk(values, size) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

function resolveCliPath() {
  const candidates = [
    path.join(rootDir, 'node_modules/vitest/vitest.mjs'),
    path.join(rootDir, 'node_modules/vitest/dist/cli.js'),
  ];
  const cliPath = candidates.find((candidate) => existsSync(candidate));
  if (!cliPath) throw new Error('cannot resolve the workspace Vitest CLI');
  return cliPath;
}

function greenReport(report) {
  return Boolean(
    report &&
      report.success === true &&
      Number(report.numFailedTests ?? 0) === 0 &&
      Number(report.numFailedTestSuites ?? 0) === 0,
  );
}

function readReport(reportPath) {
  if (!existsSync(reportPath)) return null;
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (error) {
    throw new Error(`failed to parse ${reportPath}: ${error.message}`);
  }
}

function runChild(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputError = null;
    const collect = (chunks) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxChildOutputBytes) {
        outputError ??= new Error(
          `Vitest child output exceeded ${maxChildOutputBytes} bytes; refusing to buffer unbounded concurrent logs`,
        );
        child.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => resolve({ error, status: null, signal: null, stdout, stderr }));
    child.on('close', (status, signal) =>
      resolve({ error: outputError, status, signal, stdout, stderr }),
    );
  });
}

async function runGroup({ cliPath, group, groupIndex, maxWorkers, coverage, vitestArgs }) {
  const tempDir = coverage ? mkdtempSync(path.join(os.tmpdir(), 'forgeax-vitest-coverage-')) : null;
  const coverageDir = tempDir === null ? null : path.join(tempDir, 'coverage');
  const reportPath = tempDir === null ? null : path.join(tempDir, 'vitest.json');
  const logPath = tempDir === null ? null : path.join(tempDir, 'vitest.log');
  if (coverageDir !== null) mkdirSync(coverageDir, { recursive: true });
  const args = [
    cliPath,
    'run',
    ...group.flatMap((project) => ['--project', project]),
    `--maxWorkers=${maxWorkers}`,
    ...(coverage ? [] : vitestArgs),
  ];
  if (coverage)
    args.push(
      '--typecheck',
      '--coverage',
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=${coverageDir}`,
      ...coverageThresholds,
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${reportPath}`,
    );
  const child = await runChild(args);
  const stdout = Buffer.concat(child.stdout).toString('utf8');
  const stderr = Buffer.concat(child.stderr).toString('utf8');
  const log = `${stdout}${stderr}`;
  if (logPath !== null) writeFileSync(logPath, log);
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  if (child.error) {
    throw new Error(`Vitest group ${groupIndex} could not start: ${child.error.message}`);
  }
  if (child.signal) {
    const error = new Error(`Vitest group ${groupIndex} terminated by ${child.signal}`);
    error.signal = child.signal;
    throw error;
  }
  const report = coverage && reportPath !== null ? readReport(reportPath) : null;
  const closeTimeoutOnly =
    coverage &&
    child.status !== 0 &&
    log.includes('close timed out after 500ms') &&
    greenReport(report);
  if (child.status !== 0 && !closeTimeoutOnly) {
    const error = new Error(
      `Vitest group ${groupIndex} failed with status ${child.status}; projects=${group.join(', ')}; log=${logPath ?? 'inherited output'}`,
    );
    error.status = child.status ?? 1;
    throw error;
  }

  if (!coverage) return { report: null, coveragePath: null, tempDir: null };

  if (!greenReport(report)) {
    throw new Error(
      `Vitest group ${groupIndex} reported failures; projects=${group.join(', ')}; report=${reportPath}`,
    );
  }
  const coveragePath = path.join(coverageDir, 'coverage-final.json');
  if (!existsSync(coveragePath)) {
    throw new Error(
      `Vitest group ${groupIndex} did not produce ${coveragePath}; projects=${group.join(', ')}`,
    );
  }
  return { coveragePath, report, tempDir };
}

export async function runGroups({ groups, concurrency, runGroupImpl }) {
  const results = Array(groups.length);
  let nextIndex = 0;
  let firstError = null;

  async function worker() {
    while (firstError === null) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= groups.length) return;
      try {
        results[index] = await runGroupImpl(groups[index], index);
      } catch (error) {
        firstError ??= error;
      }
    }
  }

  const workerCount = Math.min(concurrency, groups.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError !== null) throw firstError;
  return results;
}

function mergeReports(reports) {
  const aggregate = {
    numTotalTestSuites: 0,
    numPassedTestSuites: 0,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 0,
    numPassedTests: 0,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    snapshot: {},
    startTime: Number.POSITIVE_INFINITY,
    success: true,
    testResults: [],
  };
  for (const report of reports) {
    for (const counter of reportCounters) {
      aggregate[counter] += Number(report[counter] ?? 0);
    }
    if (typeof report.startTime === 'number')
      aggregate.startTime = Math.min(aggregate.startTime, report.startTime);
    aggregate.success &&= greenReport(report);
    aggregate.testResults.push(...(Array.isArray(report.testResults) ? report.testResults : []));
    for (const [key, value] of Object.entries(report.snapshot ?? {})) {
      if (typeof value === 'number')
        aggregate.snapshot[key] = (aggregate.snapshot[key] ?? 0) + value;
      else aggregate.snapshot[key] = value;
    }
  }
  if (!Number.isFinite(aggregate.startTime)) delete aggregate.startTime;
  return aggregate;
}

function coverageDependencies() {
  const rootRequire = createRequire(import.meta.url);
  const providerPath = rootRequire.resolve('@vitest/coverage-v8');
  const providerRequire = createRequire(providerPath);
  return {
    createCoverageMap: providerRequire('istanbul-lib-coverage').createCoverageMap,
    libReport: providerRequire('istanbul-lib-report'),
    reports: providerRequire('istanbul-reports'),
  };
}

function writeCoverageReport(coveragePaths, outputDir) {
  const { createCoverageMap, libReport, reports } = coverageDependencies();
  const coverageMap = createCoverageMap({});
  for (const coveragePath of coveragePaths) {
    coverageMap.merge(JSON.parse(readFileSync(coveragePath, 'utf8')));
  }

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const context = libReport.createContext({ dir: outputDir, coverageMap });
  for (const reporter of ['text', 'json', 'json-summary', 'html']) {
    reports.create(reporter, { projectRoot: rootDir }).execute(context);
  }
  const finalPath = path.join(outputDir, 'coverage-final.json');
  if (!existsSync(finalPath)) writeFileSync(finalPath, JSON.stringify(coverageMap.toJSON()));
  const summary = coverageMap.getCoverageSummary().toJSON();
  const summaryPath = path.join(outputDir, 'coverage-summary.json');
  if (!existsSync(summaryPath))
    writeFileSync(summaryPath, JSON.stringify({ total: summary }, null, 2));
  return summary;
}

function assertRootThresholds(summary) {
  const failures = [];
  for (const metric of ['lines', 'functions']) {
    const actual = Number(summary[metric]?.pct);
    if (!Number.isFinite(actual) || actual < 70) {
      failures.push(`${metric}=${summary[metric]?.pct ?? 'Unknown'}% (required >= 70%)`);
    }
  }
  if (failures.length)
    throw new Error(`aggregate coverage threshold failed: ${failures.join(', ')}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const discovered = allProjectNames();
  const projects = options.projects.length ? options.projects : discovered;
  const unknown = projects.filter((project) => !discovered.includes(project));
  if (unknown.length) throw new Error(`unknown Vitest project(s): ${unknown.join(', ')}`);
  const groups = chunk(projects, options.groupSize);
  const resources = runnerResources();
  const groupConcurrency =
    options.groupConcurrency === 'auto'
      ? coverageGroupConcurrency(resources)
      : options.groupConcurrency;
  if (groupConcurrency > 1 && options.maxWorkers > 1) {
    throw new Error(
      'concurrent groups require --max-workers=1 to preserve the isolated coverage memory bound',
    );
  }
  if (options.dryRun) {
    process.stderr.write(
      `[vitest] group concurrency=${groupConcurrency} (requested=${options.groupConcurrency}, cpus=${resources.cpus}, memoryBytes=${resources.memoryBytes})\n`,
    );
    for (const [index, group] of groups.entries()) {
      process.stdout.write(`group-${String(index + 1).padStart(2, '0')}: ${group.join(', ')}\n`);
    }
    return;
  }

  const cliPath = resolveCliPath();
  let groupResults = [];
  try {
    process.stderr.write(
      `[vitest] group concurrency=${groupConcurrency} (requested=${options.groupConcurrency}, cpus=${resources.cpus}, memoryBytes=${resources.memoryBytes})\n`,
    );
    groupResults = await runGroups({
      groups,
      concurrency: groupConcurrency,
      runGroupImpl: async (group, index) => {
        const startedAt = Date.now();
        process.stderr.write(
          `[vitest] ${options.coverage ? 'coverage' : 'bounded unit'} group ${index + 1}/${groups.length}: ${group.join(', ')}\n`,
        );
        const result = await runGroup({
          cliPath,
          group,
          groupIndex: index + 1,
          maxWorkers: options.maxWorkers,
          coverage: options.coverage,
          vitestArgs: options.vitestArgs,
        });
        process.stderr.write(
          `[vitest] group ${index + 1}/${groups.length} passed in ${((Date.now() - startedAt) / 1000).toFixed(2)}s\n`,
        );
        return result;
      },
    });

    if (!options.coverage) {
      process.stdout.write(
        `[vitest] bounded unit passed: groups=${groups.length}, projects=${projects.length}\n`,
      );
      return;
    }
    const outputFile = path.resolve(rootDir, options.outputFile);
    const coverageDir = path.resolve(rootDir, options.coverageDir);
    const aggregateReport = mergeReports(groupResults.map(({ report }) => report));
    writeFileSync(outputFile, JSON.stringify(aggregateReport, null, 2));
    const summary = writeCoverageReport(
      groupResults.map(({ coveragePath }) => coveragePath),
      coverageDir,
    );
    assertRootThresholds(summary);
    process.stdout.write(
      `[vitest] split coverage passed: groups=${groups.length}, tests=${aggregateReport.numTotalTests}, files=${aggregateReport.testResults.length}\n`,
    );
    for (const { tempDir } of groupResults) rmSync(tempDir, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`[vitest] split coverage failed: ${error.message}\n`);
    if (error.signal) process.kill(process.pid, error.signal);
    process.exitCode = error.status ?? 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`[vitest] split coverage failed: ${error.message}\n`);
    if (error.signal) process.kill(process.pid, error.signal);
    process.exitCode = 1;
  }
}
