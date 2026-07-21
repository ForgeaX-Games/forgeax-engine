import { Time, Update } from '@forgeax/engine-ecs';
// @forgeax/engine-physics-rapier3d — RapierPhysicsWorld3D class and three-phase
// tick systems (syncBackend / stepSimulation / writeback).
//
// RapierPhysicsWorld3D implements the PhysicsWorld interface from
// @forgeax/engine-physics and holds a Rapier 3D World instance as its
// simulation backend.
//
// Three-phase pipeline (plan-strategy D-1):
//   1. syncBackend: apply pending teleports, update kinematic positions.
//   2. stepSimulation: call rapierWorld.step(eventQueue).
//   3. writeback: read Rapier body positions (dynamic only).
//
// Entity-to-body mapping (plan-strategy D-7): Rapier RigidBody.userData holds
// the ECS entity raw value for reverse lookup in collision events.
//
// Despawn cleanup (plan-strategy D-5): removeEntity() removes the Rapier body
// and colliders from the physics world.

import type { Component, EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem, Entity as EntityComponent, resolveComponent } from '@forgeax/engine-ecs';
import { mat4, quat, type Vec3, vec3 } from '@forgeax/engine-math';
import type { PhysicsWorld, RaycastHit } from '@forgeax/engine-physics';
import {
  CharacterController,
  Collider,
  CollidingEntities,
  colliderShapeFromF32,
  PHYSICS_ERROR_HINTS,
  PhysicsError,
  PhysicsSet,
  RIGID_BODY_TYPE_STATIC,
  RigidBody,
  registerColliderRemoveListener,
  rigidBodyTypeFromF32,
} from '@forgeax/engine-physics';
import type { Rapier3DModule } from './wasm-loader';

/**
 * Per-entity physics record — tracks the Rapier body handle for
 * each ECS entity.
 */
interface PhysicsEntityRecord {
  bodyHandle: number;
}

interface PhysicsTransform3D {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly rotation: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
  readonly scale: { readonly x: number; readonly y: number; readonly z: number };
}

interface PhysicsCollider3D {
  readonly shape: number;
  readonly halfExtents: readonly [number, number, number];
  readonly radius: number;
  readonly halfHeight: number;
  readonly friction: number;
  readonly restitution: number;
  readonly density: number;
  readonly isSensor: number;
  readonly collisionGroups: number;
  readonly solverGroups: number;
}

// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
type RapierWorld = any;
// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
type RapierEventQueue = any;
// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
type RapierRigidBody = any;

/** CharacterController tuning fields read per moveAndSlide call (degrees + world units). */
interface CharacterControllerTuning {
  offset: number;
  maxSlopeClimbDeg: number;
  minSlopeSlideDeg: number;
  autoStepMaxHeight: number;
  autoStepMinWidth: number;
  snapToGroundDist: number;
}

/** Schema defaults mirror CharacterController defineComponent (components.ts). */
const DEFAULT_CC_TUNING: CharacterControllerTuning = {
  offset: 0.01,
  maxSlopeClimbDeg: 45,
  minSlopeSlideDeg: 30,
  autoStepMaxHeight: 0.3,
  autoStepMinWidth: 0.2,
  snapToGroundDist: 0.2,
};

const DEG_TO_RAD = Math.PI / 180;

/**
 * Re-apply all KCC setters from the component tuning every call (plan-strategy
 * D-7: full reset, no dirty tracking). Degrees -> radians for the two slope
 * setters; offset / autostep / snap pass through as world units. A zero value
 * for auto-step / snap calls `disable*()` rather than `enable*(0)`.
 */
// biome-ignore lint/suspicious/noExplicitAny: Rapier KinematicCharacterController from dynamic module
function applyKccTuning(ctrl: any, cc: CharacterControllerTuning): void {
  ctrl.setMaxSlopeClimbAngle(cc.maxSlopeClimbDeg * DEG_TO_RAD);
  ctrl.setMinSlopeSlideAngle(cc.minSlopeSlideDeg * DEG_TO_RAD);
  ctrl.setSlideEnabled(true);
  if (cc.autoStepMaxHeight === 0) {
    ctrl.disableAutostep();
  } else {
    ctrl.enableAutostep(cc.autoStepMaxHeight, cc.autoStepMinWidth, false); // D-7: includeDynamicBodies=false
  }
  if (cc.snapToGroundDist === 0) {
    ctrl.disableSnapToGround();
  } else {
    ctrl.enableSnapToGround(cc.snapToGroundDist);
  }
}

/**
 * Map a Rapier RigidBodyType enum value to the engine's string union for the
 * `controller-requires-kinematic` error detail.
 */
// biome-ignore lint/suspicious/noExplicitAny: Rapier module enum from dynamic module
function rapierBodyTypeToString(rapier: any, bodyType: number): string {
  if (bodyType === rapier.RigidBodyType.Dynamic) return 'dynamic';
  if (bodyType === rapier.RigidBodyType.Fixed) return 'static';
  return 'kinematic';
}

/**
 * RapierPhysicsWorld3D — Rapier 3D WASM backend implementing the PhysicsWorld
 * interface.
 */
export class RapierPhysicsWorld3D implements PhysicsWorld {
  /** Rapier 3D World instance owning all bodies, colliders, and pipeline. */
  readonly raw: RapierWorld;

  private readonly rapierModule: Rapier3DModule;

  /** Entity (raw number) -> PhysicsEntityRecord mapping. */
  private readonly entityMap = new Map<number, PhysicsEntityRecord>();

  /** Pending teleports: entity -> target position, applied on next sync. */
  private readonly pendingTeleports = new Map<number, { x: number; y: number; z: number }>();

  /** Event queue for collision events. */
  private readonly eventQueue: RapierEventQueue;

  /**
   * Active overlap set per entity, maintained by draining the event queue each
   * step. `started` events add the pair both ways; `stopped` events remove it.
   * Read out into each entity's `CollidingEntities` component by
   * `writebackCollidingEntities`. Covers both solid contacts and sensor
   * intersections (Rapier emits CollisionEvent for both).
   */
  private readonly collisionPairs = new Map<number, Set<number>>();

  private currentGravity: { x: number; y: number; z: number };

  /**
   * Lazily-built Rapier KinematicCharacterController per character entity
   * (plan-strategy D-1/D-3). `moveAndSlide` creates one on first call; the
   * `Collider.onRemove` hook (registerPhysicsSystems) clears it on despawn.
   * Public so AC-11 despawn tests can assert `kccCache.size === 0`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Rapier KinematicCharacterController from dynamic module
  readonly kccCache = new Map<number, any>();

  /**
   * ECS World + components wired in by `registerPhysicsSystems`, so
   * `moveAndSlide` can read CharacterController tuning and write Transform +
   * grounded back. Undefined until systems are registered — the input-validation
   * error paths (body / collider) fire before these are read, so direct
   * `pw.moveAndSlide()` calls in error tests need no World.
   */
  private moveContext:
    | { world: World; transform: Component; characterController: Component }
    | undefined;

  constructor(rapier: Rapier3DModule) {
    this.rapierModule = rapier;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World constructor is a class exported from a namespace module
    this.raw = new (rapier as any).World({ x: 0, y: -9.81, z: 0 }) as RapierWorld;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier EventQueue constructor comes from a namespace module
    this.eventQueue = new (rapier as any).EventQueue(true) as RapierEventQueue;
    this.currentGravity = { x: 0, y: -9.81, z: 0 };
  }

  // ─── PhysicsWorld interface ────────────────────────────────────────────

  setGravity(gravity: Vec3): void {
    const x = gravity[0] ?? 0;
    const y = gravity[1] ?? 0;
    const z = gravity[2] ?? 0;
    this.raw.gravity = { x, y, z };
    this.currentGravity = { x, y, z };
  }

  getGravity(): Vec3 {
    const { x, y, z } = this.currentGravity;
    return vec3.create(x, y, z);
  }

  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDist: number,
    filterMask?: number,
  ): RaycastHit | undefined {
    const RAPIER = this.rapierModule;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier Ray constructor comes from a namespace module
    const RayCtor = (RAPIER as any).Ray as new (
      origin: { x: number; y: number; z: number },
      dir: { x: number; y: number; z: number },
    ) => { pointAt(t: number): { x: number; y: number; z: number } };
    const ray = new RayCtor(
      { x: origin[0] ?? 0, y: origin[1] ?? 0, z: origin[2] ?? 0 },
      { x: direction[0] ?? 0, y: direction[1] ?? 0, z: direction[2] ?? 0 },
    );
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World castRayAndGetNormal
    const hit = (this.raw as any).castRayAndGetNormal(
      ray,
      maxDist,
      true,
      undefined,
      filterMask,
    ) as {
      collider: { parent(): { userData: number } | null };
      timeOfImpact: number;
      normal: { x: number; y: number; z: number };
    } | null;

    if (hit === null) return undefined;

    const point = ray.pointAt(hit.timeOfImpact);
    // `hit.collider.parent()` already returns the owning RigidBody OBJECT (compat
    // build), whose userData holds the ECS entity — read it directly, mirroring
    // `colliderHandleToEntity` (the proven CollidingEntities path). The prior code
    // treated the object as a body HANDLE and re-resolved it via `bodies.get(...)`,
    // which returned a DIFFERENT body → raycast reported the wrong entity.
    const colliderParentBody = hit.collider.parent();
    const entity = colliderParentBody !== null ? colliderParentBody.userData : 0;

    return {
      entity,
      point: vec3.create(point.x, point.y, point.z),
      normal: vec3.create(hit.normal.x, hit.normal.y, hit.normal.z),
      timeOfImpact: hit.timeOfImpact,
    };
  }

  teleport(entity: number, position: Vec3): void {
    this.pendingTeleports.set(entity, {
      x: position[0] ?? 0,
      y: position[1] ?? 0,
      z: position[2] ?? 0,
    });
  }

  step(deltaTime: number): void {
    void deltaTime;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.step
    (this.raw as any).step(this.eventQueue);
    this.drainCollisionEvents();
  }

  /**
   * Drain the Rapier event queue into `collisionPairs`. Each event names two
   * collider handles + a `started` flag; we resolve each collider to its owning
   * entity (collider.parent() -> body.userData) and add/remove the symmetric
   * pair. This is what populates `CollidingEntities` for sensor pickup + contact
   * queries (the queue is otherwise drained-on-overflow and never observed).
   */
  private drainCollisionEvents(): void {
    this.eventQueue.drainCollisionEvents((handle1: number, handle2: number, started: boolean) => {
      const a = this.colliderHandleToEntity(handle1);
      const b = this.colliderHandleToEntity(handle2);
      if (a === undefined || b === undefined) return;
      if (started) {
        this.addPair(a, b);
      } else {
        this.removePair(a, b);
      }
    });
  }

  /** Resolve a Rapier collider handle to its owning ECS entity, or undefined. */
  private colliderHandleToEntity(colliderHandle: number): number | undefined {
    // getCollider(handle).parent() returns the owning RigidBody (compat build),
    // whose userData holds the ECS entity raw value (set in ensureBody).
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.getCollider from dynamic module
    const collider = (this.raw as any).getCollider(colliderHandle) as {
      parent(): { userData: number } | null;
    } | null;
    if (collider === null || collider === undefined) return undefined;
    const body = collider.parent();
    if (body === null || body === undefined) return undefined;
    return body.userData;
  }

  private addPair(a: number, b: number): void {
    let setA = this.collisionPairs.get(a);
    if (!setA) {
      setA = new Set<number>();
      this.collisionPairs.set(a, setA);
    }
    setA.add(b);
    let setB = this.collisionPairs.get(b);
    if (!setB) {
      setB = new Set<number>();
      this.collisionPairs.set(b, setB);
    }
    setB.add(a);
  }

  private removePair(a: number, b: number): void {
    this.collisionPairs.get(a)?.delete(b);
    this.collisionPairs.get(b)?.delete(a);
  }

  /**
   * Write the current overlap set into each entity's `CollidingEntities`
   * component (entities that carry it). Called by the PhysicsCollisionSync
   * system after writeback. Entities with no current overlaps get an empty set,
   * so a Core that the player has left clears correctly. Only entities that own
   * a CollidingEntities component are written (others are skipped).
   */
  writebackCollidingEntities(world: World, collidingComponent: Component): void {
    for (const [entity, others] of this.collisionPairs) {
      const handle = entity as EntityHandle;
      if (!world.get(handle, collidingComponent).ok) continue;
      world.set(handle, collidingComponent, { entities: [...others] });
    }
  }

  getBodyCount(): number {
    return this.entityMap.size;
  }

  hasBody(entity: number): boolean {
    return this.entityMap.has(entity);
  }

  /**
   * Wire the ECS World + Transform / CharacterController components needed by
   * `moveAndSlide` to read tuning and write back pose + grounded. Called once by
   * `registerPhysicsSystems` (plan-strategy D-1/D-7).
   */
  setMoveContext(world: World, transform: Component, characterController: Component): void {
    this.moveContext = { world, transform, characterController };
  }

  moveAndSlide(entity: number, desiredDelta: Vec3): Vec3 {
    return this.computeMove(entity, desiredDelta);
  }

  /**
   * Shared moveAndSlide core (plan-strategy D-1/D-2/D-4/D-6/D-7).
   *
   * The three Fail-Fast entry checks (body / collider / kinematic) throw
   * structured PhysicsError before the World is read, so error-path tests can
   * call this without registered systems.
   */
  private computeMove(entity: number, desiredDelta: Vec3): Vec3 {
    // ── Fail-Fast entry checks (charter P3) ──
    const record = this.entityMap.get(entity);
    if (!record) {
      throw new PhysicsError({
        code: 'body-not-found',
        expected: 'a registered Rapier body for this entity',
        hint: PHYSICS_ERROR_HINTS['body-not-found'],
        detail: { code: 'body-not-found', entity },
      });
    }
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody | null;
    if (!body) {
      throw new PhysicsError({
        code: 'body-not-found',
        expected: 'a registered Rapier body for this entity',
        hint: PHYSICS_ERROR_HINTS['body-not-found'],
        detail: { code: 'body-not-found', entity },
      });
    }
    if (body.numColliders() === 0) {
      // D-2: body exists but carries no collider — more precise than body-not-found.
      throw new PhysicsError({
        code: 'collider-not-found',
        expected: 'a Collider attached to this entity body',
        hint: PHYSICS_ERROR_HINTS['collider-not-found'],
        detail: { code: 'collider-not-found', entity },
      });
    }
    const RAPIER = this.rapierModule;
    if (body.bodyType() !== RAPIER.RigidBodyType.KinematicPositionBased) {
      throw new PhysicsError({
        code: 'controller-requires-kinematic',
        expected: "RigidBody.type === 'kinematic'",
        hint: PHYSICS_ERROR_HINTS['controller-requires-kinematic'],
        detail: {
          code: 'controller-requires-kinematic',
          entity,
          bodyType: rapierBodyTypeToString(RAPIER, body.bodyType()),
        },
      });
    }

    const collider = body.collider(0); // D-4: zero-schema reverse lookup

    // ── Read CharacterController tuning + lazily build/configure the KCC ──
    const cc = this.readCharacterController(entity);
    const ctrl = this.ensureKcc(entity, cc.offset);
    applyKccTuning(ctrl, cc);

    // ── Step 1: solve collisions (D-1 self-exclude predicate) ──
    // Rapier's filter predicate returns true to INCLUDE a collider as a
    // potential obstacle, false to skip it; this excludes the character's own
    // collider so it never collides with itself. EXCLUDE_SENSORS makes the KCC
    // treat sensor colliders as non-solid (their purpose is overlap detection,
    // not blocking) -- without it any sensor overlapping the character (e.g. a
    // pickup/attack trigger volume) walls the KCC and freezes it in place.
    const delta = { x: desiredDelta[0] ?? 0, y: desiredDelta[1] ?? 0, z: desiredDelta[2] ?? 0 };
    ctrl.computeColliderMovement(
      collider,
      delta,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      // biome-ignore lint/suspicious/noExplicitAny: Rapier Collider in filter predicate
      (other: any) => other.handle !== collider.handle,
    );

    // ── Step 2/3: read corrected movement + grounded ──
    const movement = ctrl.computedMovement() as { x: number; y: number; z: number };
    const grounded = ctrl.computedGrounded() as boolean;

    // ── Write back: push the kinematic body + ECS Transform + grounded ──
    const t = body.translation();
    const next = { x: t.x + movement.x, y: t.y + movement.y, z: t.z + movement.z };
    // setNextKinematicTranslation feeds the physics step pipeline; setTranslation
    // advances the body + its collider immediately so consecutive moveAndSlide
    // calls (without an intervening world.step) see the updated pose for the next
    // collision solve + grounded check. The query structures are refreshed so the
    // next computeColliderMovement reads the new position.
    body.setNextKinematicTranslation(next);
    body.setTranslation(next, true);
    // setTranslation marks the body modified but does not re-place its collider
    // in the collider set; propagate so the next computeColliderMovement
    // shape-casts the character from its updated pose.
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.propagateModifiedBodyPositionsToColliders
    (this.raw as any).propagateModifiedBodyPositionsToColliders();

    const ctx = this.moveContext;
    if (ctx) {
      // D-6: writeback Result ignored — entry checks already guard liveness.
      ctx.world.set(entity as EntityHandle, ctx.transform, {
        pos: [next.x, next.y, next.z],
      });
      ctx.world.set(entity as EntityHandle, ctx.characterController, { grounded });
    }

    return vec3.create(movement.x, movement.y, movement.z);
  }

  /**
   * Read CharacterController tuning fields for an entity from the ECS World,
   * falling back to schema defaults when the World is not wired (defensive;
   * the kinematic check upstream means a valid character always has the World).
   */
  private readCharacterController(entity: number): CharacterControllerTuning {
    const ctx = this.moveContext;
    if (ctx) {
      const r = ctx.world.get(entity as EntityHandle, ctx.characterController);
      if (r.ok) {
        const v = r.value as Record<string, number>;
        return {
          offset: v.offset as number,
          maxSlopeClimbDeg: v.maxSlopeClimbDeg as number,
          minSlopeSlideDeg: v.minSlopeSlideDeg as number,
          autoStepMaxHeight: v.autoStepMaxHeight as number,
          autoStepMinWidth: v.autoStepMinWidth as number,
          snapToGroundDist: v.snapToGroundDist as number,
        };
      }
    }
    return DEFAULT_CC_TUNING;
  }

  /**
   * Lazily build a Rapier KinematicCharacterController for `entity` (cached).
   */
  // biome-ignore lint/suspicious/noExplicitAny: Rapier KinematicCharacterController from dynamic module
  private ensureKcc(entity: number, offset: number): any {
    const cached = this.kccCache.get(entity);
    if (cached) return cached;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCharacterController
    const ctrl = (this.raw as any).createCharacterController(offset);
    this.kccCache.set(entity, ctrl);
    return ctrl;
  }

  /**
   * Remove an entity's cached KCC and unregister it from the Rapier world
   * (plan-strategy D-3). Idempotent — safe for entities that never moved.
   */
  removeKccController(entity: number): void {
    const ctrl = this.kccCache.get(entity);
    if (!ctrl) return;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.removeCharacterController
    (this.raw as any).removeCharacterController(ctrl);
    this.kccCache.delete(entity);
  }

  // ─── ECS→Rapier bridge (D-2) ──────────────────────────────────────────

  /**
   * Ensure a Rapier body and collider exist for an ECS entity (idempotent).
   *
   * When `entityMap` already contains the entity this returns immediately.
   * Otherwise creates a Rapier RigidBody (dynamic / fixed / kinematic) +
   * Collider (cuboid / ball / capsule) from the ECS component data, sets
   * `body.userData = entity`, and registers the pairing via `registerBody`.
   *
   * @param entity      Raw ECS entity number (stored in Rapier body.userData).
   * @param transform   ECS Transform fields: { posX, posY, posZ, ... }.
   * @param rigidBody   ECS RigidBody fields: { type (enum num), mass, ... }.
   * @param collider    ECS Collider fields: { shape (enum num), radius, ... }.
   *
   * Plan-strategy D-2 + D-3: enum→Rapier desc mapping consumes
   * rigidBodyTypeFromF32 / colliderShapeFromF32 helpers; closed switch with
   * no default — TypeScript enforces exhaustiveness on the string-union arms.
   */
  ensureBody(
    entity: number,
    transform: PhysicsTransform3D,
    rigidBody: {
      type: number;
      mass: number;
      linearDamping: number;
      angularDamping: number;
      gravityScale: number;
      ccdEnabled: number;
    },
    collider: PhysicsCollider3D,
  ): void {
    if (this.entityMap.has(entity)) return; // M1 idempotent guard (D-2)

    const RAPIER = this.rapierModule;

    // ── Create RigidBodyDesc ──
    const rbType = rigidBodyTypeFromF32(rigidBody.type);
    let body: RapierRigidBody;
    switch (rbType) {
      case 'dynamic': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.dynamic()
          .setTranslation(transform.position.x, transform.position.y, transform.position.z)
          .setRotation(transform.rotation)
          .setLinearDamping(rigidBody.linearDamping)
          .setAngularDamping(rigidBody.angularDamping)
          .setGravityScale(rigidBody.gravityScale);
        if (rigidBody.mass > 0) {
          desc.setAdditionalMass(rigidBody.mass);
        }
        if (rigidBody.ccdEnabled) {
          desc.setCcdEnabled(true);
        }
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
      case 'static': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.fixed()
          .setTranslation(transform.position.x, transform.position.y, transform.position.z)
          .setRotation(transform.rotation);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
      case 'kinematic': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.kinematicPositionBased()
          .setTranslation(transform.position.x, transform.position.y, transform.position.z)
          .setRotation(transform.rotation);
        // CCD sweeps the collider along its per-step kinematic translation so a
        // fast mover (player, bullet) reliably contacts dynamics instead of
        // tunneling through them on discrete steps.
        if (rigidBody.ccdEnabled) {
          desc.setCcdEnabled(true);
        }
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
      // No default — rigidBodyTypeFromF32 ensures only 3 arms; TS guards completeness.
    }

    body.userData = entity;
    this.registerBody(entity, body.handle);

    // ── Create ColliderDesc ──
    const scaleX = Math.abs(transform.scale.x);
    const scaleY = Math.abs(transform.scale.y);
    const scaleZ = Math.abs(transform.scale.z);
    // Enable collision events + all body-type combinations so sensors register
    // overlaps against kinematic/fixed bodies too (the default omits non-dynamic
    // pairs, which would silence kinematic-sensor-vs-kinematic-body pickup).
    // biome-ignore lint/suspicious/noExplicitAny: Rapier enums from dynamic module
    const activeEvents = (RAPIER as any).ActiveEvents.COLLISION_EVENTS as number;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier enums from dynamic module
    const activeCollisionTypes = (RAPIER as any).ActiveCollisionTypes.ALL as number;
    const cShape = colliderShapeFromF32(collider.shape);
    switch (cShape) {
      case 'cuboid': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier ColliderDesc
        const desc = (RAPIER as any).ColliderDesc.cuboid(
          collider.halfExtents[0] * scaleX,
          collider.halfExtents[1] * scaleY,
          collider.halfExtents[2] * scaleZ,
        )
          .setFriction(collider.friction)
          .setRestitution(collider.restitution)
          .setDensity(collider.density)
          .setCollisionGroups(collider.collisionGroups)
          .setSolverGroups(collider.solverGroups)
          .setActiveEvents(activeEvents)
          .setActiveCollisionTypes(activeCollisionTypes);
        if (collider.isSensor) desc.setSensor(true);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCollider
        (this.raw as any).createCollider(desc, body);
        break;
      }
      case 'sphere': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier ColliderDesc
        const desc = (RAPIER as any).ColliderDesc.ball(
          collider.radius * Math.max(scaleX, scaleY, scaleZ),
        )
          .setFriction(collider.friction)
          .setRestitution(collider.restitution)
          .setDensity(collider.density)
          .setCollisionGroups(collider.collisionGroups)
          .setSolverGroups(collider.solverGroups)
          .setActiveEvents(activeEvents)
          .setActiveCollisionTypes(activeCollisionTypes);
        if (collider.isSensor) desc.setSensor(true);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCollider
        (this.raw as any).createCollider(desc, body);
        break;
      }
      case 'capsule': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier ColliderDesc
        const desc = (RAPIER as any).ColliderDesc.capsule(
          collider.halfHeight * scaleY,
          collider.radius * Math.max(scaleX, scaleZ),
        )
          .setFriction(collider.friction)
          .setRestitution(collider.restitution)
          .setDensity(collider.density)
          .setCollisionGroups(collider.collisionGroups)
          .setSolverGroups(collider.solverGroups)
          .setActiveEvents(activeEvents)
          .setActiveCollisionTypes(activeCollisionTypes);
        if (collider.isSensor) desc.setSensor(true);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCollider
        (this.raw as any).createCollider(desc, body);
        break;
      }
      // No default — colliderShapeFromF32 ensures only 3 arms; TS guards completeness.
    }
  }

  /**
   * Synchronize a static or kinematic body's Rapier pose and collider shape from
   * the resolved Transform pose. Dynamic bodies own their pose after creation.
   */
  syncAuthoredPose(
    entity: number,
    transform: PhysicsTransform3D,
    collider: PhysicsCollider3D,
    bodyType: 'static' | 'kinematic',
  ): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody | null;
    if (!body) return;

    if (bodyType === 'static') {
      body.setTranslation(transform.position, true);
      body.setRotation(transform.rotation, true);
    } else {
      body.setNextKinematicTranslation(transform.position);
      body.setNextKinematicRotation(transform.rotation);
    }

    const rapierCollider = body.collider(0);
    if (!rapierCollider) return;
    const scaleX = Math.abs(transform.scale.x);
    const scaleY = Math.abs(transform.scale.y);
    const scaleZ = Math.abs(transform.scale.z);
    switch (colliderShapeFromF32(collider.shape)) {
      case 'cuboid':
        rapierCollider.setHalfExtents({
          x: collider.halfExtents[0] * scaleX,
          y: collider.halfExtents[1] * scaleY,
          z: collider.halfExtents[2] * scaleZ,
        });
        break;
      case 'sphere':
        rapierCollider.setRadius(collider.radius * Math.max(scaleX, scaleY, scaleZ));
        break;
      case 'capsule':
        rapierCollider.setHalfHeight(collider.halfHeight * scaleY);
        rapierCollider.setRadius(collider.radius * Math.max(scaleX, scaleZ));
        break;
    }
  }

  // ─── ECS integration helpers ───────────────────────────────────────────

  /**
   * Register an ECS entity with its Rapier body handle.
   */
  registerBody(entity: number, bodyHandle: number): void {
    this.entityMap.set(entity, { bodyHandle });
  }

  /**
   * Apply all pending teleports to their respective bodies.
   */
  applyPendingTeleports(): void {
    for (const [entity, target] of this.pendingTeleports) {
      const record = this.entityMap.get(entity);
      if (!record) continue;
      // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
      const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody | null;
      if (!body) continue;

      body.setTranslation({ x: target.x, y: target.y, z: target.z }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    }
    this.pendingTeleports.clear();
  }

  /**
   * Set a kinematic body's next position from ECS transform.
   */
  setKinematicPosition(entity: number, pos: { x: number; y: number; z: number }): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody | null;
    if (!body) return;
    body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
  }

  /**
   * Write Rapier dynamic body poses back.
   */
  writebackDynamicBodies(): Array<{
    entity: number;
    pos: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number; w: number };
  }> {
    const results: Array<{
      entity: number;
      pos: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number; w: number };
    }> = [];
    for (const [entity, record] of this.entityMap) {
      // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
      const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody | null;
      if (!body) continue;
      if (body.bodyType() !== this.rapierModule.RigidBodyType.Dynamic) continue;
      const translation = body.translation();
      const rotation = body.rotation();
      results.push({
        entity,
        pos: { x: translation.x, y: translation.y, z: translation.z },
        rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      });
    }
    return results;
  }

  /**
   * Remove a Rapier body and its colliders when the ECS entity is despawned.
   */
  removeEntity(entity: number): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    this.removeKccController(entity); // D-3: clear cached KCC before body removal
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.removeRigidBody
    (this.raw as any).removeRigidBody({ handle: record.bodyHandle } as RapierRigidBody);
    this.entityMap.delete(entity);
    // Clear the despawned entity from every overlap set so a collected Core does
    // not linger in the player's CollidingEntities (Rapier emits no `stopped`
    // event when a collider is removed mid-overlap).
    const own = this.collisionPairs.get(entity);
    if (own) {
      for (const other of own) this.collisionPairs.get(other)?.delete(entity);
      this.collisionPairs.delete(entity);
    }
  }
}

/**
 * Create a new RapierPhysicsWorld3D instance.
 */
export function createRapier3DPhysicsWorld(rapier: Rapier3DModule): RapierPhysicsWorld3D {
  return new RapierPhysicsWorld3D(rapier);
}

// ─── Internal archetype graph surface (mirrors advance-animation-player) ──
interface GraphLike {
  readonly archetypes: ReadonlyArray<ArchetypeLike | undefined>;
}
interface ArchetypeLike {
  readonly components: ReadonlyArray<{ readonly id: number }>;
  readonly columns: ReadonlyMap<
    number,
    ReadonlyMap<
      string,
      {
        readonly view:
          | Uint32Array
          | Float32Array
          | ReadonlyArray<Uint32Array>
          | ReadonlyArray<Float32Array>;
      }
    >
  >;
  readonly size: number;
}
interface InternalWorldSurface {
  /** @internal Archetype graph accessor mirrored from World; used for tick-system traversal. */
  _getGraph(): GraphLike;
}
function asInternal(w: World): InternalWorldSurface {
  return w as unknown as InternalWorldSurface;
}

/**
 * Read the full packed `Entity` handle for archetype `row` from the essential
 * id=0 `Entity` column (`self` field), present on every archetype.
 */
function readEntityAt(arch: ArchetypeLike, row: number): EntityHandle {
  const selfCol = arch.columns.get((EntityComponent as unknown as Component).id)?.get('self')
    ?.view as Uint32Array | undefined;
  return (selfCol?.[row] ?? 0) as EntityHandle;
}

function hasResolvedWorldPose(world: Float32Array | undefined, base: number): boolean {
  if (!world) return false;
  return (
    world[base] !== 1 ||
    world[base + 5] !== 1 ||
    world[base + 10] !== 1 ||
    world[base + 15] !== 1 ||
    world[base + 1] !== 0 ||
    world[base + 2] !== 0 ||
    world[base + 4] !== 0 ||
    world[base + 6] !== 0 ||
    world[base + 8] !== 0 ||
    world[base + 9] !== 0 ||
    world[base + 12] !== 0 ||
    world[base + 13] !== 0 ||
    world[base + 14] !== 0
  );
}

/** dt upper bound (plan-strategy D-4): skip step if dt exceeds this. */
const PHYSICS_DT_MAX = 0.1;
const poseScratchPosition = vec3.create();
const poseScratchRotation = quat.create();
const poseScratchScale = vec3.create();
const poseScratchWorld = new Float32Array(16);

// ─── Collider removal despawn-cleanup dispatch (plan-strategy D-3) ───
//
// `Collider.onRemove` (defined in @forgeax/engine-physics) fans removal out to
// subscribed listeners. The frozen component token cannot be mutated, so each
// backend subscribes via `registerColliderRemoveListener` and dispatches
// removeEntity to every live backend on removal — only the one whose entityMap
// holds the entity acts (removeEntity early-returns otherwise, idempotent). One
// global subscription covers all backends; backends are tracked in a Set.

const registeredBackends = new Set<RapierPhysicsWorld3D>();
let colliderRemoveListenerSubscribed = false;

function registerBackendForRemoveHook(pw: RapierPhysicsWorld3D): void {
  registeredBackends.add(pw);
  if (colliderRemoveListenerSubscribed) return;
  colliderRemoveListenerSubscribed = true;
  registerColliderRemoveListener((entity) => {
    for (const backend of registeredBackends) {
      backend.removeEntity(entity as unknown as number);
    }
  });
}

// ── System name constants ──
const PHYSICS_SYNC_BACKEND = 'physicsSyncBackend' as const;
const PHYSICS_STEP_SIMULATION = 'physicsStepSimulation' as const;
const PHYSICS_WRITEBACK = 'physicsWriteback' as const;
const PHYSICS_COLLISION_SYNC = 'physicsCollisionSync' as const;

/**
 * Resolve the runtime `Transform` component token from the global ECS
 * registry (M2 — full resource-ification, D-3). physics already depends on
 * `@forgeax/engine-ecs`, so `resolveComponent` introduces no new dependency
 * and replaces the closure-captured `transformComponent` second parameter.
 * Returns `undefined` when Transform is not yet defined (the runtime package
 * defines it on import); callers early-out.
 */
function resolveTransform(): Component | undefined {
  return resolveComponent('Transform');
}

/**
 * `physicsSyncBackend` system token (M2 — full resource-ification, D-4).
 *
 * After propagateTransforms — query entities with (Transform, Collider) and
 * call ensureBody for each. `RigidBody` is OPTIONAL: an entity with a Collider
 * but no RigidBody is treated as a STATIC collider (Rapier-native behavior — a
 * collider without a parent body is fixed), which is exactly what the `Collider`
 * component docstring promises and how static level geometry (floors, walls) is
 * naturally authored. Reads `world` from its first parameter; resolves Transform
 * via the global registry. Labelled `'physics'`.
 */
export const PhysicsSyncBackend: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_SYNC_BACKEND,
  queries: [],
  after: ['propagateTransforms'],
  fn: (world) => {
    const transformComponent = resolveTransform();
    if (transformComponent === undefined) return;
    let pw: RapierPhysicsWorld3D;
    try {
      pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    } catch {
      return; // C-2: PhysicsWorld resource not yet ready — safe early out
    }

    pw.applyPendingTeleports();

    const graph = asInternal(world)._getGraph();

    for (const arch of graph.archetypes) {
      if (!arch || arch.size === 0) continue;
      // (Collider, Transform) are REQUIRED; RigidBody is OPTIONAL. A
      // Collider-only entity is simulated as an implicit static collider (see
      // the system doc + the Collider component docstring). Gating on RigidBody
      // here — as the pre-fix filter did — silently dropped every bare-Collider
      // static body from the simulation, contradicting the documented contract.
      if (
        !arch.components.some((c) => c.id === Collider.id) ||
        !arch.components.some((c) => c.id === transformComponent.id)
      ) {
        continue;
      }

      // D-5: character entities (CharacterController) move via moveAndSlide
      // (which pushes the kinematic body + writes Transform itself), so the
      // kinematic mirror below must NOT double-write them. Detected once per
      // archetype — characters fall into a distinct archetype by component set.
      const hasCharacterController = arch.components.some((c) => c.id === CharacterController.id);

      // RigidBody column is optional (bare-Collider archetypes have none). When
      // absent, `rbCols` is undefined → every rb* view below is undefined → the
      // per-row rigidBody is synthesized as a static default (the `static`
      // ensureBody arm ignores mass/damping/gravity anyway).
      const rbCols = arch.columns.get(RigidBody.id);
      const cCols = arch.columns.get(Collider.id);
      const tfCols = arch.columns.get(transformComponent.id);
      if (!cCols || !tfCols) continue;

      const rbType = rbCols?.get('type')?.view as Uint32Array | undefined;
      const rbMass = rbCols?.get('mass')?.view as Float32Array | undefined;
      const rbLinDamp = rbCols?.get('linearDamping')?.view as Float32Array | undefined;
      const rbAngDamp = rbCols?.get('angularDamping')?.view as Float32Array | undefined;
      const rbGravScale = rbCols?.get('gravityScale')?.view as Float32Array | undefined;
      const rbCcd = rbCols?.get('ccdEnabled')?.view as Uint32Array | undefined;

      const cShape = cCols.get('shape')?.view as Uint32Array | undefined;
      // feat-20260709 M4: halfExtents is one inline array<f32,3> column
      // (stride 3, row r's xyz at [r*3 .. +2]). radius/halfHeight stay scalar
      // columns (OOS-1).
      const cHalfExtents = cCols.get('halfExtents')?.view as Float32Array | undefined;
      const cRadius = cCols.get('radius')?.view as Float32Array | undefined;
      const cHalfH = cCols.get('halfHeight')?.view as Float32Array | undefined;
      const cFric = cCols.get('friction')?.view as Float32Array | undefined;
      const cRest = cCols.get('restitution')?.view as Float32Array | undefined;
      const cDens = cCols.get('density')?.view as Float32Array | undefined;
      const cSensor = cCols.get('isSensor')?.view as Uint32Array | undefined;
      const cCGroups = cCols.get('collisionGroups')?.view as Uint32Array | undefined;
      const cSGroups = cCols.get('solverGroups')?.view as Uint32Array | undefined;

      // Local TRS position is a flat stride-3 array<f32,3> column
      // (feat-20260709 M2): row i's xyz at pos[i*3 .. +2]. Indexed reads only
      // -- zero per-call allocation on this per-frame sync path (AC-08).
      const tfPos = tfCols.get('pos')?.view as Float32Array | undefined;
      const tfQuat = tfCols.get('quat')?.view as Float32Array | undefined;
      const tfScale = tfCols.get('scale')?.view as Float32Array | undefined;
      // Transform.world is an inline `array<f32, 16>` column (stride 16,
      // column-major mat4); row r's world-space translation is at
      // [r*16 + 12 .. +14]. The kinematic mirror MUST drive the Rapier collider
      // from WORLD space, not local pos: a ChildOf collider (e.g. a Guardian
      // attack sensor parented to its body) has local pos (0,0,0), so mirroring
      // local would pin its collider at the world origin forever while only its
      // ECS Transform follows the parent (via propagateTransforms). physicsSync
      // runs AFTER propagateTransforms, so this column is fresh this frame.
      const tfWorld = tfCols.get('world')?.view as Float32Array | undefined;

      // rb* views are intentionally NOT guarded here: a bare-Collider archetype
      // has no RigidBody column, so they are legitimately undefined and the
      // per-row rigidBody below falls back to a static default. Only the
      // Collider + Transform columns are required.
      if (
        !cShape ||
        !cHalfExtents ||
        !cRadius ||
        !cHalfH ||
        !cFric ||
        !cRest ||
        !cDens ||
        !cSensor ||
        !cCGroups ||
        !cSGroups ||
        !tfPos ||
        !tfQuat ||
        !tfScale
      ) {
        continue;
      }

      for (let row = 0; row < arch.size; row++) {
        const entity = readEntityAt(arch, row);

        const localBase = row * 3;
        const quatBase = row * 4;
        const worldBase = row * 16;
        const useWorldPose = hasResolvedWorldPose(tfWorld, worldBase);
        const worldPosition =
          useWorldPose && tfWorld
            ? {
                x: tfWorld[worldBase + 12] ?? tfPos[localBase] ?? 0,
                y: tfWorld[worldBase + 13] ?? tfPos[localBase + 1] ?? 0,
                z: tfWorld[worldBase + 14] ?? tfPos[localBase + 2] ?? 0,
              }
            : {
                x: tfPos[localBase] ?? 0,
                y: tfPos[localBase + 1] ?? 0,
                z: tfPos[localBase + 2] ?? 0,
              };
        if (useWorldPose && tfWorld) {
          for (let lane = 0; lane < 16; lane++) {
            poseScratchWorld[lane] = tfWorld[worldBase + lane] ?? 0;
          }
          mat4.decompose(
            poseScratchPosition,
            poseScratchRotation,
            poseScratchScale,
            poseScratchWorld,
          );
        } else {
          poseScratchPosition[0] = tfPos[localBase] ?? 0;
          poseScratchPosition[1] = tfPos[localBase + 1] ?? 0;
          poseScratchPosition[2] = tfPos[localBase + 2] ?? 0;
          poseScratchRotation[0] = tfQuat[quatBase] ?? 0;
          poseScratchRotation[1] = tfQuat[quatBase + 1] ?? 0;
          poseScratchRotation[2] = tfQuat[quatBase + 2] ?? 0;
          poseScratchRotation[3] = tfQuat[quatBase + 3] ?? 1;
          poseScratchScale[0] = tfScale[localBase] ?? 1;
          poseScratchScale[1] = tfScale[localBase + 1] ?? 1;
          poseScratchScale[2] = tfScale[localBase + 2] ?? 1;
        }
        const transform: PhysicsTransform3D = {
          position: useWorldPose
            ? {
                x: poseScratchPosition[0] ?? 0,
                y: poseScratchPosition[1] ?? 0,
                z: poseScratchPosition[2] ?? 0,
              }
            : worldPosition,
          rotation: {
            x: poseScratchRotation[0] ?? 0,
            y: poseScratchRotation[1] ?? 0,
            z: poseScratchRotation[2] ?? 0,
            w: poseScratchRotation[3] ?? 1,
          },
          scale: {
            x: poseScratchScale[0] ?? 1,
            y: poseScratchScale[1] ?? 1,
            z: poseScratchScale[2] ?? 1,
          },
        };

        // Bare-Collider (no RigidBody) → synthesize a STATIC body. The `static`
        // ensureBody arm reads only `type`, so mass/damping/gravity/ccd defaults
        // are inert; this matches Rapier's "collider without a parent body is
        // fixed" semantics and the Collider component docstring.
        const rigidBody: {
          type: number;
          mass: number;
          linearDamping: number;
          angularDamping: number;
          gravityScale: number;
          ccdEnabled: number;
        } = rbType
          ? {
              type: rbType[row] as number,
              mass: (rbMass?.[row] ?? 0) as number,
              linearDamping: (rbLinDamp?.[row] ?? 0) as number,
              angularDamping: (rbAngDamp?.[row] ?? 0) as number,
              gravityScale: (rbGravScale?.[row] ?? 1) as number,
              ccdEnabled: (rbCcd?.[row] ?? 0) as number,
            }
          : {
              type: RIGID_BODY_TYPE_STATIC,
              mass: 0,
              linearDamping: 0,
              angularDamping: 0,
              gravityScale: 1,
              ccdEnabled: 0,
            };

        const collider: {
          shape: number;
          halfExtents: readonly [number, number, number];
          radius: number;
          halfHeight: number;
          friction: number;
          restitution: number;
          density: number;
          isSensor: number;
          collisionGroups: number;
          solverGroups: number;
        } = {
          shape: cShape[row] as number,
          halfExtents: [
            cHalfExtents[row * 3] as number,
            cHalfExtents[row * 3 + 1] as number,
            cHalfExtents[row * 3 + 2] as number,
          ],
          radius: cRadius[row] as number,
          halfHeight: cHalfH[row] as number,
          friction: cFric[row] as number,
          restitution: cRest[row] as number,
          density: cDens[row] as number,
          isSensor: cSensor[row] as number,
          collisionGroups: cCGroups[row] as number,
          solverGroups: cSGroups[row] as number,
        };

        pw.ensureBody(entity, transform, rigidBody, collider);

        const rbTypeVal = rigidBodyTypeFromF32(rigidBody.type);
        if (rbTypeVal === 'static') {
          pw.syncAuthoredPose(entity, transform, collider, 'static');
        } else if (rbTypeVal === 'kinematic' && !hasCharacterController) {
          pw.syncAuthoredPose(entity, transform, collider, 'kinematic');
        }
      }
    }
  },
});

/**
 * `physicsStepSimulation` system token (M2 — full resource-ification, D-4).
 *
 * After physicsSyncBackend — read Time.delta and call pw.step() with dt-gating.
 */
export const PhysicsStepSimulation: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_STEP_SIMULATION,
  queries: [],
  after: [PHYSICS_SYNC_BACKEND],
  fn: (world) => {
    let pw: RapierPhysicsWorld3D;
    try {
      pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    } catch {
      return; // C-2: safe early out
    }

    const dt = world.getResource(Time).delta;
    if (dt <= 0 || dt > PHYSICS_DT_MAX) return; // D-4: skip abnormal delta

    pw.step(dt);
  },
});

/**
 * `physicsWriteback` system token (M2 — full resource-ification, D-4).
 *
 * After physicsStepSimulation — call pw.writebackDynamicBodies() and write
 * positions back to ECS Transform (resolved via the global registry, D-3).
 */
export const PhysicsWriteback: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_WRITEBACK,
  queries: [],
  after: [PHYSICS_STEP_SIMULATION],
  fn: (world) => {
    const transformComponent = resolveTransform();
    if (transformComponent === undefined) return;
    let pw: RapierPhysicsWorld3D;
    try {
      pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    } catch {
      return; // C-2: safe early out
    }

    const results = pw.writebackDynamicBodies();
    for (const r of results) {
      const entity = r.entity as EntityHandle;
      world.set(entity, transformComponent, {
        pos: [r.pos.x, r.pos.y, r.pos.z],
        quat: [r.rotation.x, r.rotation.y, r.rotation.z, r.rotation.w],
      });
    }
  },
});

/**
 * `physicsCollisionSync` system token — writes the drained overlap set into each
 * entity's `CollidingEntities` component (the contact/sensor set-query path).
 *
 * Runs after writeback so the component reflects this step's contacts. Without
 * it the `CollidingEntities` component documented in the physics README never
 * updates (the event queue was drained-on-overflow only), so sensor pickup +
 * proximity queries silently saw an empty set.
 */
export const PhysicsCollisionSync: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_COLLISION_SYNC,
  queries: [],
  after: [PHYSICS_WRITEBACK],
  fn: (world) => {
    let pw: RapierPhysicsWorld3D;
    try {
      pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    } catch {
      return; // C-2: safe early out
    }
    pw.writebackCollidingEntities(world, CollidingEntities as unknown as Component);
  },
});

/**
 * Register the physics tick systems into an ECS World.
 *
 * The systems ({@link PhysicsSyncBackend} / {@link PhysicsStepSimulation} /
 * {@link PhysicsWriteback} / {@link PhysicsCollisionSync}) are module-level
 * `defineSystem` tokens; this helper wires the moveAndSlide context + despawn
 * cleanup hook, then adds the tokens to the schedule.
 *
 * Transform is resolved from the global ECS registry (`resolveComponent`,
 * D-3) — the previous `transformComponent` second parameter was redundant once
 * the system fns and moveContext resolve Transform themselves, so it is gone.
 *
 * @param world ECS World instance.
 */
export function registerPhysicsSystems(world: World): void {
  // ── moveAndSlide context + despawn cleanup wiring (D-1/D-3) ──
  // Wire the World + Transform/CharacterController components into the backend
  // so moveAndSlide can read tuning and write pose/grounded back, and register
  // the backend for the global Collider.onRemove dispatch (despawn cleanup).
  const transformComponent = resolveTransform();
  try {
    const pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    if (transformComponent !== undefined) {
      pw.setMoveContext(world, transformComponent, CharacterController);
    }
    registerBackendForRemoveHook(pw);
  } catch {
    // PhysicsWorld resource not yet inserted — moveAndSlide falls back to
    // CharacterController schema defaults until a later registration wires it.
  }

  world.addSystems(Update, PhysicsSet, [
    PhysicsSyncBackend,
    PhysicsStepSimulation,
    PhysicsWriteback,
    PhysicsCollisionSync,
  ]);
}
