import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { forgeaxShader } from '../index.js';

interface EmittedAsset {
  readonly type: 'asset';
  readonly fileName: string;
  readonly source: string;
}

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

function mockContext(): { emitted: EmittedAsset[]; emitFile: (asset: EmittedAsset) => string } {
  const emitted: EmittedAsset[] = [];
  return {
    emitted,
    emitFile(asset) {
      emitted.push(asset);
      return asset.fileName;
    },
  };
}

describe('user material shader variant manifest', () => {
  it('compiles both WEBGL2_COMPAT branches and inlines them into materialShaders[]', async () => {
    const sourcePath = resolve(
      repoRoot,
      'apps/learn-render/4.advanced-opengl/3.blending/src/alpha-test.wgsl',
    );
    const source = await readFile(sourcePath, 'utf8');

    const plugin = forgeaxShader({ engineEntries: false });
    const ctx = mockContext();
    await plugin.transform?.call(ctx as never, source, sourcePath);
    plugin.generateBundle?.call(ctx as never);

    const manifestAsset = ctx.emitted.find((asset) => asset.fileName === 'shaders/manifest.json');
    expect(manifestAsset).toBeDefined();
    if (manifestAsset === undefined) return;
    const manifest = JSON.parse(manifestAsset.source) as {
      materialShaders: Array<{
        identifier: string;
        composedWgsl: string;
        variants: Array<{
          definesKey: string;
          defines: Record<string, boolean>;
          composedWgsl: string;
        }>;
      }>;
    };
    const entry = manifest.materialShaders.find(
      (item) => item.identifier === 'learn-render::alpha-test',
    );
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.variants).toHaveLength(4);
    const webgl = entry.variants.find(
      (variant) =>
        variant.defines.WEBGL2_COMPAT === true &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === false,
    );
    const webgpu = entry.variants.find(
      (variant) =>
        variant.defines.WEBGL2_COMPAT === false &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === true,
    );
    const primary = entry.variants.find(
      (variant) =>
        variant.defines.WEBGL2_COMPAT === true && variant.defines.STORAGE_BUFFER_AVAILABLE === true,
    );
    expect(webgl?.definesKey).toBe('STORAGE_BUFFER_AVAILABLE=false+WEBGL2_COMPAT=true');
    expect(webgpu?.definesKey).toBe('STORAGE_BUFFER_AVAILABLE=true+WEBGL2_COMPAT=false');
    expect(webgl?.composedWgsl).toContain('textureSampleLevel');
    expect(webgpu?.composedWgsl).toContain('textureSample');
    expect(webgpu?.composedWgsl).not.toContain('textureSampleLevel');
    expect(entry.composedWgsl).toBe(primary?.composedWgsl);
  });

  it('infers the storage-buffer capability axis for mesh-importing custom shaders', async () => {
    const sourcePath = resolve(
      repoRoot,
      'apps/learn-render/5.advanced-lighting/1.advanced-lighting/src/blinn-phong.wgsl',
    );
    const source = await readFile(sourcePath, 'utf8');

    const plugin = forgeaxShader({ engineEntries: false });
    const ctx = mockContext();
    await plugin.transform?.call(ctx as never, source, sourcePath);
    plugin.generateBundle?.call(ctx as never);

    const manifestAsset = ctx.emitted.find((asset) => asset.fileName === 'shaders/manifest.json');
    expect(manifestAsset).toBeDefined();
    if (manifestAsset === undefined) return;
    const manifest = JSON.parse(manifestAsset.source) as {
      materialShaders: Array<{
        identifier: string;
        variants: Array<{
          definesKey: string;
          defines: Record<string, boolean>;
          composedWgsl: string;
        }>;
      }>;
    };
    const entry = manifest.materialShaders.find(
      (item) => item.identifier === 'learn-render::5-1-blinn-phong',
    );
    expect(entry?.variants).toHaveLength(2);
    expect(entry?.variants.map((variant) => variant.defines.STORAGE_BUFFER_AVAILABLE)).toEqual([
      true,
      false,
    ]);
    expect(
      entry?.variants.find((variant) => variant.defines.STORAGE_BUFFER_AVAILABLE === false)
        ?.composedWgsl,
    ).toMatch(/@group\(2\)\s+@binding\(0\)\s+var<uniform> meshes/);
  });
});
