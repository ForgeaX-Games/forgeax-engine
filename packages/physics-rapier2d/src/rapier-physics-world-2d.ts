// @forgeax/engine-physics-rapier2d — RapierPhysicsWorld2D class and three-phase
// tick systems (syncBackend / stepSimulation / writeback).
//
// Mirrors packages/physics-rapier3d/ with 2D adaptations (research Finding 12):
//   - Vec2 instead of Vec3 for translations
//   - scalar angle instead of Quat for rotation
//   - Rapier2D world.step() (no z-axis)
//
// Three-phase pipeline (plan-strategy D-1):
//   1. syncBackend: apply pending teleports, update kinematic positions.
//   2. stepSimulation: call rapierWorld.step(eventQueue).
//   3. writeback: read Rapier body positions (dynamic only).

import type { Component, EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem, Entity as EntityComponent, resolveComponent } from '@forgeax/engine-ecs';
import { mat4, quat, type Vec2, type Vec3Like, vec2, vec3 } from '@forgeax/engine-math';
import type { PhysicsWorld2D, RaycastHit2D } from '@forgeax/engine-physics';
import {
  CharacterController,
  Collider,
  colliderShapeFromF32,
  PHYSICS_ERROR_HINTS,
  PhysicsError,
  RIGID_BODY_TYPE_STATIC,
  RigidBody,
  registerColliderRemoveListener,
  rigidBodyTypeFromF32,
} from '@forgeax/engine-physics';
import type { Rapier2DModule } from './wasm-loader';

interface PhysicsEntityRecord {
  bodyHandle: number;
}

interface PhysicsTransform2D {
  readonly position: { readonly x: number; readonly y: number };
  readonly rotation: number;
  readonly scale: { readonly x: number; readonly y: number };
}

interface PhysicsCollider2D {
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
type RapierWorld2D = any;
// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
type RapierEventQueue = any;
// biome-ignore lint/suspicious/noExplicitAny: Rapier types from dynamically loaded module
type RapierRigidBody2D = any;

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
 * D-7: full reset, no dirty tracking). Mirrors the 3D applyKccTuning; the KCC
 * API is dimension-agnostic. Degrees -> radians for the two slope setters;
 * offset / autostep / snap pass through as world units. A zero value for
 * auto-step / snap calls `disable*()` rather than `enable*(0)`.
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
 * Map a Rapier 2D RigidBodyType enum value to the engine's string union for the
 * `controller-requires-kinematic` error detail.
 */
// biome-ignore lint/suspicious/noExplicitAny: Rapier module enum from dynamic module
function rapierBodyTypeToString(rapier: any, bodyType: number): string {
  if (bodyType === rapier.RigidBodyType.Dynamic) return 'dynamic';
  if (bodyType === rapier.RigidBodyType.Fixed) return 'static';
  return 'kinematic';
}

export class RapierPhysicsWorld2D implements PhysicsWorld2D {
  readonly raw: RapierWorld2D;

  private readonly rapierModule: Rapier2DModule;

  /** Entity (raw number) -> PhysicsEntityRecord mapping. */
  private readonly entityMap = new Map<number, PhysicsEntityRecord>();

  /** Pending teleports: entity -> target position and rotation. */
  private readonly pendingTeleports = new Map<number, { x: number; y: number; rotation: number }>();

  private readonly eventQueue: RapierEventQueue;

  private currentGravity: { x: number; y: number };

  /**
   * Lazily-built Rapier KinematicCharacterController per character entity
   * (plan-strategy D-1/D-3, 2D variant). `moveAndSlide` creates one on first
   * call; the `Collider.onRemove` hook clears it on despawn. Public so AC-12
   * despawn tests can assert `kccCache.size === 0`.
   */
  // biome-ignore lint/suspicious/noExplicitAny: Rapier KinematicCharacterController from dynamic module
  readonly kccCache = new Map<number, any>();

  /**
   * ECS World + components wired in by `registerPhysicsSystems2D`, so
   * `moveAndSlide` can read CharacterController tuning and write Transform +
   * grounded back. Undefined until systems are registered — the input-validation
   * error paths fire before these are read, so direct `pw.moveAndSlide()` calls
   * in error tests need no World.
   */
  private moveContext:
    | { world: World; transform: Component; characterController: Component }
    | undefined;

  constructor(rapier: Rapier2DModule) {
    this.rapierModule = rapier;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World constructor is a class exported from a namespace module
    this.raw = new (rapier as any).World({ x: 0, y: -9.81 }) as RapierWorld2D;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier EventQueue constructor comes from a namespace module
    this.eventQueue = new (rapier as any).EventQueue(true) as RapierEventQueue;
    this.currentGravity = { x: 0, y: -9.81 };
  }

  // ─── PhysicsWorld2D interface ──────────────────────────────────────────

  setGravity(gravity: Vec2): void {
    const x = gravity[0] ?? 0;
    const y = gravity[1] ?? 0;
    this.raw.gravity = { x, y };
    this.currentGravity = { x, y };
  }

  getGravity(): Vec2 {
    const { x, y } = this.currentGravity;
    return vec2.create(x, y);
  }

  raycast(
    origin: Vec2,
    direction: Vec2,
    maxDist: number,
    filterMask?: number,
  ): RaycastHit2D | undefined {
    const RAPIER = this.rapierModule;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier Ray constructor comes from a namespace module
    const RayCtor = (RAPIER as any).Ray as new (
      origin: { x: number; y: number },
      dir: { x: number; y: number },
    ) => { pointAt(t: number): { x: number; y: number } };
    const ray = new RayCtor(
      { x: origin[0] ?? 0, y: origin[1] ?? 0 },
      { x: direction[0] ?? 0, y: direction[1] ?? 0 },
    );
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World castRayAndGetNormal (2D)
    const hit = (this.raw as any).castRayAndGetNormal(
      ray,
      maxDist,
      true,
      undefined,
      filterMask,
    ) as {
      collider: { parent(): { userData: number } | null };
      timeOfImpact: number;
      normal: { x: number; y: number };
    } | null;

    if (hit === null) return undefined;

    const point = ray.pointAt(hit.timeOfImpact);
    // `hit.collider.parent()` already returns the owning RigidBody OBJECT (compat
    // build), whose userData holds the ECS entity — read it directly. The prior
    // code treated the object as a body HANDLE and re-resolved it via
    // `bodies.get(...)`, which returned a DIFFERENT body → the wrong entity
    // (identical bug + fix as the 3D backend, solo round-22).
    const colliderParentBody = hit.collider.parent();
    const entity = colliderParentBody !== null ? colliderParentBody.userData : 0;

    return {
      entity,
      point: vec2.create(point.x, point.y),
      normal: vec2.create(hit.normal.x, hit.normal.y),
      timeOfImpact: hit.timeOfImpact,
    };
  }

  teleport(entity: number, position: Vec2, rotation: number): void {
    this.pendingTeleports.set(entity, {
      x: position[0] ?? 0,
      y: position[1] ?? 0,
      rotation,
    });
  }

  step(deltaTime: number): void {
    void deltaTime;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.step
    (this.raw as any).step(this.eventQueue);
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
   * `registerPhysicsSystems2D` (plan-strategy D-1/D-7).
   */
  setMoveContext(world: World, transform: Component, characterController: Component): void {
    this.moveContext = { world, transform, characterController };
  }

  moveAndSlide(entity: number, desiredDelta: Vec2): Vec2 {
    return this.computeMove(entity, desiredDelta);
  }

  /**
   * Shared moveAndSlide core (plan-strategy D-1/D-2/D-4/D-6/D-7), 2D variant.
   * Mirrors the 3D computeMove with Vec2 movement (x, y only — no z).
   *
   * The three Fail-Fast entry checks (body / collider / kinematic) throw
   * structured PhysicsError before the World is read, so error-path tests can
   * call this without registered systems.
   */
  private computeMove(entity: number, desiredDelta: Vec3Like): Vec2 {
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
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody2D | null;
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
    // collider so it never collides with itself.
    const delta = { x: desiredDelta[0] ?? 0, y: desiredDelta[1] ?? 0 };
    ctrl.computeColliderMovement(
      collider,
      delta,
      undefined,
      undefined,
      // biome-ignore lint/suspicious/noExplicitAny: Rapier Collider in filter predicate
      (other: any) => other.handle !== collider.handle,
    );

    // ── Step 2/3: read corrected movement + grounded ──
    const movement = ctrl.computedMovement() as { x: number; y: number };
    const grounded = ctrl.computedGrounded() as boolean;

    // ── Write back: push the kinematic body + ECS Transform + grounded ──
    const t = body.translation();
    const next = { x: t.x + movement.x, y: t.y + movement.y };
    // setNextKinematicTranslation feeds the physics step pipeline; setTranslation
    // advances the body + its collider immediately so consecutive moveAndSlide
    // calls (without an intervening world.step) see the updated pose for the next
    // collision solve + grounded check.
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
        pos: [next.x, next.y, readTransformPosZ(ctx.world, entity as EntityHandle, ctx.transform)],
      });
      ctx.world.set(entity as EntityHandle, ctx.characterController, { grounded });
    }

    return vec2.create(movement.x, movement.y);
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
   * Lazily build a Rapier 2D KinematicCharacterController for `entity` (cached).
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

  // ─── ECS->Rapier bridge (D-2, 2D variant) ────────────────────────────

  /**
   * Ensure a Rapier 2D body and collider exist for an ECS entity (idempotent).
   *
   * 2D variant of the M1 3D ensureBody: Vec2 {x,y} instead of Vec3 {x,y,z},
   * Rapier2D ColliderDesc.{cuboid(hx,hy), ball(radius), capsule(halfHeight,radius)},
   * scalar rotation from transform quat (extracted via atan2 for z-axis angle).
   *
   * Plan-strategy C-3 symmetry with M1, D-2 + D-5 2D adaptations.
   */
  ensureBody(
    entity: number,
    transform: PhysicsTransform2D,
    rigidBody: {
      type: number;
      mass: number;
      linearDamping: number;
      angularDamping: number;
      gravityScale: number;
      ccdEnabled: number;
    },
    collider: PhysicsCollider2D,
  ): void {
    if (this.entityMap.has(entity)) return;

    const RAPIER = this.rapierModule;

    // ── Create RigidBodyDesc (2D) ──
    const rbType = rigidBodyTypeFromF32(rigidBody.type);
    let body: RapierRigidBody2D;
    switch (rbType) {
      case 'dynamic': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.dynamic()
          .setTranslation(transform.position.x, transform.position.y)
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
          .setTranslation(transform.position.x, transform.position.y)
          .setRotation(transform.rotation);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
      case 'kinematic': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier RigidBodyDesc
        const desc = (RAPIER as any).RigidBodyDesc.kinematicPositionBased()
          .setTranslation(transform.position.x, transform.position.y)
          .setRotation(transform.rotation);
        // CCD sweeps the collider along its per-step kinematic translation so a
        // fast mover reliably contacts dynamics instead of tunneling through
        // them on discrete steps.
        if (rigidBody.ccdEnabled) {
          desc.setCcdEnabled(true);
        }
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createRigidBody
        body = (this.raw as any).createRigidBody(desc);
        break;
      }
    }

    body.userData = entity;
    this.registerBody(entity, body.handle);

    // ── Create ColliderDesc (2D) ──
    const scaleX = Math.abs(transform.scale.x);
    const scaleY = Math.abs(transform.scale.y);
    const cShape = colliderShapeFromF32(collider.shape);
    switch (cShape) {
      case 'cuboid': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier ColliderDesc
        const desc = (RAPIER as any).ColliderDesc.cuboid(
          collider.halfExtents[0] * scaleX,
          collider.halfExtents[1] * scaleY,
        )
          .setFriction(collider.friction)
          .setRestitution(collider.restitution)
          .setDensity(collider.density)
          .setCollisionGroups(collider.collisionGroups)
          .setSolverGroups(collider.solverGroups);
        if (collider.isSensor) desc.setSensor(true);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCollider
        (this.raw as any).createCollider(desc, body);
        break;
      }
      case 'sphere': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier ColliderDesc
        const desc = (RAPIER as any).ColliderDesc.ball(collider.radius * Math.max(scaleX, scaleY))
          .setFriction(collider.friction)
          .setRestitution(collider.restitution)
          .setDensity(collider.density)
          .setCollisionGroups(collider.collisionGroups)
          .setSolverGroups(collider.solverGroups);
        if (collider.isSensor) desc.setSensor(true);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCollider
        (this.raw as any).createCollider(desc, body);
        break;
      }
      case 'capsule': {
        // biome-ignore lint/suspicious/noExplicitAny: Rapier ColliderDesc
        const desc = (RAPIER as any).ColliderDesc.capsule(
          collider.halfHeight * scaleY,
          collider.radius * scaleX,
        )
          .setFriction(collider.friction)
          .setRestitution(collider.restitution)
          .setDensity(collider.density)
          .setCollisionGroups(collider.collisionGroups)
          .setSolverGroups(collider.solverGroups);
        if (collider.isSensor) desc.setSensor(true);
        // biome-ignore lint/suspicious/noExplicitAny: Rapier World.createCollider
        (this.raw as any).createCollider(desc, body);
        break;
      }
    }
  }

  /** Synchronize a static or kinematic Rapier body from its resolved 2D Transform pose. */
  syncAuthoredPose(
    entity: number,
    transform: PhysicsTransform2D,
    collider: PhysicsCollider2D,
    bodyType: 'static' | 'kinematic',
  ): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody2D | null;
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
    switch (colliderShapeFromF32(collider.shape)) {
      case 'cuboid':
        rapierCollider.setHalfExtents({
          x: collider.halfExtents[0] * scaleX,
          y: collider.halfExtents[1] * scaleY,
        });
        break;
      case 'sphere':
        rapierCollider.setRadius(collider.radius * Math.max(scaleX, scaleY));
        break;
      case 'capsule':
        rapierCollider.setHalfHeight(collider.halfHeight * scaleY);
        rapierCollider.setRadius(collider.radius * scaleX);
        break;
    }
  }

  // ─── ECS integration helpers ───────────────────────────────────────────

  registerBody(entity: number, bodyHandle: number): void {
    this.entityMap.set(entity, { bodyHandle });
  }

  applyPendingTeleports(): void {
    for (const [entity, target] of this.pendingTeleports) {
      const record = this.entityMap.get(entity);
      if (!record) continue;
      // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
      const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody2D | null;
      if (!body) continue;

      body.setTranslation({ x: target.x, y: target.y }, true);
      body.setLinvel({ x: 0, y: 0 }, false);
      body.setAngvel(0, false);
      if (target.rotation !== undefined) {
        body.setRotation(target.rotation, true);
      }
    }
    this.pendingTeleports.clear();
  }

  setKinematicPosition(entity: number, pos: { x: number; y: number }, rotation?: number): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
    const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody2D | null;
    if (!body) return;
    body.setNextKinematicTranslation({ x: pos.x, y: pos.y });
    if (rotation !== undefined) {
      body.setNextKinematicRotation(rotation);
    }
  }

  writebackDynamicBodies(): Array<{
    entity: number;
    pos: { x: number; y: number };
    rotation: number;
  }> {
    const results: Array<{
      entity: number;
      pos: { x: number; y: number };
      rotation: number;
    }> = [];
    for (const [entity, record] of this.entityMap) {
      // biome-ignore lint/suspicious/noExplicitAny: Rapier bodies API needs any-cast
      const body = (this.raw as any).bodies.get(record.bodyHandle) as RapierRigidBody2D | null;
      if (!body) continue;
      if (body.bodyType() !== this.rapierModule.RigidBodyType.Dynamic) continue;
      const translation = body.translation();
      const rotation = body.rotation();
      results.push({
        entity,
        pos: { x: translation.x, y: translation.y },
        rotation,
      });
    }
    return results;
  }

  removeEntity(entity: number): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    this.removeKccController(entity); // D-3: clear cached KCC before body removal
    // biome-ignore lint/suspicious/noExplicitAny: Rapier World.removeRigidBody
    (this.raw as any).removeRigidBody({
      handle: record.bodyHandle,
    } as RapierRigidBody2D);
    this.entityMap.delete(entity);
  }
}

export function createRapier2DPhysicsWorld(rapier: Rapier2DModule): RapierPhysicsWorld2D {
  return new RapierPhysicsWorld2D(rapier);
}

// ─── Internal archetype graph surface (mirrors advance-animation-player + 3D) ──
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
  /**
   * @internal Column-level zero-copy view of an `array<T, N>` field row
   * (mirrored from World; see runtime propagate-transforms). Used by the 2D
   * write paths to read the current pos z lane.
   */
  _getArrayView(
    entity: EntityHandle,
    component: Component,
    fieldName: string,
  ): ArrayLike<number> | undefined;
}
function asInternal(w: World): InternalWorldSurface {
  return w as unknown as InternalWorldSurface;
}

/**
 * Read the entity's current `Transform.pos` z lane. Transform.pos is one
 * `array<f32, 3>` column row (feat-20260709 M2) so per-axis partial writes no
 * longer exist; 2D physics owns only the xy lanes and must carry the authored
 * z (sprite layering / camera depth) through its full-row `world.set` writes.
 * Falls back to 0 when the row is unreachable (entity died mid-frame).
 */
function readTransformPosZ(w: World, entity: EntityHandle, transform: Component): number {
  const view = asInternal(w)._getArrayView(entity, transform, 'pos');
  return view?.[2] ?? 0;
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
const poseScratchPosition2D = vec3.create();
const poseScratchRotation2D = quat.create();
const poseScratchScale2D = vec3.create();
const poseScratchWorld2D = new Float32Array(16);

// ─── Collider removal despawn-cleanup dispatch (plan-strategy D-3, 2D) ───
//
// Mirrors the 3D backend-removal hook: `Collider.onRemove` fans removal out to
// subscribed listeners; each 2D backend subscribes and dispatches removeEntity
// to every live backend on removal — only the one whose entityMap holds the
// entity acts (removeEntity early-returns otherwise, idempotent).

const registeredBackends2D = new Set<RapierPhysicsWorld2D>();
let colliderRemoveListenerSubscribed2D = false;

function registerBackendForRemoveHook2D(pw: RapierPhysicsWorld2D): void {
  registeredBackends2D.add(pw);
  if (colliderRemoveListenerSubscribed2D) return;
  colliderRemoveListenerSubscribed2D = true;
  registerColliderRemoveListener((entity) => {
    for (const backend of registeredBackends2D) {
      backend.removeEntity(entity as unknown as number);
    }
  });
}

/**
 * Register three-phase physics tick systems into an ECS World (2D variant).
 *
 * Mirrors registerPhysicsSystems from physics-rapier3d with 2D adaptations
 * (plan-strategy C-3 symmetry):
 *   - physicsSyncBackend2D:  after propagateTransforms — query (Transform,
 *     RigidBody, Collider) and call RapierPhysicsWorld2D.ensureBody for each.
 *   - physicsStepSimulation2D: after physicsSyncBackend2D — read Time.dt and
 *     call pw.step() with dt-gating.
 *   - physicsWriteback2D: after physicsStepSimulation2D — call
 *     pw.writebackDynamicBodies() and write positions + rotation back to ECS
 *     Transform (2D scalar angle -> quat via quat.fromAxisAngle z-axis).
 *
 * @param world              ECS World instance.
 * @param transformComponent The Transform component schema (from
 *                           @forgeax/engine-runtime, passed by caller to
 *                           avoid adding a runtime dependency to this package).
 */
// ── System name constants (2D suffix avoids SYSTEM_REGISTRY collision with 3D, D-5) ──
const PHYSICS_SYNC_BACKEND_2D = 'physicsSyncBackend2D' as const;
const PHYSICS_STEP_SIMULATION_2D = 'physicsStepSimulation2D' as const;
const PHYSICS_WRITEBACK_2D = 'physicsWriteback2D' as const;

/**
 * Resolve the runtime `Transform` component token from the global ECS
 * registry (M2 — full resource-ification, D-3). Mirrors the 3D variant:
 * physics already depends on `@forgeax/engine-ecs`, so `resolveComponent`
 * introduces no new dependency and replaces the closure-captured
 * `transformComponent` second parameter.
 */
function resolveTransform(): Component | undefined {
  return resolveComponent('Transform');
}

/**
 * `physicsSyncBackend2D` system token (M2 — full resource-ification, D-4).
 *
 * After propagateTransforms — query entities with (Transform, Collider) and
 * call ensureBody for each. `RigidBody` is OPTIONAL: an entity with a Collider
 * but no RigidBody is treated as a STATIC collider (Rapier-native — a collider
 * without a parent body is fixed), matching the Collider docstring and how
 * static level geometry is authored. The 2D suffix keeps the name distinct from
 * the 3D system in the shared SYSTEM_REGISTRY (D-5).
 */
export const PhysicsSyncBackend2D: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_SYNC_BACKEND_2D,
  queries: [],
  labels: ['physics'],
  after: ['propagateTransforms'],
  fn: (world) => {
    const transformComponent = resolveTransform();
    if (transformComponent === undefined) return;
    let pw: RapierPhysicsWorld2D;
    try {
      pw = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
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

      // Local TRS flat stride-N array columns (feat-20260709 M2): pos is
      // array<f32,3> (row i at pos[i*3+a]), quat is array<f32,4> (row i at
      // quat[i*4+a]). Indexed reads only -- zero per-call allocation on this
      // per-frame sync path (AC-08).
      const tfPos = tfCols.get('pos')?.view as Float32Array | undefined;
      const tfQuat = tfCols.get('quat')?.view as Float32Array | undefined;
      const tfScale = tfCols.get('scale')?.view as Float32Array | undefined;
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
        if (useWorldPose && tfWorld) {
          for (let lane = 0; lane < 16; lane++) {
            poseScratchWorld2D[lane] = tfWorld[worldBase + lane] ?? 0;
          }
          mat4.decompose(
            poseScratchPosition2D,
            poseScratchRotation2D,
            poseScratchScale2D,
            poseScratchWorld2D,
          );
        } else {
          poseScratchPosition2D[0] = tfPos[localBase] ?? 0;
          poseScratchPosition2D[1] = tfPos[localBase + 1] ?? 0;
          poseScratchPosition2D[2] = tfPos[localBase + 2] ?? 0;
          poseScratchRotation2D[0] = tfQuat[quatBase] ?? 0;
          poseScratchRotation2D[1] = tfQuat[quatBase + 1] ?? 0;
          poseScratchRotation2D[2] = tfQuat[quatBase + 2] ?? 0;
          poseScratchRotation2D[3] = tfQuat[quatBase + 3] ?? 1;
          poseScratchScale2D[0] = tfScale[localBase] ?? 1;
          poseScratchScale2D[1] = tfScale[localBase + 1] ?? 1;
          poseScratchScale2D[2] = tfScale[localBase + 2] ?? 1;
        }
        const transform: PhysicsTransform2D = {
          position: { x: poseScratchPosition2D[0] ?? 0, y: poseScratchPosition2D[1] ?? 0 },
          rotation: 2 * Math.atan2(poseScratchRotation2D[2] ?? 0, poseScratchRotation2D[3] ?? 1),
          scale: { x: poseScratchScale2D[0] ?? 1, y: poseScratchScale2D[1] ?? 1 },
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
 * `physicsStepSimulation2D` system token (M2 — full resource-ification, D-4).
 *
 * After physicsSyncBackend2D — read Time.dt and call pw.step() with dt-gating.
 */
export const PhysicsStepSimulation2D: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_STEP_SIMULATION_2D,
  queries: [],
  labels: ['physics'],
  after: [PHYSICS_SYNC_BACKEND_2D],
  fn: (world) => {
    let pw: RapierPhysicsWorld2D;
    try {
      pw = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
    } catch {
      return; // C-2: safe early out
    }

    let time: { dt: number } | undefined;
    try {
      time = world.getResource<{ dt: number }>('Time');
    } catch {
      // Time resource not ready — skip
    }

    const dt = time?.dt ?? 0;
    if (dt <= 0 || dt > PHYSICS_DT_MAX) return; // D-4: skip abnormal dt

    pw.step(dt);
  },
});

/**
 * `physicsWriteback2D` system token (M2 — full resource-ification, D-4).
 *
 * After physicsStepSimulation2D — call pw.writebackDynamicBodies() and write
 * positions + rotation back to ECS Transform (resolved via the global
 * registry, D-3; 2D scalar angle -> quat via quat.fromAxisAngle z-axis).
 */
export const PhysicsWriteback2D: SystemHandle<readonly []> = defineSystem({
  name: PHYSICS_WRITEBACK_2D,
  queries: [],
  labels: ['physics'],
  after: [PHYSICS_STEP_SIMULATION_2D],
  fn: (world) => {
    const transformComponent = resolveTransform();
    if (transformComponent === undefined) return;
    let pw: RapierPhysicsWorld2D;
    try {
      pw = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
    } catch {
      return; // C-2: safe early out
    }

    const results = pw.writebackDynamicBodies();
    for (const r of results) {
      const entity = r.entity as EntityHandle;
      // D-5 2D variant: pos from {x,y}, rotation from scalar angle -> quat
      const outQuat = quat.create();
      // biome-ignore lint/suspicious/noExplicitAny: quat accepts Vec3 array
      quat.fromAxisAngle(outQuat, [0, 0, 1] as any as Vec3Like, r.rotation);
      world.set(entity, transformComponent, {
        pos: [r.pos.x, r.pos.y, readTransformPosZ(world, entity, transformComponent)],
        // Component order [x, y, z, w] (E6). `?? 0/1` narrows the
        // noUncheckedIndexedAccess undefined out of the quat elements.
        quat: [outQuat[0] ?? 0, outQuat[1] ?? 0, outQuat[2] ?? 0, outQuat[3] ?? 1],
      });
    }
  },
});

/**
 * Register three-phase physics tick systems into an ECS World (2D variant).
 *
 * Mirrors registerPhysicsSystems from physics-rapier3d with 2D adaptations
 * (plan-strategy C-3 symmetry). The three systems
 * ({@link PhysicsSyncBackend2D} / {@link PhysicsStepSimulation2D} /
 * {@link PhysicsWriteback2D}) are module-level `defineSystem` tokens; this
 * helper wires the moveAndSlide context + despawn cleanup hook, then adds the
 * three tokens to the schedule.
 *
 * Transform is resolved from the global ECS registry (`resolveComponent`,
 * D-3) — the previous `transformComponent` second parameter is gone.
 *
 * @param world ECS World instance.
 */
export function registerPhysicsSystems2D(world: World): void {
  // ── moveAndSlide context + despawn cleanup wiring (D-1/D-3) ──
  // Wire the World + Transform/CharacterController components into the backend
  // so moveAndSlide can read tuning and write pose/grounded back, and register
  // the backend for the global Collider.onRemove dispatch (despawn cleanup).
  const transformComponent = resolveTransform();
  try {
    const pw = world.getResource<RapierPhysicsWorld2D>('PhysicsWorld');
    if (transformComponent !== undefined) {
      pw.setMoveContext(world, transformComponent, CharacterController);
    }
    registerBackendForRemoveHook2D(pw);
  } catch {
    // PhysicsWorld resource not yet inserted — moveAndSlide falls back to
    // CharacterController schema defaults until a later registration wires it.
  }

  world.addSystem(PhysicsSyncBackend2D);
  world.addSystem(PhysicsStepSimulation2D);
  world.addSystem(PhysicsWriteback2D);
}
