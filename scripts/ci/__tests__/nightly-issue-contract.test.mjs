import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DAWN_COMPACT_TEST_FILES } from '../dawn-compact-roster.mjs';
import { DAWN_GATE_GROUPS, DAWN_GATE_SHARDS } from '../dawn-gate-roster.mjs';

const workflow = readFileSync(resolve('.github/workflows/nightly.yml'), 'utf8');
const shadowFieldsObservable = readFileSync(
  resolve('packages/runtime/src/__tests__/shadow-fields-observable.dawn.test.ts'),
  'utf8',
);
const spriteNinesliceSection = readFileSync(
  resolve('packages/runtime/src/__tests__/dawn/hello-sprite-nineslice-section.dawn.test.ts'),
  'utf8',
);

test('hosted Dawn probes remain selected and reject an empty test population', () => {
  const start = workflow.indexOf('      - name: Vitest Dawn platform probe');
  assert.ok(start >= 0);
  const end = workflow.indexOf('\n      - name:', start + 1);
  const probe = workflow.slice(start, end);
  assert.match(probe, /FORGEAX_DAWN_COMPACT: ['"]1['"]/);
  assert.match(probe, /--passWithNoTests=false/);
  const files = probe.match(/packages\/[^\s]+\.dawn\.test\.ts/g) ?? [];
  assert.equal(files.length, 4, 'all four hosted platform probes must remain selected');
  for (const file of files) {
    assert.ok(existsSync(file), `missing hosted probe ${file}`);
    assert.ok(DAWN_COMPACT_TEST_FILES.includes(file), `unadmitted hosted probe ${file}`);
  }
});

function jobSection(name) {
  const start = workflow.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing ${name}`);
  const remaining = workflow.slice(start);
  const nextJob = remaining.slice(1).search(/\n {2}[a-z][\w-]+:/);
  return remaining.slice(0, nextJob === -1 ? undefined : nextJob + 1);
}

test('nightly failure issue records failed jobs and deduplicates reruns', () => {
  const section = jobSection('notify-failure');
  assert.match(section, /if: failure\(\)/);
  assert.match(section, /issues: write/);
  assert.match(section, /actions: read/);
  assert.match(section, /retries: 3/);
  assert.match(section, /github\.rest\.actions\.listJobsForWorkflowRun/);
  assert.match(section, /\*\*failed jobs \/ steps\*\*:/);
  assert.match(section, /\*\*nightly run id\*\*:/);
  assert.match(section, /process\.env\.GITHUB_RUN_ATTEMPT/);
  assert.doesNotMatch(section, /context\.runAttempt/);
  assert.match(section, /github\.rest\.issues\.listForRepo/);
  assert.match(section, /updated existing nightly issue/);
  assert.match(section, /github\.rest\.issues\.create/);
});

test('nightly keeps full Linux history and only current hosted probe inputs', () => {
  const checkout = workflow.slice(
    workflow.indexOf('      - name: Checkout\n'),
    workflow.indexOf('      - name: Setup Node.js for WASM hydration\n'),
  );
  assert.match(
    checkout,
    /fetch-depth: \$\{\{ matrix\.hostedPlatform && 1 \|\| 0 \}\}/,
    'Linux retains the historical sibling baseline; hosted probes need only the current commit',
  );
  assert.match(
    checkout,
    /submodules: \$\{\{ matrix\.ubuntu && 'recursive' \|\| false \}\}/,
    'Linux keeps the asset/View/Rust inputs; hosted procedural native probes do not fetch them',
  );
});

test('nightly provisions Node before the wgpu-wasm provenance step', () => {
  const section = jobSection('smoke-browser-dawn');
  const node = section.indexOf('      - name: Setup Node.js for WASM hydration');
  const wgpu = section.indexOf('      - name: Build wgpu-wasm');
  assert.ok(node >= 0, 'missing shared Node setup');
  assert.ok(wgpu >= 0, 'missing wgpu-wasm build');
  assert.ok(node < wgpu, 'Node setup must precede build.sh');
});

test('full Linux nightly uses the verified native and coverage capacity pool', () => {
  const section = jobSection('smoke-browser-dawn');
  assert.match(section, /runner: '\["self-hosted", "Linux", "X64", "heavy"\]'/);
  assert.match(
    section,
    /- name: Verify full Linux gate capacity\n\s+if: matrix\.ubuntu\n\s+run: node scripts\/ci\/verify-runner-pool-capacity\.mjs --pool heavy/,
  );
  const linux = section.slice(
    section.indexOf('- name: self-hosted-linux-heavy'),
    section.indexOf('- name: macos-latest'),
  );
  assert.match(linux, /ubuntu: true\n\s+hostedPlatform: false/);
  assert.match(linux, /timeout: 90/);
  assert.doesNotMatch(section, /FORGEAX_DAWN_LIGHTWEIGHT/);
});

test('nightly uses the canonical package graph and declaration preflight', () => {
  const section = jobSection('smoke-browser-dawn');
  const start = section.indexOf(
    '      - name: Build (.mjs + .d.ts, packages only — apps tested from source)',
  );
  assert.notEqual(start, -1, 'missing nightly package build step');
  const end = section.indexOf('\n      - name:', start + 1);
  const build = section.slice(start, end === -1 ? undefined : end);
  assert.match(build, /shell: bash/);
  assert.match(build, /if \[ "\$RUNNER_OS" = "Windows" \]; then/);
  assert.match(build, /export FORGEAX_PACKAGE_BUILD_CONCURRENCY=2/);
  assert.match(build, /FORGEAX_BUILD_NO_TASK_CACHE: ['"]1['"]/);
  assert.match(build, /node scripts\/build-packages\.mjs/);
  assert.match(build, /node scripts\/typecheck-output-preflight\.mjs/);
  assert.match(build, /pnpm exec tsc -b/);
  assert.ok(
    build.indexOf('typecheck-output-preflight') < build.indexOf('pnpm exec tsc -b'),
    'declaration preflight must run before the final typecheck',
  );
  assert.doesNotMatch(build, /pnpm -r --filter=/);
});

test('nightly bounds hosted platform probes and keeps the complete roster on Linux', () => {
  const section = jobSection('smoke-browser-dawn');
  assert.match(
    section,
    /timeout-minutes: \$\{\{ matrix\.timeout \}\}/,
    'nightly timeout must come from the per-platform budget',
  );
  assert.match(
    section,
    /hostedPlatform: true[\s\S]*?timeout: 15[\s\S]*?hostedPlatform: true[\s\S]*?timeout: 25/,
    'hosted macOS and Windows must keep their separate bounded probe budgets',
  );
  assert.match(
    section,
    /- name: Vitest Dawn platform probe \(hosted macOS\/Windows\)\n\s+if: matrix\.hostedPlatform[\s\S]*?--maxWorkers=1/,
    'hosted platforms must use the bounded serial probe',
  );
  assert.match(
    section,
    /- name: Vitest dawn project \(real GPU command capture\)\n\s+if: matrix\.ubuntu/,
    'the complete Dawn roster must remain Linux-owned',
  );
  assert.match(
    section,
    /- name: Vitest dawn project \(real GPU command capture\)[\s\S]*?FORGEAX_SHARED_APP_INPUTS_MANIFEST: \$\{\{ github\.workspace \}\}\/shared-build-inputs\/manifest\.json[\s\S]*?run: >-\s+node scripts\/ci\/run-with-runner-cpu-affinity\.mjs --\s+node scripts\/ci\/run-dawn-gate\.mjs/,
    'nightly must run the same complete gate after producing its shader inputs',
  );
  assert.doesNotMatch(section, /FORGEAX_DAWN_LIGHTWEIGHT/);
  assert.match(
    section,
    /- name: Prepare XDG runtime directory[\s\S]*?uses: \.\/\.github\/actions\/prepare-xdg-runtime/,
    'the Linux nightly Dawn lane must provide a private XDG runtime directory',
  );
});

test('nightly Linux Mesa provisioning isolates host apt sources', () => {
  const section = jobSection('smoke-browser-dawn');
  const installStart = section.indexOf('      - name: Install Mesa Vulkan (Linux only)');
  assert.notEqual(installStart, -1, 'missing nightly Mesa provisioning step');
  const installEnd = section.indexOf('\n      - name:', installStart + 1);
  const install = section.slice(installStart, installEnd === -1 ? undefined : installEnd);
  assert.match(
    install,
    /apt_wrapper="\$GITHUB_WORKSPACE\/scripts\/ci\/with-apt-ubuntu-sources\.sh"/,
  );
  assert.match(install, /"\$apt_wrapper" sudo apt-get update/);
  assert.match(install, /"\$apt_wrapper" sudo apt-get install -y mesa-vulkan-drivers vulkan-tools/);
  assert.doesNotMatch(install, /\n\s+sudo apt-get update/);
});

test('shadow-field Dawn falsifiers keep a bounded Windows cold-start budget', () => {
  assert.match(
    shadowFieldsObservable,
    /const SHADOW_FIELDS_FULL_PIXEL_TIMEOUT_MS = 300_000;/,
    'shadow-field falsifiers need a five-minute bound for the Windows Dawn prebuild',
  );
  assert.equal(
    (shadowFieldsObservable.match(/SHADOW_FIELDS_FULL_PIXEL_TIMEOUT_MS/g) ?? []).length,
    5,
    'the declaration plus all four per-field falsifiers must use the bounded timeout',
  );
});

test('sprite nineslice Dawn falsifier keeps a bounded Windows cold-start budget', () => {
  assert.match(
    spriteNinesliceSection,
    /const SPRITE_NINESLICE_DAWN_TEST_TIMEOUT_MS = 120_000;/,
    'sprite nineslice falsifier needs a bounded timeout for the Windows Dawn cold start',
  );
  assert.equal(
    (spriteNinesliceSection.match(/SPRITE_NINESLICE_DAWN_TEST_TIMEOUT_MS/g) ?? []).length,
    3,
    'the sprite nineslice declaration must be applied to both falsifiers',
  );
});

test('nightly materializes the cold tree-shake bundles before coverage', () => {
  const section = jobSection('smoke-browser-dawn');
  const coverage = section.indexOf(
    '      - name: Vitest unit + coverage (nightly fallback for AC-33)',
  );
  assert.notEqual(coverage, -1, 'missing nightly coverage step');
  const packageBuildStart = section.indexOf(
    '      - name: Build (.mjs + .d.ts, packages only — apps tested from source)',
  );
  assert.notEqual(packageBuildStart, -1, 'missing nightly package build step');
  const packageBuildEnd = section.indexOf('\n      - name:', packageBuildStart + 1);
  const packageBuild = section.slice(
    packageBuildStart,
    packageBuildEnd === -1 ? coverage : packageBuildEnd,
  );
  assert.match(
    section.slice(coverage),
    /pnpm --filter @forgeax\/hello-cube build[\s\S]*node scripts\/ci\/run-split-vitest-coverage\.mjs/,
    'coverage must materialize the consumer bundle required by tree-shake tests',
  );
  assert.match(
    section.slice(coverage),
    /FORGEAX_SHARED_APP_INPUTS_MANIFEST: \$\{\{ github\.workspace \}\}\/shared-build-inputs\/manifest\.json/,
    'coverage must consume the verified shared shader projection',
  );
  assert.doesNotMatch(
    packageBuild,
    /pnpm --filter @forgeax\/hello-cube build/,
    'cold app builds belong to the coverage consumer, not the shared package build',
  );
});

test('nightly success closes only machine-tracked issues with proof', () => {
  const section = jobSection('notify-success');
  assert.match(section, /needs: \[smoke-browser-dawn, native-ray-query-metal-build\]/);
  assert.match(
    section,
    /needs\.smoke-browser-dawn\.result == 'success'.*needs\.native-ray-query-metal-build\.result == 'success'/s,
  );
  assert.match(section, /issues: write/);
  assert.match(section, /\*\*nightly run id\*\*:/);
  assert.match(section, /legacyNightlyFailure/);
  assert.match(section, /nightly run failed — see/);
  assert.match(section, /actions\\\/runs\\\/\\d+/);
  assert.match(section, /includes\('\*\*nightly run id\*\*:'\) \|\| legacyNightlyFailure/);
  assert.match(section, /state: 'closed'/);
  assert.match(section, /\*\*scenario\*\*: nightly-green/);
});

test('Bun installs only after every pnpm consumer in the shared Linux workspace', () => {
  const section = jobSection('smoke-browser-dawn');
  const install = section.indexOf('- name: Bun install (frozen)');
  assert.ok(install > section.lastIndexOf('pnpm '));
  assert.match(section.slice(install), /if: matrix\.ubuntu/);
  assert.match(section.slice(install), /bun install --frozen-lockfile --ignore-scripts/);
});

test('Windows source and smoke gates fail immediately and retain a bounded heap', () => {
  const section = jobSection('smoke-browser-dawn');
  for (const name of ['English-only check', 'Hello-triangle headless smoke']) {
    const start = section.indexOf(`- name: ${name}`);
    const end = section.indexOf('\n      - name:', start + 1);
    const step = section.slice(start, end);
    assert.match(step, /shell: bash/);
    if (name.includes('smoke')) {
      assert.match(step, /NODE_OPTIONS: --max-old-space-size=4096/);
      assert.ok(
        /FORGEAX_SHADER_COMPILE_WORKERS: \$\{\{ runner\.os == 'Windows' && '2' \|\| '' \}\}/.test(
          step,
        ),
      );
      assert.match(
        step,
        /pnpm --filter @forgeax\/hello-triangle build\s+pnpm --filter @forgeax\/hello-triangle smoke/,
      );
    }
  }
});

test('a successful diagnostic branch nightly cannot close main tracking issues', () => {
  assert.match(jobSection('notify-success'), /github\.ref == 'refs\/heads\/main'/);
});

test('full Linux nightly consumers inherit the existing software-GPU CPU envelope', () => {
  assert.match(workflow, /LP_NUM_THREADS: '?4'?/);
  const section = jobSection('smoke-browser-dawn');
  for (const command of ['run-dawn-gate', 'run-split-vitest-coverage']) {
    assert.match(
      section,
      new RegExp(
        `node scripts/ci/run-with-runner-cpu-affinity\\.mjs --\\s+node scripts/ci/${command}\\.mjs`,
      ),
    );
  }
});

test('nightly full Linux shards conserve every native owner and one coverage owner', () => {
  const matrix = workflow.slice(
    workflow.indexOf('        include:'),
    workflow.indexOf('    runs-on:'),
  );
  const linuxRows = matrix
    .split('          - name: ')
    .slice(1)
    .filter((row) => row.includes('ubuntu: true'));
  assert.equal(linuxRows.length, 4);
  const selections = linuxRows.map((row) => row.match(/dawnShard: '([1-4])\/4'/)?.[1]);
  assert.deepEqual(selections.toSorted(), ['1', '2', '3', '4']);
  const command = workflow.match(/node scripts\/ci\/run-dawn-gate\.mjs ([^\n]+)/)?.[1];
  assert.ok(command, 'nightly must invoke the native gate CLI');
  const owners = selections.flatMap((index) => {
    const args = command.replace('${{ matrix.dawnShard }}', `${index}/4`).trim().split(/\s+/);
    const result = spawnSync(
      process.execPath,
      ['scripts/ci/run-dawn-gate.mjs', ...args, '--dry-run'],
      {
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, `nightly shard ${index}: ${result.stderr}`);
    const groups = JSON.parse(result.stdout);
    assert.deepEqual(
      new Set(groups.map((group) => group.id)),
      new Set(DAWN_GATE_SHARDS[Number(index) - 1]),
    );
    return groups.map((group) => group.id);
  });
  assert.equal(new Set(owners).size, owners.length, 'no duplicate native owners');
  assert.deepEqual(owners.toSorted(), DAWN_GATE_GROUPS.map((group) => group.id).toSorted());
  assert.equal(linuxRows.filter((row) => /coverage: true/.test(row)).length, 1);
  for (const row of linuxRows) assert.match(row, /timeout: 90/);
  for (const name of [
    'Install Playwright Chrome Beta (for nightly browser-owned unit coverage)',
    'Vitest unit + coverage (nightly fallback for AC-33)',
  ]) {
    assert.ok(workflow.includes(`- name: ${name}\n        if: matrix.ubuntu && matrix.coverage`));
  }
  assert.doesNotMatch(workflow, /FORGEAX_DAWN_LIGHTWEIGHT/);
});
