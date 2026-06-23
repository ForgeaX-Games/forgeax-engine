// feat-20260622 M6 / w22 — regression guards for the two side-table retirements.
//
//   AC-05: storedNameOf retired; per-GUID stored name lives on the envelope and
//          feeds resolveName's `storedName` argument. resolveName's three-arg
//          XOR derivation (single-asset basename / multi-asset stored name /
//          no-package '' fallback / 1->N promotion freeze) must be unchanged.
//   AC-06: the 14-arm assetBrand switch retired for the ASSET_BRAND Record
//          table. The table maps every Asset.kind to its brand, and the two
//          consumption points (instantiate -> allocSharedRef brand arg;
//          inspect().assets[].brand) return the correct brand per kind.

import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ASSET_BRAND, type Asset, type AssetBrand, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

import { AssetRegistry } from '../asset-registry';
import { createDefaultLoaderRegistry } from '../wire-default-loaders';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

function makeReg(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
}

const sampler = { kind: 'sampler' as const };

// ── AC-05: resolveName XOR derivation unchanged after storedNameOf retirement ──

describe('AC-05 resolveName regression (storedNameOf retired, name on envelope)', () => {
  it('single-asset package -> basename(path), no stored name needed', () => {
    const reg = makeReg();
    const g = '01890000-0000-7000-8000-000000000101';
    reg.catalog(g, sampler);
    reg._registerPackage('assets/hero.glb', [g]);
    expect(reg.resolveName(g)).toBe('hero.glb');
    // The payload never carries the name (it lives on the envelope only).
    const stored = reg.lookup(g);
    expect(stored).toBeDefined();
    expect(Object.hasOwn(stored as object, 'name')).toBe(false);
  });

  it('multi-asset package -> each entry stored name read from envelope', () => {
    const reg = makeReg();
    const a = '01890000-0000-7000-8000-000000000102';
    const b = '01890000-0000-7000-8000-000000000103';
    reg.catalog(a, sampler);
    reg.catalog(b, sampler);
    reg._registerPackage(
      'assets/char.glb',
      [a, b],
      new Map([
        [a, 'Body'],
        [b, 'Head'],
      ]),
    );
    expect(reg.resolveName(a)).toBe('Body');
    expect(reg.resolveName(b)).toBe('Head');
  });

  it('no-package asset with self name -> stored name; without -> empty string', () => {
    const reg = makeReg();
    const named = '01890000-0000-7000-8000-000000000104';
    const anon = '01890000-0000-7000-8000-000000000105';
    reg.catalog(named, sampler);
    reg.catalog(anon, sampler);
    reg._registerPackage(null, [named], new Map([[named, 'myProcMesh']]));
    reg._registerPackage(null, [anon]);
    expect(reg.resolveName(named)).toBe('myProcMesh');
    expect(reg.resolveName(anon)).toBe('');
  });

  it('1->N promotion -> original asset basename frozen as stored name', () => {
    const reg = makeReg();
    const g1 = '01890000-0000-7000-8000-000000000106';
    const g2 = '01890000-0000-7000-8000-000000000107';
    reg.catalog(g1, sampler);
    reg.catalog(g2, sampler);
    // Single-asset package first: resolveName == basename.
    reg._registerPackage('assets/world.glb', [g1]);
    expect(reg.resolveName(g1)).toBe('world.glb');
    // A second member arrives: the original's derived basename freezes as its
    // stored name so it keeps a stable name on the multi-asset branch.
    reg._registerPackage('assets/world.glb', [g2], new Map([[g2, 'Ground']]));
    expect(reg.resolveName(g1)).toBe('world.glb');
    expect(reg.resolveName(g2)).toBe('Ground');
  });

  it('rename writes the stored name through the envelope', () => {
    const reg = makeReg();
    const a = '01890000-0000-7000-8000-000000000108';
    const b = '01890000-0000-7000-8000-000000000109';
    reg.catalog(a, sampler);
    reg.catalog(b, sampler);
    reg._registerPackage(
      'assets/pair.glb',
      [a, b],
      new Map([
        [a, 'First'],
        [b, 'Second'],
      ]),
    );
    const r = reg.rename(a, 'Renamed');
    expect(r.ok).toBe(true);
    expect(reg.resolveName(a)).toBe('Renamed');
    expect(reg.resolveName(b)).toBe('Second');
  });
});

// ── AC-06: ASSET_BRAND Record table maps every kind; consumption points read it ─

// One representative payload per Asset.kind (all 14 members of the closed union).
const KIND_FIXTURES: ReadonlyArray<{ kind: Asset['kind']; make: () => Asset }> = [
  {
    kind: 'mesh',
    make: () => ({
      kind: 'mesh',
      vertices: new Float32Array(12),
      indices: new Uint16Array([0]),
      attributes: {},
      submeshes: [{ indexOffset: 0, indexCount: 0, vertexCount: 0, topology: 'triangle-list' }],
    }),
  },
  {
    kind: 'texture',
    make: () => ({
      kind: 'texture',
      width: 4,
      height: 4,
      format: 'rgba8unorm',
      data: new Uint8Array(64),
      colorSpace: 'srgb',
      mipmap: false,
    }),
  },
  { kind: 'sampler', make: () => ({ kind: 'sampler', magFilter: 'linear', minFilter: 'linear' }) },
  {
    kind: 'material',
    make: () => ({
      kind: 'material',
      passes: [{ name: 'forward', shader: 'test::dummy', tags: { LightMode: 'Forward' } }],
      paramValues: {},
    }),
  },
  { kind: 'scene', make: () => ({ kind: 'scene', entities: [] }) },
  {
    kind: 'cube-texture',
    make: () => ({
      kind: 'cube-texture',
      width: 4,
      height: 4,
      format: 'rgba8unorm',
      faces: [
        new Uint8Array(64),
        new Uint8Array(64),
        new Uint8Array(64),
        new Uint8Array(64),
        new Uint8Array(64),
        new Uint8Array(64),
      ],
    }),
  },
  {
    kind: 'skeleton',
    make: () => ({ kind: 'skeleton', inverseBindMatrices: new Float32Array(16), jointCount: 1 }),
  },
  {
    kind: 'skin',
    make: () => ({
      kind: 'skin',
      skeletonGuid: '01890000-0000-7000-8000-0000000000ff',
      jointPaths: ['Root'],
    }),
  },
  { kind: 'animation-clip', make: () => ({ kind: 'animation-clip', duration: 1, channels: [] }) },
  {
    kind: 'audio',
    make: () => ({
      kind: 'audio',
      buffer: { length: 0, sampleRate: 48000, numberOfChannels: 1, duration: 0 } as AudioBuffer,
    }),
  },
  {
    kind: 'shader',
    make: () => ({ kind: 'shader', name: 'test::leaf', source: 'fn main() {}', paramSchema: [] }),
  },
  {
    kind: 'font',
    make: () => ({
      kind: 'font',
      atlas: parseGuid('01890000-0000-7000-8000-0000000000f1'),
      sampler: parseGuid('01890000-0000-7000-8000-0000000000f2'),
      glyphs: {},
      common: {
        lineHeight: 0,
        base: 0,
        distanceRange: 0,
        pxRange: 0,
        atlasWidth: 0,
        atlasHeight: 0,
      },
    }),
  },
  {
    kind: 'render-pipeline',
    make: () => ({ kind: 'render-pipeline', pipelineId: 'forgeax::urp' }),
  },
  {
    kind: 'tileset',
    make: () => ({
      kind: 'tileset',
      guid: 'test/tileset',
      atlases: [toShared<'TextureAsset'>(101)],
      tileWidth: 16,
      tileHeight: 16,
      columns: 1,
      rows: 1,
      regions: [],
      tiles: [],
    }),
  },
];

const EXPECTED_BRAND: Record<Asset['kind'], AssetBrand> = {
  mesh: 'MeshAsset',
  texture: 'TextureAsset',
  sampler: 'SamplerAsset',
  material: 'MaterialAsset',
  scene: 'SceneAsset',
  'cube-texture': 'CubeTextureAsset',
  skeleton: 'SkeletonAsset',
  skin: 'SkinAsset',
  'animation-clip': 'AnimationClip',
  audio: 'AudioClipAsset',
  shader: 'ShaderAsset',
  font: 'FontAsset',
  'render-pipeline': 'RenderPipelineAsset',
  tileset: 'TilesetAsset',
};

describe('AC-06 ASSET_BRAND table (assetBrand switch retired)', () => {
  it('maps all 14 Asset kinds to the expected brand', () => {
    // Independent expected table guards against a typo'd value in ASSET_BRAND.
    for (const kind of Object.keys(EXPECTED_BRAND) as Asset['kind'][]) {
      expect(ASSET_BRAND[kind]).toBe(EXPECTED_BRAND[kind]);
    }
    // Key completeness: the table covers exactly the 14 kinds and no extras.
    expect(Object.keys(ASSET_BRAND).sort()).toEqual(Object.keys(EXPECTED_BRAND).sort());
  });

  it('inspect().assets[].brand returns the correct brand per kind', () => {
    const reg = makeReg();
    const guidByKind = new Map<Asset['kind'], string>();
    KIND_FIXTURES.forEach((f, i) => {
      const guid = `02890000-0000-7000-8000-0000000001${(i + 10).toString(16).padStart(2, '0')}`;
      guidByKind.set(f.kind, guid.toLowerCase());
      reg.catalog(parseGuid(guid), f.make());
    });
    const snap = reg.inspect();
    for (const f of KIND_FIXTURES) {
      const guid = guidByKind.get(f.kind);
      const entry = snap.assets.find((e) => e.guid === guid);
      expect(entry, `inspect entry for ${f.kind}`).toBeDefined();
      expect(entry?.brand).toBe(EXPECTED_BRAND[f.kind]);
    }
  });
});
