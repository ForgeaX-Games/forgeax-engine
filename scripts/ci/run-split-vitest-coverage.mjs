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

import { runGroups } from '../lib/run-bounded-groups.mjs';
import { coverageGroupConcurrency, runnerResources } from '../lib/runner-resources.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../..');
const defaultGroupSize = 4;
const defaultMaxWorkers = 1;
const maxGroupConcurrency = 3;
const maxChildOutputBytes = 64 * 1024 * 1024;
const serialCoveragePreflights = [
  {
    project: '@forgeax/engine-runtime',
    file: 'packages/runtime/src/__tests__/surface-fixture-types.unit.test.ts',
  },
];
// Keep projects whose tests launch expensive filesystem, browser, or native
// carriers out of shared coverage children. The devkit authoring suite scans
// the canonical game template and can cross the ordinary 5 s Vitest budget
// when it shares a child with three other package projects.
const isolatedChildProjects = new Set([
  '@forgeax/engine-devkit',
  '@forgeax/engine-rhi-wgpu',
  '@forgeax/engine-runtime',
]);
// Test files whose single-file cost dominates their project's coverage child.
// Each set runs in its own child and every other child of the same project
// excludes it, so the file is instrumented exactly once while the rest of the
// project no longer queues behind it. Weights are the measured child seconds
// from CI run 36110279881 (heavy runner, two concurrent children).
const isolatedCoverageFileSets = [
  {
    project: '@forgeax/engine-devkit',
    files: [
      'packages/devkit/src/__tests__/new-project-workers.e2e.test.ts',
      'packages/devkit/src/__tests__/scene-bootstrap.e2e.test.ts',
    ],
    weight: 270,
  },
  {
    project: '@forgeax/engine-vite-plugin-shader',
    files: ['packages/vite-plugin-shader/src/__tests__/vite-plugin-shader.unit.test.ts'],
    weight: 360,
  },
];
// Approximate coverage child seconds per project from CI run 36110279881,
// net of the isolated file sets above. Unlisted projects measured near the
// default. The weights drive longest-first launch order and the LPT shard
// plan; report order stays the canonical project order.
const defaultCoverageProjectWeight = 10;
const coverageProjectWeights = new Map([
  ['@forgeax/engine-runtime', 240],
  ['@forgeax/engine-devkit', 270],
  ['@forgeax/engine-render', 180],
  ['@forgeax/engine-vite-plugin-shader', 130],
  ['@forgeax/engine-vite-plugin-pack', 60],
  ['@forgeax/engine', 40],
  ['@forgeax/engine-app', 40],
  ['@forgeax/engine-assets-runtime', 25],
  ['@forgeax/engine-ecs', 40],
  ['@forgeax/engine-gltf', 25],
  ['@forgeax/engine-fbx', 20],
  ['@forgeax/engine-vfx-compiler', 25],
  ['@forgeax/engine-vfx-render', 25],
  ['@forgeax/engine-shader-compiler', 20],
  ['@forgeax/engine-shader', 15],
  ['@forgeax/engine-vfx', 15],
  ['@forgeax/engine-animation', 20],
  ['@forgeax/engine-rhi-debug', 15],
]);
// The all-project typecheck preflight holds both coverage slots of shard 0
// for about 90 s before any coverage child starts.
const typecheckShardWeight = 180;
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

export function parseArgs(argv) {
  const valueOptions = new Set([
    '--project',
    '--group-size',
    '--group-concurrency',
    '--max-workers',
    '--coverage-dir',
    '--output-file',
    '--shard-index',
    '--shard-count',
    '--shard-output-dir',
    '--merge-shards',
  ]);
  const options = {
    coverage: true,
    coverageDir: 'coverage',
    dryRun: false,
    groupSize: defaultGroupSize,
    groupConcurrency: 1,
    maxWorkers: defaultMaxWorkers,
    mergeShards: null,
    outputFile: 'vitest-coverage-out.json',
    projects: [],
    shardCount: 1,
    shardIndex: 0,
    shardOutputDir: null,
    typecheck: true,
    vitestArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--non-coverage') {
      options.coverage = false;
      continue;
    } else if (argument === '--skip-typecheck') {
      options.typecheck = false;
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
    } else if (key === '--shard-count') {
      options.shardCount = parsePositiveInt(value, '--shard-count', { max: 4 });
    } else if (key === '--shard-index') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0)
        throw new Error(`--shard-index must be a non-negative integer, got ${value}`);
      options.shardIndex = parsed;
    } else if (key === '--shard-output-dir') {
      if (!value) throw new Error('--shard-output-dir requires a value');
      options.shardOutputDir = value;
    } else if (key === '--merge-shards') {
      if (!value) throw new Error('--merge-shards requires a value');
      options.mergeShards = value;
    } else if (options.coverage) {
      throw new Error(`unknown argument: ${argument}`);
    } else {
      options.vitestArgs.push(argument);
    }
  }
  if (options.shardIndex >= options.shardCount) {
    throw new Error(
      `--shard-index must be below --shard-count ${options.shardCount}, got ${options.shardIndex}`,
    );
  }
  if (!options.coverage && (options.shardCount > 1 || options.mergeShards !== null)) {
    throw new Error('coverage shards and --merge-shards require coverage mode');
  }
  if (options.shardCount > 1 && options.shardOutputDir === null) {
    throw new Error('--shard-count above 1 requires --shard-output-dir');
  }
  if (options.mergeShards !== null && (options.shardCount > 1 || options.shardOutputDir !== null)) {
    throw new Error('--merge-shards cannot be combined with shard execution options');
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
  return [
    ...packageProjectNames(),
    '@forgeax/hello-physical-material',
    '@forgeax/hello-triangle',
    'unit',
  ];
}

function chunk(values, size) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

export function projectGroups(projects, size) {
  return chunk(projects, size).flatMap((group) => {
    const groups = [];
    let sharedProjects = [];
    for (const project of group) {
      if (isolatedChildProjects.has(project)) {
        if (sharedProjects.length) groups.push(sharedProjects);
        groups.push([project]);
        sharedProjects = [];
      } else {
        sharedProjects.push(project);
      }
    }
    if (sharedProjects.length) groups.push(sharedProjects);
    return groups;
  });
}

function projectWeight(project) {
  return coverageProjectWeights.get(project) ?? defaultCoverageProjectWeight;
}

// Coverage children are objects so a heavy test file can own its own child
// while the rest of its project keeps the ordinary project group. `label` is
// the stable identity the shard merge uses to prove every child ran once.
export function coverageGroups(projects, size, { isolateFiles = true } = {}) {
  const fileSets = isolateFiles
    ? isolatedCoverageFileSets.filter(({ project }) => projects.includes(project))
    : [];
  const excludes = fileSets.flatMap(({ files }) => files);
  return projectGroups(projects, size).flatMap((group) => [
    {
      label: group.join(','),
      projects: group,
      files: [],
      excludes,
      weight: group.reduce((total, project) => total + projectWeight(project), 0),
    },
    ...fileSets
      .filter(({ project }) => group.includes(project))
      .map(({ project, files, weight }) => ({
        label: `${project}:${files.join(',')}`,
        projects: [project],
        files,
        excludes: [],
        weight,
      })),
  ]);
}

export function coverageGroupOrder(groups) {
  return groups
    .map((_group, index) => index)
    .sort((left, right) => groups[right].weight - groups[left].weight || left - right);
}

// Longest-processing-time assignment. Shard 0 starts with the typecheck
// preflight's measured cost because only that shard runs it.
export function assignCoverageShards(groups, shardCount, { typecheck = true } = {}) {
  const totals = Array.from({ length: shardCount }, (_value, shard) =>
    shard === 0 && typecheck && shardCount > 1 ? typecheckShardWeight : 0,
  );
  const assignment = Array(groups.length).fill(0);
  for (const index of coverageGroupOrder(groups)) {
    let selected = 0;
    for (let shard = 1; shard < shardCount; shard += 1) {
      if (totals[shard] < totals[selected]) selected = shard;
    }
    assignment[index] = selected;
    totals[selected] += groups[index].weight;
  }
  return assignment;
}

// Every shard records the full expected roster it derived; the merge
// recomputes that roster independently and accepts only an exact partition.
export function validateShardManifests(manifests, expectedGroups) {
  if (manifests.length === 0) throw new Error('no coverage shard manifests found');
  const shardCount = manifests[0].shardCount;
  const failures = [];
  if (manifests.length !== shardCount) {
    failures.push(`expected ${shardCount} shard manifests, found ${manifests.length}`);
  }
  const indexes = manifests.map(({ shardIndex }) => shardIndex).sort((a, b) => a - b);
  if (indexes.some((shardIndex, position) => shardIndex !== position)) {
    failures.push(`shard indexes must be 0..${shardCount - 1} exactly once, got ${indexes}`);
  }
  for (const manifest of manifests) {
    if (manifest.shardCount !== shardCount) {
      failures.push(`shard ${manifest.shardIndex} declares shardCount=${manifest.shardCount}`);
    }
    if (JSON.stringify(manifest.expectedGroups) !== JSON.stringify(expectedGroups)) {
      failures.push(`shard ${manifest.shardIndex} planned a different coverage group roster`);
    }
  }
  const seen = new Map();
  for (const manifest of manifests) {
    for (const label of manifest.groups) seen.set(label, (seen.get(label) ?? 0) + 1);
  }
  for (const label of expectedGroups) {
    const count = seen.get(label) ?? 0;
    if (count !== 1) failures.push(`group ${label} ran ${count} times`);
  }
  for (const label of seen.keys()) {
    if (!expectedGroups.includes(label)) failures.push(`unexpected group ${label}`);
  }
  if (failures.length) throw new Error(`coverage shard merge rejected: ${failures.join('; ')}`);
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

export function buildTypecheckArgs({ cliPath, projects, maxWorkers }) {
  return [
    cliPath,
    'run',
    ...projects.flatMap((project) => ['--project', project]),
    `--maxWorkers=${maxWorkers}`,
    '--typecheck.only',
    '--reporter=default',
  ];
}

async function runTypecheck({ cliPath, projects, maxWorkers }) {
  const child = await runChild(buildTypecheckArgs({ cliPath, projects, maxWorkers }));
  const stdout = Buffer.concat(child.stdout).toString('utf8');
  const stderr = Buffer.concat(child.stderr).toString('utf8');
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (child.error)
    throw new Error(`Vitest typecheck preflight could not start: ${child.error.message}`);
  if (child.signal) {
    const error = new Error(`Vitest typecheck preflight terminated by ${child.signal}`);
    error.signal = child.signal;
    throw error;
  }
  if (child.status !== 0) {
    const error = new Error(`Vitest typecheck preflight failed with status ${child.status}`);
    error.status = child.status ?? 1;
    throw error;
  }
}

async function runSerialCoveragePreflights({ cliPath, projects }) {
  for (const preflight of serialCoveragePreflights) {
    if (!projects.includes(preflight.project)) continue;
    const child = await runChild([
      cliPath,
      'run',
      '--project',
      preflight.project,
      preflight.file,
      '--maxWorkers=1',
      '--typecheck.enabled=false',
      '--reporter=default',
    ]);
    const stdout = Buffer.concat(child.stdout).toString('utf8');
    const stderr = Buffer.concat(child.stderr).toString('utf8');
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    if (child.error) throw child.error;
    if (child.signal) throw new Error(`coverage preflight terminated by ${child.signal}`);
    if (child.status !== 0)
      throw new Error(`coverage preflight failed with status ${child.status}: ${preflight.file}`);
  }
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
    ...group.projects.flatMap((project) => ['--project', project]),
    ...group.files,
    `--maxWorkers=${maxWorkers}`,
    ...(coverage ? [] : vitestArgs),
  ];
  if (coverage)
    args.push(
      // When requested, typechecking is a single all-project preflight in
      // main(). Repeating it in every coverage child multiplied tsc startup
      // and declaration work without adding a second assertion; keep coverage
      // children responsible only for their instrumented runtime tests.
      '--typecheck.enabled=false',
      '--coverage',
      ...serialCoveragePreflights.map(({ file }) => `--exclude=${file}`),
      ...group.excludes.map((file) => `--exclude=${file}`),
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
      `Vitest group ${groupIndex} failed with status ${child.status}; group=${group.label}; log=${logPath ?? 'inherited output'}`,
    );
    error.status = child.status ?? 1;
    throw error;
  }

  if (!coverage) return { report: null, coveragePath: null, tempDir: null };

  if (!greenReport(report)) {
    throw new Error(
      `Vitest group ${groupIndex} reported failures; group=${group.label}; report=${reportPath}`,
    );
  }
  const coveragePath = path.join(coverageDir, 'coverage-final.json');
  if (!existsSync(coveragePath)) {
    throw new Error(
      `Vitest group ${groupIndex} did not produce ${coveragePath}; group=${group.label}`,
    );
  }
  return { coveragePath, report, tempDir };
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

function mergeCoverageMaps(coveragePaths, { fromRoot = rootDir } = {}) {
  const { createCoverageMap } = coverageDependencies();
  const coverageMap = createCoverageMap({});
  for (const coveragePath of coveragePaths) {
    const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
    coverageMap.merge(
      fromRoot === rootDir ? coverage : rerootCoverage(coverage, fromRoot, rootDir),
    );
  }
  return coverageMap;
}

// Shards run on runners with different checkout roots, so shard coverage is
// stored relative to the repository and re-rooted at the merge checkout;
// otherwise one source file becomes one istanbul entry per runner and the
// uncovered placeholders dilute the aggregate.
export function rerootCoverage(coverage, fromRoot, toRoot) {
  const reroot = (filePath) => {
    const relative = fromRoot ? path.relative(fromRoot, filePath) : filePath;
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`coverage path ${filePath} is outside ${fromRoot || 'the repository'}`);
    }
    const portable = relative.split(path.sep).join('/');
    return toRoot ? path.join(toRoot, portable) : portable;
  };
  return Object.fromEntries(
    Object.values(coverage).map((fileCoverage) => {
      // CoverageMap#toJSON yields FileCoverage instances; their raw data is `.data`.
      const data = fileCoverage.data ?? fileCoverage;
      const filePath = reroot(data.path);
      return [filePath, { ...data, path: filePath }];
    }),
  );
}

function writeCoverageReport(coveragePaths, outputDir, { fromRoot = rootDir } = {}) {
  const { libReport, reports } = coverageDependencies();
  const coverageMap = mergeCoverageMaps(coveragePaths, { fromRoot });

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

const shardManifestName = 'shard.json';
const shardReportName = 'vitest.json';
const shardCoverageName = 'coverage-final.json';

function writeShardOutput({ outputDir, manifest, groupResults }) {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    path.join(outputDir, shardReportName),
    JSON.stringify(mergeReports(groupResults.map(({ report }) => report)), null, 2),
  );
  writeFileSync(
    path.join(outputDir, shardCoverageName),
    JSON.stringify(
      rerootCoverage(
        mergeCoverageMaps(groupResults.map(({ coveragePath }) => coveragePath)).toJSON(),
        rootDir,
        '',
      ),
    ),
  );
  writeFileSync(path.join(outputDir, shardManifestName), JSON.stringify(manifest, null, 2));
}

function findShardDirectories(directory) {
  const found = [];
  if (existsSync(path.join(directory, shardManifestName))) found.push(directory);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...findShardDirectories(path.join(directory, entry.name)));
  }
  return found.sort();
}

function writeFinalReport({ options, reports, coveragePaths, groupCount, coverageRoot = rootDir }) {
  const outputFile = path.resolve(rootDir, options.outputFile);
  const coverageDir = path.resolve(rootDir, options.coverageDir);
  const aggregateReport = mergeReports(reports);
  writeFileSync(outputFile, JSON.stringify(aggregateReport, null, 2));
  const summary = writeCoverageReport(coveragePaths, coverageDir, { fromRoot: coverageRoot });
  assertRootThresholds(summary);
  process.stdout.write(
    `[vitest] split coverage passed: groups=${groupCount}, tests=${aggregateReport.numTotalTests}, files=${aggregateReport.testResults.length}\n`,
  );
}

function mergeShards({ options, groups }) {
  const shardDirectories = findShardDirectories(path.resolve(rootDir, options.mergeShards));
  const manifests = shardDirectories.map((directory) =>
    JSON.parse(readFileSync(path.join(directory, shardManifestName), 'utf8')),
  );
  validateShardManifests(
    manifests,
    groups.map(({ label }) => label),
  );
  const reports = shardDirectories.map((directory) =>
    readReport(path.join(directory, shardReportName)),
  );
  for (const [position, report] of reports.entries()) {
    if (!greenReport(report)) {
      throw new Error(`coverage shard ${manifests[position].shardIndex} report is not green`);
    }
  }
  writeFinalReport({
    options,
    reports,
    coveragePaths: shardDirectories.map((directory) => path.join(directory, shardCoverageName)),
    groupCount: groups.length,
    coverageRoot: '',
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const discovered = allProjectNames();
  const projects = options.projects.length ? options.projects : discovered;
  const unknown = projects.filter((project) => !discovered.includes(project));
  if (unknown.length) throw new Error(`unknown Vitest project(s): ${unknown.join(', ')}`);
  const groups = coverageGroups(projects, options.groupSize, { isolateFiles: options.coverage });
  if (options.mergeShards !== null) {
    mergeShards({ options, groups });
    return;
  }
  const shardAssignment = assignCoverageShards(groups, options.shardCount, {
    typecheck: options.typecheck,
  });
  const selectedGroups = groups.filter(
    (_group, index) => shardAssignment[index] === options.shardIndex,
  );
  const selectedProjects = [...new Set(selectedGroups.flatMap((group) => group.projects))];
  const runsTypecheck = options.coverage && options.typecheck && options.shardIndex === 0;
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
  const scheduling = options.coverage ? 'weighted-longest-first' : 'stable';
  const plan = `[vitest] group concurrency=${groupConcurrency}, scheduling=${scheduling}, shard=${options.shardIndex + 1}/${options.shardCount}, groups=${selectedGroups.length}/${groups.length} (requested=${options.groupConcurrency}, typecheck=${runsTypecheck ? 'on' : 'off'}, cpus=${resources.cpus}, memoryBytes=${resources.memoryBytes})\n`;
  if (options.dryRun) {
    process.stderr.write(plan);
    for (const [index, group] of groups.entries()) {
      if (shardAssignment[index] !== options.shardIndex) continue;
      process.stdout.write(
        `group-${String(index + 1).padStart(2, '0')}: ${group.label} (weight ${group.weight})\n`,
      );
    }
    return;
  }

  const cliPath = path.join(scriptDir, 'run-vitest-projects.mjs');
  let groupResults = [];
  try {
    process.stderr.write(plan);
    if (runsTypecheck) {
      const startedAt = Date.now();
      process.stderr.write(
        `[vitest] typecheck preflight: projects=${projects.length}, maxWorkers=${options.maxWorkers}\n`,
      );
      await runTypecheck({
        cliPath,
        projects,
        maxWorkers: options.maxWorkers,
      });
      process.stderr.write(
        `[vitest] typecheck preflight passed in ${((Date.now() - startedAt) / 1000).toFixed(2)}s\n`,
      );
    }
    if (options.coverage) {
      const startedAt = Date.now();
      await runSerialCoveragePreflights({ cliPath, projects: selectedProjects });
      process.stderr.write(
        `[vitest] serial coverage preflights passed in ${((Date.now() - startedAt) / 1000).toFixed(2)}s\n`,
      );
    }
    groupResults = await runGroups({
      groups: selectedGroups,
      concurrency: groupConcurrency,
      order: options.coverage ? coverageGroupOrder(selectedGroups) : undefined,
      runGroupImpl: async (group, index) => {
        const startedAt = Date.now();
        process.stderr.write(
          `[vitest] ${options.coverage ? 'coverage' : 'bounded unit'} group ${index + 1}/${selectedGroups.length}: ${group.label}\n`,
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
          `[vitest] group ${index + 1}/${selectedGroups.length} passed in ${((Date.now() - startedAt) / 1000).toFixed(2)}s\n`,
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
    if (options.shardOutputDir !== null) {
      writeShardOutput({
        outputDir: path.resolve(rootDir, options.shardOutputDir),
        manifest: {
          shardIndex: options.shardIndex,
          shardCount: options.shardCount,
          expectedGroups: groups.map(({ label }) => label),
          groups: selectedGroups.map(({ label }) => label),
        },
        groupResults,
      });
      process.stdout.write(
        `[vitest] coverage shard ${options.shardIndex + 1}/${options.shardCount} passed: groups=${selectedGroups.length}\n`,
      );
    } else {
      writeFinalReport({
        options,
        reports: groupResults.map(({ report }) => report),
        coveragePaths: groupResults.map(({ coveragePath }) => coveragePath),
        groupCount: groups.length,
      });
    }
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
