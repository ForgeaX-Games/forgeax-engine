import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('keeps the real project test reporter and test console off JSON stdout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-test-output-'));
  try {
    await symlink(
      fileURLToPath(new URL('../../node_modules', import.meta.url)),
      join(root, 'node_modules'),
      'dir',
    );
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'test-output', type: 'module' }),
    );
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        id: 'test-output',
        name: 'Test output',
        roots: {},
      }),
    );
    await writeFile(
      join(root, 'example.test.js'),
      "import { it } from 'vitest'; it('real user test', () => { console.log('test diagnostic'); });",
    );
    const result = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url)),
        'project',
        'test',
        '--root',
        root,
        '--json',
      ],
      { env: { ...process.env, FORGEAX_DISABLE_UPDATE_CHECK: '1' } },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, command: 'project test' });
    expect(result.stderr).toContain('test diagnostic');
    expect(result.stderr).toContain('passed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
