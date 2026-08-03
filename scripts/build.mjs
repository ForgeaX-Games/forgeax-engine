#!/usr/bin/env node
// Full repository build graph. Package JavaScript, shared engine inputs, app
// projections, and TypeScript declarations are separate observable stages.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve('.');
const mode = process.argv.includes('--engine') ? 'engine' : 'full';
const clean = process.argv.includes('--clean');
const summaryPath = join(root, 'node_modules/.cache/forgeax-build/summary.json');
const packageFactsPath = join(root, 'node_modules/.cache/forgeax-build/package-facts.json');
mkdirSync(resolve(summaryPath, '..'), { recursive: true });

const summary = {
  schemaVersion: 2,
  command: clean ? 'pnpm build:clean' : mode === 'engine' ? 'pnpm build:engine' : 'pnpm build',
  engineShaderCompileCount: 0,
  appShaderCompileCount: 0,
  assetCookHitCount: 0,
  assetCookMissCount: 0,
  assetCookWriteFailureCount: 0,
  stageDurationMs: {},
};

function persist() {
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

function runStage(name, command, args, env = process.env) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  });
  summary.stageDurationMs[name] = Number((performance.now() - startedAt).toFixed(1));
  if (name === 'apps' && existsSync(summaryPath)) {
    const childSummary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    Object.assign(summary, childSummary);
    summary.stageDurationMs[name] = Number((performance.now() - startedAt).toFixed(1));
  }
  persist();
  if (result.status !== 0) process.exit(result.status ?? 1);
}

persist();
if (clean) runStage('clean', process.execPath, ['scripts/clean-build-outputs.mjs']);

runStage('packages', process.execPath, ['scripts/build-packages.mjs'], {
  ...process.env,
  FORGEAX_REPO_ROOT: root,
  FORGEAX_PACKAGE_FACTS_PATH: packageFactsPath,
});

runStage('producer', process.execPath, ['scripts/build-shared-inputs.mjs', '--root', root]);

const sharedManifest = resolve(root, 'shared-build-inputs/manifest.json');
const producerFactsPath = resolve(root, 'shared-build-inputs/production-facts.json');
if (!existsSync(sharedManifest) || !existsSync(producerFactsPath))
  throw new Error('shared producer completed without its manifest and facts');
const producerFacts = JSON.parse(readFileSync(producerFactsPath, 'utf8'));
summary.engineShaderCompileCount = producerFacts.engineShaderCompileCount ?? 0;

if (mode === 'full') {
  runStage(
    'apps',
    process.execPath,
    ['scripts/build-apps.mjs', '--shared-input-manifest', sharedManifest],
    {
      ...process.env,
      FORGEAX_REPO_ROOT: root,
      FORGEAX_BUILD_PACKAGES_READY: '1',
      FORGEAX_BUILD_SUMMARY_PATH: summaryPath,
    },
  );
  if (existsSync(summaryPath))
    Object.assign(summary, JSON.parse(readFileSync(summaryPath, 'utf8')));
}

runStage('types-preflight', process.execPath, ['scripts/typecheck-output-preflight.mjs'], {
  ...process.env,
  FORGEAX_REPO_ROOT: root,
});
runStage('types', 'pnpm', ['exec', 'tsc', '-b']);
persist();
console.log(`[build] summary ${summaryPath}`);
