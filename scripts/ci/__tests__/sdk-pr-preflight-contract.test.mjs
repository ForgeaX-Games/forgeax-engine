import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/sdk-pr-preflight.yml'), 'utf8');
const candidateWorkflow = readFileSync(
  resolve('.github/workflows/sdk-release-candidate.yml'),
  'utf8',
);
const collisionScript = readFileSync(
  resolve('scripts/forgeax/check-sdk-version-collision.mjs'),
  'utf8',
);
const ciPaths = JSON.parse(readFileSync(resolve('scripts/ci/paths.json'), 'utf8'));
const ciWorkflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const buildJob = workflow.slice(workflow.indexOf('  build-sdk:\n'));
const consumerJob = buildJob;
const archiveJob = buildJob;
const candidateArchiveJob = candidateWorkflow.slice(
  candidateWorkflow.indexOf('  archive-browser:\n'),
  candidateWorkflow.indexOf('  reproducibility:\n'),
);

test('main CI push paths include SDK skill and catalog changes', () => {
  assert.ok(ciPaths.includes('skills/**'));
  const pushBlock = ciWorkflow.slice(
    ciWorkflow.indexOf('  push:\n'),
    ciWorkflow.indexOf('  pull_request:\n'),
  );
  assert.match(pushBlock, /- 'skills\/\*\*'/);
});

test('SDK candidate accepts only a tree-equivalent empty-merge parent baseline', () => {
  assert.match(candidateWorkflow, /find_successful_push_ci\(\)/);
  assert.match(candidateWorkflow, /git diff --quiet "\$\{parent_words\[1\]\}" "\$source_sha"/);
  assert.match(candidateWorkflow, /ci_basis="tree-equivalent-first-parent:\$\{parent_sha\}"/);
  assert.match(
    candidateWorkflow,
    /successful same-commit CI \(exact-head\) or a tree-equivalent empty-merge first-parent baseline/,
  );
  assert.doesNotMatch(candidateWorkflow, /--event pull_request/);
});

test('SDK candidate pins an ancestor source and records a separate collision witness', () => {
  assert.match(candidateWorkflow, /source_sha:/);
  assert.match(candidateWorkflow, /git merge-base --is-ancestor "\$source_sha" "\$main_sha"/);
  assert.match(candidateWorkflow, /ci_conclusion="\$\(find_successful_push_ci "\$source_sha"\)"/);
  assert.match(candidateWorkflow, /ref: \$\{\{ inputs\.source_sha \|\| github\.sha \}\}/);
  assert.match(
    candidateWorkflow,
    /git show "\$WITNESS_COMMIT:apps\/preview\/scripts\/smoke-templates\.mjs"/,
  );
  assert.match(candidateWorkflow, /collision-witness\.json/);
});

test('SDK PR preflight can be dispatched against an exact ref after a missed PR webhook', () => {
  assert.equal(
    (workflow.match(/\n {2}workflow_dispatch:\n/g) ?? []).length,
    1,
    'SDK preflight must declare exactly one workflow_dispatch trigger',
  );
  assert.match(
    workflow,
    /SDK_PREFLIGHT_VERSION: 0\.0\.0-pr\.\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
});

test('SDK preflight routes wgpu-wasm changes and uses a content-keyed package cache', () => {
  assert.match(workflow, /- 'packages\/wgpu-wasm\/\*\*'/);
  assert.match(workflow, /- 'scripts\/lib\/ensure-wasm-lib\.mjs'/);
  assert.match(buildJob, /uses: actions\/cache@v5/);
  assert.match(buildJob, /path: packages\/wgpu-wasm\/pkg/);
  assert.match(
    buildJob,
    /wgpu-wasm-pkg-v1-\$\{\{ hashFiles\('packages\/wgpu-wasm\/src\/\*\*\/\*\.rs'/,
  );
});

test('SDK PR build and consumers share the self-hosted heavy pool', () => {
  const heavySelector =
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "heavy"\]'\) \}\}/;
  assert.match(buildJob, heavySelector);
  assert.match(buildJob, /Verify heavy runner capacity[\s\S]*--pool heavy/);
});

test('SDK PR consumers reuse the local exact build without artifact transfer', () => {
  const build = buildJob.indexOf('name: Build exact PR SDK and npm tarballs once');
  const identity = buildJob.indexOf('name: Verify exact SDK build for local consumers');
  const npm = buildJob.indexOf('name: Install Engine and SDK through the exact PR consumer route');
  const browser = buildJob.indexOf('name: Verify exact SDK archive through real browser');
  assert.ok(build >= 0 && build < identity && identity < npm && npm < browser);
  assert.doesNotMatch(workflow, /upload-artifact|download-artifact/);
  assert.doesNotMatch(workflow, /sdk-pr-seed/);
});

test('SDK preflight ensures release artifacts before conditional source fallback', () => {
  const ensure = buildJob.indexOf('name: Ensure wgpu-wasm release artifact');
  const rust = buildJob.indexOf('name: Setup Rust toolchain for wgpu-wasm source fallback');
  const install = buildJob.indexOf('name: Install dependencies');
  const build = buildJob.indexOf('pnpm -F @forgeax/engine-wgpu-wasm build:wasm');
  const verify = buildJob.indexOf('name: Verify wgpu-wasm artifact and provenance');
  assert.ok(ensure >= 0 && ensure < rust && rust < install && install < build && build < verify);
  assert.match(buildJob, /if: steps\.wgpu-release\.outputs\.needs_build == 'true'/g);
  assert.match(buildJob, /test -f packages\/wgpu-wasm\/pkg\/wgpu_wasm\.js/);
  assert.match(buildJob, /test -f packages\/wgpu-wasm\/pkg\/wgpu_wasm_bg\.wasm/);
  assert.match(buildJob, /test -f packages\/wgpu-wasm\/pkg\/provenance\.json/);
  assert.match(buildJob, /verifyProvenance/);
  assert.doesNotMatch(buildJob, /continue-on-error/);
  assert.doesNotMatch(buildJob, /build:wasm[^\n]*\|\| true/);
});

test('SDK preflight uses the canonical source-build action when FBX release is absent', () => {
  for (const path of [
    "- '.github/actions/editor-prerequisite-build/**'",
    "- 'packages/fbx/**'",
    "- 'scripts/ci/build-editor-prerequisite.mjs'",
    "- 'scripts/ci/editor-prerequisite-build.contract.json'",
    "- 'scripts/ci/setup-emscripten-no-xz.py'",
    "- 'scripts/ci/prepare-emscripten-no-xz-archive.py'",
    "- 'scripts/ci/emscripten-no-xz.lock.json'",
  ]) {
    assert.match(workflow, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const ensure = buildJob.indexOf('name: Ensure FBX release artifact');
  const sourceSha = buildJob.indexOf('name: Resolve checked source SHA for FBX fallback');
  const fallback = buildJob.indexOf(
    'name: Build FBX WASM from source when release artifact is unavailable',
  );
  const verify = buildJob.indexOf('name: Verify FBX WASM release or source fallback');
  const rehydrate = buildJob.indexOf('name: Rehydrate SDK dependencies after FBX source fallback');
  const wgpuBuild = buildJob.indexOf(
    'name: Build wgpu-wasm from source when release artifact is unavailable',
  );
  assert.ok(
    ensure >= 0 &&
      ensure < sourceSha &&
      sourceSha < fallback &&
      fallback < verify &&
      verify < rehydrate &&
      rehydrate < wgpuBuild,
  );
  assert.match(buildJob, /uses: \.\/\.github\/actions\/editor-prerequisite-build/);
  assert.match(buildJob, /engine-sha: \$\{\{ steps\.checked-source\.outputs\.value \}\}/);
  assert.match(buildJob, /payload-classes: fbx-wasm/);
  assert.match(buildJob, /engine-prerequisite-build-manifest\.json/);
  assert.match(
    buildJob,
    /Rehydrate SDK dependencies after FBX source fallback[\s\S]*?rm -rf node_modules[\s\S]*?pnpm install --frozen-lockfile --ignore-scripts/,
  );
  assert.doesNotMatch(buildJob, /upload-artifact|download-artifact/);
  assert.doesNotMatch(buildJob, /gh release upload|contents:\s*write/);
});

test('SDK preflight does not publish PR assets or alter the release workflow', () => {
  assert.doesNotMatch(workflow, /gh release upload|npm publish|sdk-release\.yml/);
  assert.match(buildJob, /pnpm sdk:build -- --version/);
  assert.match(consumerJob, /pnpm sdk:check:npm -- --version/);
});

test('SDK npm consumer pins and asserts the known-good npm CLI before checking the route', () => {
  const pin = consumerJob.indexOf('name: Pin npm CLI for nested consumer gate');
  const check = consumerJob.indexOf(
    'name: Install Engine and SDK through the exact PR consumer route',
  );
  assert.ok(pin >= 0 && pin < check);
  const setupBlock = consumerJob.slice(pin, check);
  assert.match(setupBlock, /npm@11\.17\.0/);
  assert.match(setupBlock, /test "\$\("\$NPM_BIN\/npm" --version\)" = "11\.17\.0"/);
  const checkBlock = consumerJob.slice(check);
  assert.match(checkBlock, /NPM_BIN="\$RUNNER_TEMP\/forgeax-npm-11\.17\.0\/node_modules\/\.bin"/);
  assert.match(checkBlock, /export PATH="\$NPM_BIN:\$PATH"/);
  assert.match(checkBlock, /test "\$\(npm --version\)" = "11\.17\.0"/);
});

test('headed SDK archive gates use the capacity-checked Heavy WebGPU pool', () => {
  const heavySelector =
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "heavy"\]'\) \}\}/;
  assert.match(archiveJob, heavySelector);
  assert.match(archiveJob, /node scripts\/ci\/verify-runner-pool-capacity\.mjs --pool heavy/);
  assert.match(candidateArchiveJob, heavySelector);
  assert.match(
    candidateArchiveJob,
    /node scripts\/ci\/verify-runner-pool-capacity\.mjs --pool heavy/,
  );
});

test('SDK reproducibility gate retains history for catalog ancestry validation', () => {
  const reproducibilityJob = candidateWorkflow.slice(
    candidateWorkflow.indexOf('  reproducibility:\n'),
    candidateWorkflow.indexOf('  collision:\n'),
  );
  assert.match(
    reproducibilityJob,
    /uses: actions\/checkout@v5[\s\S]*?fetch-depth: 0[\s\S]*?submodules: recursive/,
  );
});

test('SDK collision evidence maps archive paths without passing array indexes as suffixes', () => {
  assert.match(collisionScript, /archives\.map\(\(archive\) => basename\(archive\)\)/);
  assert.doesNotMatch(collisionScript, /archives\.map\(basename\)/);
});

test('SDK collision smoke publishes evidence at the repository root', () => {
  const collisionJob = candidateWorkflow.slice(
    candidateWorkflow.indexOf('  collision:\n'),
    candidateWorkflow.indexOf('  seal:\n'),
  );
  assert.match(
    collisionJob,
    /FORGEAX_TEMPLATE_SMOKE_DIR: \$\{\{ github\.workspace \}\}\/artifacts\/sdk-release-template-smoke/,
  );
  assert.match(collisionJob, /artifacts\/sdk-release-template-smoke\/report\.json/);
});
