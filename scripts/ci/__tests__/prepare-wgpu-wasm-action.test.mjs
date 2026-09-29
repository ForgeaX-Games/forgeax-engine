import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const actionPath = '.github/actions/prepare-wgpu-wasm/action.yml';
function shellStep(name) {
  const action = readFileSync(actionPath, 'utf8');
  const step = action.split(`    - name: ${name}\n`)[1]?.split('\n    - name: ')[0];
  assert.ok(step, name);
  return step
    .split('      run: |\n')[1]
    .split('\n')
    .filter((line) => !line.trim() || line.startsWith('        '))
    .map((line) => line.slice(8))
    .join('\n');
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-wgpu-readiness-'));
  const pkg = join(root, 'packages/wgpu-wasm');
  mkdirSync(join(pkg, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  for (const file of ['ensure-wasm.mjs', 'verify-current.mjs', 'provenance.mjs', 'content-key.mjs'])
    cpSync(resolve('packages/wgpu-wasm/scripts', file), join(pkg, 'scripts', file));
  cpSync(resolve('scripts/lib/ensure-wasm-lib.mjs'), join(root, 'scripts/lib/ensure-wasm-lib.mjs'));
  for (const file of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.sh'])
    cpSync(resolve('packages/wgpu-wasm', file), join(pkg, file));
  cpSync(resolve('packages/wgpu-wasm/src'), join(pkg, 'src'), { recursive: true });
  const output = join(root, 'output');
  const env = { ...process.env, FORGEAX_SKIP_WGPU_WASM_FETCH: '1', GITHUB_OUTPUT: output };
  const run = (command, args) => spawnSync(command, args, { cwd: root, env, encoding: 'utf8' });
  const seed = () => {
    mkdirSync(join(pkg, 'pkg'), { recursive: true });
    writeFileSync(join(pkg, 'pkg/wgpu_wasm.js'), '// fixture glue\n');
    writeFileSync(join(pkg, 'pkg/wgpu_wasm_bg.wasm'), 'fixture bytes');
    const result = run(process.execPath, ['packages/wgpu-wasm/scripts/provenance.mjs']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  return { root, pkg, output, run, seed };
}

for (const state of ['absent', 'stale-source', 'corrupt-bytes', 'current']) {
  test(`WASM preparation uses real provenance for ${state} after unavailable release`, () => {
    const script = shellStep('Hydrate and verify current wgpu-wasm');
    const f = fixture();
    try {
      if (state !== 'absent') f.seed();
      if (state === 'stale-source')
        writeFileSync(join(f.pkg, 'src/fixture-change.rs'), '// new source\n');
      if (state === 'corrupt-bytes') writeFileSync(join(f.pkg, 'pkg/wgpu_wasm_bg.wasm'), 'changed');
      const result = f.run('bash', ['-c', script]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(
        readFileSync(f.output, 'utf8'),
        new RegExp(`needs_build=${state === 'current' ? 'false' : 'true'}`),
      );
      const final = f.run('bash', ['-c', shellStep('Verify prepared wgpu-wasm')]);
      assert.equal(final.status === 0, state === 'current', final.stdout + final.stderr);
      if (state !== 'current') {
        f.seed();
        const repaired = f.run('bash', ['-c', shellStep('Verify prepared wgpu-wasm')]);
        assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test('full and focused CI use the same verified source fallback before building', () => {
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/ci-focus.yml']) {
    const workflow = readFileSync(path, 'utf8');
    assert.match(workflow, /uses: \.\/\.github\/actions\/prepare-wgpu-wasm/);
  }
  const action = readFileSync(actionPath, 'utf8');
  for (const name of ['setup-rust-toolchain', 'setup-wasm-pack'])
    assert.match(
      action,
      new RegExp(
        `if: steps.hydrate.outputs.needs_build == 'true'\\n      uses: \\.\\/\\.github\\/actions\\/${name}`,
      ),
    );
  assert.match(action, /bash packages\/wgpu-wasm\/build\.sh/);
  assert.doesNotMatch(action, /continue-on-error/);
});

test('GPU timing contracts provision current WASM before artifact-loss source recovery', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const job = workflow.split('\n  gpu-pass-timing-contract:\n')[1]?.split(/\n {2}\S/)[0];
  assert.ok(job);
  const provision = job.indexOf('uses: ./.github/actions/prepare-wgpu-wasm');
  const recovery = job.indexOf('node scripts/ci/prepare-ci-inputs.mjs');
  assert.ok(provision >= 0 && provision < recovery, 'source recovery needs verified current WASM');
});

test('multithread benchmark prepares only core/shared inputs and owns one executable build', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const job = workflow.split('\n  multithread-browser-benchmark:\n')[1]?.split(/\n {2}\S/)[0];
  assert.ok(job);
  assert.match(job, /needs: \[core-build, shared-app-inputs, post-merge-gate\]/);
  assert.doesNotMatch(job, /needs\.build-artifacts/);
  assert.ok(
    job.indexOf('uses: ./.github/actions/prepare-wgpu-wasm') <
      job.indexOf('prepare-ci-inputs.mjs --consumer multithread-browser-benchmark'),
  );
  assert.equal(
    (job.match(/node scripts\/build-apps\.mjs apps\/hello\/multithreaded-execution/g) ?? []).length,
    1,
  );
  for (const owner of [
    'run-capability-matrix.mjs',
    'run-raw-kernel.mjs',
    'smoke-browser.mjs',
    'bench-browser.mjs',
  ])
    assert.ok(job.includes(owner));
});

test('every input-recovery job provisions current WASM before optional transfers', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const jobs = [
    ...workflow.matchAll(
      /^ {2}([a-zA-Z0-9_-]+):\n([\s\S]*?)(?=^ {2}[a-zA-Z0-9_-]+:|$(?![\s\S]))/gm,
    ),
  ];
  const consumers = jobs.filter((job) => job[2].includes('node scripts/ci/prepare-ci-inputs.mjs'));
  assert.ok(consumers.length >= 20, 'must inspect the actual recovery roster');
  for (const [, name, body] of consumers) {
    const provision = body.indexOf('uses: ./.github/actions/prepare-wgpu-wasm');
    const recovery = body.indexOf('node scripts/ci/prepare-ci-inputs.mjs');
    assert.ok(
      provision >= 0 && provision < recovery,
      `${name}: source recovery lacks current WASM`,
    );
  }
});
