import { type EntityHandle, FrameEnd, World } from '@forgeax/engine-ecs';
import { MeshFilter } from '@forgeax/engine-render';
import { TileLayer, Tilemap, tilemapChunkExtractSystem } from '@forgeax/engine-render/authoring';
import { ChildOf, Children, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

describe('tilemap derivation and Transform publication order', () => {
  it('materializes in FrameEnd and publishes the new world matrix before update returns', () => {
    const world = new World();
    registerPropagateTransforms(world);
    const map = world
      .spawn(
        {
          component: Tilemap,
          data: {
            cols: 1,
            rows: 1,
            tileSize: [2, 2],
            chunkSize: 1,
            tileset: world.allocSharedRef('TilesetAsset', {
              kind: 'tileset',
              guid: 'test/frame-publish-order',
              atlases: [toShared(101)],
              tileWidth: 1,
              tileHeight: 1,
              columns: 1,
              rows: 1,
              regions: [{ x: 0, y: 0, width: 1, height: 1 }],
              tiles: [{ regionIndex: 0 }],
            }),
          },
        },
        { component: Transform, data: { pos: [4, 0, 0] } },
      )
      .unwrap();
    const layer = world
      .spawn(
        {
          component: TileLayer,
          data: { tiles: new Uint32Array([1]), dirty: 1, sortScope: 1 },
        },
        { component: Transform, data: {} },
        { component: ChildOf, data: { parent: map } },
      )
      .unwrap();
    world
      .addSystem(FrameEnd, {
        name: 'renderDerivedEntities',
        queries: [],
        fn: tilemapChunkExtractSystem,
      })
      .unwrap();

    world.update(1 / 60).unwrap();

    const derivedTable = world
      .inspect()
      .archetypes.find((table) => table.componentNames.includes(MeshFilter.name));
    expect(derivedTable?.entityCount).toBe(1);
    const children = world.get(layer, Children).unwrap();
    const derived = children.entities[0] as EntityHandle | undefined;
    expect(derived).toBeDefined();
    const transform = derived === undefined ? undefined : world.get(derived, Transform);
    const matrix = transform?.ok ? transform.value.world : undefined;
    expect({
      derived: matrix?.[12],
      layer: world.get(layer, Transform).unwrap().world[12],
      map: world.get(map, Transform).unwrap().world[12],
      structureEpoch: (world as unknown as { _getStructureEpoch(): number })._getStructureEpoch(),
    }).toEqual({ derived: 5, layer: 4, map: 4, structureEpoch: expect.any(Number) });
    expect(matrix?.[13]).toBeCloseTo(1);
    expect(world.inspect().schedules.map((entry) => entry.schedule.name)).not.toContain(
      'FramePublish',
    );
  });
});
