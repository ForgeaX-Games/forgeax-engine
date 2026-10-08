// sync-harness.test.mjs — divergence is a warning by default and a failure only
// when an explicit strict-mode opt-in is present.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const sourcePath = resolve('scripts/sync-harness.mjs');

function writeSyncScript(destination, source = readFileSync(sourcePath, 'utf8')) {
  const lib = resolve(destination, '..', 'lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(
    join(lib, 'shared-harness.mjs'),
    readFileSync(resolve('scripts/lib/shared-harness.mjs')),
  );
  writeFileSync(destination, source);
}

test('linked-worktree install shares the primary Harness without changing it', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sync-harness-linked-')));
  try {
    const primary = join(root, 'engine');
    const linked = join(root, 'linked');
    const harness = join(primary, '.forgeax-harness');
    mkdirSync(join(primary, 'scripts'), { recursive: true });
    mkdirSync(harness);
    const config = join(root, 'gitconfig');
    writeFileSync(config, '');
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
      FORGEAX_HARNESS_TOKEN: 'fixture-token',
      FORGEAX_HARNESS_STRICT: '0',
      FORGEAX_HARNESS_SPARSE_DOCS: '0',
      FORGEAX_SKIP_HARNESS_SYNC: '',
    };
    const git = (cwd, ...args) => {
      const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const commit = (cwd) => {
      git(cwd, 'add', '.');
      git(
        cwd,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-m',
        'fixture',
      );
    };
    git(harness, 'init', '--initial-branch=main');
    writeFileSync(join(harness, 'README.md'), 'shared Harness\n');
    commit(harness);
    writeFileSync(join(harness, 'unpublished.bin'), Buffer.alloc(1024 * 1024, 7));
    const harnessHead = git(harness, 'rev-parse', 'HEAD');
    const script = readFileSync(sourcePath, 'utf8').replace(
      'https://github.com/ForgeaX-Games/forgeax-engine-harness.git',
      pathToFileURL(harness).href,
    );
    writeSyncScript(join(primary, 'scripts/sync-harness.mjs'), script);
    writeFileSync(join(primary, '.gitignore'), '.forgeax-harness/\n');
    git(primary, 'init', '--initial-branch=main');
    commit(primary);
    git(primary, 'worktree', 'add', '--detach', linked);
    for (let run = 0; run < 2; run++) {
      const result = spawnSync(process.execPath, [join(linked, 'scripts/sync-harness.mjs')], {
        cwd: linked,
        env,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(lstatSync(join(linked, '.forgeax-harness')).isSymbolicLink(), true);
      assert.equal(realpathSync(join(linked, '.forgeax-harness')), harness);
      assert.equal(git(harness, 'rev-parse', 'HEAD'), harnessHead);
      assert.equal(readFileSync(join(harness, 'unpublished.bin')).length, 1024 * 1024);
      assert.match(result.stdout, /shared primary/);
    }
    const freshPrimary = join(root, 'fresh-engine');
    const freshLinked = join(root, 'fresh-linked');
    mkdirSync(join(freshPrimary, 'scripts'), { recursive: true });
    writeSyncScript(join(freshPrimary, 'scripts/sync-harness.mjs'), script);
    writeFileSync(join(freshPrimary, '.gitignore'), '.forgeax-harness/\n');
    git(freshPrimary, 'init', '--initial-branch=main');
    commit(freshPrimary);
    git(freshPrimary, 'worktree', 'add', '--detach', freshLinked);
    const firstInstall = spawnSync(
      process.execPath,
      [join(freshLinked, 'scripts/sync-harness.mjs')],
      {
        cwd: freshLinked,
        env,
        encoding: 'utf8',
      },
    );
    assert.equal(firstInstall.status, 0, firstInstall.stderr);
    assert.equal(existsSync(join(freshPrimary, '.forgeax-harness/.git')), true);
    assert.equal(lstatSync(join(freshLinked, '.forgeax-harness')).isSymbolicLink(), true);
    assert.equal(
      realpathSync(join(freshLinked, '.forgeax-harness')),
      join(freshPrimary, '.forgeax-harness'),
    );

    const upstream = join(root, 'upstream');
    git(root, 'clone', pathToFileURL(harness).href, upstream);
    git(harness, 'remote', 'add', 'origin', pathToFileURL(upstream).href);
    writeFileSync(join(upstream, 'README.md'), 'upstream Harness revision\n');
    commit(upstream);
    writeFileSync(join(harness, 'README.md'), 'unpublished Harness revision\n');
    commit(harness);
    const unpublishedHead = git(harness, 'rev-parse', 'HEAD');
    const strict = spawnSync(process.execPath, [join(linked, 'scripts/sync-harness.mjs')], {
      cwd: linked,
      env: { ...env, FORGEAX_HARNESS_STRICT: '1' },
      encoding: 'utf8',
    });
    assert.equal(strict.status, 1, strict.stdout + strict.stderr);
    assert.match(strict.stderr, /FORGEAX_HARNESS_DIVERGED/);
    assert.equal(git(harness, 'rev-parse', 'HEAD'), unpublishedHead);

    const reportCheckout = join(linked, '.forgeax-harness');
    unlinkSync(reportCheckout);
    git(harness, 'worktree', 'add', '-b', 'report/private', reportCheckout);
    writeFileSync(join(reportCheckout, 'private-report.txt'), 'private report\n');
    const reportStatus = git(reportCheckout, 'status', '--porcelain=v1');
    const reportSync = spawnSync(process.execPath, [join(linked, 'scripts/sync-harness.mjs')], {
      cwd: linked,
      env,
      encoding: 'utf8',
    });
    assert.equal(reportSync.status, 0, reportSync.stderr);
    assert.match(reportSync.stdout, /shared primary/);
    assert.equal(git(reportCheckout, 'branch', '--show-current'), 'report/private');
    assert.equal(git(reportCheckout, 'status', '--porcelain=v1'), reportStatus);
    assert.equal(
      readFileSync(join(reportCheckout, 'private-report.txt'), 'utf8'),
      'private report\n',
    );
    assert.equal(git(harness, 'rev-parse', 'HEAD'), unpublishedHead);
    git(harness, 'worktree', 'remove', '--force', reportCheckout);

    // An already-owned clone must retain its own identity and private data.
    const independent = join(linked, '.forgeax-harness');
    git(root, 'clone', pathToFileURL(upstream).href, independent);
    writeFileSync(join(independent, 'private.txt'), 'independent owner\n');
    const resync = spawnSync(process.execPath, [join(linked, 'scripts/sync-harness.mjs')], {
      cwd: linked,
      env,
      encoding: 'utf8',
    });
    assert.equal(resync.status, 0, resync.stderr);
    assert.match(resync.stderr, /independent Harness/);
    assert.equal(lstatSync(independent).isSymbolicLink(), false);
    assert.equal(readFileSync(join(independent, 'private.txt'), 'utf8'), 'independent owner\n');
    assert.equal(git(harness, 'rev-parse', 'HEAD'), unpublishedHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'sync-harness-'));
  const scriptDir = join(root, 'scripts');
  const harnessDir = join(root, '.forgeax-harness');
  const binDir = join(root, 'bin');
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(harnessDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeSyncScript(join(scriptDir, 'sync-harness.mjs'));
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

test('native Git clone and resync leave LFS payloads as pointers', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-harness-lfs-'));
  try {
    const upstream = join(root, 'upstream');
    const consumer = join(root, 'consumer');
    const scriptDir = join(consumer, 'scripts');
    const config = join(root, 'gitconfig');
    const filter = join(root, 'lfs-filter.mjs');
    const hydrated = join(root, 'hydrated');
    mkdirSync(upstream);
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(config, '');
    writeFileSync(
      filter,
      `
import { readFileSync, writeFileSync } from 'node:fs';
const input = readFileSync(0);
if (process.argv[2] === 'smudge' && process.env.GIT_LFS_SKIP_SMUDGE !== '1') {
  writeFileSync(${JSON.stringify(hydrated)}, 'unexpected payload download');
  process.exit(1);
}
process.stdout.write(input);
`,
    );
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
      // Sync owns the on-demand policy even when a caller enables hydration.
      GIT_LFS_SKIP_SMUDGE: '0',
      FORGEAX_HARNESS_TOKEN: 'fixture-token',
      FORGEAX_HARNESS_STRICT: '1',
      FORGEAX_HARNESS_SPARSE_DOCS: '0',
      FORGEAX_SKIP_HARNESS_SYNC: '',
    };
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: upstream, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git('init', '--initial-branch=main');
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 10485760\n`;
    writeFileSync(join(upstream, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    writeFileSync(join(upstream, 'capture.bin'), pointer);
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'fixture',
    );
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    git(
      'config',
      '--global',
      'filter.lfs.smudge',
      `${quote(process.execPath)} ${quote(filter)} smudge`,
    );
    git(
      'config',
      '--global',
      'filter.lfs.clean',
      `${quote(process.execPath)} ${quote(filter)} clean`,
    );
    git('config', '--global', 'filter.lfs.required', 'true');
    const script = join(scriptDir, 'sync-harness.mjs');
    writeSyncScript(
      script,
      readFileSync(sourcePath, 'utf8').replace(
        'https://github.com/ForgeaX-Games/forgeax-engine-harness.git',
        pathToFileURL(upstream).href,
      ),
    );
    for (let run = 0; run < 2; run++) {
      const result = spawnSync(process.execPath, [script], {
        cwd: consumer,
        env,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(hydrated), false, 'LFS payload hydration was attempted');
      assert.equal(
        readFileSync(join(consumer, '.forgeax-harness', 'capture.bin'), 'utf8'),
        pointer,
      );
      assert.match(result.stdout, run === 0 ? /cloned/ : /fast-forwarded/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sparse CI sync materializes requested docs without checking out invalid paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-harness-sparse-docs-'));
  try {
    const upstream = join(root, 'upstream');
    const consumer = join(root, 'consumer');
    const scriptDir = join(consumer, 'scripts');
    const config = join(root, 'gitconfig');
    mkdirSync(upstream);
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(config, '');

    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_LFS_SKIP_SMUDGE: '1',
      FORGEAX_HARNESS_TOKEN: 'fixture-token',
      FORGEAX_HARNESS_STRICT: '1',
      FORGEAX_HARNESS_SPARSE_DOCS: '1',
      FORGEAX_HARNESS_SPARSE_DOCS_PATHS: JSON.stringify(['docs/required.md']),
      FORGEAX_SKIP_HARNESS_SYNC: '',
    };
    const git = (cwd, ...args) => {
      const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git(upstream, 'init', '--initial-branch=main');
    git(
      upstream,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'config',
      'user.name',
      'Fixture',
    );
    git(
      upstream,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'config',
      'user.email',
      'fixture@example.test',
    );

    const requiredDoc = join(upstream, 'docs', 'required.md');
    const invalidPath = join(
      upstream,
      'reports',
      '2026-10-01-engine-patch-triage',
      'implementation',
      'hello-bloom-smoke:all.log',
    );
    mkdirSync(join(requiredDoc, '..'), { recursive: true });
    mkdirSync(join(invalidPath, '..'), { recursive: true });
    writeFileSync(requiredDoc, 'first revision\n');
    writeFileSync(invalidPath, 'must stay outside the worktree\n');
    git(upstream, 'add', '.');
    git(
      upstream,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'fixture docs with a Windows-invalid path',
    );

    const script = join(scriptDir, 'sync-harness.mjs');
    writeSyncScript(
      script,
      readFileSync(sourcePath, 'utf8').replace(
        'https://github.com/ForgeaX-Games/forgeax-engine-harness.git',
        pathToFileURL(upstream).href,
      ),
    );
    const run = () =>
      spawnSync(process.execPath, [script], {
        cwd: consumer,
        env,
        encoding: 'utf8',
      });

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /materialized 1 requested documentation file/, first.stderr);
    assert.equal(
      readFileSync(join(consumer, '.forgeax-harness', 'docs', 'required.md'), 'utf8'),
      'first revision\n',
    );
    assert.equal(
      existsSync(join(consumer, '.forgeax-harness', 'reports')),
      false,
      'sparse sync checked out an unrelated report path',
    );

    writeFileSync(requiredDoc, 'second revision\n');
    git(upstream, 'add', '.');
    git(
      upstream,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'update required doc',
    );

    const second = run();
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.match(second.stdout, /refreshed requested documentation from origin\/main/);
    assert.match(second.stdout, /materialized 1 requested documentation file/);
    assert.equal(
      readFileSync(join(consumer, '.forgeax-harness', 'docs', 'required.md'), 'utf8'),
      'second revision\n',
    );
    assert.equal(existsSync(join(consumer, '.forgeax-harness', 'reports')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
