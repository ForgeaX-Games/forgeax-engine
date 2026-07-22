import { describe, expect, it } from 'vitest';
import { projectUiDevArtifacts } from '../import-products.js';

describe('UI dev artifact transport', () => {
  it('projects all private companion formats to requestable URLs', () => {
    const artifacts = projectUiDevArtifacts(
      [
        { path: 'hero.png', mimeType: 'image/png', bytes: new Uint8Array([137]) },
        { path: 'hero.jpeg', mimeType: 'image/jpeg', bytes: new Uint8Array([255]) },
        { path: 'hero.webp', mimeType: 'image/webp', bytes: new Uint8Array([82]) },
        { path: 'icon.svg', mimeType: 'image/svg+xml', bytes: new Uint8Array([60]) },
        { path: 'font.woff2', mimeType: 'font/woff2', bytes: new Uint8Array([119]) },
      ],
      '/__ui/',
    );
    expect(artifacts.map((artifact) => artifact.url)).toEqual([
      '/__ui/hero.png',
      '/__ui/hero.jpeg',
      '/__ui/hero.webp',
      '/__ui/icon.svg',
      '/__ui/font.woff2',
    ]);
    expect(artifacts.every((artifact) => artifact.bytes.length > 0)).toBe(true);
  });
});
