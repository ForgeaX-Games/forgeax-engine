import { describe, expect, test } from 'vitest';
import * as publicSurface from '../index.js';

describe('vite-plugin-pack public surface', () => {
  test('keeps the pack plugin without a version mirror', () => {
    expect(typeof publicSurface.pluginPack).toBe('function');
    expect('VITE_PLUGIN_PACK_PACKAGE_VERSION' in publicSurface).toBe(false);
  });
});
