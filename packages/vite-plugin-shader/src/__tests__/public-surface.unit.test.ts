import { describe, expect, test } from 'vitest';
import * as publicSurface from '../index.js';

describe('vite plugin shader public surface', () => {
  test('keeps the plugin front door without a version mirror', () => {
    expect(typeof publicSurface.forgeaxShader).toBe('function');
    expect('VITE_PLUGIN_SHADER_PACKAGE_VERSION' in publicSurface).toBe(false);
  });
});
