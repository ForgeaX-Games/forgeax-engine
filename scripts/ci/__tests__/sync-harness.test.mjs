// sync-harness.test.mjs — divergence is a warning by default and a failure only
// when an explicit strict-mode opt-in is present.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const sourcePath = resolve('scripts/sync-harness.mjs');

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'sync-harness-'));
  const scriptDir = join(root, 'scripts');
  const harnessDir = join(root, '.forgeax-harness');
  const binDir = join(root, 'bin');
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(harnessDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(scriptDir, 'sync-harness.mjs'), readFileSync(sourcePath, 'utf8'));
  writeFileSync(join(harnessDir, '.git'), 'gitdir: /tmp/sync-harness-fixture\n');

  // The real script must observe a successful fetch, an ff-only refusal, and
  // a local-ahead count without touching a real repository.
  const fakeGit = join(binDir, 'git');
  writeFileSync(
    fakeGit,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('fetch')) process.exit(0);
if (args.includes('merge')) {
  process.stderr.write('fatal: Not possible to fast-forward, aborting.\\n');
  process.exit(1);
}
if (args.includes('rev-list')) {
  process.stdout.write('60\\n');
  process.exit(0);
}
process.exit(0);
`,
  );
  chmodSync(fakeGit, 0o755);
  return { root, script: join(scriptDir, 'sync-harness.mjs'), binDir };
}

function runFixture(strict) {
  const fixture = makeFixture();
  try {
    const result = spawnSync(process.execPath, [fixture.script], {
      cwd: fixture.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH ?? ''}`,
        FORGEAX_HARNESS_TOKEN: 'fixture-token',
        FORGEAX_HARNESS_STRICT: strict ? '1' : '0',
      },
    });
    return result;
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('warns and skips a divergent clone by default', () => {
  const result = runFixture(false);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /warning: FORGEAX_HARNESS_DIVERGED/);
  assert.match(result.stderr, /FORGEAX_HARNESS_STRICT=1/);
});

test('fails a divergent clone only in explicit strict mode', () => {
  const result = runFixture(true);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /FORGEAX_HARNESS_DIVERGED/);
});
