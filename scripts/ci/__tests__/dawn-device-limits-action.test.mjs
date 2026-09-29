import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

const dawnPrepareAction = readFileSync(
  resolve('.github/actions/prepare-dawn-device-limits/action.yml'),
  'utf8',
);
const packageManifest = readFileSync(resolve('package.json'), 'utf8');

test('Dawn wrapper preserves short-lived pnpm child diagnostics and exit status', () => {
  const root = resolve('.');
  const temporary = mkdtempSync(resolve(tmpdir(), 'forgeax-dawn-wrapper-'));
  try {
    const install = dawnPrepareAction
      .split('      run: |\n')[1]
      .split('\n    - name:')[0]
      .split('\n')
      .map((line) => line.slice(8))
      .join('\n');
    const environment = {
      ...process.env,
      GITHUB_WORKSPACE: root,
      RUNNER_TEMP: temporary,
      GITHUB_PATH: resolve(temporary, 'github-path'),
      GITHUB_ENV: resolve(temporary, 'github-env'),
    };
    const installed = spawnSync('bash', ['-c', install], {
      cwd: root,
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(installed.status, 0, installed.stderr);
    writeFileSync(
      resolve(temporary, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: JSON.parse(packageManifest).packageManager,
        scripts: { fail: 'node fail.mjs' },
      }),
    );
    writeFileSync(
      resolve(temporary, 'fail.mjs'),
      "process.stdout.write('gate-start\\n'); process.stderr.write('gate-failed: path=src/example.ts actual=4097 expected=4096 hint=split-owner\\n'); process.exitCode = 1;\n",
    );
    const failed = spawnSync('bash', ['-c', 'pnpm run fail'], {
      cwd: temporary,
      env: {
        ...environment,
        BASH_ENV: resolve(temporary, 'forgeax-dawn-device-limits.env'),
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(failed.status, 1, failed.stderr);
    const output = failed.stdout + failed.stderr;
    assert.match(output, /gate-start/);
    assert.match(
      output,
      /gate-failed: path=src\/example\.ts actual=4097 expected=4096 hint=split-owner/,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
