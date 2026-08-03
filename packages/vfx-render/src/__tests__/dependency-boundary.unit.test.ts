import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const packageRoot = resolve(repositoryRoot, 'packages/vfx-render');
const sourceRoot = resolve(packageRoot, 'src');

const allowedPackageRoots = new Set([
  '@forgeax/engine-assets-runtime',
  '@forgeax/engine-ecs',
  '@forgeax/engine-render',
  '@forgeax/engine-scene',
  '@forgeax/engine-types',
  '@forgeax/engine-vfx',
]);

const forbiddenImportPatterns = [
  /@forgeax\/engine-(?:vfx-)?compiler(?:['"/]|$)/,
  /@forgeax\/engine-(?:naga|shader-compiler|render-graph)(?:['"/]|$)/,
  /@forgeax\/engine-rhi(?:['"/]|$)/,
  /(?:^|['"])(?:node:)?(?:fs|path|url)(?:['"]|$)/,
  /\/internal(?:['"/]|$)/,
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.(?:ts|wgsl)$/.test(entry.name) ? [path] : [];
  });
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function packageImports(source: string): string[] {
  return [...source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].flatMap((match) => {
    const specifier = match[1];
    return specifier === undefined ? [] : [specifier];
  });
}

function packageManifest(): {
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  sideEffects?: boolean;
} {
  return JSON.parse(read(resolve(packageRoot, 'package.json'))) as {
    dependencies?: Record<string, string>;
    exports?: Record<string, unknown>;
    files?: string[];
    sideEffects?: boolean;
  };
}

describe('vfx-render dependency boundary', () => {
  it('keeps the manifest downstream of public engine vocabulary', () => {
    const manifest = packageManifest();
    const dependencies = Object.keys(manifest.dependencies ?? {}).sort();

    expect(dependencies).toEqual(
      [
        '@forgeax/engine-assets-runtime',
        '@forgeax/engine-ecs',
        '@forgeax/engine-render',
        '@forgeax/engine-scene',
        '@forgeax/engine-types',
        '@forgeax/engine-vfx',
      ].sort(),
    );
    expect(dependencies.every((dependency) => allowedPackageRoots.has(dependency))).toBe(true);
    expect(dependencies.some((dependency) => /compiler|naga|shader|rhi/.test(dependency))).toBe(
      false,
    );
    expect(manifest.sideEffects).toBe(false);
  });

  it('keeps the public entry browser-safe and package-root only', () => {
    const manifest = packageManifest();
    const entry = read(resolve(sourceRoot, 'index.ts'));
    const imports = packageImports(entry);
    const exports = manifest.exports;
    const mainExport = exports?.['.'] as Record<string, unknown> | undefined;

    expect(imports.every((specifier) => specifier.startsWith('.'))).toBe(true);
    expect(entry).not.toMatch(/node:|from ['"](?:fs|path|url)['"]|\/internal(?:['"/]|$)/);
    expect(entry).not.toMatch(/engine-(?:vfx-)?compiler|engine-naga|shader-compiler|engine-rhi/);
    expect(mainExport).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.mjs',
    });
    expect(manifest.files).toEqual(['dist', 'src', 'README.md', 'LICENSE']);
  });

  it('keeps production source on public roots without build-time or device imports', () => {
    const files = sourceFiles(sourceRoot);
    const production = files.map((path) => ({ path, source: read(path) }));
    const imports = production.flatMap(({ source }) => packageImports(source));

    expect(files.length).toBeGreaterThan(0);
    expect(imports.filter((specifier) => specifier.startsWith('@forgeax/engine-'))).toEqual(
      expect.arrayContaining([
        '@forgeax/engine-ecs',
        '@forgeax/engine-render',
        '@forgeax/engine-types',
        '@forgeax/engine-vfx',
      ]),
    );
    expect(
      imports.filter(
        (specifier) =>
          !specifier.startsWith('.') &&
          specifier.startsWith('@forgeax/engine-') &&
          !allowedPackageRoots.has(specifier),
      ),
    ).toEqual([]);
    for (const { path, source } of production) {
      const fileImports = packageImports(source);
      for (const specifier of fileImports) {
        for (const pattern of forbiddenImportPatterns) {
          expect(specifier, path).not.toMatch(pattern);
        }
        expect(specifier, path).not.toMatch(/(?:device|GPUDevice|WebGPU|RenderGraph)/i);
      }
    }
  });

  it('keeps generic render and runtime production code particle-agnostic', () => {
    const genericFiles = [
      ...sourceFiles(resolve(repositoryRoot, 'packages/render/src')),
      ...sourceFiles(resolve(repositoryRoot, 'packages/runtime/src')),
    ];
    const particleSpecific = /particle|@forgeax\/engine-vfx|vfx-render|ParticleRenderBatch/i;

    for (const path of genericFiles) {
      expect(read(path), path).not.toMatch(particleSpecific);
    }
  });
});
