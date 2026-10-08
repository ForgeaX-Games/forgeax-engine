import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { filesUnder } from '../sdk-lib.mjs';
import { archiveEngineSource, assertSourceDependencyInventory } from '../sdk-source.mjs';

const execFileAsync = promisify(execFile);
const dependency = 'third_party/wgpu';

async function git(cwd, ...args) {
  const result = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' },
  });
  return result.stdout.trim();
}

async function commit(root, message) {
  await git(root, 'add', '.');
  await git(
    root,
    '-c',
    'user.name=SDK test',
    '-c',
    'user.email=sdk@example.invalid',
    'commit',
    '-qm',
    message,
  );
  return git(root, 'rev-parse', 'HEAD');
}

async function fixture(t) {
  const temporary = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-source-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const upstream = resolve(temporary, 'upstream');
  const root = resolve(temporary, 'engine');
  const destination = resolve(temporary, 'sdk/source/engine');
  for (const path of [upstream, root]) {
    await mkdir(path);
    await git(path, 'init', '-q');
  }
  await mkdir(resolve(upstream, 'wgpu/src'), { recursive: true });
  await writeFile(resolve(upstream, 'wgpu/src/lib.rs'), 'pub const VERSION: u32 = 1;\n');
  await writeFile(resolve(upstream, 'LICENSE.MIT'), 'upstream license\n');
  for (const path of ['Cargo.toml', 'LICENSE.APACHE', 'wgpu/Cargo.toml', 'naga/Cargo.toml']) {
    await mkdir(resolve(upstream, path, '..'), { recursive: true });
    await writeFile(resolve(upstream, path), 'upstream source contract\n');
  }
  const sourceCommit = await commit(upstream, 'upstream source');
  await git(root, 'submodule', 'add', upstream, dependency);
  const view = resolve(temporary, 'view');
  await mkdir(view);
  await git(view, 'init', '-q');
  for (const path of ['package.json', 'LICENSE', 'host.pack.json', 'scripts/build-tool.mjs']) {
    await mkdir(resolve(view, path, '..'), { recursive: true });
    await writeFile(resolve(view, path), path === 'LICENSE' ? 'Apache-2.0 View license\n' : '{}\n');
  }
  const viewCommit = await commit(view, 'independent View source');
  await git(root, 'submodule', 'add', view, 'tools/view');
  await writeFile(resolve(root, 'engine.txt'), 'engine revision 1\n');
  const engineCommit = await commit(root, 'pin dependency');
  return { root, destination, upstream, sourceCommit, viewCommit, engineCommit };
}

test('SDK archives the Engine gitlink revision, including licenses, without remote access', async (t) => {
  const context = await fixture(t);
  const { root, destination, upstream, engineCommit, sourceCommit, viewCommit } = context;
  const checkout = resolve(root, dependency);
  await writeFile(resolve(checkout, 'wgpu/src/lib.rs'), 'pub const VERSION: u32 = 2;\n');
  await commit(checkout, 'unselected newer source');
  await writeFile(resolve(checkout, 'untracked.txt'), 'must not ship\n');
  await rm(upstream, { recursive: true });
  const sources = await archiveEngineSource({ root, destination, commit: engineCommit });
  assert.equal(
    await readFile(resolve(destination, dependency, 'wgpu/src/lib.rs'), 'utf8'),
    'pub const VERSION: u32 = 1;\n',
  );
  assert.equal(
    await readFile(resolve(destination, dependency, 'LICENSE.MIT'), 'utf8'),
    'upstream license\n',
  );
  assert.deepEqual(sources, [
    { root: dependency, commit: sourceCommit },
    { root: 'tools/view', commit: viewCommit },
  ]);
  assert.equal(
    await readFile(resolve(destination, 'tools/view/LICENSE'), 'utf8'),
    'Apache-2.0 View license\n',
  );
  for (const path of ['.git', '.gitmodules', `${dependency}/.git`, `${dependency}/untracked.txt`]) {
    await assert.rejects(readFile(resolve(destination, path)), { code: 'ENOENT' });
  }
  await rm(root, { recursive: true });
  assert.equal(
    await readFile(resolve(destination, dependency, 'wgpu/src/lib.rs'), 'utf8'),
    'pub const VERSION: u32 = 1;\n',
  );
});

test('SDK export fails when the pinned dependency has not been initialized', async (t) => {
  const { root, destination, engineCommit } = await fixture(t);
  await git(root, 'submodule', 'deinit', '--force', '--', dependency);
  await assert.rejects(
    archiveEngineSource({ root, destination, commit: engineCommit }),
    /sdk-source-git-dependency/,
  );
});

test('public View source has a JS/license closure while wgpu retains its Rust closure', async (t) => {
  const { root, destination, engineCommit } = await fixture(t);
  const gitDependencies = await archiveEngineSource({ root, destination, commit: engineCommit });
  const source = { root: 'source/engine', gitDependencies };
  const artifacts = (await filesUnder(destination)).map((path) => ({
    path: `${source.root}/${relative(destination, path).split('\\').join('/')}`,
  }));
  assert.doesNotThrow(() => assertSourceDependencyInventory(source, artifacts));
  await assert.rejects(readFile(resolve(destination, 'tools/view/Cargo.toml')), { code: 'ENOENT' });
  for (const required of ['tools/view/LICENSE', 'third_party/wgpu/wgpu/src/lib.rs']) {
    assert.throws(
      () =>
        assertSourceDependencyInventory(
          source,
          artifacts.filter((entry) => entry.path !== `${source.root}/${required}`),
        ),
      { message: `sdk-source-git-dependency-incomplete: ${required}` },
    );
  }
});
