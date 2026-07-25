import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { Collider, ColliderShapeValue, RigidBody, RigidBodyTypeValue } from '@forgeax/engine-physics';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Materials, MeshFilter, MeshRenderer, SceneInstance } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import type { BootstrapContext } from '@forgeax/engine-app';
import type { Handle, MaterialAsset } from '@forgeax/engine-runtime';
import type { SceneAsset } from '@forgeax/engine-types';

export type MatHandle = Handle<'MaterialAsset', 'shared'>;
export type GameContext = {
  world: World;
  assets?: import('@forgeax/engine-assets-runtime').AssetRegistry;
};
export type PackNode = {
  localId: number;
  components: Record<string, Record<string, unknown>>;
};
export type LoadedScene = {
  mapping: ReadonlyMap<number, EntityHandle>;
  nodes: PackNode[];
};
export type ScenePhysics = {
  props: Array<{ e: EntityHandle; mat: MatHandle }>;
  walkBlockers: Array<{ cx: number; cz: number; r: number }>;
  targets: Array<{ e: EntityHandle; points: number }>;
};

export const SCENE_GUID = '1036f6f0-d3c2-5f31-9593-3432942d4c93';
export const PLAYER_Y = 0.75;

export async function loadScene(ctx: GameContext): Promise<LoadedScene | null> {
  if (!ctx.assets) return null;
  const guid = AssetGuid.parse(SCENE_GUID);
  if (!guid.ok) return null;
  const loaded = await ctx.assets.loadByGuid<SceneAsset>(guid.value);
  if (!loaded.ok) return null;
  const handle = ctx.world.allocSharedRef('SceneAsset', loaded.value);
  const instance = ctx.assets.instantiate<SceneAsset>(handle, ctx.world);
  if (!instance.ok) return null;
  const scene = ctx.world.get(instance.value, SceneInstance);
  if (!scene.ok) return null;
  const mapping = new Map<number, EntityHandle>();
  const mappingArray = scene.value.mapping as unknown as { [index: number]: number };
  for (const node of loaded.value.entities as unknown as PackNode[]) {
    const entity = mappingArray[node.localId];
    if (entity !== undefined && entity !== 0xffffffff && entity !== 0) {
      mapping.set(node.localId, entity as EntityHandle);
    }
  }
  return { mapping, nodes: loaded.value.entities as unknown as PackNode[] };
}

export function loadedFromHost(world: World, ctx: BootstrapContext): LoadedScene | null {
  const root = ctx.defaultSceneRoot;
  if (root === undefined || ctx.defaultScene === undefined) return null;
  const scene = world.get(root, SceneInstance);
  if (!scene.ok) return null;
  const mapping = new Map<number, EntityHandle>();
  const mappingArray = scene.value.mapping as unknown as { length: number; [index: number]: number };
  for (let localId = 0; localId < mappingArray.length; localId++) {
    const entity = mappingArray[localId];
    if (entity !== undefined && entity !== 0xffffffff && entity !== 0) {
      mapping.set(localId, entity as EntityHandle);
    }
  }
  return { mapping, nodes: ctx.defaultScene.entities as unknown as PackNode[] };
}

export function spawnFallbackScene(ctx: GameContext): void {
  const material = ctx.world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({
    baseColor: [0.48, 0.62, 0.35, 1], roughness: 0.95, metallic: 0,
  }));
  ctx.world.spawn(
    { component: Transform, data: { pos: [0, -0.1, 0], scale: [24, 0.2, 24] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
}

export function spawnGroundCollider(ctx: GameContext): void {
  ctx.world.spawn(
    { component: Transform, data: { pos: [0, -5, 0] } },
    { component: RigidBody, data: { type: RigidBodyTypeValue.static } },
    { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [60, 5, 60], friction: 0.9, restitution: 0 } },
  );
}

export function setupPlayerRoot(ctx: GameContext, entity: EntityHandle): void {
  ctx.world.addComponent(entity, { component: RigidBody, data: { type: RigidBodyTypeValue.kinematic } });
  ctx.world.addComponent(entity, { component: Collider, data: { shape: ColliderShapeValue.capsule, radius: 0.3, halfHeight: 0.4 } });
}

export function attachScenePhysics(ctx: GameContext, loaded: LoadedScene): ScenePhysics {
  const { world } = ctx;
  const props: ScenePhysics['props'] = [];
  const targets: ScenePhysics['targets'] = [];
  const walkBlockers: ScenePhysics['walkBlockers'] = [];
  const matOf = (entity: EntityHandle): MatHandle => {
    const renderer = world.get(entity, MeshRenderer);
    const materials = renderer.ok ? renderer.value.materials : undefined;
    return (materials?.[0] ?? 0) as MatHandle;
  };
  for (const node of loaded.nodes) {
    const name = (node.components.Name as { value?: string } | undefined)?.value;
    const entity = loaded.mapping.get(node.localId);
    if (entity === undefined || !name) continue;
    const transform = (node.components.Transform ?? {}) as { pos?: number[]; scale?: number[] };
    const hx = (transform.scale?.[0] ?? 1) * 0.5;
    const hy = (transform.scale?.[1] ?? 1) * 0.5;
    const hz = (transform.scale?.[2] ?? 1) * 0.5;
    const sphereRadius = transform.scale?.[0] ?? 1;
    const box = (restitution: number) => world.addComponent(entity, { component: Collider, data: { shape: ColliderShapeValue.cuboid, halfExtents: [hx, hy, hz], restitution, friction: 0.7 } });
    const sphere = (restitution: number) => world.addComponent(entity, { component: Collider, data: { shape: ColliderShapeValue.sphere, radius: sphereRadius, restitution, friction: 0.6 } });
    const dynamic = () => world.addComponent(entity, { component: RigidBody, data: { type: RigidBodyTypeValue.dynamic, mass: 1, linearDamping: 0.05, angularDamping: 0.1, ccdEnabled: true } });
    const staticBody = () => world.addComponent(entity, { component: RigidBody, data: { type: RigidBodyTypeValue.static } });
    const addBlocker = (yMin: number, radius: number) => {
      if (yMin < 0.8) walkBlockers.push({ cx: transform.pos?.[0] ?? 0, cz: transform.pos?.[2] ?? 0, r: radius });
    };
    switch (name) {
      case 'Ground': break;
      case 'TreeTrunk': staticBody(); box(0.2); addBlocker((transform.pos?.[1] ?? 0) - hy, Math.hypot(hx, hz)); break;
      case 'TreeCanopy': staticBody(); sphere(0.2); addBlocker((transform.pos?.[1] ?? 0) - sphereRadius, sphereRadius); break;
      case 'RedBox': dynamic(); box(0.25); props.push({ e: entity, mat: matOf(entity) }); targets.push({ e: entity, points: 10 }); break;
      case 'BlueBall': dynamic(); sphere(0.55); props.push({ e: entity, mat: matOf(entity) }); targets.push({ e: entity, points: 15 }); break;
      case 'YellowPillar': dynamic(); box(0.2); props.push({ e: entity, mat: matOf(entity) }); targets.push({ e: entity, points: 10 }); break;
      case 'BouncyBall': dynamic(); sphere(0.92); props.push({ e: entity, mat: matOf(entity) }); targets.push({ e: entity, points: 25 }); break;
      default:
        if (name.startsWith('Crate')) { dynamic(); box(0.1); props.push({ e: entity, mat: matOf(entity) }); targets.push({ e: entity, points: 5 }); }
        break;
    }
  }
  return { props, walkBlockers, targets };
}
