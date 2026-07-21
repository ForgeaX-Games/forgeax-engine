// @forgeax/engine-assets-runtime -- inline pack-payload loader coverage
// (fix issue #709). Each loader is a pure (payload, refs, ctx) -> Asset|undefined
// function; exercise the accept + reject arms of all six, plus the
// wireDefaultLoaders / createDefaultLoaderRegistry seed-table helpers.

import type { LoadContext } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { LoaderRegistry } from '../loader-registry';
import {
  animationClipLoader,
  INLINE_PACK_LOADERS,
  materialLoader,
  meshLoader,
  sceneLoader,
  skeletonLoader,
  skinLoader,
} from '../loaders/inline-pack';
import { createDefaultLoaderRegistry, wireDefaultLoaders } from '../wire-default-loaders';

const emptyCtx = {} as LoadContext;

describe('meshLoader', () => {
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
  it('builds a material from passes + paramValues', () => {
    const out = materialLoader.load(
      { passes: [{ name: 'main', shader: 'forgeax::standard' }], paramValues: { roughness: 0.5 } },
      undefined,
      emptyCtx,
    );
    expect((out as { kind?: string }).kind).toBe('material');
  });

  it('resolves a numeric parent ref-index to a parentGuid string', () => {
    const out = materialLoader.load(
      { passes: [{ name: 'main', shader: 'x' }], parent: 1 },
      ['g0', 'g1'],
      emptyCtx,
    ) as { parentGuid?: string };
    expect(out.parentGuid).toBe('g1');
  });

  it('returns undefined when a parent ref-index is out of bounds', () => {
    expect(
      materialLoader.load({ passes: [{ name: 'm', shader: 'x' }], parent: 9 }, ['g0'], emptyCtx),
    ).toBeUndefined();
  });

  it('resolves shader-declared texture paramValue ref-indices to GUIDs', () => {
    const ctx = {
      getMaterialShaderTextureFieldNames: (id: string) =>
        id === 'forgeax::pbr' ? new Set(['baseColorTexture']) : undefined,
    } as unknown as LoadContext;
    const out = materialLoader.load(
      {
        passes: [{ name: 'm', shader: 'forgeax::pbr' }],
        paramValues: { baseColorTexture: 0, roughness: 5 },
      },
      ['tex-guid'],
      ctx,
    ) as { paramValues: Record<string, unknown> };
    expect(out.paramValues.baseColorTexture).toBe('tex-guid');
    expect(out.paramValues.roughness).toBe(5); // non-texture int untouched
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
  it('wires the engine default kinds and leaves sampler/shader unregistered', () => {
    const reg = wireDefaultLoaders(new LoaderRegistry());
    for (const kind of [
      'mesh',
      'scene',
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
    expect(reg.get('sampler')).toBeUndefined();
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
    expect(INLINE_PACK_LOADERS.length).toBe(7); // +1 animationGraphLoader (feat-20260713 M4/w30)
  });
});
