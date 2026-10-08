import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createMeshBuilder } from '@forgeax/engine-geometry';
import {
  ANTIALIAS_NONE,
  Atmosphere,
  BLOOM_DISABLED,
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  PointLight,
  Skylight,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { Handle, MeshAsset, VertexAttributeMap } from '@forgeax/engine-types';

/** Public Atmosphere values; the DirectionalLight is the sun authority. */
export const WAVE1_ATMOSPHERE_PRESET = Object.freeze({
  rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6] as const,
  mieScattering: 3.996e-6,
  mieAnisotropy: 0.8,
  sunAngularRadius: 0.004675,
});

export interface Wave1RenderingRecipeOptions {
  readonly aspect?: number;
  /** Include the selected sky source for independent on/off comparisons. */
  readonly includeAtmosphere?: boolean;
}

export interface Wave1RenderingAssets {
  readonly wallClosed: MeshAsset;
  readonly wallAperture: MeshAsset;
  readonly successor: MeshAsset;
  readonly floor: MeshAsset;
  readonly roof: MeshAsset;
  readonly emissivePattern: MeshAsset;
  readonly wallClosedHandle: Handle<'MeshAsset', 'shared'>;
  readonly wallApertureHandle: Handle<'MeshAsset', 'shared'>;
  readonly successorHandle: Handle<'MeshAsset', 'shared'>;
  readonly floorHandle: Handle<'MeshAsset', 'shared'>;
  readonly roofHandle: Handle<'MeshAsset', 'shared'>;
  readonly emissivePatternHandle: Handle<'MeshAsset', 'shared'>;
  readonly wood: Handle<'MaterialAsset', 'shared'>;
  readonly metal: Handle<'MaterialAsset', 'shared'>;
  readonly floorMaterial: Handle<'MaterialAsset', 'shared'>;
  readonly emissiveAmber: Handle<'MaterialAsset', 'shared'>;
  readonly emissiveBlue: Handle<'MaterialAsset', 'shared'>;
  readonly emissiveGold: Handle<'MaterialAsset', 'shared'>;
}

export interface Wave1RenderingEntities {
  readonly wall: EntityHandle;
  readonly floor: EntityHandle;
  readonly screen: EntityHandle;
  readonly roof: EntityHandle;
  readonly camera: EntityHandle;
  readonly sun: EntityHandle;
  readonly skylight: EntityHandle;
  readonly localLight: EntityHandle;
  readonly atmosphere?: EntityHandle;
}

export interface Wave1RenderingRecipe {
  readonly assets: Wave1RenderingAssets;
  readonly entities: Wave1RenderingEntities;
  /** Spawn one ordinary MeshFilter/MeshRenderer successor in the same scene. */
  readonly spawnSuccessor: (position: readonly [number, number, number]) => EntityHandle;
  /** Spawn a fresh entity after the original wall is removed. */
  readonly spawnReplacement: () => EntityHandle;
  readonly setPosition: (entity: EntityHandle, position: readonly [number, number, number]) => void;
  readonly destroy: (entity: EntityHandle) => void;
  readonly dispose: () => void;
}

interface BoxSpec {
  readonly size: readonly [number, number, number];
  readonly position: readonly [number, number, number];
  readonly materialSlot: number;
  readonly color: readonly [number, number, number, number];
}

const TWO_MATERIAL_SLOTS = Object.freeze([{ slotName: 'wood' }, { slotName: 'metal' }]);
const WALL_MATERIAL_SLOTS = Object.freeze([
  { slotName: 'wood-left' },
  { slotName: 'metal-right' },
  { slotName: 'wood-top' },
  { slotName: 'metal-bottom' },
]);

function boxesMesh(
  specs: readonly BoxSpec[],
  materialSlots: readonly { slotName: string }[],
): MeshAsset {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const tangents: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const submeshes: Array<{
    readonly indexOffset: number;
    readonly indexCount: number;
    readonly vertexCount: number;
    readonly topology: 'triangle-list';
    readonly materialSlot: number;
  }> = [];

  for (const spec of specs) {
    const box = createBoxGeometry(spec.size[0], spec.size[1], spec.size[2]).unwrap();
    const position = box.attributes.position;
    const normal = box.attributes.normal;
    const uv = box.attributes.uv;
    const tangent = box.attributes.tangent;
    const boxIndices = box.indices;
    if (
      !(position instanceof Float32Array) ||
      !(normal instanceof Float32Array) ||
      !(uv instanceof Float32Array) ||
      !(tangent instanceof Float32Array) ||
      boxIndices === undefined
    ) {
      throw new Error('wave1-rendering: box factory did not provide canonical attributes');
    }

    const vertexOffset = positions.length / 3;
    const vertexCount = position.length / 3;
    const indexOffset = indices.length;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      const p = vertex * 3;
      const t = vertex * 4;
      const uvOffset = vertex * 2;
      positions.push(
        (position[p] ?? 0) + spec.position[0],
        (position[p + 1] ?? 0) + spec.position[1],
        (position[p + 2] ?? 0) + spec.position[2],
      );
      normals.push(normal[p] ?? 0, normal[p + 1] ?? 0, normal[p + 2] ?? 0);
      uvs.push(uv[uvOffset] ?? 0, uv[uvOffset + 1] ?? 0);
      tangents.push(tangent[t] ?? 1, tangent[t + 1] ?? 0, tangent[t + 2] ?? 0, tangent[t + 3] ?? 1);
      colors.push(spec.color[0], spec.color[1], spec.color[2], spec.color[3]);
    }
    for (const index of boxIndices) indices.push(index + vertexOffset);
    submeshes.push({
      indexOffset,
      indexCount: boxIndices.length,
      vertexCount,
      topology: 'triangle-list',
      materialSlot: spec.materialSlot,
    });
  }

  const attributes: VertexAttributeMap = {
    position: new Float32Array(positions),
    normal: new Float32Array(normals),
    uv: new Float32Array(uvs),
    tangent: new Float32Array(tangents),
    color: new Float32Array(colors),
  };
  const result = createMeshBuilder({
    attributes,
    indices,
    submeshes,
    materialSlots,
  }).build();
  if (!result.ok) throw result.error;
  return result.value;
}

function renderable(
  world: World,
  entities: Set<EntityHandle>,
  mesh: Handle<'MeshAsset', 'shared'>,
  materials: readonly Handle<'MaterialAsset', 'shared'>[],
  position: readonly [number, number, number],
): EntityHandle {
  const entity = world
    .spawn(
      { component: Transform, data: { pos: position } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials } },
    )
    .unwrap();
  entities.add(entity);
  return entity;
}

/**
 * Build one public Engine scene used by Browser/Dawn acceptance.
 *
 * The recipe intentionally contains only ordinary MeshAsset + PBR material
 * data. Dynamic topology and frame observation stay in the consumer test so
 * this scene can be reused by a dev verification script without a private
 * renderer adapter.
 */
export function createWave1RenderingRecipe(
  world: World,
  options: Wave1RenderingRecipeOptions = {},
): Wave1RenderingRecipe {
  const entities = new Set<EntityHandle>();
  const aspect = options.aspect ?? 1;

  const wallClosed = boxesMesh(
    [
      {
        size: [2.8, 2.6, 0.55],
        position: [0, 0, 0],
        materialSlot: 0,
        color: [0.92, 0.56, 0.22, 1],
      },
    ],
    WALL_MATERIAL_SLOTS,
  );
  const wallAperture = boxesMesh(
    [
      {
        size: [0.35, 2.6, 0.55],
        position: [-1.225, 0, 0],
        materialSlot: 0,
        color: [0.92, 0.56, 0.22, 1],
      },
      {
        size: [0.35, 2.6, 0.55],
        position: [1.225, 0, 0],
        materialSlot: 1,
        color: [0.58, 0.7, 0.86, 1],
      },
      {
        size: [2.1, 0.3, 0.55],
        position: [0, 1.15, 0],
        materialSlot: 0,
        color: [0.92, 0.56, 0.22, 1],
      },
      {
        size: [2.1, 0.3, 0.55],
        position: [0, -1.15, 0],
        materialSlot: 1,
        color: [0.58, 0.7, 0.86, 1],
      },
    ],
    WALL_MATERIAL_SLOTS,
  );
  const successor = boxesMesh(
    [
      {
        size: [0.65, 1.8, 0.5],
        position: [-0.42, 0, 0],
        materialSlot: 0,
        color: [0.84, 0.4, 0.16, 1],
      },
      {
        size: [0.65, 1.8, 0.5],
        position: [0.42, 0, 0],
        materialSlot: 1,
        color: [0.5, 0.62, 0.78, 1],
      },
    ],
    TWO_MATERIAL_SLOTS,
  );
  const floor = boxesMesh(
    [
      {
        size: [8, 0.2, 8],
        position: [0, 0, 0],
        materialSlot: 0,
        color: [0.72, 0.78, 0.9, 1],
      },
    ],
    [{ slotName: 'floor' }],
  );
  const roof = boxesMesh(
    [
      {
        size: [4.2, 0.15, 3.2],
        position: [0, 0, 0],
        materialSlot: 0,
        color: [0.36, 0.42, 0.52, 1],
      },
    ],
    [{ slotName: 'roof' }],
  );
  const emissivePattern = boxesMesh(
    [
      {
        size: [0.24, 1.45, 0.08],
        position: [-0.58, 0.2, 0],
        materialSlot: 0,
        color: [1, 1, 1, 1],
      },
      {
        size: [0.24, 1.45, 0.08],
        position: [0, 0.2, 0],
        materialSlot: 1,
        color: [1, 1, 1, 1],
      },
      {
        size: [0.24, 1.45, 0.08],
        position: [0.58, 0.2, 0],
        materialSlot: 2,
        color: [1, 1, 1, 1],
      },
    ],
    [{ slotName: 'amber' }, { slotName: 'blue' }, { slotName: 'gold' }],
  );

  const wallClosedHandle = world.allocSharedRef('MeshAsset', wallClosed);
  const wallApertureHandle = world.allocSharedRef('MeshAsset', wallAperture);
  const successorHandle = world.allocSharedRef('MeshAsset', successor);
  const floorHandle = world.allocSharedRef('MeshAsset', floor);
  const roofHandle = world.allocSharedRef('MeshAsset', roof);
  const emissivePatternHandle = world.allocSharedRef('MeshAsset', emissivePattern);

  const wood = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.62, 0.25, 0.07, 1],
      metallic: 0,
      roughness: 0.78,
    }),
  );
  const metal = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.42, 0.5, 0.62, 1],
      metallic: 0.82,
      roughness: 0.2,
    }),
  );
  const floorMaterial = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.12, 0.16, 0.22, 1],
      metallic: 0.08,
      roughness: 0.92,
    }),
  );
  const emissiveAmber = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.04, 0.03, 0.02, 1],
      metallic: 0.1,
      roughness: 0.35,
      emissive: [1, 0.08, 0.01],
      emissiveIntensity: 5,
    }),
  );
  const emissiveBlue = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.01, 0.03, 0.08, 1],
      metallic: 0.15,
      roughness: 0.28,
      emissive: [0.02, 0.28, 1],
      emissiveIntensity: 3.5,
    }),
  );
  const emissiveGold = world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [0.06, 0.04, 0.01, 1],
      metallic: 0.2,
      roughness: 0.3,
      emissive: [1, 0.6, 0.04],
      emissiveIntensity: 7,
    }),
  );

  const assets: Wave1RenderingAssets = {
    wallClosed,
    wallAperture,
    successor,
    floor,
    roof,
    emissivePattern,
    wallClosedHandle,
    wallApertureHandle,
    successorHandle,
    floorHandle,
    roofHandle,
    emissivePatternHandle,
    wood,
    metal,
    floorMaterial,
    emissiveAmber,
    emissiveBlue,
    emissiveGold,
  };

  const wall = renderable(world, entities, wallClosedHandle, [wood, metal, wood, metal], [0, 0, 0]);
  const floorEntity = renderable(world, entities, floorHandle, [floorMaterial], [0, -1.42, 0]);
  const screen = renderable(
    world,
    entities,
    emissivePatternHandle,
    [emissiveAmber, emissiveBlue, emissiveGold],
    [0, 0.15, -0.34],
  );
  // Start outside the camera frustum. Moving this same entity into the light
  // path below is the off-screen occlusion contrast in the consumer test.
  const roofEntity = renderable(world, entities, roofHandle, [metal], [20, 2.9, 0.5]);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0.65, 7] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect,
          near: 0.1,
          far: 40,
          tonemap: TONEMAP_REINHARD_EXTENDED,
          exposure: 1,
          whitePoint: 4,
          antialias: ANTIALIAS_NONE,
          bloom: BLOOM_DISABLED,
          autoAspect: false,
          clearColor: [0.015, 0.02, 0.035, 1],
        },
      },
    )
    .unwrap();
  entities.add(camera);
  const sun = world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [-0.55, -1, -0.4],
        color: [1, 0.91, 0.78],
        intensity: 3.4,
        castShadow: true,
        mapSize: 1024,
        shadowDistance: 25,
      },
    })
    .unwrap();
  entities.add(sun);
  const skylight = world
    .spawn({
      component: Skylight,
      data: { color: [0.42, 0.54, 0.78], intensity: 0.18 },
    })
    .unwrap();
  entities.add(skylight);
  const localLight = world
    .spawn(
      { component: Transform, data: { pos: [0, 1.4, 3.2] } },
      {
        component: PointLight,
        data: { color: [1, 0.48, 0.24], intensity: 22, range: 9 },
      },
    )
    .unwrap();
  entities.add(localLight);

  let atmosphere: EntityHandle | undefined;
  if (options.includeAtmosphere === true) {
    atmosphere = world.spawn({ component: Atmosphere, data: WAVE1_ATMOSPHERE_PRESET }).unwrap();
    entities.add(atmosphere);
  }

  const destroy = (entity: EntityHandle): void => {
    if (!entities.delete(entity)) return;
    world.despawn(entity).unwrap();
  };
  const spawnSuccessor = (position: readonly [number, number, number]): EntityHandle =>
    renderable(world, entities, successorHandle, [wood, metal], position);
  const spawnReplacement = (): EntityHandle =>
    renderable(world, entities, wallClosedHandle, [wood, metal, wood, metal], [0, 0, 0]);
  const setPosition = (entity: EntityHandle, position: readonly [number, number, number]): void => {
    world.set(entity, Transform, { pos: position }).unwrap();
  };
  const dispose = (): void => {
    for (const entity of [...entities].reverse()) world.despawn(entity).unwrap();
    entities.clear();
    const handles: readonly Handle<string, 'shared'>[] = [
      wallClosedHandle,
      wallApertureHandle,
      successorHandle,
      floorHandle,
      roofHandle,
      emissivePatternHandle,
      wood,
      metal,
      floorMaterial,
      emissiveAmber,
      emissiveBlue,
      emissiveGold,
    ];
    for (const handle of handles) world.sharedRefs.release(handle).unwrap();
  };

  return {
    assets,
    entities: {
      wall,
      floor: floorEntity,
      screen,
      roof: roofEntity,
      camera,
      sun,
      skylight,
      localLight,
      ...(atmosphere === undefined ? {} : { atmosphere }),
    },
    spawnSuccessor,
    spawnReplacement,
    setPosition,
    destroy,
    dispose,
  };
}
