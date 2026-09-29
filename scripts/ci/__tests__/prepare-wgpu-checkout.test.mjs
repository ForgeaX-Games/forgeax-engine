import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const script = resolve(import.meta.dirname, '../prepare-wgpu-checkout.mjs');

test('wgpu preparation restores the Engine pin without accessing unrelated private submodules', (t) => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'forgeax-wgpu-checkout-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const source = resolve(temporary, 'source');
  const root = resolve(temporary, 'engine');
  for (const path of [source, root]) {
    git(temporary, 'init', '-q', path);
    git(path, 'config', 'user.name', 'CI test');
    git(path, 'config', 'user.email', 'ci@example.invalid');
  }
  writeFileSync(resolve(source, 'source.rs'), 'pinned source\n');
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'source');
  const expected = git(source, 'rev-parse', 'HEAD');
  git(root, 'submodule', 'add', source, 'third_party/wgpu');
  git(root, 'config', '-f', '.gitmodules', 'submodule.assets.path', 'forgeax-engine-assets');
  git(
    root,
    'config',
    '-f',
    '.gitmodules',
    'submodule.assets.url',
    resolve(temporary, 'inaccessible-assets'),
  );
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${expected},forgeax-engine-assets`);
  git(root, 'add', '.gitmodules');
  git(root, 'commit', '-qm', 'pin');
  git(root, 'submodule', 'deinit', '--force', '--', 'third_party/wgpu');
  writeFileSync(resolve(source, 'source.rs'), 'newer unselected source\n');
  git(source, 'commit', '-qam', 'advance upstream');
  for (let index = 0; index < 2; index += 1) {
    const result = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { path: 'third_party/wgpu', commit: expected });
  }
  assert.equal(existsSync(resolve(root, 'forgeax-engine-assets/.git')), false);
});
