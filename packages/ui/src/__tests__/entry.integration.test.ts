import { type ImageError, ImportError } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { profileCorpus } from '../authoring/__tests__/fixtures/profile-corpus.js';
import { validateUiAuthoring } from '../authoring/index.js';
import { createUiImporter, importUiSource } from '../importer/index.js';
import { createUiLoader, mountUi } from '../index.js';

function unusedImageError(): ImageError {
  const error = new Error('unused image decoder');
  error.name = 'ImageError';
  return Object.assign(error, {
    code: 'image-decode-failed' as const,
    expected: 'image bytes decode successfully',
    hint: 'not used by this fixture',
    detail: { code: 'image-decode-failed' as const, reason: 'unused' },
  });
}

describe('engine-ui dual entry', () => {
  it('imports, loads, mounts and disposes without importing Node APIs', () => {
    const imported = importUiSource({
      guid: 'entry-ui',
      html: '<div data-ui-part="root">ok</div>',
      css: '.root{}',
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const payload = imported.value.assets[0]?.payload;
    const loaded = createUiLoader().load(payload);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const result = mountUi(loaded.value, { root: document.body, layer: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) result.value.dispose();
  });

  it('keeps importer and browser surfaces independently callable', () => {
    expect(typeof importUiSource).toBe('function');
    expect(typeof mountUi).toBe('function');
  });

  it('reads the declared GUID and local CSS/asset companions', async () => {
    const reads = new Map([
      ['hud.ui.html', '<section><img src="icons/panel.png"></section>'],
      ['hud.ui.css', '.hud { background: url("icons/panel.png"); }'],
      ['icons/panel.png', 'png-bytes'],
    ]);
    const importer = createUiImporter();
    const result = await importer.import({
      source: 'hud.ui.html',
      readSource: async () => ({
        ok: true,
        value: new TextEncoder().encode(reads.get('hud.ui.html')),
      }),
      readSibling: async (path) => {
        const value = reads.get(path);
        return value === undefined
          ? {
              ok: false,
              error: new ImportError({
                code: 'source-read-failed',
                expected: 'the sibling source is readable',
                hint: 'provide the declared UI companion file',
                detail: { source: path, reason: `missing ${path}` },
              }),
            }
          : { ok: true, value: new TextEncoder().encode(value) };
      },
      decodeImage: async () => ({ ok: false, error: unusedImageError() }),
      subAssets: [{ guid: 'hud-guid', sourceIndex: 0, kind: 'ui' }],
      importSettings: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assets[0]?.guid).toBe('hud-guid');
    expect(result.value.sourceDependencies).toEqual([
      'hud.ui.html',
      'hud.ui.css',
      'icons/panel.png',
    ]);
    expect(result.value.artifacts[0]?.path).toBe('icons/panel.png');
    expect(result.value.assets[0]?.payload.html).toContain('ui-token:icons/panel.png');
    expect(result.value.assets[0]?.payload.css).toContain('ui-token:icons/panel.png');
  });

  it('keeps validator and importer blocking conclusions identical across the shared corpus', async () => {
    for (const entry of profileCorpus) {
      const source = { guid: `corpus-${entry.name}`, html: entry.html, css: entry.css };
      const validated = await validateUiAuthoring({
        sourcePath: `${source.guid}.ui.html`,
        html: source.html,
        css: source.css,
      });
      const imported = importUiSource(source);
      expect(imported.ok).toBe(validated.ok);
      if (!validated.ok && !imported.ok) {
        expect(imported.error.code).toBe('source-validation-failed');
        expect('diagnostics' in imported.error.detail).toBe(true);
        if ('diagnostics' in imported.error.detail)
          expect(imported.error.detail.diagnostics.length).toBeGreaterThan(0);
      }
    }
  });

  it('accepts established game-default slot and setting hooks', async () => {
    const result = await validateUiAuthoring({
      sourcePath: 'game-default.ui.html',
      html: '<section><span data-ui-slot="score">Score</span><input data-ui-setting="music" /></section>',
      css: '[data-ui-slot="score"] { color: red; }',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
  });
});
