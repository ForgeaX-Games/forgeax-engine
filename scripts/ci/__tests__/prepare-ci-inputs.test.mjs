import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { appPackages } from '../../build-task-cache.mjs';
import { prepareInputs, sourceAppBuilds } from '../prepare-ci-inputs.mjs';

test('Bun input fallback runs pnpm commands without replacing the installed dependency tree', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const job = workflow.slice(workflow.indexOf('\n  portability-bun:'));
  const jobEnvironment = job.slice(
    job.indexOf('\n    env:'),
    job.indexOf('\n    timeout-minutes:'),
  );
  const policy = jobEnvironment.match(/^ {6}pnpm_config_verify_deps_before_run: '([^']+)'$/m)?.[1];
  const root = mkdtempSync(join(tmpdir(), 'forgeax-bun-inputs-'));
  try {
    const packageManager = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).packageManager;
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'bun-input-fallback',
        private: true,
        packageManager,
        dependencies: { 'fixture-dep': 'file:./dep' },
        scripts: {
          build: 'node -e "require(\'fixture-dep\')"',
          postinstall: "node -e \"require('node:fs').writeFileSync('unexpected-install', '1')\"",
        },
      }),
    );
    mkdirSync(join(root, 'dep'));
    writeFileSync(
      join(root, 'dep/package.json'),
      JSON.stringify({ name: 'fixture-dep', version: '1.0.0', main: 'index.cjs' }),
    );
    writeFileSync(join(root, 'dep/index.cjs'), 'module.exports = 1;');
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(join(root, 'dep'), join(root, 'node_modules/fixture-dep'), 'dir');
    const env = { ...process.env, CI: 'true' };
    delete env.pnpm_config_verify_deps_before_run;
    if (policy !== undefined) env.pnpm_config_verify_deps_before_run = policy;
    const result = spawnSync('pnpm', ['run', 'build'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    assert.equal(
      existsSync(join(root, 'unexpected-install')),
      false,
      'pnpm reinstalled Bun dependencies',
    );
    assert.equal(
      existsSync(join(root, 'pnpm-lock.yaml')),
      false,
      'pnpm rewrote the dependency authority',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const reason of [
  'HTTP 404 artifact expired',
  'product SHA mismatch',
  'digest mismatch',
  'artifact acceleration budget exhausted',
]) {
  test(`${reason}: discard acceleration and verify the source rebuild`, async () => {
    const calls = [];
    const result = await prepareInputs({
      restore: async () => {
        throw new Error(reason);
      },
      publish: async () => calls.push('publish'),
      rebuild: async () => calls.push('build'),
      verify: async (source) => calls.push(`verify:${source}`),
    });
    assert.deepEqual(calls, ['build', 'verify:build']);
    assert.equal(result.source, 'build');
  });
}

test('verified acceleration is published once without a rebuild', async () => {
  const calls = [];
  const result = await prepareInputs({
    restore: async () => true,
    verify: async (source) => calls.push(source),
    publish: async () => calls.push('publish'),
    rebuild: async () => assert.fail('unexpected rebuild'),
  });
  assert.deepEqual(calls, ['restore', 'publish']);
  assert.equal(result.source, 'artifact');
});

test('incomplete restored inputs never publish and a broken source build stays red', async () => {
  const calls = [];
  await assert.rejects(
    prepareInputs({
      restore: async () => true,
      verify: async () => {
        throw new Error('missing required input');
      },
      publish: async () => calls.push('publish'),
      rebuild: async () => {
        calls.push('build');
        throw new Error('source compile failed');
      },
    }),
    /source compile failed/,
  );
  assert.deepEqual(calls, ['build']);
});

test('cancellation never starts a fallback build', async () => {
  await assert.rejects(
    prepareInputs({
      restore: async () => {
        throw Object.assign(new Error('cancelled'), { cancelled: true });
      },
      verify: async () => assert.fail(),
      publish: async () => assert.fail(),
      rebuild: async () => assert.fail(),
    }),
    /cancelled/,
  );
});

test('source fallback selects only declared roots and rejects empty or unknown scope', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-ci-source-apps-'));
  try {
    for (const app of ['apps/hello/triangle', 'apps/hello-collision/example', 'apps/bevy/sprite']) {
      mkdirSync(join(root, app), { recursive: true });
      writeFileSync(join(root, app, 'package.json'), '{"scripts":{"build":"fixture"}}');
    }
    assert.deepEqual(sourceAppBuilds(root, { sourceAppRoots: ['apps/hello'] }).apps, [
      'apps/hello/triangle',
    ]);
    assert.deepEqual(sourceAppBuilds(root, { sourceAppRoots: ['apps/hello/triangle'] }).apps, [
      'apps/hello/triangle',
    ]);
    for (const sourceAppRoots of [
      undefined,
      [],
      ['apps/missing'],
      ['apps/../hello'],
      ['hello'],
      ['apps/hello/'],
    ]) {
      assert.throws(
        () => sourceAppBuilds(root, { sourceAppRoots }),
        /sourceAppRoots|no buildable apps/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('real artifact consumers retain the complete hello/learn-render fleet and one benchmark app', () => {
  const contract = JSON.parse(readFileSync('scripts/ci/build-artifact-contract.json'));
  for (const consumer of Object.values(contract.consumers)) {
    if (consumer.requiredArtifactClasses.some((name) => name.startsWith('app-dist-'))) {
      assert.ok(sourceAppBuilds(process.cwd(), consumer).apps.length > 0);
    }
  }
  assert.deepEqual(
    sourceAppBuilds(process.cwd(), contract.consumers['multithread-browser-benchmark']).apps,
    ['apps/hello/multithreaded-execution'],
  );
  const fleet = sourceAppBuilds(process.cwd(), contract.consumers['smoke-fleet']);
  const all = appPackages(process.cwd()).map((app) => app.relativeDirectory);
  assert.deepEqual(
    fleet.apps,
    all.filter((app) =>
      fleet.roots.some((prefix) => app === prefix || app.startsWith(`${prefix}/`)),
    ),
  );
  assert.ok(fleet.apps.length < all.length);
});

test('source app recovery covers every Smoke gate without building unrelated fleets', () => {
  const contract = JSON.parse(readFileSync('scripts/ci/build-artifact-contract.json', 'utf8'));
  const apps = new Set(sourceAppBuilds(process.cwd(), contract.consumers['smoke-fleet']).apps);
  const roster = JSON.parse(readFileSync('scripts/ci/dawn-smoke-roster.json', 'utf8'));
  for (const entry of roster.entries) {
    if (entry.gates.some((gate) => gate.executionClass !== 'excluded')) {
      assert.ok(apps.has(entry.path.replace(/\/package\.json$/, '')), entry.path);
    }
  }
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const smoke = workflow.slice(
    workflow.indexOf('\n  smoke-fleet:'),
    workflow.indexOf('\n  smoke-fleet-required-context:'),
  );
  const manifests = new Map(
    globSync(['apps/**/package.json', 'packages/*/package.json'], {
      exclude: ['**/node_modules/**', '**/dist/**'],
    }).map((path) => {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      return [manifest.name, { manifest, app: path.replace(/\/package\.json$/, '') }];
    }),
  );
  for (const match of smoke.matchAll(
    /pnpm --filter ['"]?(@forgeax\/[^\s'"\n]+)['"]? (?:build|smoke(?:[\w:-]*))/g,
  )) {
    const entry = manifests.get(match[1]);
    assert.ok(entry, `unknown explicit Smoke package: ${match[1]}`);
    if (entry.app.startsWith('apps/') && entry.manifest.scripts?.build)
      assert.ok(apps.has(entry.app), `missing explicit Smoke input: ${match[1]}`);
  }
  assert.equal(
    [...apps].some((app) => app.startsWith('apps/bevy/')),
    false,
  );
  assert.deepEqual(
    [...apps].filter((app) => app.startsWith('apps/perf/')),
    ['apps/perf/10k-cubes-lights', 'apps/perf/shadow-stress'],
  );
  assert.deepEqual(
    sourceAppBuilds(process.cwd(), contract.consumers['multithread-browser-benchmark']).apps,
    ['apps/hello/multithreaded-execution'],
  );
  assert.throws(() => sourceAppBuilds(process.cwd(), {}), /requires valid/);
  assert.throws(
    () => sourceAppBuilds(process.cwd(), { sourceAppRoots: ['apps/not-a-real-input'] }),
    /no buildable apps/,
  );
});
