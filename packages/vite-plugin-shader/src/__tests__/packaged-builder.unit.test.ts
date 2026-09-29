import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({ packaged: vi.fn(), source: vi.fn() }));
vi.mock('../shared-engine-inputs.js', async (original) => ({
  ...(await original<typeof import('../shared-engine-inputs.js')>()),
  loadPackagedEngineShaderInputs: fixtures.packaged,
}));
vi.mock('../engine-inputs/load-engine-shader-entries.js', async (original) => ({
  ...(await original<typeof import('../engine-inputs/load-engine-shader-entries.js')>()),
  loadEngineShaderEntries: fixtures.source,
}));

beforeEach(() => {
  vi.resetModules();
  fixtures.packaged.mockReset();
  fixtures.source.mockReset().mockRejectedValue(new Error('source compiler selected'));
});

describe('standalone point-shadow builder input ownership', () => {
  it('uses the prepared point profile without invoking the source producer', async () => {
    fixtures.packaged.mockReturnValue({
      entries: [{ hash: 'point', wgsl: 'point shader', bindings: '[]' }],
      materialShaders: [],
      imports: {},
    });
    const { buildEngineShaderManifest } = await import('../index.js');
    const manifest = await buildEngineShaderManifest({ pointShadows: true });
    expect(fixtures.packaged).toHaveBeenCalledWith(true, false);
    expect(fixtures.source).not.toHaveBeenCalled();
    expect(manifest.entries).toEqual([
      { hash: 'point', wgsl: 'point shader', bindings: '[]', glsl: '' },
    ]);
  });

  it('falls back to source when the packaged loader rejects missing or forced-source input', async () => {
    fixtures.packaged.mockReturnValue(null);
    const { buildEngineShaderManifest } = await import('../index.js');
    await expect(buildEngineShaderManifest({ pointShadows: true })).rejects.toThrow(
      'source compiler selected',
    );
    expect(fixtures.source).toHaveBeenCalledOnce();
  });

  it('does not let an earlier packaged result hide a forced source validation', async () => {
    const previous = process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
    process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = '0';
    fixtures.packaged.mockReturnValue({ entries: [], materialShaders: [], imports: {} });
    try {
      const { buildEngineShaderManifest } = await import('../index.js');
      await buildEngineShaderManifest({ pointShadows: true });
      process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = '1';
      fixtures.packaged.mockReturnValue(null);
      await expect(buildEngineShaderManifest({ pointShadows: true })).rejects.toThrow(
        'source compiler selected',
      );
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
      else process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = previous;
    }
  });

  it('keeps authored point-shadow packages on their source compilation path', async () => {
    const { buildEngineShaderManifest } = await import('../index.js');
    await expect(
      buildEngineShaderManifest({ pointShadows: true, materialPackages: ['custom.pack.json'] }),
    ).rejects.toThrow('source compiler selected');
    expect(fixtures.packaged).not.toHaveBeenCalled();
  });
});
