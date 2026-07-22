import { describe, expect, it } from 'vitest';
import { projectUiBuildArtifacts } from '../import-products.js';

describe('UI production artifact transport', () => {
  it('emits hashed public paths without source tokens or dependency ledgers', () => {
    const emitted = projectUiBuildArtifacts(
      [{ path: 'hero.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2]) }],
      (artifact) => `assets/${artifact.path.replace('.png', '-hash.png')}`,
    );
    expect(emitted).toEqual([
      { path: 'assets/hero-hash.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2]) },
    ]);
    expect(JSON.stringify(emitted)).not.toContain('sourceDependencies');
    expect(JSON.stringify(emitted)).not.toContain('ui-token');
  });
});
