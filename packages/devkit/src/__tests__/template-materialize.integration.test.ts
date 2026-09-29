import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { materializeTemplate } from '../templates/materialize.js';

describe('template materialization transaction', () => {
  it('uses target basename only when explicit identity is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-template-materialize-'));
    try {
      const templateRoot = join(root, 'template');
      await mkdir(templateRoot);
      await writeFile(join(templateRoot, 'forge.json'), JSON.stringify({ schemaVersion: '2.0.0' }));
      await writeFile(
        join(templateRoot, 'package.json'),
        JSON.stringify({ name: 'template-game' }),
      );
      const result = await materializeTemplate({
        templateRoot,
        targetRoot: join(root, 'target'),
        targetBasename: 'sample-game',
      });

      expect(result).toMatchObject({ ok: true, value: { identity: { id: 'sample-game' } } });
      await expect(readFile(join(root, 'target', 'forge.json'), 'utf8')).resolves.toContain(
        '"id": "sample-game"',
      );
      await expect(readFile(join(root, 'target', 'package.json'), 'utf8')).resolves.toContain(
        '"name": "@local/sample-game"',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rolls back staging when schema validation fails before rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-template-rollback-'));
    const target = join(root, 'target');
    try {
      await expect(
        materializeTemplate({
          templateRoot: join(root, 'missing-template'),
          targetRoot: target,
          targetBasename: 'broken',
        }),
      ).rejects.toMatchObject({ code: 'template-materialize-failed' });
      await expect(readFile(join(target, 'forge.json'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
