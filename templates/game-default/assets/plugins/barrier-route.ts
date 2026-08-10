import { Update, defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import {
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  RigidBody,
  RigidBodyTypeValue,
  type PhysicsWorld,
} from '@forgeax/engine-physics';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { inState } from '@forgeax/engine-state';
import type { Handle } from '@forgeax/engine-types';
import { Projectile } from './components/gameplay';
import { DamageHazard } from './counterattack';
import { GameState } from './gameplay-state';

const PROJECTILE_BARRIER_HIT_MASK = 0x80000000;

export const BarrierRoute = defineComponent('GameDefaultBarrierRoute', {
  active: { type: 'bool', default: false },
  opens: 'u32',
  ordinaryHits: 'u32',
  alreadyOpenHits: 'u32',
}, { transient: true });

export type BarrierImpact = {
  readonly active: boolean;
  readonly projectileContact: boolean;
  readonly impactScale: number;
};

export type BarrierImpactResult = 'open' | 'ordinary' | 'already-open' | 'non-projectile';

export function resolveBarrierImpact(impact: BarrierImpact): BarrierImpactResult {
  if (!impact.projectileContact) return 'non-projectile';
  if (!impact.active) return 'already-open';
  if (impact.impactScale <= 1) return 'ordinary';
  return 'open';
}

export type AuthoredBarrierRouteIdentity = {
  readonly emitter: EntityHandle;
  readonly emitterLocalId: number;
  readonly barrier: EntityHandle;
  readonly barrierLocalId: number;
};

export type BarrierRouteSnapshot = {
  readonly emitterEntity: number;
  readonly emitterLocalId: number;
  readonly barrierEntity: number;
  readonly barrierLocalId: number;
  readonly active: boolean;
  readonly activeVisual: boolean;
  readonly damagingContact: boolean;
  readonly physicsReady: boolean;
  readonly damageCooldown: number;
  readonly acceptedDamageHits: number;
  readonly opens: number;
  readonly ordinaryHits: number;
  readonly alreadyOpenHits: number;
};

export type BarrierRouteHandle = {
  readonly installSystem: (ctx: {
    readonly physics: PhysicsWorld | undefined;
    readonly projectileEntities: () => readonly EntityHandle[];
    readonly isUnlocked: () => boolean;
    readonly onImpact: (result: BarrierImpactResult, position: readonly [number, number, number]) => void;
  }) => void;
  readonly reset: () => void;
  readonly snapshot: () => BarrierRouteSnapshot;
  readonly dispose: () => void;
};

function removeIfPresent(world: World, entity: EntityHandle, component: Parameters<World['removeComponent']>[1]): void {
  if (world.get(entity, component).ok) world.removeComponent(entity, component).unwrap();
}

/** Project one authored route through a single active fact into render and physics. */
export function createBarrierRoute(
  world: World,
  authored: AuthoredBarrierRouteIdentity,
): BarrierRouteHandle | undefined {
  const barrierTransform = world.get(authored.barrier, Transform);
  const barrierMesh = world.get(authored.barrier, MeshFilter);
  const barrierRenderer = world.get(authored.barrier, MeshRenderer);
  if (!barrierTransform.ok || !barrierMesh.ok || !barrierRenderer.ok) return undefined;
  const mesh = barrierMesh.value.assetHandle as Handle<'MeshAsset', 'shared'>;
  const materials = [...barrierRenderer.value.materials] as Handle<'MaterialAsset', 'shared'>[];
  if (!world.sharedRefs.retain(mesh).ok) return undefined;
  const retainedMaterials: Handle<'MaterialAsset', 'shared'>[] = [];
  for (const material of materials) {
    if (!world.sharedRefs.retain(material).ok) {
      world.sharedRefs.release(mesh);
      for (const retained of retainedMaterials) world.sharedRefs.release(retained);
      return undefined;
    }
    retainedMaterials.push(material);
  }
  let physics: PhysicsWorld | undefined;
  let disposed = false;

  const state = () => world.get(authored.emitter, BarrierRoute);
  const setActiveProjection = (): void => {
    if (!world.get(authored.barrier, MeshFilter).ok) {
      world.addComponent(authored.barrier, { component: MeshFilter, data: { assetHandle: mesh } }).unwrap();
    }
    if (!world.get(authored.barrier, MeshRenderer).ok) {
      world.addComponent(authored.barrier, { component: MeshRenderer, data: { materials } }).unwrap();
    }
    if (!world.get(authored.barrier, DamageHazard).ok) {
      world.addComponent(authored.barrier, { component: DamageHazard, data: {} }).unwrap();
    }
    if (!world.get(authored.barrier, RigidBody).ok) {
      world.addComponent(authored.barrier, { component: RigidBody, data: { type: RigidBodyTypeValue.static } }).unwrap();
    }
    if (!world.get(authored.barrier, Collider).ok) {
      world.addComponent(authored.barrier, {
        component: Collider,
        data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.5, 0.5, 0.5], isSensor: true },
      }).unwrap();
    }
  };
  const setInactiveProjection = (): void => {
    removeIfPresent(world, authored.barrier, Collider);
    removeIfPresent(world, authored.barrier, RigidBody);
    removeIfPresent(world, authored.barrier, DamageHazard);
    removeIfPresent(world, authored.barrier, MeshRenderer);
    removeIfPresent(world, authored.barrier, MeshFilter);
  };
  const position = (): readonly [number, number, number] => {
    const transform = world.get(authored.emitter, Transform);
    return transform.ok
      ? [transform.value.pos[0] ?? 0, transform.value.pos[1] ?? 0, transform.value.pos[2] ?? 0]
      : [0, 0, 0];
  };
  const reset = (): void => {
    if (disposed) return;
    world.set(authored.emitter, BarrierRoute, {
      active: false,
      opens: 0,
      ordinaryHits: 0,
      alreadyOpenHits: 0,
    });
    setInactiveProjection();
  };
  const snapshot = (): BarrierRouteSnapshot => {
    const value = state();
    const active = value.ok && value.value.active;
    const damage = world.get(authored.barrier, DamageHazard);
    return {
      emitterEntity: authored.emitter,
      emitterLocalId: authored.emitterLocalId,
      barrierEntity: authored.barrier,
      barrierLocalId: authored.barrierLocalId,
      active,
      activeVisual: active && world.get(authored.barrier, MeshRenderer).ok,
      damagingContact: active && world.get(authored.barrier, DamageHazard).ok && world.get(authored.barrier, Collider).ok,
      physicsReady: active && physics?.hasBody(authored.barrier) === true,
      damageCooldown: damage.ok ? damage.value.cooldown : 0,
      acceptedDamageHits: damage.ok ? damage.value.acceptedHits : 0,
      opens: value.ok ? value.value.opens : 0,
      ordinaryHits: value.ok ? value.value.ordinaryHits : 0,
      alreadyOpenHits: value.ok ? value.value.alreadyOpenHits : 0,
    };
  };

  world.addComponent(authored.emitter, { component: BarrierRoute, data: {} }).unwrap();
  world.addComponent(authored.emitter, { component: RigidBody, data: { type: RigidBodyTypeValue.static } }).unwrap();
  world.addComponent(authored.emitter, {
    component: Collider,
    data: { shape: ColliderShapeValue.cuboid, halfExtents: [0.45, 0.8, 0.45], isSensor: true },
  }).unwrap();
  world.addComponent(authored.emitter, { component: CollidingEntities, data: { entities: [] } }).unwrap();
  world.addComponent(authored.barrier, { component: CollidingEntities, data: { entities: [] } }).unwrap();
  reset();

  return {
    installSystem: (ctx) => {
      physics = ctx.physics;
      world.addSystem(Update, {
        name: 'game-barrier-route',
        runIf: inState(GameState, 'Play'),
        after: ['physicsCollisionSync', 'game-projectile-simulation'],
        before: ['game-counterattack'],
        queries: [],
        fn: () => {
          let current = state();
          if (!current.ok) return;
          if (!current.value.active && current.value.opens === 0 && ctx.isUnlocked()) {
            world.set(authored.emitter, BarrierRoute, { active: true });
            setActiveProjection();
            current = state();
          }
          if (!current.ok || (!current.value.active && current.value.opens === 0)) return;
          for (const projectileEntity of ctx.projectileEntities()) {
            const projectile = world.get(projectileEntity, Projectile);
            const contacts = world.get(projectileEntity, CollidingEntities);
            if (!projectile.ok || !contacts.ok || !contacts.value.entities.includes(authored.emitter)) continue;
            if ((projectile.value.hitMask & PROJECTILE_BARRIER_HIT_MASK) !== 0) continue;
            world.set(projectileEntity, Projectile, {
              hitMask: (projectile.value.hitMask | PROJECTILE_BARRIER_HIT_MASK) >>> 0,
            });
            const latest = state();
            if (!latest.ok) continue;
            const result = resolveBarrierImpact({
              active: latest.value.active,
              projectileContact: true,
              impactScale: projectile.value.impactScale,
            });
            if (result === 'ordinary') {
              world.set(authored.emitter, BarrierRoute, { ordinaryHits: latest.value.ordinaryHits + 1 });
            } else if (result === 'already-open') {
              world.set(authored.emitter, BarrierRoute, { alreadyOpenHits: latest.value.alreadyOpenHits + 1 });
            } else if (result === 'open') {
              world.set(authored.emitter, BarrierRoute, { active: false, opens: latest.value.opens + 1 });
              setInactiveProjection();
            }
            ctx.onImpact(result, position());
          }
        },
      }).unwrap();
    },
    reset,
    snapshot,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      world.sharedRefs.release(mesh);
      for (const material of retainedMaterials) world.sharedRefs.release(material);
    },
  };
}
