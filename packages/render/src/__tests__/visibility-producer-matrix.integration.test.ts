import { HANDLE_CUBE, HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import {
  extractFrames,
  Instances,
  MeshFilter,
  MeshRenderer,
  SpriteInstances,
  TileLayer,
  Tilemap,
  tilemapChunkExtractSystem,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render/internal';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { type TilesetAsset, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

type ProducerCase = {
  readonly name: string;
  readonly setup: (world: World) => EntityHandle;
};

function staticMesh(world: World): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function skinnedMesh(world: World): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Skin, data: { skeleton: toShared<'SkeletonAsset'>(999), joints: [] } },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function spriteMesh(world: World): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: {} },
      {
        component: SpriteInstances,
        data: { transforms: IDENTITY, regions: new Float32Array([0, 0, 1, 1]) },
      },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function autoFoldInstances(world: World): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Instances, data: { transforms: IDENTITY } },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function explicitInstances(world: World): EntityHandle {
  return world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
      { component: Instances, data: { transforms: IDENTITY } },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
}

function tilemap(world: World): EntityHandle {
  const tileset: TilesetAsset = {
    kind: 'tileset',
    guid: 'visibility/producer-matrix',
    atlases: [toShared<'TextureAsset'>(101)],
    tileWidth: 16,
    tileHeight: 16,
    columns: 1,
    rows: 1,
    regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    tiles: [{ regionIndex: 0 }],
  };
  const tilesetHandle = world.allocSharedRef<'TilesetAsset', TilesetAsset>('TilesetAsset', tileset);
  const map = world
    .spawn(
      { component: Tilemap, data: { cols: 1, rows: 1, tileset: tilesetHandle } },
      { component: Transform, data: {} },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
  world.spawn(
    { component: TileLayer, data: { tiles: new Uint32Array([1]), dirty: 0 } },
    { component: ChildOf, data: { parent: map } },
  );
  tilemapChunkExtractSystem(world, 0);
  return map;
}

const PRODUCERS: readonly ProducerCase[] = [
  { name: 'static mesh', setup: staticMesh },
  { name: 'skinned mesh', setup: skinnedMesh },
  { name: 'sprite', setup: spriteMesh },
  { name: 'auto-fold Instances', setup: autoFoldInstances },
  { name: 'explicit Instances', setup: explicitInstances },
  { name: 'tilemap', setup: tilemap },
];

describe('visibility built-in producer matrix', () => {
  it.each(PRODUCERS)('$name is hidden, visible, then restorable', ({ setup }) => {
    const world = new World();
    const entity = setup(world);

    const hidden = extractFrames([world], 0);
    expect(hidden.renderables).toHaveLength(0);
    expect(hidden.dispatch).toHaveLength(0);

    world.set(entity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    const visible = extractFrames([world], 0);
    expect(visible.visibilitySnapshots[0]?.get(entity)?.effective).toBe('visible');

    world.set(entity, Visibility, { state: VisibilityStateValue.hidden }).unwrap();
    const restored = extractFrames([world], 0);
    expect(restored.renderables).toHaveLength(0);
    expect(restored.dispatch).toHaveLength(0);
  });
});
