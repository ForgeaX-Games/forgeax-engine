import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  engineDoctorCommand,
  engineStatusCommand,
  engineUnlinkCommand,
  engineUseLocalCommand,
} from '../engine-binding.js';

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture(workspaceDependency = false): Promise<{
  readonly game: string;
  readonly engine: string;
}> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-engine-binding-'));
  const game = resolve(root, 'game');
  const engine = resolve(root, 'engine');
  await Promise.all([mkdir(game, { recursive: true }), mkdir(engine, { recursive: true })]);
  await Promise.all([
    mkdir(resolve(game, '.forgeax'), { recursive: true }),
    mkdir(resolve(engine, 'packages', 'engine', 'dist'), { recursive: true }),
    mkdir(resolve(engine, 'packages', 'engine-render', 'dist'), { recursive: true }),
    writeFile(resolve(engine, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n'),
    writeFile(resolve(game, 'main.ts'), 'export default {};\n'),
  ]);
  await writeJson(resolve(game, 'forge.json'), {
    id: 'binding-fixture',
    name: 'Binding Fixture',
    schemaVersion: '1.0.0',
    entry: 'main.ts',
    plugins: [],
  });
  await writeJson(resolve(game, 'package.json'), {
    name: 'binding-fixture',
    ...(workspaceDependency
      ? { dependencies: { '@forgeax/engine': 'workspace:*' } }
      : { forgeax: { assets: { roots: [] } } }),
  });
  for (const [directory, name] of [
    ['engine', '@forgeax/engine'],
    ['engine-render', '@forgeax/engine-render'],
  ] as const) {
    await writeJson(resolve(engine, 'packages', directory, 'package.json'), {
      name,
      version: '0.1.7',
      type: 'module',
      exports: { '.': './dist/index.mjs' },
    });
    await writeFile(resolve(engine, 'packages', directory, 'dist/index.mjs'), 'export {};\n');
  }
  return { game, engine };
}

describe('engine binding commands', () => {
  it('persists one local binding and returns to the SDK route on unlink', async () => {
    const { game, engine } = await fixture();
    const selected = await engineUseLocalCommand({ root: game, path: engine });
    expect(selected).toMatchObject({
      ok: true,
      value: {
        mode: 'local',
        binding: { path: expect.stringContaining('/engine') },
        resolved: { source: 'local', version: '0.1.7', built: true },
        workspace: {
          digest: expect.stringMatching(/^sha256:/),
          builtAt: expect.any(String),
          packages: [
            expect.objectContaining({
              entryDigest: expect.stringMatching(/^sha256:/),
              builtAt: expect.any(String),
            }),
            expect.objectContaining({
              entryDigest: expect.stringMatching(/^sha256:/),
              builtAt: expect.any(String),
            }),
          ],
        },
        healthy: true,
      },
    });
    await expect(engineDoctorCommand({ root: game })).resolves.toMatchObject({
      ok: true,
      value: { healthy: true },
    });

    const unlinked = await engineUnlinkCommand({ root: game });
    expect(unlinked).toMatchObject({
      ok: true,
      value: { mode: 'sdk', binding: null },
    });
    await expect(engineStatusCommand({ root: game })).resolves.toMatchObject({
      ok: true,
      value: { mode: 'sdk', healthy: false },
    });
  });

  it('derives workspace identity from built entry bytes', async () => {
    const { game, engine } = await fixture();
    const selected = await engineUseLocalCommand({ root: game, path: engine });
    if (!selected.ok || selected.value.workspace === null)
      throw new Error('fixture-binding-failed');
    const before = selected.value.workspace.digest;
    await writeFile(
      resolve(engine, 'packages', 'engine-render', 'dist', 'index.mjs'),
      'export const build = 2;\n',
    );
    const updated = await engineStatusCommand({ root: game });
    if (!updated.ok || updated.value.workspace === null) throw new Error('fixture-status-failed');
    expect(updated.value.workspace.digest).not.toBe(before);
  });

  it('fails npm doctor for a workspace dependency with a structured hint', async () => {
    const { game, engine } = await fixture(true);
    await expect(engineUseLocalCommand({ root: game, path: engine })).resolves.toMatchObject({
      ok: true,
      value: { healthy: true, projectDependencies: 'workspace' },
    });
    await expect(engineDoctorCommand({ root: game })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'engine-project-workspace-dependency',
        detail: { projectDependencies: 'workspace' },
      },
    });
  });
});
