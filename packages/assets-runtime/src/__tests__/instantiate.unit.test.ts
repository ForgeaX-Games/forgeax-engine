// @forgeax/engine-assets-runtime -- AssetRegistry.instantiate / instantiateFlat
// coverage (fix issue #709). Drives the scene-instantiate collaboration module
// (instantiate.ts) end-to-end through a real World + the two-tier handle
// resolver. The assertions check the structured Result surface (charter P3:
// instantiate never throws for an expected failure) rather than a specific
// spawn outcome, so the coverage does not couple to the full ECS scene-spawn
// prerequisites (node env, no GPU).

import { defineComponent, World } from '@forgeax/engine-ecs';
import type { Asset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';
import { resolveAssetHandle } from '../resolve-asset-handle';
import { parseScenePayload } from '../scene-payload';

const T709Tag = defineComponent('T709Tag', { value: 'f32' });
const T709MaterialCarrier = defineComponent('T709MaterialCarrier', {
  materials: 'array<shared<MaterialAsset>>',
});
const MeshFilterComponent = defineComponent('MeshFilter', { assetHandle: 'shared<MeshAsset>' });
const MeshRendererComponent = defineComponent('MeshRenderer', {
  materials: 'array<shared<MaterialAsset>>',
});
const Transform = defineComponent('Transform', {
  posX: 'f32',
  posY: 'f32',
  posZ: 'f32',
});
const ChildOf = defineComponent('ChildOf', { parent: 'entity' });
const SceneInstance = defineComponent('SceneInstance', {
  source: 'shared<SceneAsset>',
  mapping: 'array<entity>',
  state: 'unique<SceneInstanceState>',
});

const SCENE_COMPONENTS = [
  T709Tag,
  T709MaterialCarrier,
  MeshFilterComponent,
  MeshRendererComponent,
  Transform,
  ChildOf,
  SceneInstance,
] as const;

const MATERIAL_GUID = '11111111-1111-4111-8111-111111111111';
const CHILD_A_GUID = '22222222-2222-4222-8222-222222222222';
const CHILD_B_GUID = '33333333-3333-4333-8333-333333333333';
const PARENT_GUID = '44444444-4444-4444-8444-444444444444';
const MIGRATION_MESH_GUID = '55555555-5555-4555-8555-555555555555';
const MIGRATION_MATERIAL_A_GUID = '66666666-6666-4666-8666-666666666666';
const MIGRATION_MATERIAL_B_GUID = '77777777-7777-4777-8777-777777777777';
const MIGRATION_SCENE_GUID = '88888888-8888-4888-8888-888888888888';
const MIGRATION_MATERIAL_C_GUID = '99999999-9999-4999-8999-999999999999';
const MIGRATION_CHILD_SCENE_GUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MIGRATION_ALT_MESH_GUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MIGRATION_GRANDCHILD_SCENE_GUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function makeRegistry(): AssetRegistry {
  return new AssetRegistry({
    getMaterialShaderManifest: vi.fn().mockReturnValue(undefined),
    findMaterialArtifact: vi.fn().mockReturnValue({ ok: false, error: new Error('mock') }),
    getPipeline: vi.fn().mockReturnValue(undefined),
    installMaterialArtifact: vi.fn(),
    inspect: vi.fn().mockReturnValue({ materialShaders: [] }),
  } as unknown as import('@forgeax/engine-shader').ShaderRegistry);
}

function makeWorld(): World {
  const world = new World();
  for (const component of SCENE_COMPONENTS) {
    world.components.register(component).unwrap();
  }
  return world;
}

function twoEntityScene(): SceneAsset {
  return {
    kind: 'scene',
    entities: [
      { localId: 0 as never, components: { T709Tag: { value: 1 } } },
      { localId: 1 as never, components: { T709Tag: { value: 2 } } },
    ],
    mounts: [],
  } as unknown as SceneAsset;
}

function isResult(v: unknown): v is { ok: boolean } {
  return typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';
}

describe('AssetRegistry.instantiate', () => {
  it('resolves a catalogued scene handle and returns a structured Result', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    const scene = twoEntityScene();
    const handle = world.allocSharedRef('SceneAsset', scene);
    const res = reg.instantiate(handle, world);
    expect(isResult(res)).toBe(true);
    if (res.ok) expect(typeof res.value).toBe('number');
  });

  it('returns an error Result when the handle does not resolve to a scene', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    const handle = world.allocSharedRef('SceneAsset', { kind: 'material' } as unknown as Asset);
    const res = reg.instantiate(handle as never, world);
    expect(res.ok).toBe(false);
  });
});

describe('AssetRegistry.instantiateFlat', () => {
  it('drives the flat scene-materialise path to a structured Result', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    const handle = world.allocSharedRef('SceneAsset', twoEntityScene());
    const res = reg.instantiateFlat(handle, world);
    expect(isResult(res)).toBe(true);
    if (res.ok) expect(Array.isArray(res.value)).toBe(true);
  });
});

describe('scene graph GUID handle ownership', () => {
  it('mints one handle per GUID across sibling mount recursion', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    const material = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' } },
        },
      ],
      values: {},
    } as unknown as Asset;
    const child = (value: number): SceneAsset => ({
      kind: 'scene',
      entities: [
        {
          localId: 0 as never,
          components: {
            T709Tag: { value },
            T709MaterialCarrier: { materials: [MATERIAL_GUID] },
          },
        },
      ],
    });
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        { localId: 0 as never, source: CHILD_A_GUID, memberFirst: 1 as never, memberCount: 1 },
        { localId: 2 as never, source: CHILD_B_GUID, memberFirst: 3 as never, memberCount: 1 },
        { localId: 4 as never, source: CHILD_A_GUID, memberFirst: 5 as never, memberCount: 1 },
      ],
    };
    reg.catalog(MATERIAL_GUID, material);
    reg.catalog(CHILD_A_GUID, child(1));
    reg.catalog(CHILD_B_GUID, child(2));
    reg.catalog(PARENT_GUID, parent);

    const resolved = reg._resolveSceneGuids(parent, world, PARENT_GUID);

    expect(resolved).toMatchObject({ ok: true });
    if (!resolved.ok) return;
    const childHandles = resolved.value.mounts?.map((mount) => mount.source) ?? [];
    expect(childHandles).toHaveLength(3);
    expect(childHandles[2]).toBe(childHandles[0]);
    const resolvedChildren = childHandles.map((handle) =>
      resolveAssetHandle<SceneAsset>(world, handle as never).unwrap(),
    );
    const materialHandles = resolvedChildren.map(
      (scene) =>
        (
          scene.entities[0]?.components as Record<
            string,
            { readonly materials?: readonly number[] }
          >
        ).T709MaterialCarrier?.materials?.[0],
    );
    expect(materialHandles[0]).toBeGreaterThanOrEqual(1024);
    expect(materialHandles[1]).toBe(materialHandles[0]);
    expect(materialHandles[2]).toBe(materialHandles[0]);
  });

  it('reuses a catalogued payload handle across separate scene resolutions', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    const material = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' } },
        },
      ],
      values: {},
    } as unknown as Asset;
    const scene: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: 0 as never,
          components: {
            T709MaterialCarrier: { materials: [MATERIAL_GUID] },
          },
        },
      ],
    };
    expect(reg.catalog(MATERIAL_GUID, material).ok).toBe(true);

    const first = reg._resolveSceneGuids(scene, world);
    const second = reg._resolveSceneGuids(scene, world);

    if (!first.ok) throw first.error;
    if (!second.ok) throw second.error;
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    const handleOf = (resolved: SceneAsset): number | undefined =>
      (
        resolved.entities[0]?.components as Record<
          string,
          { readonly materials?: readonly number[] }
        >
      ).T709MaterialCarrier?.materials?.[0];
    expect(handleOf(second.value)).toBe(handleOf(first.value));
    expect(world.sharedRefs._liveCount()).toBe(1);
  });
});

describe('serialized v2 scene material override migration', () => {
  function registerMigrationAssets(reg: AssetRegistry): void {
    const material = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::default-unlit' },
          renderState: { tags: { LightMode: 'Forward' } },
        },
      ],
      values: {},
    } as unknown as Asset;
    expect(reg.catalog(MIGRATION_MATERIAL_A_GUID, material).ok).toBe(true);
    expect(reg.catalog(MIGRATION_MATERIAL_B_GUID, { ...material } as Asset).ok).toBe(true);
    expect(reg.catalog(MIGRATION_MATERIAL_C_GUID, material).ok).toBe(true);
    const meshResult = reg.catalog(MIGRATION_MESH_GUID, {
      kind: 'mesh',
      vertices: new Float32Array(12),
      indices: new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0]),
      attributes: {},
      submeshes: [
        {
          indexOffset: 0,
          indexCount: 3,
          vertexCount: 1,
          topology: 'triangle-list',
          materialSlot: 1,
        },
        {
          indexOffset: 3,
          indexCount: 3,
          vertexCount: 1,
          topology: 'triangle-list',
          materialSlot: 0,
        },
        {
          indexOffset: 6,
          indexCount: 3,
          vertexCount: 1,
          topology: 'triangle-list',
          materialSlot: 1,
        },
      ],
      materialSlots: [
        { slotName: 'Body', sourceKey: 'material:body' },
        { slotName: 'Accent', sourceKey: 'material:accent' },
      ],
    } as unknown as Asset);
    expect(meshResult.ok).toBe(true);
    const baseMesh = reg.assetCatalog.get(MIGRATION_MESH_GUID)?.payload;
    if (baseMesh?.kind !== 'mesh') throw new Error('migration mesh missing');
    expect(
      reg.catalog(MIGRATION_ALT_MESH_GUID, {
        ...baseMesh,
        submeshes: baseMesh.submeshes.map((section, index) => ({
          ...section,
          materialSlot: index === 1 ? 1 : 0,
        })),
      }).ok,
    ).toBe(true);
  }

  function parseSerialized(
    materialRefIndices: readonly number[],
    prefix?: readonly number[],
  ): SceneAsset {
    const parsed = parseScenePayload(
      {
        entities: [
          ...(prefix === undefined
            ? []
            : [
                {
                  localId: 16,
                  components: {
                    MeshFilter: { assetHandle: 0 },
                    MeshRenderer: { materials: prefix },
                  },
                },
              ]),
          {
            localId: 17,
            components: {
              MeshFilter: { assetHandle: 0 },
              MeshRenderer: { materials: materialRefIndices },
            },
          },
        ],
      },
      [
        MIGRATION_MESH_GUID,
        MIGRATION_MATERIAL_A_GUID,
        MIGRATION_MATERIAL_B_GUID,
        MIGRATION_MATERIAL_C_GUID,
      ],
    );
    if (parsed === undefined || !('kind' in parsed))
      throw new Error('serialized scene fixture did not parse');
    return parsed;
  }

  function mountChildScene(): SceneAsset {
    return {
      kind: 'scene',
      entities: [
        {
          localId: 0 as never,
          components: {
            MeshFilter: { assetHandle: MIGRATION_MESH_GUID as never },
            MeshRenderer: { materials: [] },
          },
        },
      ],
    };
  }

  it('collapses equal per-section overrides in the resolved scene saved by the Editor', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    registerMigrationAssets(reg);
    const scene = parseSerialized([1, 2, 1]);
    reg.catalog(MIGRATION_SCENE_GUID, scene, [
      {
        guid: MIGRATION_MESH_GUID,
        sceneEntityId: 17,
        sourceField: { componentName: 'MeshFilter', fieldName: 'assetHandle' },
      },
      {
        guid: MIGRATION_MATERIAL_A_GUID,
        sceneEntityId: 17,
        sourceField: { componentName: 'MeshRenderer', fieldName: 'materials', arrayIndex: 0 },
      },
      {
        guid: MIGRATION_MATERIAL_B_GUID,
        sceneEntityId: 17,
        sourceField: { componentName: 'MeshRenderer', fieldName: 'materials', arrayIndex: 1 },
      },
      {
        guid: MIGRATION_MATERIAL_A_GUID,
        sceneEntityId: 17,
        sourceField: { componentName: 'MeshRenderer', fieldName: 'materials', arrayIndex: 2 },
      },
    ]);

    const result = reg._resolveSceneGuids(scene, world, MIGRATION_SCENE_GUID);
    if (!result.ok) throw result.error;
    const materials = (result.value.entities[0]?.components.MeshRenderer as { materials: number[] })
      .materials;
    expect(materials).toHaveLength(2);
    expect(resolveAssetHandle<Asset>(world, materials[0] as never).unwrap()).toBe(
      reg.assetCatalog.get(MIGRATION_MATERIAL_B_GUID)?.payload,
    );
    expect(resolveAssetHandle<Asset>(world, materials[1] as never).unwrap()).toBe(
      reg.assetCatalog.get(MIGRATION_MATERIAL_A_GUID)?.payload,
    );
  });

  it('fails before rewriting the serialized scene when section overrides conflict', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    registerMigrationAssets(reg);
    const scene = parseSerialized([1, 2, 3], [1, 2, 1]);
    const before = JSON.stringify(scene);
    reg.catalog(MIGRATION_SCENE_GUID, scene);
    const liveBefore = world.sharedRefs._liveCount();

    const result = reg._resolveSceneGuids(scene, world, MIGRATION_SCENE_GUID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toMatchObject({
        code: 'mesh-material-slot-override-conflict',
        meshGuid: MIGRATION_MESH_GUID,
        sceneGuid: MIGRATION_SCENE_GUID,
        entityId: 17,
        materialSlot: 1,
        submeshIndices: [0, 2],
        overrideGuids: [MIGRATION_MATERIAL_A_GUID, MIGRATION_MATERIAL_C_GUID],
      });
    }
    expect(JSON.stringify(scene)).toBe(before);
    expect(world.sharedRefs._liveCount()).toBe(liveBefore);
  });

  it('preflights nested mount conflicts before parent references touch the World', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    registerMigrationAssets(reg);
    const child = parseSerialized([1, 2, 3]);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [
        {
          localId: 0 as never,
          components: { T709MaterialCarrier: { materials: [MIGRATION_MATERIAL_B_GUID] } },
        },
      ],
      mounts: [
        {
          localId: 1 as never,
          source: MIGRATION_CHILD_SCENE_GUID,
          memberFirst: 2 as never,
          memberCount: 1,
        },
      ],
    };
    reg.catalog(MIGRATION_CHILD_SCENE_GUID, child);
    reg.catalog(MIGRATION_SCENE_GUID, parent);
    const liveBefore = world.sharedRefs._liveCount();

    const result = reg._resolveSceneGuids(parent, world, MIGRATION_SCENE_GUID);
    expect(result.ok).toBe(false);
    expect(world.sharedRefs._liveCount()).toBe(liveBefore);
  });

  it('migrates PATCH mount materials using the mounted member mesh', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    registerMigrationAssets(reg);
    const child = mountChildScene();
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: 0 as never,
          source: MIGRATION_CHILD_SCENE_GUID,
          memberFirst: 1 as never,
          memberCount: 1,
          overrides: [
            {
              localId: 1 as never,
              comp: 'MeshRenderer',
              field: 'materials',
              value: [
                MIGRATION_MATERIAL_A_GUID,
                MIGRATION_MATERIAL_B_GUID,
                MIGRATION_MATERIAL_A_GUID,
              ],
            },
          ],
        },
      ],
    };
    reg.catalog(MIGRATION_CHILD_SCENE_GUID, child);
    reg.catalog(MIGRATION_SCENE_GUID, parent);

    const result = reg._resolveSceneGuids(parent, world, MIGRATION_SCENE_GUID);
    if (!result.ok) throw result.error;
    const materials = result.value.mounts?.[0]?.overrides?.[0]?.value as number[];
    expect(materials).toHaveLength(2);
    expect(resolveAssetHandle<Asset>(world, materials[0] as never).unwrap()).toBe(
      reg.assetCatalog.get(MIGRATION_MATERIAL_B_GUID)?.payload,
    );
    expect(resolveAssetHandle<Asset>(world, materials[1] as never).unwrap()).toBe(
      reg.assetCatalog.get(MIGRATION_MATERIAL_A_GUID)?.payload,
    );
  });

  it('applies an earlier MeshFilter override before migrating UPSERT mount materials', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    registerMigrationAssets(reg);
    const child = mountChildScene();
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: 0 as never,
          source: MIGRATION_CHILD_SCENE_GUID,
          memberFirst: 1 as never,
          memberCount: 1,
          overrides: [
            {
              localId: 1 as never,
              comp: 'MeshFilter',
              field: 'assetHandle',
              value: MIGRATION_ALT_MESH_GUID,
            },
            {
              localId: 1 as never,
              comp: 'MeshRenderer',
              value: {
                materials: [
                  MIGRATION_MATERIAL_A_GUID,
                  MIGRATION_MATERIAL_B_GUID,
                  MIGRATION_MATERIAL_A_GUID,
                ],
              },
            },
          ],
        },
      ],
    };
    reg.catalog(MIGRATION_CHILD_SCENE_GUID, child);
    reg.catalog(MIGRATION_SCENE_GUID, parent);

    const result = reg._resolveSceneGuids(parent, world, MIGRATION_SCENE_GUID);
    if (!result.ok) throw result.error;
    const value = result.value.mounts?.[0]?.overrides?.[1]?.value as { materials: number[] };
    expect(value.materials).toHaveLength(2);
    expect(resolveAssetHandle<Asset>(world, value.materials[0] as never).unwrap()).toBe(
      reg.assetCatalog.get(MIGRATION_MATERIAL_A_GUID)?.payload,
    );
    expect(resolveAssetHandle<Asset>(world, value.materials[1] as never).unwrap()).toBe(
      reg.assetCatalog.get(MIGRATION_MATERIAL_B_GUID)?.payload,
    );
  });

  it('rejects conflicting mount materials before any World mutation', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    registerMigrationAssets(reg);
    const child = mountChildScene();
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: 0 as never,
          source: MIGRATION_CHILD_SCENE_GUID,
          memberFirst: 1 as never,
          memberCount: 1,
          overrides: [
            {
              localId: 1 as never,
              comp: 'MeshRenderer',
              field: 'materials',
              value: [
                MIGRATION_MATERIAL_A_GUID,
                MIGRATION_MATERIAL_B_GUID,
                MIGRATION_MATERIAL_C_GUID,
              ],
            },
          ],
        },
      ],
    };
    reg.catalog(MIGRATION_CHILD_SCENE_GUID, child);
    reg.catalog(MIGRATION_SCENE_GUID, parent);
    const liveBefore = world.sharedRefs._liveCount();

    const result = reg._resolveSceneGuids(parent, world, MIGRATION_SCENE_GUID);
    expect(result.ok).toBe(false);
    expect(world.sharedRefs._liveCount()).toBe(liveBefore);
  });

  it('migrates an override that targets a nested mount member slot', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    registerMigrationAssets(reg);
    const grandchild = mountChildScene();
    const child: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: 0 as never,
          source: MIGRATION_GRANDCHILD_SCENE_GUID,
          memberFirst: 1 as never,
          memberCount: 1,
        },
      ],
    };
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: 0 as never,
          source: MIGRATION_CHILD_SCENE_GUID,
          memberFirst: 1 as never,
          memberCount: 2,
          overrides: [
            {
              localId: 2 as never,
              comp: 'MeshRenderer',
              field: 'materials',
              value: [
                MIGRATION_MATERIAL_A_GUID,
                MIGRATION_MATERIAL_B_GUID,
                MIGRATION_MATERIAL_A_GUID,
              ],
            },
          ],
        },
      ],
    };
    reg.catalog(MIGRATION_GRANDCHILD_SCENE_GUID, grandchild);
    reg.catalog(MIGRATION_CHILD_SCENE_GUID, child);
    reg.catalog(MIGRATION_SCENE_GUID, parent);

    const result = reg._resolveSceneGuids(parent, world, MIGRATION_SCENE_GUID);
    if (!result.ok) throw result.error;
    const materials = result.value.mounts?.[0]?.overrides?.[0]?.value as number[];
    expect(materials).toHaveLength(2);
    expect(resolveAssetHandle<Asset>(world, materials[0] as never).unwrap()).toBe(
      reg.assetCatalog.get(MIGRATION_MATERIAL_B_GUID)?.payload,
    );
  });

  it('migrates material arrays authored on the mount entity itself', () => {
    const reg = makeRegistry();
    const world = makeWorld();
    registerMigrationAssets(reg);
    const parent: SceneAsset = {
      kind: 'scene',
      entities: [],
      mounts: [
        {
          localId: 0 as never,
          source: MIGRATION_CHILD_SCENE_GUID,
          memberFirst: 1 as never,
          memberCount: 1,
          components: {
            MeshFilter: { assetHandle: MIGRATION_MESH_GUID as never },
            MeshRenderer: {
              materials: [
                MIGRATION_MATERIAL_A_GUID,
                MIGRATION_MATERIAL_B_GUID,
                MIGRATION_MATERIAL_A_GUID,
              ] as never,
            },
          },
        },
      ],
    };
    reg.catalog(MIGRATION_CHILD_SCENE_GUID, mountChildScene());
    reg.catalog(MIGRATION_SCENE_GUID, parent);

    const parentHandle = world.allocSharedRef('SceneAsset', parent);
    const result = reg.instantiateFlat(parentHandle, world);
    if (!result.ok) throw result.error;
    const carrier = result.value.find((entity) => world.get(entity, MeshFilterComponent).ok);
    expect(carrier).toBeDefined();
    if (carrier === undefined) return;
    const meshHandle = world.get(carrier, MeshFilterComponent).unwrap().assetHandle;
    const materials = world.get(carrier, MeshRendererComponent).unwrap().materials;
    expect(resolveAssetHandle<Asset>(world, meshHandle as never).unwrap()).toBe(
      reg.assetCatalog.get(MIGRATION_MESH_GUID)?.payload,
    );
    expect(materials).toHaveLength(2);
    expect(resolveAssetHandle<Asset>(world, materials[0] as never).unwrap()).toBe(
      reg.assetCatalog.get(MIGRATION_MATERIAL_B_GUID)?.payload,
    );
    expect(resolveAssetHandle<Asset>(world, materials[1] as never).unwrap()).toBe(
      reg.assetCatalog.get(MIGRATION_MATERIAL_A_GUID)?.payload,
    );
  });
});
