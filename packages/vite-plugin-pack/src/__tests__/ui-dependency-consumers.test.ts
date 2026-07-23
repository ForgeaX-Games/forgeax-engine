import { describe, expect, it } from 'vitest';
import {
  enumerateUiDependencyConsumers,
  UI_DEPENDENCY_CONSUMER_CHANNELS,
} from '../import-products.js';

describe('UI dependency consumer enumeration', () => {
  it('covers TypeScript imports, script literals, and JSON/pack manifests', () => {
    const consumers = enumerateUiDependencyConsumers({
      typescriptImports: ['hud.ui.html', 'hud.ui.css', 'hero.png'],
      scriptLiterals: ['hud.ui.html', 'font.woff2', 'ignored.ts'],
      manifestEntries: ['hud.ui.css', 'hero.webp', 'ignored.bin'],
    });

    expect(UI_DEPENDENCY_CONSUMER_CHANNELS).toEqual([
      'typescript-import',
      'script-literal',
      'json-pack-manifest',
    ]);
    expect(consumers).toEqual([
      { channel: 'typescript-import', path: 'hud.ui.html', kind: 'html' },
      { channel: 'typescript-import', path: 'hud.ui.css', kind: 'css' },
      { channel: 'typescript-import', path: 'hero.png', kind: 'companion' },
      { channel: 'script-literal', path: 'hud.ui.html', kind: 'html' },
      { channel: 'script-literal', path: 'font.woff2', kind: 'companion' },
      { channel: 'json-pack-manifest', path: 'hud.ui.css', kind: 'css' },
      { channel: 'json-pack-manifest', path: 'hero.webp', kind: 'companion' },
    ]);
  });

  it('retains companion discriminants across query strings and upper-case paths', () => {
    expect(
      enumerateUiDependencyConsumers({
        manifestEntries: ['HUD.UI.HTML?rev=4', 'HUD.UI.CSS', 'ICON.SVG', 'FONT.WOFF2'],
      }),
    ).toEqual([
      { channel: 'json-pack-manifest', path: 'HUD.UI.HTML?rev=4', kind: 'html' },
      { channel: 'json-pack-manifest', path: 'HUD.UI.CSS', kind: 'css' },
      { channel: 'json-pack-manifest', path: 'ICON.SVG', kind: 'companion' },
      { channel: 'json-pack-manifest', path: 'FONT.WOFF2', kind: 'companion' },
    ]);
  });
});
