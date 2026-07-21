#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function parseArgs(argv) {
  const result = {
    root: '.',
    shardCount: 3,
    shardIndex: 0,
    dryRun: false,
    mergeDdc: false,
    cacheHit: false,
    snapshotsDir: null,
    ddcOutputDir: null,
    outputDir: null,
    sharedInputManifest: null,
    attempt: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--root') result.root = argv[++index];
    else if (arg === '--shard-count') result.shardCount = Number(argv[++index]);
    else if (arg === '--shard-index') result.shardIndex = Number(argv[++index]);
    else if (arg === '--output-dir') result.outputDir = argv[++index];
    else if (arg === '--shared-input-manifest') result.sharedInputManifest = argv[++index];
    else if (arg === '--attempt') result.attempt = Number(argv[++index]);
    else if (arg === '--merge-ddc') result.mergeDdc = true;
    else if (arg === '--cache-hit') result.cacheHit = true;
    else if (arg === '--snapshots-dir') result.snapshotsDir = argv[++index];
    else if (arg === '--ddc-output-dir') result.ddcOutputDir = argv[++index];
    else if (arg === '--dry-run') result.dryRun = true;
  }
  return result;
}

function fail(code, detail) {
  process.stdout.write(`${JSON.stringify({ code, ...detail })}\n`);
  process.exit(1);
}

function discoverApps(root) {
  const appsRoot = join(root, 'apps');
  const found = [];
  const visit = (relative) => {
    for (const entry of readdirSync(join(appsRoot, relative), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      const manifestPath = join(appsRoot, next, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.scripts?.build === 'string') found.push(next);
      } else {
        visit(next);
      }
    }
  };
  visit('');
  return found.sort();
}

function artifactInventory(root, apps) {
  return apps.flatMap((app) => {
    const manifest = `apps/${app}/dist/shaders/manifest.json`;
    return existsSync(join(root, manifest)) ? [manifest] : [];
  });
}

function copyShardArtifacts(root, outputDir, report) {
  for (const relative of report.artifactInventory) {
    const source = join(root, relative);
    const destination = join(outputDir, 'artifacts', relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true });
  }
}

function writeReport(root, outputDir, report) {
  const output = resolve(outputDir);
  const reportDir = join(output, 'report');
  mkdirSync(reportDir, { recursive: true });
  copyShardArtifacts(root, output, report);
  writeFileSync(
    join(reportDir, `coverage-${report.shardIndex}-a${report.attempt}.json`),
    JSON.stringify({ ...report, result: 'success' }, null, 2),
  );
  writeFileSync(
    join(reportDir, `artifact-inventory-${report.shardIndex}-a${report.attempt}.json`),
    JSON.stringify(report.artifactInventory, null, 2),
  );
}

const options = parseArgs(process.argv.slice(2));
if (
  !Number.isInteger(options.shardCount) ||
  options.shardCount < 1 ||
  !Number.isInteger(options.shardIndex) ||
  options.shardIndex < 0 ||
  options.shardIndex >= options.shardCount
) {
  fail('ci-app-shard-index-out-of-range', {
    shardIndex: options.shardIndex,
    shardCount: options.shardCount,
  });
}

if (options.mergeDdc) {
  const mergeScript = join(process.cwd(), 'scripts', 'ci', 'merge-ddc-snapshots.mjs');
  const result = spawnSync(
    process.execPath,
    [
      mergeScript,
      '--snapshots-dir',
      options.snapshotsDir ?? 'ddc-snapshots',
      '--out-dir',
      options.ddcOutputDir ?? 'ddc-merged',
      '--shard-count',
      String(options.shardCount),
      ...(options.cacheHit ? ['--cache-hit'] : []),
    ],
    { encoding: 'utf8' },
  );
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  process.exit(result.status ?? 1);
}

const root = resolve(options.root);
if (
  options.sharedInputManifest !== null &&
  !existsSync(resolve(root, options.sharedInputManifest))
) {
  fail('ci-app-shard-shared-input-missing', { manifest: options.sharedInputManifest });
}
const attempt = options.attempt ?? Number(process.env.GITHUB_RUN_ATTEMPT ?? 1);
if (!Number.isInteger(attempt) || attempt < 1) fail('ci-app-shard-attempt-invalid', { attempt });
const roster = discoverApps(root);
const apps = roster.filter((_, index) => index % options.shardCount === options.shardIndex);
const shardSizes = Array.from(
  { length: options.shardCount },
  (_, shardIndex) => roster.filter((_, index) => index % options.shardCount === shardIndex).length,
);
const report = {
  shardIndex: options.shardIndex,
  shardCount: options.shardCount,
  attempt,
  apps,
  appCount: apps.length,
  loadImbalance: Math.max(...shardSizes) - Math.min(...shardSizes),
  artifactInventory: options.dryRun ? artifactInventory(root, apps) : [],
  dryRun: options.dryRun,
};

if (!options.dryRun && apps.length > 0) {
  const runner = join(root, 'scripts', 'build-apps.mjs');
  const result = spawnSync(
    process.execPath,
    [
      runner,
      ...(options.sharedInputManifest === null
        ? []
        : ['--shared-input-manifest', resolve(root, options.sharedInputManifest)]),
      ...apps,
    ],
    {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
report.artifactInventory = artifactInventory(root, apps);
if (options.outputDir) writeReport(root, options.outputDir, report);
process.stdout.write(`${JSON.stringify(report)}\n`);
