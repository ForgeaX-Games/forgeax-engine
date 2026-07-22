import { describe, expect, it } from 'vitest';
import { uiArtifactMimeType } from '../ui-artifact-finalizer.js';

describe('UI artifact MIME mapping', () => {
  it.each([
    ['hero.png', 'image/png'],
    ['hero.jpeg', 'image/jpeg'],
    ['hero.webp', 'image/webp'],
    ['icon.svg', 'image/svg+xml'],
    ['font.woff2', 'font/woff2'],
  ] as const)('maps %s', (path, mimeType) => expect(uiArtifactMimeType(path)).toBe(mimeType));

  it('rejects unknown extensions', () => expect(uiArtifactMimeType('blob.bin')).toBeUndefined());
});
