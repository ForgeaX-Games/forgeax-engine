import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const assetRoot = resolve(process.cwd(), 'forgeax-engine-assets/demo-assets/template-game-default/ui');

async function readMeta(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(assetRoot, name), 'utf8')) as Record<string, unknown>;
}

describe('game-default UI asset manifest', () => {
  it('keeps one GUID per authored UI document', async () => {
    const hud = await readMeta('hud.meta.json');
    const settings = await readMeta('settings.meta.json');
    expect(hud.kind).toBe('external-asset-package');
    expect(settings.kind).toBe('external-asset-package');
    const hudGuid = (hud.subAssets as Array<{ guid: string }>)[0]?.guid;
    const settingsGuid = (settings.subAssets as Array<{ guid: string }>)[0]?.guid;
    expect(hudGuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(settingsGuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(hudGuid).not.toBe(settingsGuid);
  });

  it('keeps private companions embedded in the UI package', async () => {
    const hud = await readMeta('hud.meta.json');
    const settings = await readMeta('settings.meta.json');
    for (const meta of [hud, settings]) {
      expect(meta.subAssets).toHaveLength(1);
      expect(meta.source).toMatch(/\.ui\.html$/);
    }
    await expect(readFile(resolve(assetRoot, 'hud.ui.html'), 'utf8')).resolves.toContain('data-ui-template');
    await expect(readFile(resolve(assetRoot, 'settings.ui.html'), 'utf8')).resolves.toContain('data-ui-action');
  });
});
