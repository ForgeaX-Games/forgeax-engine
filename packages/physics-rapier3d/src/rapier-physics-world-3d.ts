import { componentDefinition, Disabled, FixedTime, FixedUpdate } from '@forgeax/engine-ecs';
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
import { defineSystem } from '@forgeax/engine-ecs';
import { createWorldProjection, type WorldProjection } from '@forgeax/engine-ecs/projection';
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
  registerPhysicsComponents,
  rigidBodyTypeFromF32,
} from '@forgeax/engine-physics';
import { ChildOf } from '@forgeax/engine-scene';
import type { Rapier3DModule } from './wasm-loader';

interface Rapier3DKinematicControllerState {
  readonly entity: number;
  readonly offset: number;
}

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

interface PhysicsSyncQueryRow {
  readonly entity: EntityHandle;
  has(component: Component): boolean;
  get(component: Component): Record<string, unknown> | undefined;
}

interface PhysicsSyncQuery extends Iterable<PhysicsSyncQueryRow> {
  at(entity: EntityHandle): PhysicsSyncQueryRow | undefined;
}

interface PhysicsSyncState {
  readonly world: World;
  readonly transformComponent: Component;
  readonly query: PhysicsSyncQuery;
  readonly projection: WorldProjection;
  initialized: boolean;
}

interface PhysicsSyncDescriptor {
  readonly entity: EntityHandle;
  readonly transform: PhysicsTransform3D;
  readonly rigidBody: {
    readonly type: number;
    readonly mass: number;
    readonly linearDamping: number;
    readonly angularDamping: number;
    readonly gravityScale: number;
    readonly ccdEnabled: number;
  };
  readonly collider: PhysicsCollider3D;
  readonly hasCharacterController: boolean;
  readonly characterControllerOffset: number | undefined;
}

interface PhysicsEntityDelta {
  transformChanged: boolean;
  colliderChanged: boolean;
  rigidBodyChanged: boolean;
  characterControllerChanged: boolean;
  characterControllerRemoved: boolean;
}

export interface Rapier3DCollisionEvent {
  readonly type: 'started' | 'stopped';
  readonly entityA: number;
  readonly entityB: number;
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
  raw: RapierWorld;

  private readonly rapierModule: Rapier3DModule;

  /** Entity (raw number) -> PhysicsEntityRecord mapping. */
  private readonly entityMap = new Map<number, PhysicsEntityRecord>();

  /** Pending teleports: entity -> target position, applied on next sync. */
  private readonly pendingTeleports = new Map<number, { x: number; y: number; z: number }>();

  /** Event queue for collision events. */
  private eventQueue: RapierEventQueue;

  /**
   * Active overlap set per entity, maintained by draining the event queue each
   * step. `started` events add the pair both ways; `stopped` events remove it.
   * Read out into each entity's `CollidingEntities` component by
   * `writebackCollidingEntities`. Covers both solid contacts and sensor
   * intersections (Rapier emits CollisionEvent for both).
   */
  private readonly collisionPairs = new Map<number, Set<number>>();

  private readonly pendingCollisionEvents: Rapier3DCollisionEvent[] = [];

  private readonly collisionEventHistory: Rapier3DCollisionEvent[] = [];

  private currentGravity: { x: number; y: number; z: number };

  /**
   * Lazily-built Rapier KinematicCharacterController per character entity
   * (plan-strategy D-1/D-3). `moveAndSlide` creates one on first call; the
   * `Collider.onRemove` hook (registerPhysicsSystems) clears it on despawn.
   * Public so AC-11 despawn tests can assert `kccCache.size === 0`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Rapier KinematicCharacterController from dynamic module
  readonly kccCache = new Map<number, any>();

  private readonly kccOffsets = new Map<number, number>();

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

  /** Persistent ECS query + projection cursor for incremental backend sync. */
  private syncState: PhysicsSyncState | undefined;

  private disposed = false;

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
    this.assertActive('setGravity');
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
    this.assertActive('raycast');
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
    this.assertActive('teleport');
    this.pendingTeleports.set(entity, {
      x: position[0] ?? 0,
      y: position[1] ?? 0,
      z: position[2] ?? 0,
    });
  }

  step(deltaTime: number): void {
    this.assertActive('step');
    void deltaTime;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.step
    (this.raw as any).step(this.eventQueue);
    this.drainRapierCollisionEvents();
  }

  /**
   * Drain the Rapier event queue into `collisionPairs`. Each event names two
   * collider handles + a `started` flag; we resolve each collider to its owning
   * entity (collider.parent() -> body.userData) and add/remove the symmetric
   * pair. This is what populates `CollidingEntities` for sensor pickup + contact
   * queries (the queue is otherwise drained-on-overflow and never observed).
   */
  private drainRapierCollisionEvents(): void {
    this.eventQueue.drainCollisionEvents((handle1: number, handle2: number, started: boolean) => {
      const a = this.colliderHandleToEntity(handle1);
      const b = this.colliderHandleToEntity(handle2);
      if (a === undefined || b === undefined) return;
      const changed = started ? this.addPair(a, b) : this.removePair(a, b);
      if (!changed) return;
      this.pushCollisionEvent({
        type: started ? 'started' : 'stopped',
        entityA: a,
        entityB: b,
      });
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

  private addPair(a: number, b: number): boolean {
    let setA = this.collisionPairs.get(a);
    if (!setA) {
      setA = new Set<number>();
      this.collisionPairs.set(a, setA);
    }
    if (setA.has(b)) return false;
    setA.add(b);
    let setB = this.collisionPairs.get(b);
    if (!setB) {
      setB = new Set<number>();
      this.collisionPairs.set(b, setB);
    }
    setB.add(a);
    return true;
  }

  private removePair(a: number, b: number): boolean {
    const removedA = this.collisionPairs.get(a)?.delete(b) ?? false;
    const removedB = this.collisionPairs.get(b)?.delete(a) ?? false;
    return removedA || removedB;
  }

  private pushCollisionEvent(event: Rapier3DCollisionEvent): void {
    const ordered =
      event.entityA <= event.entityB
        ? event
        : { ...event, entityA: event.entityB, entityB: event.entityA };
    this.pendingCollisionEvents.push(ordered);
    this.collisionEventHistory.push(ordered);
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

  drainCollisionEvents(): Rapier3DCollisionEvent[] {
    return this.pendingCollisionEvents.splice(0);
  }

  getCollisionPairs(): Map<number, Set<number>> {
    return new Map([...this.collisionPairs].map(([entity, others]) => [entity, new Set(others)]));
  }

  getCollisionEventHistory(): readonly Rapier3DCollisionEvent[] {
    return [...this.collisionEventHistory];
  }

  getPendingTeleports(): readonly [
    number,
    { readonly x: number; readonly y: number; readonly z: number },
  ][] {
    return [...this.pendingTeleports].map(([entity, target]) => [entity, { ...target }]);
  }

  getKinematicControllerStates(): readonly Rapier3DKinematicControllerState[] {
    return [...this.kccOffsets]
      .sort(([first], [second]) => first - second)
      .map(([entity, offset]) => ({ entity, offset }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.syncState = undefined;
    this.moveContext = undefined;
    if (typeof this.raw.free === 'function') this.raw.free();
    if (typeof this.eventQueue.free === 'function') this.eventQueue.free();
    this.entityMap.clear();
    this.pendingTeleports.clear();
    this.collisionPairs.clear();
    this.pendingCollisionEvents.length = 0;
    this.collisionEventHistory.length = 0;
    this.kccCache.clear();
    this.kccOffsets.clear();
    this.disposed = true;
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
    this.assertActive('setMoveContext');
    this.moveContext = { world, transform, characterController };
  }

  /** Release the persistent ECS readers owned by one system registration. */
  clearEcsContext(world: World): void {
    if (this.syncState?.world === world) this.syncState = undefined;
    if (this.moveContext?.world === world) this.moveContext = undefined;
  }

  moveAndSlide(entity: number, desiredDelta: Vec3): Vec3 {
    this.assertActive('moveAndSlide');
    return this.computeMove(entity, desiredDelta);
  }

  private assertActive(operation: string): void {
    if (this.disposed) {
      throw new Error(`RapierPhysicsWorld3D.${operation} cannot run on a disposed instance`);
    }
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
    // The ECS token owns the defaults; keep the defensive no-context path on
    // that projection so 3D cannot drift from the shared CharacterController schema.
    return componentDefinition(CharacterController)
      .defaults as unknown as CharacterControllerTuning;
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
    this.kccOffsets.set(entity, offset);
    return ctrl;
  }

  /** Remove backend rows whose Collider disappeared from the World query. */
  pruneMissingEntities(active: ReadonlySet<number>): void {
    for (const entity of this.entityMap.keys()) {
      if (!active.has(entity)) this.removeEntity(entity);
    }
  }

  private bodyForEntity(entity: number): RapierRigidBody | undefined {
    const record = this.entityMap.get(entity);
    if (!record) return undefined;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    return ((this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody | null) ?? undefined;
  }

  private isCommittedFixedBody(entity: number): boolean {
    return this.bodyForEntity(entity)?.bodyType() === this.rapierModule.RigidBodyType.Fixed;
  }

  private reconcileTransformlessCompatibility(entity: number, staticByEcs: boolean): void {
    if (!staticByEcs || !this.isCommittedFixedBody(entity)) {
      this.removeEntity(entity);
      return;
    }
    // A fixed body cannot be controller-owned. Clear stale KCC state defensively
    // while retaining the already-committed body and collider receipt.
    this.removeKccController(entity);
  }

  private resetForFullReconcile(transformlessStatic: ReadonlySet<number>): void {
    // Without a descriptor/hash mirror, an overflow cannot prove which existing
    // Transform-backed body changed. Recreate those bodies from the final ECS
    // combination. Dynamic velocity/contact state is intentionally reset during
    // this recovery path so stale motion type or collider data cannot survive.
    for (const entity of [...this.entityMap.keys()]) {
      if (transformlessStatic.has(entity) && this.isCommittedFixedBody(entity)) {
        this.removeKccController(entity);
        continue;
      }
      this.removeEntity(entity);
    }
  }

  private fullReconcilePhysicsState(state: PhysicsSyncState): void {
    const descriptors: PhysicsSyncDescriptor[] = [];
    const transformlessStatic = new Set<number>();
    for (const row of state.query) {
      if (!row.has(state.transformComponent)) {
        if (physicsRowIsStatic(row)) transformlessStatic.add(row.entity);
        continue;
      }
      const descriptor = readPhysicsSyncDescriptor(row, state.transformComponent);
      if (descriptor !== undefined) descriptors.push(descriptor);
    }

    this.resetForFullReconcile(transformlessStatic);
    for (const descriptor of descriptors) {
      this.ensureBody(
        descriptor.entity,
        descriptor.transform,
        descriptor.rigidBody,
        descriptor.collider,
      );
    }
    state.initialized = true;
  }

  private reconcilePhysicsDelta(
    state: PhysicsSyncState,
    entity: EntityHandle,
    delta: PhysicsEntityDelta,
  ): void {
    const row = state.query.at(entity);
    if (row === undefined) {
      this.removeEntity(entity);
      return;
    }
    if (!row.has(state.transformComponent)) {
      // A lifecycle mutation cannot be applied without a pose. Keep only the
      // narrow migration case where Transform alone disappeared from an already
      // committed fixed body; never create or reshape a Transform-less row.
      if (delta.colliderChanged || delta.rigidBodyChanged) {
        this.removeEntity(entity);
        return;
      }
      this.reconcileTransformlessCompatibility(entity, physicsRowIsStatic(row));
      return;
    }

    const descriptor = readPhysicsSyncDescriptor(row, state.transformComponent);
    if (descriptor === undefined) {
      this.removeEntity(entity);
      return;
    }

    if (this.hasBody(entity) && (delta.colliderChanged || delta.rigidBodyChanged)) {
      // Collider/RigidBody lifecycle is reconciled by replacement from the final
      // ECS combination. This deliberately resets velocity/contact state for an
      // affected dynamic body; no descriptor mirror is introduced in M1.
      this.removeEntity(entity);
    }
    if (!this.hasBody(entity)) {
      this.ensureBody(entity, descriptor.transform, descriptor.rigidBody, descriptor.collider);
      return;
    }

    if (delta.characterControllerChanged) {
      const cachedOffset = this.kccOffsets.get(entity);
      const hadCachedReceipt = this.kccCache.has(entity);
      const finalOffset = descriptor.characterControllerOffset;
      if (!descriptor.hasCharacterController) {
        this.removeKccController(entity);
      } else if (
        hadCachedReceipt &&
        (delta.characterControllerRemoved ||
          finalOffset === undefined ||
          !Object.is(cachedOffset, finalOffset))
      ) {
        // Consume the final ECS combination. A remove+add in one journal window
        // rebuilds the KCC receipt with the final offset, while transient
        // grounded writeback leaves an equal-offset receipt untouched.
        this.removeKccController(entity);
        if (finalOffset !== undefined) this.ensureKcc(entity, finalOffset);
      }
    }
    if (!delta.transformChanged && !delta.characterControllerRemoved) return;

    const bodyType = rigidBodyTypeFromF32(descriptor.rigidBody.type);
    if (bodyType === 'static') {
      this.syncAuthoredPose(entity, descriptor.transform, descriptor.collider, 'static');
    } else if (bodyType === 'kinematic' && !descriptor.hasCharacterController) {
      this.syncAuthoredPose(entity, descriptor.transform, descriptor.collider, 'kinematic');
    }
  }

  /** @internal ECS system bridge; consumers should register PhysicsSyncBackend. */
  _syncFromEcs(world: World, transformComponent: Component): void {
    this.assertActive('syncFromEcs');
    let state = this.syncState;
    if (
      state === undefined ||
      state.world !== world ||
      state.transformComponent !== transformComponent
    ) {
      const queryResult = world.query({
        read: [Collider],
        optional: [transformComponent, RigidBody, CharacterController, ChildOf],
      });
      if (!queryResult.ok) return;
      state = {
        world,
        transformComponent,
        query: queryResult.value as unknown as PhysicsSyncQuery,
        projection: createWorldProjection(world, {
          components: [
            transformComponent,
            Collider,
            RigidBody,
            CharacterController,
            ChildOf,
            Disabled,
          ],
        }),
        initialized: false,
      };
      this.syncState = state;
    }

    if (!state.initialized) {
      this.fullReconcilePhysicsState(state);
      return;
    }

    const evidence = state.projection.poll();
    if (evidence.status === 'rebuild') {
      this.fullReconcilePhysicsState(state);
      return;
    }
    if (evidence.changes.length === 0) return;

    const deltas = new Map<EntityHandle, PhysicsEntityDelta>();
    for (const change of evidence.changes) {
      let delta = deltas.get(change.entity);
      if (delta === undefined) {
        delta = {
          transformChanged: false,
          colliderChanged: false,
          rigidBodyChanged: false,
          characterControllerChanged: false,
          characterControllerRemoved: false,
        };
        deltas.set(change.entity, delta);
      }
      if (change.kind === 'entity-removed') continue;
      if (change.component === undefined) {
        this.fullReconcilePhysicsState(state);
        return;
      }
      if (change.component === transformComponent) {
        delta.transformChanged = true;
      } else if (change.component === Collider) {
        delta.colliderChanged = true;
      } else if (change.component === RigidBody) {
        delta.rigidBodyChanged = true;
      } else if (change.component === CharacterController) {
        delta.characterControllerChanged = true;
        if (change.kind === 'component-removed') delta.characterControllerRemoved = true;
      } else if (change.component === ChildOf) {
        delta.transformChanged = true;
      } else if (change.component !== Disabled) {
        // The projection is intentionally closed over the membership inputs.
        // Any future unattributable record fails closed to a complete read.
        this.fullReconcilePhysicsState(state);
        return;
      }
    }

    for (const [entity, delta] of deltas) this.reconcilePhysicsDelta(state, entity, delta);
  }

  /**
   * Remove an entity's cached KCC and unregister it from the Rapier world
   * (plan-strategy D-3). Idempotent — safe for entities that never moved.
   */
  removeKccController(entity: number): void {
    const ctrl = this.kccCache.get(entity);
    this.kccOffsets.delete(entity);
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
    this.assertActive('ensureBody');
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
    this.assertActive('syncAuthoredPose');
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
    const ownPairs = [...(this.collisionPairs.get(entity) ?? [])];
    for (const other of ownPairs) {
      if (this.removePair(entity, other)) {
        this.pushCollisionEvent({ type: 'stopped', entityA: entity, entityB: other });
      }
    }
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

function hasReadableWorldPose(world: Float32Array | undefined): world is Float32Array {
  return world !== undefined && world.length >= 16;
}

/** dt upper bound (plan-strategy D-4): skip step if dt exceeds this. */
const PHYSICS_DT_MAX = 0.1;
const poseScratchPosition = vec3.create();
const poseScratchRotation = quat.create();
const poseScratchScale = vec3.create();
const poseScratchWorld = new Float32Array(16);

function physicsRowIsStatic(row: PhysicsSyncQueryRow): boolean {
  if (!row.has(RigidBody)) return true;
  const rigidBody = row.get(RigidBody) as { readonly type: number } | undefined;
  return rigidBody !== undefined && rigidBodyTypeFromF32(rigidBody.type) === 'static';
}

function readPhysicsSyncDescriptor(
  row: PhysicsSyncQueryRow,
  transformComponent: Component,
): PhysicsSyncDescriptor | undefined {
  const transformData = row.get(transformComponent) as
    | {
        readonly pos: Float32Array;
        readonly quat: Float32Array;
        readonly scale: Float32Array;
        readonly world?: Float32Array;
      }
    | undefined;
  const colliderData = row.get(Collider) as
    | {
        readonly shape: number;
        readonly halfExtents: Float32Array;
        readonly radius: number;
        readonly halfHeight: number;
        readonly friction: number;
        readonly restitution: number;
        readonly density: number;
        readonly isSensor: number | boolean;
        readonly collisionGroups: number;
        readonly solverGroups: number;
      }
    | undefined;
  if (transformData === undefined || colliderData === undefined) return undefined;

  // Root-local TRS is already a world pose. A ChildOf row, however, must use
  // Scene's derived world matrix whenever that field is readable. Matrix
  // contents cannot be a validity sentinel: a legitimate parent/local
  // composition can resolve to identity. Direct/test rows that omit `world`
  // retain the authored-local fallback.
  const useWorldPose = row.has(ChildOf) && hasReadableWorldPose(transformData.world);
  if (useWorldPose) {
    poseScratchWorld.set(transformData.world.subarray(0, 16));
    mat4.decompose(poseScratchPosition, poseScratchRotation, poseScratchScale, poseScratchWorld);
  } else {
    poseScratchPosition[0] = transformData.pos[0] ?? 0;
    poseScratchPosition[1] = transformData.pos[1] ?? 0;
    poseScratchPosition[2] = transformData.pos[2] ?? 0;
    poseScratchRotation[0] = transformData.quat[0] ?? 0;
    poseScratchRotation[1] = transformData.quat[1] ?? 0;
    poseScratchRotation[2] = transformData.quat[2] ?? 0;
    poseScratchRotation[3] = transformData.quat[3] ?? 1;
    poseScratchScale[0] = transformData.scale[0] ?? 1;
    poseScratchScale[1] = transformData.scale[1] ?? 1;
    poseScratchScale[2] = transformData.scale[2] ?? 1;
  }

  const rigidBodyData = row.has(RigidBody)
    ? (row.get(RigidBody) as
        | {
            readonly type: number;
            readonly mass: number;
            readonly linearDamping: number;
            readonly angularDamping: number;
            readonly gravityScale: number;
            readonly ccdEnabled: number | boolean;
          }
        | undefined)
    : undefined;
  const characterControllerData = row.has(CharacterController)
    ? (row.get(CharacterController) as { readonly offset: number } | undefined)
    : undefined;

  return {
    entity: row.entity,
    transform: {
      position: {
        x: poseScratchPosition[0] ?? 0,
        y: poseScratchPosition[1] ?? 0,
        z: poseScratchPosition[2] ?? 0,
      },
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
    },
    rigidBody:
      rigidBodyData === undefined
        ? {
            type: RIGID_BODY_TYPE_STATIC,
            mass: 0,
            linearDamping: 0,
            angularDamping: 0,
            gravityScale: 1,
            ccdEnabled: 0,
          }
        : {
            type: rigidBodyData.type,
            mass: rigidBodyData.mass,
            linearDamping: rigidBodyData.linearDamping,
            angularDamping: rigidBodyData.angularDamping,
            gravityScale: rigidBodyData.gravityScale,
            ccdEnabled: Number(rigidBodyData.ccdEnabled),
          },
    collider: {
      shape: colliderData.shape,
      halfExtents: [
        colliderData.halfExtents[0] ?? 0,
        colliderData.halfExtents[1] ?? 0,
        colliderData.halfExtents[2] ?? 0,
      ],
      radius: colliderData.radius,
      halfHeight: colliderData.halfHeight,
      friction: colliderData.friction,
      restitution: colliderData.restitution,
      density: colliderData.density,
      isSensor: Number(colliderData.isSensor),
      collisionGroups: colliderData.collisionGroups,
      solverGroups: colliderData.solverGroups,
    },
    hasCharacterController: row.has(CharacterController),
    characterControllerOffset: characterControllerData?.offset,
  };
}

// ── System name constants ──
const PHYSICS_SYNC_BACKEND = 'physicsSyncBackend' as const;
const PHYSICS_STEP_SIMULATION = 'physicsStepSimulation' as const;
const PHYSICS_WRITEBACK = 'physicsWriteback' as const;
const PHYSICS_COLLISION_SYNC = 'physicsCollisionSync' as const;

/**
 * Resolve the runtime `Transform` component token from the World-local ECS
 * registry (M2 — full resource-ification, D-3). physics already depends on
 * `@forgeax/engine-ecs`, so the catalog introduces no new dependency
 * and replaces the closure-captured `transformComponent` second parameter.
 * Returns `undefined` when Transform is not yet defined (the runtime package
 * defines it on import); callers early-out.
 */
function resolveTransform(world: World): Component | undefined {
  return world.components.resolve('Transform');
}

/**
 * `physicsSyncBackend` system token (M2 — full resource-ification, D-4).
 *
 * After propagateTransforms, bootstrap/recovery performs one complete Collider
 * reconcile. Warm ticks poll the existing ECS projection and identity-read only
 * final changed rows. Bare Colliders remain implicit static bodies; Transform-less
 * fixed bodies are retained only as a migration defense and are never created.
 * Reads `world` from its first parameter; resolves Transform via the global
 * registry. Labelled `'physics'`.
 */
export const PhysicsSyncBackend: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_SYNC_BACKEND,
  queries: [],
  after: ['propagateTransformsFixed'],
  fn: (world) => {
    const transformComponent = resolveTransform(world);
    if (transformComponent === undefined) return;
    let pw: RapierPhysicsWorld3D;
    try {
      pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    } catch {
      return; // C-2: PhysicsWorld resource not yet ready — safe early out
    }

    pw.applyPendingTeleports();
    pw._syncFromEcs(world, transformComponent);
  },
});

/**
 * `physicsStepSimulation` system token (M2 — full resource-ification, D-4).
 *
 * After physicsSyncBackend — read FixedTime.delta and call pw.step() with dt-gating.
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

    const dt = world.getResource(FixedTime).delta;
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
    const transformComponent = resolveTransform(world);
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
 * Transform is resolved from the World-local ECS component catalog,
 * D-3) — the previous `transformComponent` second parameter was redundant once
 * the system fns and moveContext resolve Transform themselves, so it is gone.
 *
 * @param world ECS World instance.
 */
export function registerPhysicsSystems(world: World): () => void {
  const releaseComponents = registerPhysicsComponents(world);
  // ── moveAndSlide context + despawn cleanup wiring (D-1/D-3) ──
  // Wire the World + Transform/CharacterController components into the backend
  // so moveAndSlide can read tuning and write pose/grounded back, and register
  // the backend for the global Collider.onRemove dispatch (despawn cleanup).
  const transformComponent = resolveTransform(world);
  try {
    const pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    if (transformComponent !== undefined) {
      pw.setMoveContext(world, transformComponent, CharacterController);
    }
  } catch {
    // PhysicsWorld resource not yet inserted — moveAndSlide falls back to
    // CharacterController schema defaults until a later registration wires it.
  }

  world
    .addSystems(FixedUpdate, PhysicsSet, [
      PhysicsSyncBackend,
      PhysicsStepSimulation,
      PhysicsWriteback,
      PhysicsCollisionSync,
    ])
    .unwrap();
  return () => {
    world.removeSystem(FixedUpdate, PHYSICS_COLLISION_SYNC);
    world.removeSystem(FixedUpdate, PHYSICS_WRITEBACK);
    world.removeSystem(FixedUpdate, PHYSICS_STEP_SIMULATION);
    world.removeSystem(FixedUpdate, PHYSICS_SYNC_BACKEND);
    try {
      world.getResource<RapierPhysicsWorld3D>('PhysicsWorld').clearEcsContext(world);
    } catch {
      // PhysicsWorld may already have been removed as part of outer teardown.
    }
    releaseComponents();
  };
}
