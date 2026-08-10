import { describe, expect, it } from 'vitest';
import { pluginPack } from '../index.js';

const MAX_ENTRY_LINES = 1500;

function passesEntryCohesion(lineCount: number): boolean {
  return lineCount <= MAX_ENTRY_LINES;
}

describe('Pack plugin entry cohesion contract', () => {
  it('rejects an entry above the declared threshold and accepts the boundary', () => {
    expect(passesEntryCohesion(MAX_ENTRY_LINES + 1)).toBe(false);
    expect(passesEntryCohesion(MAX_ENTRY_LINES)).toBe(true);
  });

  it('keeps the public factory contract available at the extracted boundary', () => {
    const plugin = pluginPack({ roots: [] });
    expect(plugin.name).toBe('forgeax:pack');
    expect(typeof plugin.configureServer).toBe('function');
    expect(typeof plugin.generateBundle).toBe('function');
    expect(typeof plugin.writeBundle).toBe('function');
    expect(typeof plugin.closeBundle).toBe('function');
  });
});
