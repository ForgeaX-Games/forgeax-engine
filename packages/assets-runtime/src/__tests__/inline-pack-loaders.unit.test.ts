// @forgeax/engine-assets-runtime -- inline pack-payload loader coverage
// (fix issue #709). Each loader is a pure (payload, refs, ctx) -> Asset|undefined
// function; exercise the accept + reject arms of all eight, plus the
// wireDefaultLoaders / createDefaultLoaderRegistry seed-table helpers.

import type { LoadContext, MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { LoaderRegistry } from '../loader-registry';
import {
  animationClipLoader,
  animationGraphLoader,
  INLINE_PACK_LOADERS,
  materialLoader,
  meshLoader,
  samplerLoader,
  sceneLoader,
  skeletonLoader,
  skinLoader,
} from '../loaders/inline-pack';
import { createDefaultLoaderRegistry, wireDefaultLoaders } from '../wire-default-loaders';

const emptyCtx = {} as LoadContext;

describe('meshLoader', () => {
  it('restores extra UV attributes from a v2 mesh binary', () => {
    const bytes = new Uint8Array(28 + 14 * Float32Array.BYTES_PER_ELEMENT);
    const header = new DataView(bytes.buffer);
    header.setUint32(0, 2, true); // mesh binary v2
    header.setUint32(4, 2, true); // uv + uv1
    header.setUint32(8, 14, true); // 12F base + 2F uv1
    header.setUint32(12, 14, true); // one vertex
    const vertex = new Float32Array(bytes.buffer, 28, 14);
    vertex[12] = 0.25;
    vertex[13] = 0.75;

    const loadPack = meshLoader.loadPack;
    expect(loadPack).toBeDefined();
    if (!loadPack) throw new Error('meshLoader.loadPack must be registered');

    const out = loadPack({ payload: {}, artifacts: { body: { bytes } } } as never, emptyCtx) as {
      attributes: { uv1?: unknown };
    };

    expect(out.attributes.uv1).toEqual(new Float32Array([0.25, 0.75]));
  });

  it('preserves the packed AABB from the v2 mesh binary', () => {
    const tail = new TextEncoder().encode(JSON.stringify({ aabb: [1, 2, 3, 4, 5, 6] }));
    const bytes = new Uint8Array(28 + 12 * Float32Array.BYTES_PER_ELEMENT + tail.length);
    const header = new DataView(bytes.buffer);
    header.setUint32(0, 2, true); // mesh binary v2
    header.setUint32(4, 1, true); // one UV set
    header.setUint32(8, 12, true); // base 12F layout
    header.setUint32(12, 12, true); // one vertex
    header.setUint32(16, 0, true); // non-indexed
    header.setUint32(20, 0, true);
    header.setUint32(24, tail.length, true);
    bytes.set(tail, 28 + 12 * Float32Array.BYTES_PER_ELEMENT);

    const loadPack = meshLoader.loadPack;
    expect(loadPack).toBeDefined();
    if (!loadPack) throw new Error('meshLoader.loadPack must be registered');

    const out = loadPack({ payload: {}, artifacts: { body: { bytes } } } as never, emptyCtx) as {
      aabb?: Float32Array;
    };

    expect(out.aabb).toEqual(new Float32Array([1, 2, 3, 4, 5, 6]));
  });

  it('normalises Array vertices/indices into typed arrays with a default submesh', () => {
    const out = meshLoader.load(
      { vertices: new Array(12).fill(0), indices: [0, 0, 0] },
      undefined,
      emptyCtx,
    );
    expect(out).toBeDefined();
    const mesh = out as {
      kind: string;
      vertices: Float32Array;
      indices?: Uint16Array;
      submeshes: unknown[];
    };
    expect(mesh.kind).toBe('mesh');
    expect(mesh.vertices).toBeInstanceOf(Float32Array);
    expect(mesh.indices).toBeInstanceOf(Uint16Array);
    expect(mesh.submeshes).toHaveLength(1);
  });

  it('drops an empty index array (vertex-only path)', () => {
    const out = meshLoader.load(
      { vertices: new Float32Array(12), indices: [] },
      undefined,
      emptyCtx,
    ) as {
      indices?: unknown;
    };
    expect(out.indices).toBeUndefined();
  });

  it('accepts skinIndex/skinWeight as arrays', () => {
    const out = meshLoader.load(
      {
        vertices: new Float32Array(18),
        attributes: { skinIndex: [0, 1, 2, 3], skinWeight: [1, 0, 0, 0] },
      },
      undefined,
      emptyCtx,
    ) as { attributes: { skinIndex: unknown; skinWeight: unknown } };
    expect(out.attributes.skinIndex).toBeInstanceOf(Uint16Array);
    expect(out.attributes.skinWeight).toBeInstanceOf(Float32Array);
  });

  it('rejects a non-array/non-typed vertices payload', () => {
    expect(meshLoader.load({ vertices: 'bad' }, undefined, emptyCtx)).toBeUndefined();
  });

  it('rejects a malformed skinIndex', () => {
    expect(
      meshLoader.load(
        { vertices: new Float32Array(12), attributes: { skinIndex: 'bad' } },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
  });
});

describe('sceneLoader', () => {
  it('parses a scene payload into a SceneAsset', () => {
    const out = sceneLoader.load(
      { entities: [{ localId: 0, components: {} }] },
      undefined,
      emptyCtx,
    );
    expect((out as { kind?: string }).kind).toBe('scene');
  });

  it('returns undefined for a malformed scene payload', () => {
    expect(sceneLoader.load({ entities: 'bad' }, undefined, emptyCtx)).toBeUndefined();
  });

  it('routes an out-of-bounds ref error inline as { ok:false, error }', () => {
    const out = sceneLoader.load(
      { entities: [{ localId: 0, components: { MeshFilter: { assetHandle: 9 } } }] },
      ['only-one-guid'],
      emptyCtx,
    );
    expect(out).toMatchObject({ ok: false });
  });
});

describe('materialLoader', () => {
  it('builds a material from passes + values', () => {
    const out = materialLoader.load(
      {
        passes: [{ name: 'main', program: { module: 'forgeax::standard' } }],
        values: { roughness: 0.5 },
      },
      undefined,
      emptyCtx,
    );
    expect((out as { kind?: string }).kind).toBe('material');
  });

  it('resolves a numeric parent ref-index to a parentGuid string', () => {
    const out = materialLoader.load(
      { passes: [{ name: 'main', program: { module: 'x' } }], parent: 1 },
      ['g0', 'g1'],
      emptyCtx,
    ) as { parentGuid?: string };
    expect(out.parentGuid).toBe('g1');
  });

  it('preserves an authored parent GUID without requiring a refs index', () => {
    const out = materialLoader.load(
      { values: { baseColor: [1, 0, 0, 1] }, parent: '01935b00-0000-7000-8000-000000000001' },
      undefined,
      emptyCtx,
    ) as { parentGuid?: string };
    expect(out.parentGuid).toBe('01935b00-0000-7000-8000-000000000001');
  });

  it('returns undefined when a parent ref-index is out of bounds', () => {
    expect(
      materialLoader.load(
        { passes: [{ name: 'm', program: { module: 'x' } }], parent: 9 },
        ['g0'],
        emptyCtx,
      ),
    ).toBeUndefined();
  });

  it('resolves shader-declared texture paramValue ref-indices to GUIDs', () => {
    const ctx = {
      getMaterialShaderTextureFieldNames: (id: string) =>
        id === 'forgeax::pbr' ? new Set(['baseColorTexture']) : undefined,
    } as unknown as LoadContext;
    const out = materialLoader.load(
      {
        passes: [{ name: 'm', program: { module: 'forgeax::pbr' } }],
        values: { baseColorTexture: 0, roughness: 5 },
      },
      ['tex-guid'],
      ctx,
    ) as { values: Record<string, unknown> };
    expect(out.values.baseColorTexture).toBe('tex-guid');
    expect(out.values.roughness).toBe(5); // non-texture int untouched
  });

  it('resolves nested MaterialTextureValue texture ref-indices to GUIDs', () => {
    const ctx = {
      getMaterialShaderTextureFieldNames: () => new Set(['baseColorTexture']),
    } as unknown as LoadContext;
    const out = materialLoader.load(
      {
        passes: [{ name: 'm', program: { module: 'forgeax::pbr' } }],
        values: { baseColorTexture: { texture: 0 } },
      },
      ['tex-guid'],
      ctx,
    ) as { values: Record<string, unknown> };
    expect(out.values.baseColorTexture).toEqual({ texture: 'tex-guid' });
  });

  it('resolves nested texture values when the shader schema is present but empty', () => {
    const out = materialLoader.load(
      {
        passes: [{ program: { module: 'forgeax::pbr-skin' } }],
        values: { baseColor: [1, 1, 1, 1], metallic: 0, baseColorTexture: { texture: 0 } },
      },
      ['tex-guid'],
      {
        ...emptyCtx,
        getMaterialShaderTextureFieldNames: () => new Set(),
      },
    ) as MaterialAsset;

    expect(out.values).toBeDefined();
    if (!out.values) throw new Error('material loader must preserve material values');
    expect(out.values.baseColorTexture).toEqual({ texture: 'tex-guid' });
    expect(out.values.metallic).toBe(0);
  });

  it('returns undefined for a passes-less, parent-less material', () => {
    expect(materialLoader.load({}, undefined, emptyCtx)).toBeUndefined();
  });
});

describe('skeletonLoader', () => {
  it('accepts a valid inverseBindMatrices/jointCount pair', () => {
    const out = skeletonLoader.load(
      { inverseBindMatrices: new Array(16).fill(0), jointCount: 1 },
      undefined,
      emptyCtx,
    );
    expect((out as { kind?: string }).kind).toBe('skeleton');
  });

  it('rejects a stride mismatch (byteLength !== jointCount*64)', () => {
    expect(
      skeletonLoader.load(
        { inverseBindMatrices: new Array(16).fill(0), jointCount: 2 },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
  });

  it('rejects a non-array inverseBindMatrices', () => {
    expect(
      skeletonLoader.load({ inverseBindMatrices: 'bad', jointCount: 0 }, undefined, emptyCtx),
    ).toBeUndefined();
  });
});

describe('skinLoader', () => {
  it('accepts a valid skeletonGuid + jointPaths', () => {
    const out = skinLoader.load({ skeletonGuid: 'g', jointPaths: ['a', 'b'] }, undefined, emptyCtx);
    expect((out as { kind?: string }).kind).toBe('skin');
  });

  it('rejects a missing skeletonGuid or non-string joint path', () => {
    expect(skinLoader.load({ jointPaths: [] }, undefined, emptyCtx)).toBeUndefined();
    expect(
      skinLoader.load({ skeletonGuid: 'g', jointPaths: [1] }, undefined, emptyCtx),
    ).toBeUndefined();
  });
});

describe('animationClipLoader', () => {
  it('accepts a valid channel with LINEAR sampler arrays', () => {
    const out = animationClipLoader.load(
      {
        duration: 1,
        channels: [
          {
            targetPath: ['root'],
            property: 'translation',
            sampler: { input: [0, 1], output: [0, 0, 0, 1, 1, 1], interpolation: 'LINEAR' },
          },
        ],
      },
      undefined,
      emptyCtx,
    );
    expect((out as { kind?: string }).kind).toBe('animation-clip');
  });

  it('rejects a bad property / missing sampler / bad interpolation', () => {
    expect(
      animationClipLoader.load(
        { channels: [{ targetPath: ['r'], property: 'bogus' }] },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
    expect(
      animationClipLoader.load(
        { channels: [{ targetPath: ['r'], property: 'scale' }] },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
    expect(
      animationClipLoader.load(
        {
          channels: [
            {
              targetPath: ['r'],
              property: 'scale',
              sampler: { input: [0], output: [0], interpolation: 'CUBIC' },
            },
          ],
        },
        undefined,
        emptyCtx,
      ),
    ).toBeUndefined();
  });

  it('rejects a non-array channels payload', () => {
    expect(animationClipLoader.load({ channels: 'bad' }, undefined, emptyCtx)).toBeUndefined();
  });
});

describe('wireDefaultLoaders / createDefaultLoaderRegistry', () => {
  it('loads a serialised sampler descriptor', () => {
    expect(
      samplerLoader.load({ addressModeU: 'repeat', magFilter: 'linear' }, undefined, emptyCtx),
    ).toEqual({
      kind: 'sampler',
      addressModeU: 'repeat',
      magFilter: 'linear',
    });
    expect(samplerLoader.load({ addressModeU: 'invalid' }, undefined, emptyCtx)).toBeUndefined();
  });

  it('keeps animation graph loader in assets-runtime', () => {
    expect(animationGraphLoader.kind).toBe('animation-graph');
  });
  it('wires the engine default kinds and leaves shader unregistered', () => {
    const reg = wireDefaultLoaders(new LoaderRegistry());
    for (const kind of [
      'mesh',
      'scene',
      'sampler',
      'material',
      'skeleton',
      'skin',
      'animation-clip',
      'texture',
      'font',
      'equirect',
      'video',
    ]) {
      expect(reg.get(kind)).toBeDefined();
    }
    expect(reg.get('shader')).toBeUndefined();
  });

  it('appends extraLoaders after the defaults', () => {
    const audio = { kind: 'audio', load: () => undefined } as never;
    const reg = wireDefaultLoaders(new LoaderRegistry(), [audio]);
    expect(reg.get('audio')).toBe(audio);
  });

  it('createDefaultLoaderRegistry returns a fresh pre-wired registry', () => {
    const reg = createDefaultLoaderRegistry();
    expect(reg.get('mesh')).toBeDefined();
    expect(INLINE_PACK_LOADERS.length).toBe(8); // +1 sampler +1 animationGraphLoader
  });
});
