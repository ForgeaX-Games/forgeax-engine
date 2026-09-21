import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../build-sdk.mjs', import.meta.url), 'utf8');
const runner = source.slice(
  source.indexOf('async function run('),
  source.indexOf('\nasync function git('),
);

test('SDK command failures retain diagnostics beyond the Node inspection limit', async () => {
  const failure = Object.assign(new Error('compiler exited with code 2'), {
    code: 2,
    stdout: `${'build output\n'.repeat(5000)}error TS2375: invalid asset GUID\n`,
    stderr: 'declaration build failed\n',
  });
  const stdout = [];
  const stderr = [];
  const run = runInNewContext(`${runner}\nrun`, {
    execFileAsync: async () => {
      throw failure;
    },
    root: '/source',
    process: {
      env: {},
      stdout: { write: (chunk) => stdout.push(chunk) },
      stderr: { write: (chunk) => stderr.push(chunk) },
    },
  });
  await assert.rejects(run('pnpm', ['build:engine']), (error) => error === failure);
  assert.equal(stdout.join(''), failure.stdout);
  assert.equal(stderr.join(''), failure.stderr);
});
