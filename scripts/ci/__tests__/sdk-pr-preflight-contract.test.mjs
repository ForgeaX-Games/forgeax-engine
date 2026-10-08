import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
const evidenceStart = buildJob.indexOf('name: Preserve SDK consumer evidence');
const mandatoryBuildJob = buildJob.slice(0, evidenceStart);
const consumerJob = workflow.slice(
  workflow.indexOf('  consumers:\n'),
  workflow.indexOf('  aggregate:\n'),
);
const archiveJob = consumerJob;
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
  assert.match(candidateWorkflow, /await attemptClose\('Preview'/);
  assert.match(candidateWorkflow, /witness_commit="\$source_commit"/);
  assert.match(candidateWorkflow, /cross-version witness must never change lifecycle/);
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

test('SDK PR consumers conserve four independent groups from one byte-verified seed', () => {
  assert.match(workflow, /permissions:\n {2}contents: read\n {2}actions: read/);
  assert.equal((workflow.match(/pnpm sdk:build --/g) ?? []).length, 1);
  assert.match(consumerJob, /group: \[npm, project, source, view\]/);
  assert.match(consumerJob, /fail-fast: false/);
  assert.match(buildJob, /compression-level: 0/);
  assert.match(consumerJob, /--artifact-pattern "sdk-pr-seed-\$GITHUB_RUN_ID" --expected-count 1/);
  assert.match(consumerJob, /--check-seed artifacts\/sdk --expected-head/);
  assert.match(consumerJob, /--group "\$\{\{ matrix\.group \}\}"/);
  const aggregate = workflow.slice(workflow.indexOf('  aggregate:\n'));
  assert.match(aggregate, /needs: \[build-sdk, consumers\]/);
  assert.match(aggregate, /if: always\(\)/);
  assert.match(aggregate, /name: sdk-build/);
  assert.match(aggregate, /test "\$SEED_RESULT" = success && test "\$CONSUMERS_RESULT" = success/);
  assert.match(
    aggregate,
    /--artifact-pattern 'sdk-pr-result-\*' --expected-count 4 --merge-multiple/,
  );
  assert.match(aggregate, /--aggregate artifacts\/sdk-results/);
  assert.match(
    consumerJob.slice(consumerJob.indexOf('name: Preserve SDK consumer evidence')),
    /if: always\(\)/,
  );
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
  const cache =
    / {6}- name: Cache verified SDK shader profile inputs\n[\s\S]*?(?=\n {6}- name:)/.exec(
      mandatoryBuildJob,
    )?.[0];
  assert.ok(cache);
  assert.match(cache, /uses: actions\/cache@v4/);
  assert.match(cache, /restore-keys: sdk-shader-profiles-v2-/);
  assert.match(
    cache,
    /path: \|\n {12}shared-build-inputs-release\/\*\/manifest\.json\n {12}shared-build-inputs-release\/\*\/shaders\/manifest\.json\n/,
  );
  assert.doesNotMatch(cache, /\n {8}(?:run|if):/);
  assert.doesNotMatch(mandatoryBuildJob, /continue-on-error/);
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
  assert.doesNotMatch(
    buildJob.slice(0, buildJob.indexOf('name: Build exact PR SDK')),
    /upload-artifact|download-artifact/,
  );
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
  assert.match(archiveJob, /runs-on: \[self-hosted, Linux, X64, heavy\]/);
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

test('paired View source changes trigger SDK consumers before publication', () => {
  for (const path of [
    "- 'tools/view'",
    "- 'tools/view-plugins/**'",
    "- 'scripts/forgeax/sdk-view.mjs'",
  ])
    assert.ok(workflow.includes(path), path);
  const restore = buildJob.indexOf('name: Restore pinned View tool source');
  const install = buildJob.indexOf('name: Install dependencies');
  assert.ok(restore >= 0 && restore < install);
  const browser = consumerJob.indexOf('name: Install Playwright Chrome Beta');
  const consumer = consumerJob.indexOf(
    'name: Install Engine and SDK through the exact PR consumer route',
  );
  assert.ok(browser >= 0 && browser < consumer);
  assert.match(
    consumerJob,
    /xvfb-run -a node scripts\/ci\/run-with-runner-cpu-affinity\.mjs -- pnpm sdk:check:npm/,
  );
  for (const name of ['npm-consumer', 'archive-browser']) {
    const start = candidateWorkflow.indexOf(`  ${name}:\n`);
    const end = candidateWorkflow.indexOf('\n  ', start + 3);
    // Job-local ordering is bounded by the next top-level job, not nested steps.
    const section = candidateWorkflow.slice(start).split(/\n {2}[a-z][a-z-]*:\n/)[0];
    assert.ok(start >= 0 && end >= 0);
    assert.ok(
      section.indexOf('Restore pinned View tool source') < section.indexOf('Install dependencies'),
    );
    assert.match(section, /Restore pinned View tool source/);
  }
});

test('every SDK browser owner inherits the existing cgroup CPU-affinity envelope', () => {
  for (const command of ['pnpm sdk:check:npm -- --version', 'pnpm sdk:verify --']) {
    assert.ok(workflow.includes(`node scripts/ci/run-with-runner-cpu-affinity.mjs -- ${command}`));
  }
  assert.equal(
    (workflow.match(/node scripts\/ci\/run-with-runner-cpu-affinity\.mjs -- /g) ?? []).length,
    2,
  );
  assert.match(workflow, /- 'scripts\/ci\/run-with-runner-cpu-affinity\.mjs'/);
  assert.match(workflow, /- 'scripts\/lib\/runner-resources\.mjs'/);
  assert.match(consumerJob, /FORGEAX_BROWSER_HEADLESS=0/);
});

test('the complete independent run is owned by the verified View consumer, not the seed barrier', () => {
  assert.doesNotMatch(
    workflow.slice(workflow.indexOf('  build-sdk:\n'), workflow.indexOf('  consumers:\n')),
    /verify-independent-run|Install Playwright|Install Mesa/,
  );
  const verifier = readFileSync(resolve('scripts/forgeax/verify-sdk.mjs'), 'utf8');
  const view = verifier.slice(
    verifier.lastIndexOf("if (selected('view'))"),
    verifier.indexOf("if (selected('project'))", verifier.lastIndexOf("if (selected('view'))")),
  );
  assert.match(view, /sdkStage\('verifyIndependentRun'/);
  assert.match(view, /packages\/devkit\/scripts\/verify-independent-run\.mjs/);
  assert.match(
    view,
    /FORGEAX_INDEPENDENT_ENGINE_PACKAGE:[\s\S]*\.forgeax\/cli-runtime\/node_modules\/@forgeax\/engine/,
  );
});

for (const jobName of ['build-sdk', 'reproducibility', 'collision']) {
  for (const staleMetadata of [false, true]) {
    test(`SDK Candidate ${jobName} normalizes a standalone View checkout${staleMetadata ? ' with stale submodule metadata' : ''} before recursive checkout`, () => {
      const sandbox = realpathSync(mkdtempSync(resolve(tmpdir(), 'sdk-checkout-regression-')));
      try {
        const workspace = resolve(sandbox, 'engine');
        const view = resolve(workspace, 'tools/view');
        mkdirSync(view, { recursive: true });
        const git = (cwd, ...args) =>
          execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim();
        git(workspace, 'init', '-q');
        git(view, 'init', '-q');
        git(view, 'config', 'remote.origin.url', 'https://github.com/ForgeaX-Games/forgeax-view.git');
        writeFileSync(resolve(view, 'LICENSE'), 'fixture license\n');
        git(view, 'add', 'LICENSE');
        git(
          view,
          '-c',
          'user.name=fixture',
          '-c',
          'user.email=fixture@example.test',
          'commit',
          '-qm',
          'fixture',
        );
        writeFileSync(
          resolve(workspace, '.gitmodules'),
          '[submodule "tools/view"]\n\tpath = tools/view\n\turl = https://github.com/ForgeaX-Games/forgeax-view.git\n',
        );
        git(
          workspace,
          'config',
          'submodule.tools/view.url',
          'https://github.com/ForgeaX-Games/forgeax-view.git',
        );
        git(workspace, 'add', '.gitmodules');
        git(
          workspace,
          'update-index',
          '--add',
          '--cacheinfo',
          `160000,${git(view, 'rev-parse', 'HEAD')},tools/view`,
        );
        const staleHead = git(view, 'rev-parse', 'HEAD');
        if (staleMetadata) {
          git(workspace, 'submodule', 'absorbgitdirs', 'tools/view');
          rmSync(view, { recursive: true, force: true });
          git(workspace, 'clone', '-q', resolve(workspace, '.git/modules/tools/view'), view);
          git(
            view,
            'config',
            'remote.origin.url',
            'https://github.com/ForgeaX-Games/forgeax-view.git',
          );
          git(
            view,
            '-c',
            'user.name=fixture',
            '-c',
            'user.email=fixture@example.test',
            'commit',
            '--allow-empty',
            '-qm',
            'standalone replacement',
          );
        }
        const runnerTemp = resolve(sandbox, 'runner-temp');
        mkdirSync(runnerTemp);
        const before = git(view, 'rev-parse', 'HEAD');
        if (staleMetadata) assert.notEqual(before, staleHead);
        assert.match(
          git(
            workspace,
            'submodule',
            'foreach',
            '--quiet',
            'git config --local --show-origin --name-only --get-regexp remote.origin.url',
          ),
          /^file:\.git\/config/,
        );
        const jobStart = candidateWorkflow.indexOf(`  ${jobName}:\n`);
        const job = candidateWorkflow.slice(jobStart).split(/\n {2}\S/)[0];
        const preparation = job.slice(0, job.indexOf('uses: actions/checkout@v5'));
        const shell = preparation.match(/ {8}run: \|\n((?: {10}.*\n)+)/)?.[1];
        assert.ok(shell, 'recursive checkout needs workspace preparation');
        execFileSync('bash', ['-c', shell.replace(/^ {10}/gm, '')], {
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            RUNNER_TEMP: runnerTemp,
            GIT_CONFIG_GLOBAL: resolve(sandbox, 'global-config'),
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const origin = git(
          workspace,
          'submodule',
          'foreach',
          '--quiet',
          'git config --local --show-origin --name-only --get-regexp remote.origin.url',
        );
        assert.ok(origin.startsWith(`file:${workspace}/.git/modules/tools/view/config`), origin);
        assert.equal(git(view, 'rev-parse', 'HEAD'), before);
        assert.equal(git(view, 'status', '--porcelain'), '');
        assert.equal(readFileSync(resolve(view, 'LICENSE'), 'utf8'), 'fixture license\n');
        const backups = readdirSync(runnerTemp);
        assert.equal(backups.length, staleMetadata ? 1 : 0);
        if (staleMetadata) {
          assert.equal(
            git(
              sandbox,
              '--git-dir',
              resolve(runnerTemp, backups[0], 'view.git'),
              '--work-tree',
              view,
              'rev-parse',
              'HEAD',
            ),
            staleHead,
          );
        }
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  }
}
