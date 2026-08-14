import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

describe('standalone host', () => {
  it('instantiates forge.json defaultScene before game bootstrap', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-host-'));
    await mkdir(resolve(root, 'assets'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'game',
          name: 'Game',
          entry: 'main.ts',
          defaultScene: 'c5def54a-ed2b-4fa1-9535-8e1b18cb9f5b',
        })}\n`,
      ),
      writeFile(resolve(root, 'package.json'), '{"name":"game"}\n'),
      writeFile(resolve(root, 'main.ts'), 'export async function bootstrap() {}\n'),
    ]);
    const facts = await readProjectFacts(root);
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    await createViteConfig(facts.value, 'build');
    const generated = await readFile(resolve(root, '.forgeax/generated/main.ts'), 'utf8');
    expect(generated.indexOf('assets.instantiate(handle, app.world)')).toBeLessThan(
      generated.indexOf('await bootstrap(app.world'),
    );
    expect(generated).toContain('defaultSceneRoot');
  });
});
