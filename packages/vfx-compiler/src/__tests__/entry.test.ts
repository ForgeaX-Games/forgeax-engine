import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly name: string;
  readonly sideEffects: boolean;
  readonly exports: {
    readonly '.': {
      readonly types: string;
      readonly import: string;
    };
  };
}

const packageRoot = resolve(import.meta.dirname, '..', '..');
const manifest = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
) as PackageManifest;

describe('@forgeax/engine-vfx-compiler public entry', () => {
  it('declares a side-effect-free ESM and declaration entry', () => {
    expect(manifest.name).toBe('@forgeax/engine-vfx-compiler');
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.mjs',
    });
  });
});
