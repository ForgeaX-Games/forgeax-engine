import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { expect, it } from 'vitest';
import { createRunSnapshot, snapshotDirectoryInsideProject } from '../run-snapshot.js';

it('copies a linked package payload without its repository fixtures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-package-'));
  try {
    const project = join(directory, 'project');
    const dependency = join(directory, 'dependency');
    await mkdir(join(project, 'node_modules'), { recursive: true });
    await mkdir(join(dependency, 'dist'), { recursive: true });
    await mkdir(join(dependency, 'assets'));
    await mkdir(join(dependency, 'fixtures'));
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ dependencies: { fixture: '*' } }),
    );
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({
        name: 'fixture',
        main: './dist/index.js',
        files: ['dist', 'assets/*.bin', '!assets/ignored.bin'],
      }),
    );
    await writeFile(join(dependency, '.gitignore'), 'dist\n');
    await writeFile(join(dependency, 'dist/index.js'), 'export const value = 1;');
    await writeFile(join(dependency, 'assets/lazy.bin'), 'lazy runtime asset');
    await writeFile(join(dependency, 'assets/ignored.bin'), 'unpublished asset');
    await writeFile(join(dependency, 'fixtures/large-scene.bin'), 'repository-only fixture');
    await symlink(dependency, join(project, 'node_modules/fixture'), 'junction');
    const snapshot = await createRunSnapshot(project, join(directory, 'snapshot'));
    await rm(dependency, { recursive: true, force: true });
    const copied = join(snapshot.root, 'node_modules/fixture');
    expect(await readFile(join(copied, 'dist/index.js'), 'utf8')).toContain('value = 1');
    expect(await readFile(join(copied, 'assets/lazy.bin'), 'utf8')).toBe('lazy runtime asset');
    await expect(access(join(copied, 'assets/ignored.bin'))).rejects.toThrow();
    await expect(access(join(copied, 'fixtures'))).rejects.toThrow();
    await snapshot.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not traverse agent tooling mounts in projects or linked packages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-tooling-'));
  try {
    const project = join(directory, 'project');
    const dependency = join(directory, 'dependency');
    await mkdir(join(project, 'node_modules'), { recursive: true });
    await mkdir(dependency);
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ dependencies: { fixture: '*' } }),
    );
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture' }));
    await writeFile(join(dependency, 'index.js'), 'export const value = 1;');
    await symlink(dependency, join(project, 'node_modules/fixture'), 'junction');
    for (const root of [project, dependency]) {
      for (const name of ['.agents', '.claude', '.codex']) {
        // A tooling mount must not be read, even when its target is unavailable.
        await symlink(join(directory, 'unavailable-tooling'), join(root, name), 'junction');
      }
    }
    const snapshot = await createRunSnapshot(project, join(directory, 'snapshot'));
    expect(await readFile(join(snapshot.root, 'node_modules/fixture/index.js'), 'utf8')).toContain(
      'value = 1',
    );
    for (const name of ['.agents', '.claude', '.codex']) {
      await expect(access(join(snapshot.root, name))).rejects.toThrow();
      await expect(access(join(snapshot.root, 'node_modules/fixture', name))).rejects.toThrow();
    }
    await snapshot.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('cancels snapshot preparation and removes partial output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-cancel-'));
  try {
    const project = join(directory, 'project');
    const output = join(directory, 'snapshot');
    await mkdir(project);
    await writeFile(join(project, 'package.json'), '{}');
    await writeFile(join(project, 'asset.bin'), Buffer.alloc(16 * 1024 * 1024, 7));
    const controller = new AbortController();
    const reason = new Error('snapshot cancelled by caller');
    const task = createRunSnapshot(project, output, controller.signal);
    const rejected = expect(task).rejects.toThrow(/abort|cancel/i);
    // Cancel after copying has started, rather than only testing an aborted input.
    await expect
      .poll(
        () =>
          access(join(output, 'project/asset.bin')).then(
            () => true,
            () => false,
          ),
        { interval: 1, timeout: 2000 },
      )
      .toBe(true);
    controller.abort(reason);
    await rejected;
    await expect(access(output)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('pins dirty project files, lazy assets and resolved linked dependencies after source deletion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-'));
  const project = join(directory, 'author');
  const dependency = join(directory, 'dependency');
  try {
    await mkdir(join(project, 'node_modules'), { recursive: true });
    await mkdir(dependency);
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ dependencies: { fixture: '1.0.0' } }),
    );
    await writeFile(join(project, 'late-asset.txt'), 'original dirty bytes');
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { fixture: '1.0.0' } }),
    );
    await writeFile(join(dependency, 'index.js'), 'export const value = 1;');
    await mkdir(join(dependency, 'node_modules'));
    await symlink(dependency, join(dependency, 'node_modules/fixture'), 'junction');
    await symlink(dependency, join(project, 'node_modules/fixture'), 'junction');
    const first = await createRunSnapshot(project, join(directory, 'first'));
    await writeFile(join(project, 'late-asset.txt'), 'next version');
    await writeFile(join(dependency, 'index.js'), 'export const value = 2;');
    const next = await createRunSnapshot(project, join(directory, 'next'));
    expect(next.version).not.toBe(first.version);
    await rm(project, { recursive: true, force: true });
    await rm(dependency, { recursive: true, force: true });
    expect(await readFile(join(first.root, 'late-asset.txt'), 'utf8')).toBe('original dirty bytes');
    expect(await readFile(join(first.root, 'node_modules/fixture/index.js'), 'utf8')).toContain(
      'value = 1',
    );
    expect(
      await readFile(
        join(first.root, 'node_modules/fixture/node_modules/fixture/index.js'),
        'utf8',
      ),
    ).toContain('value = 1');
    expect(await readFile(join(next.root, 'late-asset.txt'), 'utf8')).toBe('next version');
    await first.dispose();
    await next.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('fails closed and removes partial snapshots when a declared dependency is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-snapshot-'));
  try {
    await mkdir(join(directory, 'project'));
    await writeFile(
      join(directory, 'project/package.json'),
      JSON.stringify({ dependencies: { 'missing-snapshot-fixture': '1' } }),
    );
    await expect(
      createRunSnapshot(join(directory, 'project'), join(directory, 'snapshot')),
    ).rejects.toThrow('not installed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('materializes a selected local Engine binding instead of the installed registry package', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'engine-binding-snapshot-'));
  const project = join(directory, 'project');
  const workspace = join(directory, 'local-engine');
  const localPackage = join(workspace, 'packages/engine');
  const installed = join(project, 'node_modules/@forgeax/engine');
  try {
    await mkdir(join(project, '.forgeax'), { recursive: true });
    await mkdir(localPackage, { recursive: true });
    await mkdir(installed, { recursive: true });
    await writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n');
    const manifest = JSON.stringify({
      name: '@forgeax/engine',
      version: '1.0.0',
      main: './index.js',
    });
    await writeFile(join(localPackage, 'package.json'), manifest);
    await writeFile(join(localPackage, 'index.js'), 'export const owner = "local";');
    await writeFile(join(installed, 'package.json'), manifest);
    await writeFile(join(installed, 'index.js'), 'export const owner = "registry";');
    await writeFile(
      join(project, 'package.json'),
      JSON.stringify({ dependencies: { '@forgeax/engine': '1.0.0' } }),
    );
    await writeFile(
      join(project, '.forgeax/engine-binding.json'),
      JSON.stringify({ schemaVersion: '1.0.0', path: workspace }),
    );
    const snapshot = await createRunSnapshot(project, join(directory, 'snapshot'));
    await rm(workspace, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    expect(
      await readFile(join(snapshot.root, 'node_modules/@forgeax/engine/index.js'), 'utf8'),
    ).toContain('"local"');
    await snapshot.dispose();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects a snapshot directory stored inside the project', async () => {
  const project = await mkdtemp(join(tmpdir(), 'engine-snapshot-inside-'));
  try {
    await expect(createRunSnapshot(project, join(project, 'snapshot'))).rejects.toThrow(
      'outside the project inputs',
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

it('treats another Windows volume as outside the project inputs', () => {
  expect(
    snapshotDirectoryInsideProject('E:\\game', 'C:\\Users\\Temp\\forgeax-editor-play-x', win32),
  ).toBe(false);
  expect(snapshotDirectoryInsideProject('E:\\game', 'E:\\game', win32)).toBe(true);
  expect(snapshotDirectoryInsideProject('E:\\game', 'E:\\game\\snapshot', win32)).toBe(true);
  expect(snapshotDirectoryInsideProject('E:\\game', 'E:\\other\\snapshot', win32)).toBe(false);
  expect(snapshotDirectoryInsideProject('E:\\game', 'E:\\game-extra\\snapshot', win32)).toBe(false);
});
