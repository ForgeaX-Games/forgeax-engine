#!/usr/bin/env node
// Stage and join the two metrics producer reports without allowing either
// producer to overwrite the other producer's evidence.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const PRODUCER_PATHS = Object.freeze({
  browser: Object.freeze([
    'report/color-lighting-browser.json',
    'report/color-lighting-parity',
    'report/pixel-parity.json',
    'report/pixel-parity-standard-lanes.json',
  ]),
  runtime: Object.freeze([
    'packages/runtime/bench-result.json',
    'report/hello-triangle/fps.json',
    'apps/dual-impl-spike/report/texture-4x4.json',
  ]),
});

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--stage') args.mode = 'stage';
    else if (arg === '--merge') args.mode = 'merge';
    else if (arg === '--producer') args.producer = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--browser') args.browser = argv[++index];
    else if (arg === '--runtime') args.runtime = argv[++index];
    else if (arg === '--root') args.root = argv[++index];
    else if (arg === '--run-id') args.runId = argv[++index];
    else if (arg === '--run-attempt') args.runAttempt = argv[++index];
    else if (arg === '--head-sha') args.headSha = argv[++index];
    else if (arg === '--allow-earlier-attempt') args.allowEarlierAttempt = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function requiredPaths(producer) {
  const paths = PRODUCER_PATHS[producer];
  if (paths === undefined) throw new Error(`unknown metrics producer: ${producer}`);
  return [...paths];
}

function identity(args) {
  const runId = args.runId ?? process.env.GITHUB_RUN_ID ?? '';
  const runAttempt = args.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT ?? '';
  const headSha = args.headSha ?? process.env.GITHUB_SHA ?? '';
  if (runId === '' || runAttempt === '' || headSha === '') {
    throw new Error('metrics evidence identity requires run ID, run attempt, and head SHA');
  }
  return {
    runId: String(runId),
    runAttempt: String(runAttempt),
    headSha: String(headSha),
  };
}

function pathExists(root, relativePath) {
  return existsSync(resolve(root, relativePath));
}

function copySelectedPaths(root, output, paths) {
  const presentPaths = [];
  for (const relativePath of paths) {
    const source = resolve(root, relativePath);
    if (!existsSync(source)) continue;
    const destination = resolve(output, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, force: true, errorOnExist: false });
    presentPaths.push(relativePath);
  }
  return presentPaths;
}

export function stageMetricsEvidence({ root, output, producer, runId, runAttempt, headSha }) {
  const inputRoot = resolve(root ?? process.cwd());
  const outputRoot = resolve(output);
  const producerPaths = requiredPaths(producer);
  const evidenceIdentity = identity({ runId, runAttempt, headSha });
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  const presentPaths = copySelectedPaths(inputRoot, outputRoot, producerPaths);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    producer,
    ...evidenceIdentity,
    requiredPaths: producerPaths,
    presentPaths,
  };
  writeFileSync(resolve(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function readManifest(root, expectedProducer, expectedIdentity, allowEarlierAttempt) {
  const manifestPath = resolve(root, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`${expectedProducer}: manifest.json is missing`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`${expectedProducer}: manifest.json is invalid: ${error.message}`);
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION)
    throw new Error(`${expectedProducer}: unsupported manifest schema`);
  if (manifest.producer !== expectedProducer)
    throw new Error(`${expectedProducer}: producer identity mismatch`);
  for (const field of ['runId', 'headSha']) {
    if (manifest[field] !== expectedIdentity[field])
      throw new Error(
        `${expectedProducer}: ${field} mismatch (expected ${expectedIdentity[field]}, observed ${manifest[field] ?? 'missing'})`,
      );
  }
  const observedAttempt = Number(manifest.runAttempt);
  const expectedAttempt = Number(expectedIdentity.runAttempt);
  const attemptsMatch = manifest.runAttempt === expectedIdentity.runAttempt;
  const earlierAttempt =
    allowEarlierAttempt === true &&
    Number.isInteger(observedAttempt) &&
    observedAttempt >= 1 &&
    Number.isInteger(expectedAttempt) &&
    expectedAttempt >= 1 &&
    observedAttempt < expectedAttempt;
  if (!attemptsMatch && !earlierAttempt) {
    throw new Error(
      `${expectedProducer}: runAttempt mismatch (expected ${expectedIdentity.runAttempt}, observed ${manifest.runAttempt ?? 'missing'})`,
    );
  }
  const expectedPaths = requiredPaths(expectedProducer);
  if (
    !Array.isArray(manifest.requiredPaths) ||
    manifest.requiredPaths.length !== expectedPaths.length ||
    manifest.requiredPaths.some((path, index) => path !== expectedPaths[index])
  ) {
    throw new Error(`${expectedProducer}: required evidence path manifest drifted`);
  }
  const missing = expectedPaths.filter((path) => !pathExists(root, path));
  if (missing.length > 0) {
    throw new Error(`${expectedProducer}: required evidence is missing: ${missing.join(', ')}`);
  }
  return manifest;
}

function collectFiles(root, relativePath, files = []) {
  const absolute = resolve(root, relativePath);
  const stats = statSync(absolute);
  if (stats.isFile()) {
    files.push(relativePath.replaceAll(sep, '/'));
    return files;
  }
  if (!stats.isDirectory()) throw new Error(`unsupported evidence entry: ${relativePath}`);
  for (const name of readdirSync(absolute).sort()) {
    collectFiles(root, join(relativePath, name), files);
  }
  return files;
}

function copyWithoutCollisions(sourceRoot, destinationRoot, paths, claimed) {
  for (const relativePath of paths) {
    const files = collectFiles(sourceRoot, relativePath);
    for (const file of files) {
      if (claimed.has(file)) throw new Error(`metrics evidence path collision: ${file}`);
      claimed.add(file);
    }
    for (const file of files) {
      const source = resolve(sourceRoot, file);
      const destination = resolve(destinationRoot, file);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { force: false, errorOnExist: true });
    }
  }
}

export function mergeMetricsEvidence({
  browser,
  runtime,
  output,
  runId,
  runAttempt,
  headSha,
  allowEarlierAttempt = false,
  root = process.cwd(),
}) {
  const destinationRoot = resolve(root, output ?? '.');
  const expectedIdentity = identity({ runId, runAttempt, headSha });
  const browserRoot = resolve(browser);
  const runtimeRoot = resolve(runtime);
  const browserManifest = readManifest(
    browserRoot,
    'browser',
    expectedIdentity,
    allowEarlierAttempt,
  );
  const runtimeManifest = readManifest(
    runtimeRoot,
    'runtime',
    expectedIdentity,
    allowEarlierAttempt,
  );
  const claimed = new Set();
  copyWithoutCollisions(
    browserRoot,
    destinationRoot,
    browserManifest.presentPaths ?? requiredPaths('browser'),
    claimed,
  );
  copyWithoutCollisions(
    runtimeRoot,
    destinationRoot,
    runtimeManifest.presentPaths ?? requiredPaths('runtime'),
    claimed,
  );
  const join = {
    schemaVersion: SCHEMA_VERSION,
    ...expectedIdentity,
    producers: [browserManifest, runtimeManifest].map((manifest) => ({
      producer: manifest.producer,
      producerRunAttempt: manifest.runAttempt,
      presentPaths: manifest.presentPaths,
    })),
  };
  const joinPath = resolve(destinationRoot, 'report/metrics-producer-join.json');
  mkdirSync(dirname(joinPath), { recursive: true });
  writeFileSync(joinPath, `${JSON.stringify(join, null, 2)}\n`);
  return join;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'stage') {
    if (!args.producer || !args.output) throw new Error('stage requires --producer and --output');
    stageMetricsEvidence(args);
    return;
  }
  if (args.mode === 'merge') {
    if (!args.browser || !args.runtime) throw new Error('merge requires --browser and --runtime');
    mergeMetricsEvidence(args);
    return;
  }
  throw new Error('choose exactly one mode: --stage or --merge');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `[metrics-evidence] FAIL: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
