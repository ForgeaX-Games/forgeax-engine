import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appPackages } from '../build-task-cache.mjs';
import {
  createViteBuildInvocation,
  resolveViteCli,
  validateCanonicalAppBuild,
  validateCanonicalAppBuilds,
} from '../lib/app-build-launcher.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('resolves the installed Vite CLI from the repository package manifest', () => {
  const cliPath = resolveViteCli(repoRoot);
  assert.equal(cliPath, realpathSync(resolve(repoRoot, 'node_modules/vite/bin/vite.js')));
  assert.equal(existsSync(cliPath), true);
});

test('the discovered app fleet uses the canonical Vite build script', () => {
  const apps = appPackages(repoRoot);
  assert.equal(apps.length, 189);
  validateCanonicalAppBuilds(apps);
});

test('rejects an app build script outside the canonical fleet contract', () => {
  assert.throws(
    () =>
      validateCanonicalAppBuild({ manifest: { name: '@fixture/app', scripts: { build: 'true' } } }),
    /unsupported build script for @fixture\/app: expected "vite build", received "true"/,
  );
});

test('build invocation preserves app cwd, explicit environment, and direct Node CLI shape', () => {
  const invocation = createViteBuildInvocation({
    app: { directory: '/tmp/fixture-app', manifest: { name: '@fixture/app' } },
    viteCliPath: '/repo/node_modules/vite/bin/vite.js',
    sharedInputManifest: '/repo/shared-build-inputs/manifest.json',
    appFactsDir: '/tmp/facts',
    baseEnv: { KEEP_ME: 'yes' },
  });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ['/repo/node_modules/vite/bin/vite.js', 'build']);
  assert.deepEqual(invocation.options, {
    cwd: '/tmp/fixture-app',
    stdio: 'inherit',
    shell: false,
    env: {
      KEEP_ME: 'yes',
      FORGEAX_SHARED_APP_INPUTS_MANIFEST: '/repo/shared-build-inputs/manifest.json',
      FORGEAX_BUILD_METRICS_DIR: '/tmp/facts',
    },
  });
});
