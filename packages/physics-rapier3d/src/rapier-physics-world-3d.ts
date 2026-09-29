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
import { createStateProjection, type StateProjection } from '@forgeax/engine-ecs/projection';
import { mat4, quat, type Vec3, vec3 } from '@forgeax/engine-math';
import {
  CharacterController,
  Collider,
  CollidingEntities,
  cloneDerivedPhysicsInput,
  colliderShapeFromF32,
  DERIVED_PHYSICS_LIMITS,
  type DerivedPhysicsCandidate,
  type DerivedPhysicsCandidateInput,
  type DerivedPhysicsCandidateState,
  DerivedPhysicsError,
  type DerivedPhysicsFailure,
  type DerivedPhysicsMotion,
  type DerivedPhysicsPublication,
  type DerivedPhysicsSnapshot,
  type DerivedShapeSeamInput,
  type DerivedShapeState,
  estimateDerivedPhysicsInputBytes,
  PHYSICS_ERROR_HINTS,
  type PhysicsConstraintInput,
  type PhysicsContactObservation,
  PhysicsError,
  type PhysicsMassProperties,
  type PhysicsQuaternion,
  PhysicsSet,
  type PhysicsVector,
  type PhysicsWorld,
  preserveCenterOfMassVelocity,
  type RaycastHit,
  RIGID_BODY_TYPE_STATIC,
  RigidBody,
  registerPhysicsComponents,
  rigidBodyTypeFromF32,
  type VoxelShapeInput,
  validateMassProperties,
} from '@forgeax/engine-physics';
import { ChildOf } from '@forgeax/engine-scene';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { Rapier3DModule } from './wasm-loader.js';

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
  /** Authored additional mass used to restore automatic derived policy. */
  additionalMass: number;
  /** Additional mass currently applied to Rapier's automatic mass policy. */
  automaticAdditionalMass: number;
  /** Base collider density before an explicit derived mass override. */
  authoredDensity: number | undefined;
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
  readonly globalTransformComponent: Component;
  readonly queries: readonly PhysicsSyncQuery[];
  readonly projection: StateProjection;
  readonly accepted: Map<number, PhysicsSyncDescriptor>;
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
  readonly collider: PhysicsCollider3D | undefined;
  readonly hasCharacterController: boolean;
  readonly characterControllerOffset: number | undefined;
}

interface PhysicsEntityDelta {
  transformChanged: boolean;
  colliderChanged: boolean;
  rigidBodyChanged: boolean;
  characterControllerChanged: boolean;
  characterControllerStructureChanged: boolean;
}

function samePhysicsValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === undefined ||
    right === undefined ||
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  )
    return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((key) => samePhysicsValue(a[key], b[key]))
  );
}

export interface Rapier3DCollisionEvent {
  readonly type: 'started' | 'stopped';
  readonly entityA: number;
  readonly entityB: number;
  readonly fixedStep?: number;
  readonly shapeA?: string;
  readonly shapeB?: string;
}

interface DerivedShapeRecord {
  readonly input: VoxelShapeInput & {
    readonly cells: Int32Array;
    readonly origin: PhysicsVector;
    readonly rotation: PhysicsQuaternion;
  };
  readonly colliderHandle: number;
}

interface DerivedBodyRecord {
  readonly entity: number;
  readonly sourceKey: string;
  readonly generation: number;
  readonly revision: number;
  readonly bodyType: 'static' | 'dynamic' | 'kinematic' | undefined;
  readonly velocityPolicy: 'preserve' | 'reset' | undefined;
  readonly candidateId: string;
  readonly shapes: readonly DerivedShapeRecord[];
  readonly seams: readonly DerivedShapeSeamInput[];
  readonly massProperties: PhysicsMassProperties | undefined;
  readonly constraints: readonly PhysicsConstraintInput[];
}

interface DerivedCandidateRecord {
  token: DerivedPhysicsCandidate;
  readonly nativeColliders: readonly { readonly handle: number }[];
  readonly input: DerivedPhysicsCandidateInput;
  readonly bytes: number;
  state: DerivedPhysicsCandidateState;
  commitGeometry?: () => Result<void, Error>;
  batch?: DerivedAdmissionBatch;
}

interface DerivedAdmissionBatch {
  readonly records: readonly DerivedCandidateRecord[];
  readonly commitGeometry?: () => Result<void, Error>;
}

interface DerivedConstraintRecord {
  readonly input: PhysicsConstraintInput;
  readonly handle: number;
}

interface DerivedBodySource {
  readonly sourceKey: string;
  readonly revision: number;
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
function rapierBodyTypeToString(
  rapier: { readonly RigidBodyType: { readonly Dynamic: number; readonly Fixed: number } },
  bodyType: number,
): 'static' | 'dynamic' | 'kinematic' {
  if (bodyType === rapier.RigidBodyType.Dynamic) return 'dynamic';
  if (bodyType === rapier.RigidBodyType.Fixed) return 'static';
  return 'kinematic';
}

function validateConstraintInput(
  input: PhysicsConstraintInput,
): Result<PhysicsConstraintInput, DerivedPhysicsError> {
  const finiteVector = (value: readonly number[]): boolean =>
    value.length === 3 && value.every(Number.isFinite);
  if (
    typeof input.id !== 'string' ||
    input.id.trim().length === 0 ||
    !Number.isInteger(input.revision) ||
    input.revision < 0 ||
    !Number.isInteger(input.bodyA) ||
    !Number.isInteger(input.bodyB) ||
    input.bodyA === input.bodyB ||
    !finiteVector(input.anchorA) ||
    !finiteVector(input.anchorB)
  ) {
    return err(
      new DerivedPhysicsError(
        'derived-constraint-invalid',
        'constraint identity, revision, endpoint bodies, and anchors are valid',
        'supply two distinct live bodies and finite local anchors',
        { constraintId: input.id },
      ),
    );
  }
  if (input.kind === 'spring') {
    if (
      !Number.isFinite(input.restLength) ||
      input.restLength < 0 ||
      !Number.isFinite(input.stiffness) ||
      input.stiffness < 0 ||
      !Number.isFinite(input.damping) ||
      input.damping < 0
    ) {
      return err(
        new DerivedPhysicsError(
          'derived-constraint-invalid',
          'spring rest length, stiffness, and damping are finite and non-negative',
          'repair spring tuning before native creation',
          { constraintId: input.id },
        ),
      );
    }
  } else if (
    !finiteVector(input.axis) ||
    Math.hypot(input.axis[0], input.axis[1], input.axis[2]) < 1e-6 ||
    (input.limits !== undefined &&
      (!Number.isFinite(input.limits[0]) ||
        !Number.isFinite(input.limits[1]) ||
        input.limits[0] > input.limits[1]))
  ) {
    return err(
      new DerivedPhysicsError(
        'derived-constraint-invalid',
        'hinge axis is non-zero and optional limits are ordered finite values',
        'normalize the hinge axis and set minLimit <= maxLimit',
        { constraintId: input.id },
      ),
    );
  }
  return ok(input);
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

  /**
   * Entities whose dynamic pose is written back at the next writeback even if
   * Rapier no longer reports them active: bodies awake at the previous
   * writeback (their final pose before sleeping), newly registered bodies, and
   * dynamic bodies whose ECS Transform was overwritten (Rapier owns that pose).
   */
  private poseWritebackEntities = new Set<number>();
  private activeWritebackEntities = new Set<number>();

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

  /** One backend owns every derived shape; these maps are not a second world. */
  private readonly derivedBodies = new Map<number, DerivedBodyRecord>();
  private readonly derivedCandidates = new Map<string, DerivedCandidateRecord>();
  private readonly pendingDerivedCandidates = new Set<string>();
  private readonly retiredDerivedBodies: DerivedBodyRecord[] = [];
  private readonly derivedColliderToShape = new Map<number, { entity: number; id: string }>();
  private readonly derivedConstraints = new Map<string, DerivedConstraintRecord>();
  private readonly derivedBodySources = new Map<number, DerivedBodySource>();
  private readonly derivedPublications = new Map<number, DerivedPhysicsPublication>();
  private readonly derivedFailures = new Map<number, DerivedPhysicsFailure>();
  private readonly derivedContacts: PhysicsContactObservation[] = [];
  private readonly derivedPoisonedEntities = new Set<number>();
  private readonly physicsOwner = {};
  private candidateSequence = 0;
  private derivedCandidateBytes = 0;
  private backendGeneration = 1;
  private fixedStep = 0;
  private derivedPublicationPending = false;
  private worldIdentity: object | undefined;
  private activeDerivedAdmission: DerivedCandidateRecord | undefined;

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
    if (this.recoveryBlocked()) {
      throw new DerivedPhysicsError(
        'derived-recovery-invalid',
        'raycasts observe a complete healthy physics state',
        'rebuild the PhysicsWorld before querying after an unrecoverable admission',
        {},
      );
    }
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
    if (!Number.isFinite(deltaTime) || deltaTime <= 0 || deltaTime > PHYSICS_DT_MAX) return;
    try {
      // Native integration must consume the same fixed delta as force controllers.
      (this.raw as { timestep: number }).timestep = deltaTime;
      this.processDerivedCandidates();
      // A failed native rollback is an explicit rebuild boundary. Physics does
      // not advance or publish a mixed state after this point.
      if (this.derivedPoisonedEntities.size > 0) return;
      // biome-ignore lint/suspicious/noExplicitAny: Rapier World.step
      (this.raw as any).step(this.eventQueue);
      this.fixedStep = this.syncState?.world.getResource(FixedTime).tick ?? this.fixedStep + 1;
      this.drainRapierCollisionEvents();
      this.derivedPublicationPending = true;
      // Direct PhysicsWorld consumers do not have ECS writeback systems. Keep
      // that public path useful while ECS-bound worlds finalize after writeback
      // and collision component synchronization below.
      if (this.syncState === undefined) this.finalizeDerivedFixedStep();
    } catch (cause) {
      // A native step or contact drain may have advanced before throwing.
      // Geometry may already be committed; neither domain can claim LKG.
      const error = new DerivedPhysicsError(
        'derived-backend-failed',
        'native fixed-step execution and publication complete together',
        'rebuild the World and PhysicsWorld from the last committed snapshot',
        { reason: cause instanceof Error ? cause.message : String(cause) },
      );
      for (const entity of this.entityMap.keys()) this.derivedPoisonedEntities.add(entity);
      this.derivedPublicationPending = false;
      this.derivedPublications.clear();
      for (const record of this.derivedCandidates.values()) {
        this.rememberDerivedFailure(record, error, 'rebuild-required');
      }
      throw error;
    }
  }

  /** Publish only after the fixed-step ECS writeback/contact boundary. */
  finalizeDerivedFixedStep(): void {
    if (!this.derivedPublicationPending) return;
    this.derivedPublicationPending = false;
    if (this.derivedPoisonedEntities.size > 0) return;
    this.publishDerivedCandidates();
    this.retireDerivedBodies();
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
      const shapeA = this.derivedColliderToShape.get(handle1);
      const shapeB = this.derivedColliderToShape.get(handle2);
      this.recordContactObservation(
        {
          phase: started ? 'started' : 'stopped',
          fixedStep: this.fixedStep,
          entityA: a,
          entityB: b,
          ...(shapeA === undefined ? {} : { shapeA: shapeA.id }),
          ...(shapeB === undefined ? {} : { shapeB: shapeB.id }),
        },
        handle1,
        handle2,
      );
      const changed = started ? this.addPair(a, b) : this.removePair(a, b);
      if (!changed) return;
      this.pushCollisionEvent({
        type: started ? 'started' : 'stopped',
        entityA: a,
        entityB: b,
        fixedStep: this.fixedStep,
        ...(shapeA === undefined ? {} : { shapeA: shapeA.id }),
        ...(shapeB === undefined ? {} : { shapeB: shapeB.id }),
      });
    });
  }

  private recordContactObservation(
    observation: PhysicsContactObservation,
    handleA: number,
    handleB: number,
  ): void {
    let point: PhysicsVector | undefined;
    let normal: PhysicsVector | undefined;
    let geometricPoint: PhysicsVector | undefined;
    let geometricNormal: PhysicsVector | undefined;
    try {
      const colliderA = (this.raw as RapierWorld).getCollider(handleA);
      const colliderB = (this.raw as RapierWorld).getCollider(handleB);
      if (colliderA !== null && colliderB !== null) {
        (this.raw as RapierWorld).contactPair(
          colliderA,
          colliderB,
          (manifold: RapierWorld, flipped: boolean) => {
            // A contact manifold can retain geometric points without solver
            // points. Composite local points are subshape-local, so only
            // transform points from the ordinary primitive collider surface.
            if (
              manifold.numSolverContacts() === 0 &&
              geometricPoint === undefined &&
              manifold.numContacts() > 0
            ) {
              const first = flipped ? colliderB : colliderA;
              const second = flipped ? colliderA : colliderB;
              const types = this.rapierModule.ShapeType;
              for (const [collider, local] of [
                [first, manifold.localContactPoint1(0)],
                [second, manifold.localContactPoint2(0)],
              ]) {
                if (
                  local == null ||
                  ![types.Ball, types.Cuboid, types.Capsule].includes(collider.shapeType())
                )
                  continue;
                const rotation = collider.rotation();
                const rotated = quat.transformVec3(
                  vec3.create(),
                  [rotation.x, rotation.y, rotation.z, rotation.w],
                  [local.x, local.y, local.z],
                );
                const position = collider.translation();
                geometricPoint = [
                  rotated[0] + position.x,
                  rotated[1] + position.y,
                  rotated[2] + position.z,
                ];
                const n = manifold.normal();
                const direction = flipped ? -1 : 1;
                geometricNormal = [n.x * direction, n.y * direction, n.z * direction];
                break;
              }
            }
            if (manifold.numSolverContacts?.() > 0) {
              const contact = manifold.solverContactPoint(0);
              const n = manifold.normal();
              if (contact !== null && contact !== undefined) {
                point = [contact.x, contact.y, contact.z];
              }
              if (n !== null && n !== undefined) {
                const direction = flipped ? -1 : 1;
                normal = [n.x * direction, n.y * direction, n.z * direction];
              }
            }
          },
        );
      }
    } catch {
      // Contact events remain useful without optional manifold sampling. The
      // public type makes point/normal optional rather than inventing values.
    }
    if (point === undefined && geometricPoint !== undefined) {
      point = geometricPoint;
      normal = geometricNormal;
    }
    this.derivedContacts.push({
      ...observation,
      ...(point === undefined ? {} : { point }),
      ...(normal === undefined ? {} : { normal }),
    });
    if (this.derivedContacts.length > 256)
      this.derivedContacts.splice(0, this.derivedContacts.length - 256);
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

  private bodiesShareCollision(entityA: number, entityB: number): boolean {
    const bodyA = this.bodyForEntity(entityA);
    const bodyB = this.bodyForEntity(entityB);
    if (bodyA === undefined || bodyB === undefined) return false;
    const raw = this.raw as RapierWorld;
    for (const colliderA of this.bodyColliders(bodyA)) {
      for (const colliderB of this.bodyColliders(bodyB)) {
        if (raw.intersectionPair(colliderA, colliderB)) return true;
        let hasContact = false;
        raw.contactPair(colliderA, colliderB, () => {
          hasContact = true;
        });
        if (hasContact) return true;
      }
    }
    return false;
  }

  private retireRemovedColliderPairs(entity: number): void {
    for (const other of [...(this.collisionPairs.get(entity) ?? [])]) {
      if (this.bodiesShareCollision(entity, other)) continue;
      if (this.removePair(entity, other)) {
        this.pushCollisionEvent({ type: 'stopped', entityA: entity, entityB: other });
      }
    }
  }

  private pushCollisionEvent(event: Rapier3DCollisionEvent): void {
    const ordered =
      event.entityA <= event.entityB
        ? event
        : {
            type: event.type,
            entityA: event.entityB,
            entityB: event.entityA,
            ...(event.fixedStep === undefined ? {} : { fixedStep: event.fixedStep }),
            ...(event.shapeB === undefined ? {} : { shapeA: event.shapeB }),
            ...(event.shapeA === undefined ? {} : { shapeB: event.shapeA }),
          };
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
      if (!world.hasComponent(handle, collidingComponent)) continue;
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

  /** Detached fixed-step contact facts; no Rapier manifolds or handles escape. */
  getContactObservations(): readonly PhysicsContactObservation[] {
    if (this.recoveryBlocked()) return [];
    return this.derivedContacts.map((contact) => ({
      ...contact,
      ...(contact.point === undefined ? {} : { point: [...contact.point] as PhysicsVector }),
      ...(contact.normal === undefined ? {} : { normal: [...contact.normal] as PhysicsVector }),
    }));
  }

  /** Prepare disabled native Voxels for one entity without changing queries. */
  prepareDerivedShapeCandidate(
    input: DerivedPhysicsCandidateInput,
  ): ReturnType<NonNullable<PhysicsWorld['prepareDerivedShapeCandidate']>> {
    this.assertActive('prepareDerivedShapeCandidate');
    if (input.worldIdentity !== undefined && input.worldIdentity !== this.worldIdentity) {
      return err(
        new DerivedPhysicsError(
          'derived-world-mismatch',
          'candidate belongs to the ECS World bound to this PhysicsWorld',
          'submit the candidate to the PhysicsWorld that owns its entity',
          { entity: input.entity },
        ),
      );
    }
    if (!this.entityMap.has(input.entity)) {
      return err(
        new DerivedPhysicsError(
          'derived-body-not-found',
          'candidate entity has a committed body in this PhysicsWorld',
          'wait for physics reconciliation before preparing derived shapes',
          { entity: input.entity },
        ),
      );
    }
    if (this.derivedPoisonedEntities.has(input.entity)) {
      return err(
        new DerivedPhysicsError(
          'derived-recovery-invalid',
          'the entity has a recoverable committed native PhysicsWorld state',
          'rebuild the PhysicsWorld from the last portable snapshot before retrying',
          { entity: input.entity },
        ),
      );
    }
    const active = this.derivedBodies.get(input.entity);
    if (active !== undefined && input.revision <= active.revision) {
      return err(
        new DerivedPhysicsError(
          'derived-candidate-stale',
          'candidate revision is newer than the committed derived shape revision',
          'read the latest publication and advance the consumer revision',
          { entity: input.entity, actual: input.revision, expected: `>${active.revision}` },
        ),
      );
    }
    for (const pendingId of this.pendingDerivedCandidates) {
      const pending = this.derivedCandidates.get(pendingId);
      if (pending?.input.entity === input.entity) {
        return err(
          new DerivedPhysicsError(
            'derived-candidate-pending',
            'one body has at most one queued derived-shape candidate',
            'cancel or let the current candidate publish before preparing another',
            { entity: input.entity, candidateId: pendingId },
          ),
        );
      }
    }
    const copied = cloneDerivedPhysicsInput(input);
    if (!copied.ok) return copied;
    const mass = validateMassProperties(copied.value.massProperties);
    if (!mass.ok) return mass;
    const body = this.bodyForEntity(input.entity);
    if (body === undefined) {
      return err(
        new DerivedPhysicsError(
          'derived-body-not-found',
          'candidate entity resolves to a live native body',
          'wait for the next ECS physics sync',
          { entity: input.entity },
        ),
      );
    }
    if (this.derivedCandidates.size >= DERIVED_PHYSICS_LIMITS.maxCandidates) {
      return err(
        new DerivedPhysicsError(
          'derived-candidate-budget-exceeded',
          `this PhysicsWorld keeps at most ${DERIVED_PHYSICS_LIMITS.maxCandidates} candidates`,
          'cancel or publish an existing candidate before preparing another',
          { entity: input.entity, actual: this.derivedCandidates.size, reason: 'in-flight' },
        ),
      );
    }
    const candidateInput = Object.freeze({
      ...copied.value,
      ...(mass.value === undefined ? {} : { massProperties: mass.value }),
    });
    // Keep the public token's copied POD separate from the private record. A
    // readonly typed-array field is still writable at runtime; admission must
    // never consume caller mutations made after prepare() returned.
    const privateInput = cloneDerivedPhysicsInput(candidateInput);
    if (!privateInput.ok) return privateInput;
    const publicInput = cloneDerivedPhysicsInput(privateInput.value);
    if (!publicInput.ok) return publicInput;
    const nativeColliders: { handle: number }[] = [];
    try {
      for (const shape of privateInput.value.shapes) {
        const collider = this.createDerivedCollider(body, shape);
        nativeColliders.push({ handle: collider.handle });
      }
    } catch (cause) {
      for (const collider of nativeColliders) this.removeNativeCollider(collider.handle);
      return err(
        new DerivedPhysicsError(
          'derived-backend-failed',
          'Rapier can create every candidate voxel collider while it remains disabled',
          'reduce the candidate or rebuild the PhysicsWorld after a native failure',
          { entity: input.entity, reason: cause instanceof Error ? cause.message : String(cause) },
        ),
      );
    }
    const candidateBytes = estimateDerivedPhysicsInputBytes(privateInput.value);
    if (this.derivedCandidateBytes + candidateBytes > DERIVED_PHYSICS_LIMITS.maxCandidateBytes) {
      for (const collider of nativeColliders) this.removeNativeCollider(collider.handle);
      return err(
        new DerivedPhysicsError(
          'derived-candidate-budget-exceeded',
          `staged candidate bytes remain within ${DERIVED_PHYSICS_LIMITS.maxCandidateBytes}`,
          'cancel or retire an in-flight candidate before retrying',
          {
            entity: input.entity,
            actual: this.derivedCandidateBytes + candidateBytes,
            reason:
              candidateBytes > DERIVED_PHYSICS_LIMITS.maxCandidateBytes ? 'oversized' : 'in-flight',
          },
        ),
      );
    }
    const candidateId = `derived:${this.backendGeneration}:${input.entity}:${++this.candidateSequence}:${input.revision}`;
    const token: DerivedPhysicsCandidate = Object.freeze({
      candidateId,
      generation: this.backendGeneration,
      owner: this.physicsOwner,
      input: publicInput.value,
      state: 'ready',
    });
    this.derivedCandidates.set(candidateId, {
      token,
      nativeColliders,
      input: privateInput.value,
      bytes: candidateBytes,
      state: 'ready',
    });
    this.derivedCandidateBytes += candidateBytes;
    return ok(token);
  }

  /** Queue a prepared candidate for the next call to `step()`. */
  admitDerivedShapeCandidate(
    candidate: DerivedPhysicsCandidate,
    commitGeometry?: () => Result<void, Error>,
  ): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidate']>> {
    const admitted = this.admitDerivedShapeCandidateInternal(candidate);
    if (admitted.ok && commitGeometry !== undefined) {
      const record = this.derivedCandidates.get(candidate.candidateId);
      if (record !== undefined) record.commitGeometry = commitGeometry;
    }
    return admitted;
  }

  admitDerivedShapeCandidates(
    candidates: readonly DerivedPhysicsCandidate[],
    commitGeometry?: () => Result<void, Error>,
  ): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidates']>> {
    this.assertActive('admitDerivedShapeCandidates');
    const records: DerivedCandidateRecord[] = [];
    const sources = new Map<number, DerivedBodySource>();
    const constraints = new Set<string>();
    const invalid = (reason: string) =>
      new DerivedPhysicsError(
        'derived-candidate-invalid',
        'one bounded admission contains distinct prepared bodies and constraint updates',
        'prepare one candidate per body and submit the complete replacement together',
        { reason },
      );
    if (candidates.length === 0 || candidates.length > DERIVED_PHYSICS_LIMITS.maxCandidates)
      return err(invalid('invalid batch size'));
    // Resolve credentials before mutating the queue. Never use caller input as
    // the source projection or invalidate another owner's matching token ID.
    for (const candidate of candidates) {
      const record = this.derivedCandidates.get(candidate.candidateId);
      if (
        record === undefined ||
        candidate.owner !== this.physicsOwner ||
        candidate.generation !== this.backendGeneration ||
        record.state !== 'ready'
      )
        return err(invalid('batch member is not a current prepared candidate'));
      if (sources.has(record.input.entity)) return err(invalid('duplicate body'));
      for (const constraint of record.input.constraints ?? []) {
        if (constraints.has(constraint.id)) return err(invalid('duplicate constraint update'));
        constraints.add(constraint.id);
      }
      records.push(record);
      sources.set(record.input.entity, {
        sourceKey: record.input.sourceKey,
        revision: record.input.revision,
      });
    }
    for (const candidate of candidates) {
      const checked = this.admitDerivedShapeCandidateInternal(candidate, sources, true);
      if (!checked.ok) {
        for (const record of records) {
          if (this.derivedCandidates.has(record.token.candidateId))
            this.rejectPreparedCandidate(record, checked.error);
        }
        return checked;
      }
    }
    const batch: DerivedAdmissionBatch = Object.freeze({
      records: Object.freeze(records),
      ...(commitGeometry === undefined ? {} : { commitGeometry }),
    });
    for (const record of records) record.batch = batch;
    const queued: DerivedPhysicsCandidate[] = [];
    for (const candidate of candidates) {
      const admitted = this.admitDerivedShapeCandidateInternal(candidate, sources);
      if (!admitted.ok) {
        const first = records[0];
        if (first !== undefined) this.rejectPreparedCandidate(first, admitted.error);
        return admitted;
      }
      queued.push(admitted.value);
    }
    return ok(Object.freeze(queued));
  }

  getDerivedAdmission(
    entity?: number,
  ):
    | { readonly entity: number; readonly revision: number; readonly fixedStep: number }
    | undefined {
    const active = this.activeDerivedAdmission;
    const record =
      entity === undefined
        ? active
        : (active?.batch?.records.find((item) => item.input.entity === entity) ??
          (active?.input.entity === entity ? active : undefined));
    if (record === undefined) return undefined;
    return {
      entity: record.input.entity,
      revision: record.input.revision,
      fixedStep: this.syncState?.world.getResource(FixedTime).tick ?? this.fixedStep + 1,
    };
  }

  private admitDerivedShapeCandidateInternal(
    candidate: DerivedPhysicsCandidate,
    sourceOverrides?: ReadonlyMap<number, DerivedBodySource>,
    validateOnly = false,
  ): ReturnType<NonNullable<PhysicsWorld['admitDerivedShapeCandidate']>> {
    this.assertActive('admitDerivedShapeCandidate');
    const record = this.derivedCandidates.get(candidate.candidateId);
    if (
      record === undefined ||
      candidate.owner !== this.physicsOwner ||
      record.token.owner !== candidate.owner ||
      candidate.generation !== this.backendGeneration
    ) {
      return err(
        new DerivedPhysicsError(
          'derived-candidate-not-found',
          'candidate belongs to the current PhysicsWorld generation',
          'discard stale candidate credentials and prepare from committed input again',
          { candidateId: candidate.candidateId },
        ),
      );
    }
    if (this.derivedPoisonedEntities.has(record?.input.entity ?? -1)) {
      return err(
        new DerivedPhysicsError(
          'derived-recovery-invalid',
          'the candidate entity is stopped after an unrecoverable native admission failure',
          'rebuild the PhysicsWorld from its portable snapshot before retrying',
          { entity: record?.input.entity, candidateId: candidate.candidateId },
        ),
      );
    }
    if (record.state === 'cancelled' || record.state === 'invalidated') {
      return err(
        new DerivedPhysicsError(
          'derived-candidate-cancelled',
          'candidate has not been cancelled or invalidated',
          'prepare a new candidate from the latest committed revision',
          { candidateId: candidate.candidateId },
        ),
      );
    }
    if (record.state !== 'ready') {
      return err(
        new DerivedPhysicsError(
          'derived-candidate-pending',
          'a prepared candidate is admitted at most once',
          'retain the returned queued receipt and wait for fixed-step publication',
          { candidateId: candidate.candidateId },
        ),
      );
    }
    const pendingSources = this.pendingDerivedSources();
    if (sourceOverrides !== undefined) {
      for (const [entity, source] of sourceOverrides) pendingSources.set(entity, source);
    }
    pendingSources.set(record.input.entity, {
      sourceKey: record.input.sourceKey,
      revision: record.input.revision,
    });
    const admissionError = this.validateDerivedAdmission(record.input, pendingSources);
    if (admissionError !== undefined) {
      this.rejectPreparedCandidate(record, admissionError);
      return err(admissionError);
    }
    const active = this.derivedBodies.get(record.input.entity);
    if (active !== undefined && record.input.revision <= active.revision) {
      const stale = new DerivedPhysicsError(
        'derived-candidate-stale',
        'candidate revision is newer than the committed shape revision',
        'advance the consumer revision before admission',
        { entity: record.input.entity, candidateId: candidate.candidateId },
      );
      this.rejectPreparedCandidate(record, stale);
      return err(stale);
    }
    const newestPendingRevision = this.newestPendingRevision(record.input.entity);
    if (newestPendingRevision !== undefined && record.input.revision <= newestPendingRevision) {
      const stale = new DerivedPhysicsError(
        'derived-candidate-stale',
        'candidate revision advances every already queued revision for the body',
        'admit only the newest body revision at a fixed-step boundary',
        {
          entity: record.input.entity,
          candidateId: candidate.candidateId,
          expected: `>${newestPendingRevision}`,
          actual: record.input.revision,
        },
      );
      this.rejectPreparedCandidate(record, stale);
      return err(stale);
    }
    if (validateOnly) return ok(record.token);
    record.state = 'queued';
    this.pendingDerivedCandidates.add(candidate.candidateId);
    const queued = Object.freeze({ ...record.token, state: 'queued' as const });
    record.token = queued;
    // Revalidate the complete queued dependency projection after every
    // admission.  A dependent candidate may have been queued before a newer
    // endpoint revision arrived; allowing it to survive until process() would
    // make the result depend on queue order and could silently bind the old
    // endpoint source.
    let changed = true;
    while (changed) {
      changed = false;
      const projectedSources = new Map(sourceOverrides ?? []);
      for (const [entity, source] of this.pendingDerivedSources()) {
        const current = projectedSources.get(entity);
        if (current === undefined || source.revision > current.revision)
          projectedSources.set(entity, source);
      }
      for (const queuedId of [...this.pendingDerivedCandidates]) {
        const queuedRecord = this.derivedCandidates.get(queuedId);
        if (queuedRecord?.state !== 'queued') continue;
        const projected = projectedSources.get(queuedRecord.input.entity);
        const staleRevision =
          projected !== undefined && queuedRecord.input.revision < projected.revision;
        const dependencyError = staleRevision
          ? new DerivedPhysicsError(
              'derived-candidate-stale',
              'queued candidates publish only the final revision submitted for an entity',
              'discard the older queued candidate and submit one complete revision',
              {
                entity: queuedRecord.input.entity,
                candidateId: queuedRecord.token.candidateId,
                expected: `>=${projected.revision}`,
                actual: queuedRecord.input.revision,
              },
            )
          : this.validateDerivedAdmission(queuedRecord.input, projectedSources);
        if (dependencyError === undefined) continue;
        this.rejectPreparedCandidate(queuedRecord, dependencyError);
        changed = true;
        if (queuedId === candidate.candidateId) return err(dependencyError);
      }
    }
    return ok(queued);
  }

  /** Cancel candidate-native resources; the committed state remains untouched. */
  cancelDerivedShapeCandidate(
    candidate: DerivedPhysicsCandidate,
  ): ReturnType<NonNullable<PhysicsWorld['cancelDerivedShapeCandidate']>> {
    this.assertActive('cancelDerivedShapeCandidate');
    const record = this.derivedCandidates.get(candidate.candidateId);
    if (record === undefined || candidate.owner !== this.physicsOwner) {
      if (
        candidate.owner === this.physicsOwner &&
        [...this.derivedBodies.values()].some((body) => body.candidateId === candidate.candidateId)
      ) {
        return err(
          new DerivedPhysicsError(
            'derived-candidate-cancelled',
            'a published candidate remains the committed result until replaced',
            'submit a newer candidate instead of cancelling committed state',
            { candidateId: candidate.candidateId },
          ),
        );
      }
      return err(
        new DerivedPhysicsError(
          'derived-candidate-not-found',
          'candidate belongs to the current PhysicsWorld',
          'ignore already-retired credentials and prepare again when needed',
          { candidateId: candidate.candidateId },
        ),
      );
    }
    for (const member of record.batch?.records ?? [record]) {
      this.pendingDerivedCandidates.delete(member.token.candidateId);
      for (const collider of member.nativeColliders) this.removeNativeCollider(collider.handle);
      member.state = 'cancelled';
      this.releaseDerivedCandidate(member.token.candidateId);
    }
    return ok(undefined);
  }

  /** Reject all in-flight derived work while preserving the last publication. */
  invalidateDerivedShapeCandidates(reason = 'consumer-invalidated'): void {
    const committedCandidateIds = new Set(
      [...this.derivedBodies.values()].map((body) => body.candidateId),
    );
    for (const [id, record] of this.derivedCandidates) {
      if (record.state === 'published' || committedCandidateIds.has(id)) continue;
      record.state = 'invalidated';
      for (const collider of record.nativeColliders) this.removeNativeCollider(collider.handle);
      this.releaseDerivedCandidate(id);
    }
    this.pendingDerivedCandidates.clear();
    void reason;
  }

  getDerivedPublication(entity: number): DerivedPhysicsPublication | undefined {
    this.assertActive('getDerivedPublication');
    if (this.recoveryBlocked()) return undefined;
    const publication = this.derivedPublications.get(entity);
    return publication === undefined
      ? undefined
      : { ...publication, shapeIds: [...publication.shapeIds] };
  }

  getDerivedFailure(entity: number): DerivedPhysicsFailure | undefined {
    const failure = this.derivedFailures.get(entity);
    return failure === undefined ? undefined : { ...failure };
  }

  getDerivedBodyType(entity: number): 'static' | 'dynamic' | 'kinematic' | undefined {
    this.assertActive('getDerivedBodyType');
    if (this.recoveryBlocked()) return undefined;
    const body = this.bodyForEntity(entity);
    if (body === undefined) return undefined;
    return rapierBodyTypeToString(this.rapierModule, body.bodyType());
  }

  getDerivedBodyMass(entity: number): number | undefined {
    this.assertActive('getDerivedBodyMass');
    if (this.recoveryBlocked()) return undefined;
    const body = this.bodyForEntity(entity);
    return body === undefined ? undefined : body.mass();
  }

  getDerivedMotion(entity: number): DerivedPhysicsMotion | undefined {
    this.assertActive('getDerivedMotion');
    if (this.recoveryBlocked() || !this.derivedBodies.has(entity)) return undefined;
    const body = this.bodyForEntity(entity);
    if (body === undefined) return undefined;
    const com = body.worldCom();
    const linear = body.linvel();
    const angular = body.angvel();
    const rotation = body.rotation();
    return Object.freeze({
      centerOfMass: [com.x, com.y, com.z] as PhysicsVector,
      linearVelocity: [linear.x, linear.y, linear.z] as PhysicsVector,
      angularVelocity: [angular.x, angular.y, angular.z] as PhysicsVector,
      rotation: [rotation.x, rotation.y, rotation.z, rotation.w] as PhysicsQuaternion,
    });
  }

  applyDerivedImpulse(
    input: Parameters<NonNullable<PhysicsWorld['applyDerivedImpulse']>>[0],
  ): Result<void, DerivedPhysicsError> {
    this.assertActive('applyDerivedImpulse');
    const refuse = (code: DerivedPhysicsError['code'], expected: string) =>
      err(
        new DerivedPhysicsError(
          code,
          expected,
          'read the committed dynamic body and submit a finite impulse outside pending admission',
          { entity: input.entity },
        ),
      );
    if (this.recoveryBlocked())
      return refuse('derived-recovery-invalid', 'PhysicsWorld is healthy');
    const record = this.derivedBodies.get(input.entity);
    const body = this.bodyForEntity(input.entity);
    if (record === undefined || body === undefined)
      return refuse('derived-body-not-found', 'a committed derived body exists');
    if (record.sourceKey !== input.sourceKey || record.revision !== input.revision)
      return refuse(
        'derived-candidate-stale',
        'impulse identity matches the committed body revision',
      );
    if (
      this.derivedPublicationPending ||
      [...this.pendingDerivedCandidates].some(
        (id) => this.derivedCandidates.get(id)?.input.entity === input.entity,
      )
    )
      return refuse('derived-candidate-pending', 'the body has no unpublished native mutation');
    if (
      rapierBodyTypeToString(this.rapierModule, body.bodyType()) !== 'dynamic' ||
      ![input.impulse, input.point].every(
        (vector) =>
          Array.isArray(vector) &&
          vector.length === 3 &&
          vector.every((value) => Number.isFinite(value) && Number.isFinite(Math.fround(value))),
      )
    )
      return refuse(
        'derived-candidate-invalid',
        'a dynamic body receives finite Float32 world vectors',
      );
    try {
      body.applyImpulseAtPoint(
        { x: input.impulse[0], y: input.impulse[1], z: input.impulse[2] },
        { x: input.point[0], y: input.point[1], z: input.point[2] },
        true,
      );
      const linear = body.linvel(),
        angular = body.angvel();
      if (![linear.x, linear.y, linear.z, angular.x, angular.y, angular.z].every(Number.isFinite))
        throw new Error('native impulse produced non-finite motion');
      return ok(undefined);
    } catch (cause) {
      this.derivedPoisonedEntities.add(input.entity);
      return err(
        new DerivedPhysicsError(
          'derived-backend-failed',
          'native impulse completes with finite motion',
          'rebuild the World from a previously committed snapshot',
          { entity: input.entity, reason: cause instanceof Error ? cause.message : String(cause) },
        ),
      );
    }
  }

  getDerivedRecoveryState(): 'ready' | 'rebuild-required' {
    return this.recoveryBlocked() ? 'rebuild-required' : 'ready';
  }

  getDerivedShapes(entity: number): readonly DerivedShapeState[] {
    this.assertActive('getDerivedShapes');
    if (this.recoveryBlocked()) return [];
    const body = this.derivedBodies.get(entity);
    if (body === undefined) return [];
    return body.shapes.map((shape) => ({
      id: shape.input.id,
      revision: shape.input.revision,
      entity,
      voxelSize: [...shape.input.voxelSize] as PhysicsVector,
      origin: [...shape.input.origin] as PhysicsVector,
      rotation: [...shape.input.rotation] as PhysicsQuaternion,
      generation: body.generation,
    }));
  }

  captureDerivedPhysicsState(): DerivedPhysicsSnapshot {
    this.assertActive('captureDerivedPhysicsState');
    return Object.freeze({
      generation: this.backendGeneration,
      fixedStep: this.fixedStep,
      bodies: Object.freeze(
        [...this.derivedBodies.values()].map((body) => ({
          entity: body.entity,
          revision: body.revision,
          sourceKey: body.sourceKey,
          ...(body.bodyType === undefined ? {} : { bodyType: body.bodyType }),
          ...(body.velocityPolicy === undefined ? {} : { velocityPolicy: body.velocityPolicy }),
          shapes: Object.freeze(
            body.shapes.map((shape) => ({
              ...shape.input,
              cells: new Int32Array(shape.input.cells),
              voxelSize: [...shape.input.voxelSize] as PhysicsVector,
              origin: [...shape.input.origin] as PhysicsVector,
              rotation: [...shape.input.rotation] as PhysicsQuaternion,
            })),
          ),
          seams: Object.freeze(
            body.seams.map((seam) => ({ ...seam, offset: [...seam.offset] as PhysicsVector })),
          ),
          ...(body.massProperties === undefined ? {} : { massProperties: body.massProperties }),
          ...(() => {
            const motion = this.getDerivedMotion(body.entity);
            return motion === undefined ? {} : { motion };
          })(),
          constraints: Object.freeze(this.constraintsForBody(body.entity)),
        })),
      ),
    });
  }

  restoreDerivedPhysicsState(
    snapshot: DerivedPhysicsSnapshot,
  ): ReturnType<NonNullable<PhysicsWorld['restoreDerivedPhysicsState']>> {
    this.assertActive('restoreDerivedPhysicsState');
    const snapshotSources = new Map<number, DerivedBodySource>();
    for (const body of snapshot.bodies) {
      if (snapshotSources.has(body.entity)) {
        return err(
          new DerivedPhysicsError(
            'derived-candidate-invalid',
            'a portable snapshot contains one committed body row per entity',
            'capture the snapshot from one PhysicsWorld without duplicate entities',
            { entity: body.entity },
          ),
        );
      }
      snapshotSources.set(body.entity, {
        sourceKey: body.sourceKey,
        revision: body.revision,
      });
    }
    const preparedCandidates: DerivedPhysicsCandidate[] = [];
    const restoredConstraintIds = new Set<string>();
    for (const body of snapshot.bodies) {
      const prepared = this.prepareDerivedShapeCandidate({
        entity: body.entity,
        revision: body.revision,
        sourceKey: body.sourceKey,
        shapes: body.shapes,
        ...(body.seams === undefined || body.seams.length === 0 ? {} : { seams: body.seams }),
        ...(body.bodyType === undefined ? {} : { bodyType: body.bodyType }),
        ...(body.velocityPolicy === undefined ? {} : { velocityPolicy: body.velocityPolicy }),
        ...(body.motion === undefined ? {} : { motion: body.motion }),
        ...(body.massProperties === undefined ? {} : { massProperties: body.massProperties }),
        constraints: body.constraints.filter((constraint) => {
          if (restoredConstraintIds.has(constraint.id)) return false;
          restoredConstraintIds.add(constraint.id);
          return true;
        }),
      });
      if (!prepared.ok) {
        for (const candidate of preparedCandidates) this.cancelDerivedShapeCandidate(candidate);
        return prepared;
      }
      preparedCandidates.push(prepared.value);
    }
    if (preparedCandidates.length === 0) return ok([]);
    return this.admitDerivedShapeCandidates(preparedCandidates);
  }

  createDerivedConstraint(
    input: PhysicsConstraintInput,
  ): ReturnType<NonNullable<PhysicsWorld['createDerivedConstraint']>> {
    return this.installDerivedConstraint(input, false);
  }

  updateDerivedConstraint(
    input: PhysicsConstraintInput,
  ): ReturnType<NonNullable<PhysicsWorld['updateDerivedConstraint']>> {
    return this.installDerivedConstraint(input, true);
  }

  removeDerivedConstraint(
    id: string,
  ): ReturnType<NonNullable<PhysicsWorld['removeDerivedConstraint']>> {
    this.assertActive('removeDerivedConstraint');
    const existing = this.derivedConstraints.get(id);
    if (existing === undefined) {
      return err(
        new DerivedPhysicsError(
          'derived-constraint-not-found',
          'constraint identity is currently committed',
          'ignore repeated cleanup or reconcile the owning constraint set',
          { constraintId: id },
        ),
      );
    }
    this.removeNativeConstraint(existing.handle);
    this.derivedConstraints.delete(id);
    return ok(undefined);
  }

  private createDerivedCollider(
    body: RapierRigidBody,
    shape: VoxelShapeInput,
  ): { readonly handle: number } {
    const RAPIER = this.rapierModule as RapierWorld;
    const desc = RAPIER.ColliderDesc.voxels(
      shape.cells instanceof Int32Array
        ? new Int32Array(shape.cells)
        : new Int32Array(shape.cells.flat()),
      { x: shape.voxelSize[0], y: shape.voxelSize[1], z: shape.voxelSize[2] },
    )
      .setTranslation(shape.origin?.[0] ?? 0, shape.origin?.[1] ?? 0, shape.origin?.[2] ?? 0)
      .setRotation({
        x: shape.rotation?.[0] ?? 0,
        y: shape.rotation?.[1] ?? 0,
        z: shape.rotation?.[2] ?? 0,
        w: shape.rotation?.[3] ?? 1,
      })
      .setFriction(shape.friction ?? 0.5)
      .setRestitution(shape.restitution ?? 0)
      // Disabled colliders still contribute native mass. Staging must be
      // massless; admission assigns density only to its committed shape set.
      .setDensity(0)
      .setCollisionGroups(shape.collisionGroups ?? 0xffffffff)
      .setSolverGroups(shape.solverGroups ?? 0xffffffff)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
      .setEnabled(false);
    if (shape.isSensor === true) desc.setSensor(true);
    const collider = this.raw.createCollider(desc, body);
    this.derivedColliderToShape.set(collider.handle, { entity: body.userData, id: shape.id });
    return collider;
  }

  private removeNativeCollider(handle: number): void {
    this.derivedColliderToShape.delete(handle);
    try {
      const collider = (this.raw as RapierWorld).getCollider(handle);
      if (collider !== null && collider !== undefined) {
        (this.raw as RapierWorld).removeCollider(collider, false);
      }
    } catch {
      // Native removal is idempotent from the Engine lifecycle perspective.
    }
  }

  private createNativeConstraint(
    input: PhysicsConstraintInput,
  ): Result<{ readonly handle: number }, DerivedPhysicsError> {
    let native: RapierWorld | undefined;
    try {
      const RAPIER = this.rapierModule as RapierWorld;
      const bodyA = this.bodyForEntity(input.bodyA);
      const bodyB = this.bodyForEntity(input.bodyB);
      if (bodyA === undefined || bodyB === undefined) {
        return err(
          new DerivedPhysicsError(
            'derived-body-not-found',
            'both constraint endpoints have committed bodies in this PhysicsWorld',
            'reconcile both entities before creating the constraint',
            { constraintId: input.id },
          ),
        );
      }
      const anchorA = { x: input.anchorA[0], y: input.anchorA[1], z: input.anchorA[2] };
      const anchorB = { x: input.anchorB[0], y: input.anchorB[1], z: input.anchorB[2] };
      const jointData =
        input.kind === 'spring'
          ? RAPIER.JointData.spring(
              input.restLength,
              input.stiffness,
              input.damping,
              anchorA,
              anchorB,
            )
          : RAPIER.JointData.revolute(anchorA, anchorB, {
              x: input.axis[0],
              y: input.axis[1],
              z: input.axis[2],
            });
      native = this.raw.createImpulseJoint(jointData, bodyA, bodyB, true);
      if (input.kind === 'hinge' && input.limits !== undefined)
        native.setLimits(input.limits[0], input.limits[1]);
      return ok({ handle: native.handle });
    } catch (cause) {
      if (native !== undefined) this.removeNativeConstraint(native.handle);
      return err(
        new DerivedPhysicsError(
          'derived-backend-failed',
          'the selected Rapier joint can be created for both endpoint bodies',
          'repair endpoint state or use a supported spring/hinge input',
          {
            constraintId: input.id,
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      );
    }
  }

  private rememberDerivedFailure(
    record: DerivedCandidateRecord,
    error: DerivedPhysicsError,
    recovery: DerivedPhysicsFailure['recovery'],
  ): void {
    record.state = 'failed';
    this.pendingDerivedCandidates.delete(record.token.candidateId);
    this.derivedFailures.set(
      record.input.entity,
      Object.freeze({
        candidateId: record.token.candidateId,
        entity: record.input.entity,
        revision: record.input.revision,
        fixedStep: this.fixedStep,
        error,
        recovery,
      }),
    );
    this.releaseDerivedCandidate(record.token.candidateId);
  }

  private rejectPreparedCandidate(
    record: DerivedCandidateRecord,
    error: DerivedPhysicsError,
  ): void {
    for (const member of record.batch?.records ?? [record]) {
      if (!this.derivedCandidates.has(member.token.candidateId)) continue;
      for (const collider of member.nativeColliders) this.removeNativeCollider(collider.handle);
      this.rememberDerivedFailure(member, error, 'old-state-retained');
    }
  }

  private processDerivedCandidates(): void {
    if (this.pendingDerivedCandidates.size === 0) return;
    const pendingRecords = [...this.pendingDerivedCandidates]
      .map((id) => this.derivedCandidates.get(id))
      .filter((record): record is DerivedCandidateRecord => record?.state === 'queued');
    const pendingByEntity = new Map<number, DerivedCandidateRecord>();
    for (const record of pendingRecords) {
      const current = pendingByEntity.get(record.input.entity);
      if (current === undefined || record.input.revision > current.input.revision) {
        pendingByEntity.set(record.input.entity, record);
      }
    }
    // A candidate that names a queued endpoint must be processed after that
    // endpoint. This turns a queue-time source projection into a final
    // committed-source check: if the endpoint fails natively, its dependent
    // candidate sees the old source on the next iteration and is rejected.
    const ordered: (readonly DerivedCandidateRecord[])[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (record: DerivedCandidateRecord): void => {
      const group = record.batch?.records ?? [record];
      const key = group[0]?.token.candidateId ?? record.token.candidateId;
      if (visited.has(key)) return;
      if (visiting.has(key)) {
        this.rejectPreparedCandidate(
          record,
          new DerivedPhysicsError(
            'derived-constraint-invalid',
            'cyclic endpoint updates share one batch',
            'submit mutually dependent body replacements together',
            { candidateId: key },
          ),
        );
        return;
      }
      visiting.add(key);
      for (const member of group) {
        for (const constraint of member.input.constraints ?? []) {
          for (const [entity, dependency] of [
            [constraint.bodyA, constraint.bodyASource],
            [constraint.bodyB, constraint.bodyBSource],
          ] as const) {
            const target = pendingByEntity.get(entity);
            if (
              target !== undefined &&
              !group.includes(target) &&
              target.input.sourceKey === dependency.sourceKey &&
              target.input.revision === dependency.revision
            )
              visit(target);
          }
        }
      }
      visiting.delete(key);
      visited.add(key);
      ordered.push(group);
    };
    for (const record of pendingRecords) visit(record);

    for (const group of ordered) {
      if (this.derivedPoisonedEntities.size > 0) break;
      const first = group[0];
      if (first === undefined) continue;
      if (
        group.some(
          (record) =>
            record.state !== 'queued' ||
            !this.pendingDerivedCandidates.has(record.token.candidateId),
        )
      )
        continue;
      // Validate the whole final projection before any native body changes.
      const sources = this.pendingDerivedSources();
      let rejected: DerivedPhysicsError | undefined;
      for (const record of group) {
        const projected = sources.get(record.input.entity);
        if (projected !== undefined && record.input.revision < projected.revision) {
          rejected = new DerivedPhysicsError(
            'derived-candidate-stale',
            'fixed-step admission publishes the final queued body revisions',
            'discard the older group and prepare a complete replacement',
            { entity: record.input.entity },
          );
        } else if (this.derivedPoisonedEntities.has(record.input.entity)) {
          rejected = new DerivedPhysicsError(
            'derived-recovery-invalid',
            'every batch body has recoverable native state',
            'rebuild the PhysicsWorld before retrying',
            { entity: record.input.entity },
          );
        } else if (this.bodyForEntity(record.input.entity) === undefined) {
          rejected = new DerivedPhysicsError(
            'derived-body-not-found',
            'every batch body remains live through admission',
            'reconcile entities and prepare again',
            { entity: record.input.entity },
          );
        } else rejected = this.validateDerivedAdmission(record.input, sources);
        if (rejected !== undefined) break;
      }
      if (rejected !== undefined) {
        this.rejectPreparedCandidate(first, rejected);
        continue;
      }
      const undos: (() => boolean)[] = [];
      for (const record of group) {
        const id = record.token.candidateId;
        const old = this.derivedBodies.get(record.input.entity);
        const body = this.bodyForEntity(record.input.entity);
        const oldBodyType = body.bodyType();
        const oldBodyEnabled = body.isEnabled();
        const oldVelocity = body.linvel();
        const oldAngularVelocity = body.angvel();
        const oldTranslation = body.translation();
        const oldRotation = body.rotation();
        const oldCom = body.worldCom();
        const oldMass = body.mass();
        const oldAutomaticAdditionalMass =
          this.entityMap.get(record.input.entity)?.automaticAdditionalMass ?? 0;
        const oldAutomaticRecordMass = this.entityMap.get(
          record.input.entity,
        )?.automaticAdditionalMass;
        const oldSource = this.derivedBodySources.get(record.input.entity);
        const oldPublication = this.derivedPublications.get(record.input.entity);
        const oldDensities = this.bodyColliders(body).map((collider) => ({
          collider,
          density: typeof collider.density === 'function' ? collider.density() : undefined,
          enabled: typeof collider.isEnabled === 'function' ? collider.isEnabled() : true,
        }));
        const oldConstraints = new Map(this.derivedConstraints);
        const stagedConstraints = new Map<string, DerivedConstraintRecord>();
        let geometryCommitUncertain = false;
        const rollback = (): boolean => {
          for (const staged of stagedConstraints.values())
            this.removeNativeConstraint(staged.handle);
          // The commit path may already have removed/replaced a native joint
          // before a later body mutation fails. Clear every current native joint
          // now; the old records are recreated after the body state is restored
          // instead of leaving a stale JS handle that no longer exists in
          // Rapier.
          for (const current of this.derivedConstraints.values())
            this.removeNativeConstraint(current.handle);
          this.derivedConstraints.clear();
          if (old !== undefined) {
            for (const shape of old.shapes) {
              const collider = (this.raw as RapierWorld).getCollider(shape.colliderHandle);
              if (collider !== null && collider !== undefined) collider.setEnabled(true);
            }
            const retiredIndex = this.retiredDerivedBodies.indexOf(old);
            if (retiredIndex >= 0) this.retiredDerivedBodies.splice(retiredIndex, 1);
            this.derivedBodies.set(record.input.entity, old);
            this.derivedBodySources.set(record.input.entity, {
              sourceKey: old.sourceKey,
              revision: old.revision,
            });
          }
          for (const native of record.nativeColliders) {
            const collider = (this.raw as RapierWorld).getCollider(native.handle);
            if (collider !== null && collider !== undefined) collider.setEnabled(false);
          }
          // Remove staged colliders before restoring mass. Rapier defers some
          // mass-property recomputation until a collider mutation; restoring
          // while a disabled candidate is still attached can leave an explicit
          // override behind for the next fixed step.
          for (const native of record.nativeColliders) this.removeNativeCollider(native.handle);
          for (const { collider, density, enabled } of oldDensities) {
            if (this.raw.getCollider(collider.handle) === null) continue;
            if (density !== undefined && typeof collider.setDensity === 'function')
              collider.setDensity(density);
            if (typeof collider.setEnabled === 'function') collider.setEnabled(enabled);
          }
          let restored = true;
          try {
            body.setBodyType(oldBodyType, true);
            this.restoreCommittedMass(body, old, oldAutomaticAdditionalMass);
            body.setTranslation(oldTranslation, true);
            body.setRotation(oldRotation, true);
            body.setLinvel(oldVelocity, true);
            body.setAngvel(oldAngularVelocity, true);
            body.setEnabled(oldBodyEnabled);
          } catch {
            restored = false;
          }
          if (restored && !this.restoreNativeConstraints(oldConstraints)) restored = false;
          if (restored) {
            const currentMass = body.mass();
            const currentCom = body.worldCom();
            const currentVelocity = body.linvel();
            const currentAngularVelocity = body.angvel();
            const currentRotation = body.rotation();
            restored =
              Number.isFinite(currentMass) &&
              Math.abs(currentMass - oldMass) <= 1e-6 * Math.max(1, Math.abs(oldMass)) &&
              Math.abs(currentCom.x - oldCom.x) <= 1e-6 &&
              Math.abs(currentCom.y - oldCom.y) <= 1e-6 &&
              Math.abs(currentCom.z - oldCom.z) <= 1e-6 &&
              Math.abs(currentVelocity.x - oldVelocity.x) <= 1e-6 &&
              Math.abs(currentVelocity.y - oldVelocity.y) <= 1e-6 &&
              Math.abs(currentVelocity.z - oldVelocity.z) <= 1e-6 &&
              Math.abs(currentAngularVelocity.x - oldAngularVelocity.x) <= 1e-6 &&
              Math.abs(currentAngularVelocity.y - oldAngularVelocity.y) <= 1e-6 &&
              Math.abs(currentAngularVelocity.z - oldAngularVelocity.z) <= 1e-6 &&
              Math.abs(
                currentRotation.x * oldRotation.x +
                  currentRotation.y * oldRotation.y +
                  currentRotation.z * oldRotation.z +
                  currentRotation.w * oldRotation.w,
              ) >=
                1 - 1e-6 &&
              body.bodyType() === oldBodyType &&
              body.isEnabled() === oldBodyEnabled;
          }
          if (old === undefined) this.derivedBodies.delete(record.input.entity);
          else this.derivedBodies.set(record.input.entity, old);
          if (oldSource === undefined) this.derivedBodySources.delete(record.input.entity);
          else this.derivedBodySources.set(record.input.entity, oldSource);
          if (oldPublication === undefined) this.derivedPublications.delete(record.input.entity);
          else this.derivedPublications.set(record.input.entity, oldPublication);
          const entityRecord = this.entityMap.get(record.input.entity);
          if (entityRecord !== undefined && oldAutomaticRecordMass !== undefined)
            entityRecord.automaticAdditionalMass = oldAutomaticRecordMass;
          return restored;
        };
        const restore = (undo: () => boolean): boolean => {
          try {
            return undo();
          } catch {
            return false;
          }
        };
        try {
          for (const constraint of record.input.constraints ?? []) {
            const created = this.createNativeConstraint(constraint);
            if (!created.ok) throw created.error;
            stagedConstraints.set(constraint.id, {
              input: { ...constraint },
              handle: created.value.handle,
            });
          }
          if (record.input.bodyType !== undefined) {
            const RAPIER = this.rapierModule as RapierWorld;
            const bodyType =
              record.input.bodyType === 'static'
                ? RAPIER.RigidBodyType.Fixed
                : record.input.bodyType === 'kinematic'
                  ? RAPIER.RigidBodyType.KinematicPositionBased
                  : RAPIER.RigidBodyType.Dynamic;
            body.setBodyType(bodyType, true);
          }
          for (const native of record.nativeColliders) {
            const collider = (this.raw as RapierWorld).getCollider(native.handle);
            if (collider === null || collider === undefined)
              throw new Error('candidate collider disappeared');
            collider.setEnabled(true);
          }
          const nativeById = new Map(
            record.input.shapes.map((shape: VoxelShapeInput, index: number) => [
              shape.id,
              record.nativeColliders[index]?.handle as number,
            ]),
          );
          for (const seam of record.input.seams ?? []) {
            const firstHandle = nativeById.get(seam.shapeA);
            const secondHandle = nativeById.get(seam.shapeB);
            const first =
              firstHandle === undefined
                ? undefined
                : (this.raw as RapierWorld).getCollider(firstHandle);
            const second =
              secondHandle === undefined
                ? undefined
                : (this.raw as RapierWorld).getCollider(secondHandle);
            if (first === undefined || second === undefined || first === null || second === null) {
              throw new Error(`derived seam references missing shape ${seam.shapeA}`);
            }
            first.combineVoxelStates(second, seam.offset[0], seam.offset[1], seam.offset[2]);
          }
          if (record.input.motion?.rotation !== undefined) {
            const [x, y, z, w] = record.input.motion.rotation;
            body.setRotation({ x, y, z, w }, true);
          }
          this.applyDerivedMass(
            body,
            record.input.massProperties,
            oldCom,
            record.input.velocityPolicy ?? 'preserve',
            this.entityMap.get(record.input.entity)?.additionalMass ?? 0,
            record.input.entity,
            record.input.shapes,
            record.nativeColliders,
          );
          if (record.input.motion !== undefined) {
            const currentCom = body.worldCom();
            const targetCom = record.input.motion.centerOfMass;
            const translation = body.translation();
            body.setTranslation(
              {
                x: translation.x + targetCom[0] - currentCom.x,
                y: translation.y + targetCom[1] - currentCom.y,
                z: translation.z + targetCom[2] - currentCom.z,
              },
              true,
            );
            body.setLinvel(
              {
                x: record.input.motion.linearVelocity[0],
                y: record.input.motion.linearVelocity[1],
                z: record.input.motion.linearVelocity[2],
              },
              true,
            );
            body.setAngvel(
              {
                x: record.input.motion.angularVelocity[0],
                y: record.input.motion.angularVelocity[1],
                z: record.input.motion.angularVelocity[2],
              },
              true,
            );
          }
          // A body revision invalidates any committed joint that still names
          // that body's previous source/revision. Keep this tied to the body
          // that is actually committing: a different queued endpoint may still
          // fail, in which case its old joint remains valid and must not be
          // removed speculatively.
          const committedSources = new Map(this.derivedBodySources);
          committedSources.set(record.input.entity, {
            sourceKey: record.input.sourceKey,
            revision: record.input.revision,
          });
          const replacementConstraintIds = new Set(
            (record.input.constraints ?? []).map((constraint) => constraint.id),
          );
          for (const [constraintId, current] of [...this.derivedConstraints]) {
            if (
              replacementConstraintIds.has(constraintId) ||
              this.constraintDependenciesMatch(current.input, committedSources)
            )
              continue;
            this.removeNativeConstraint(current.handle);
            this.derivedConstraints.delete(constraintId);
          }
          if (old !== undefined) {
            for (const shape of old.shapes) {
              const collider = (this.raw as RapierWorld).getCollider(shape.colliderHandle);
              if (collider !== null && collider !== undefined) collider.setEnabled(false);
            }
            this.retiredDerivedBodies.push(old);
          }
          for (const constraint of record.input.constraints ?? []) {
            const previous = this.derivedConstraints.get(constraint.id);
            if (previous !== undefined) this.removeNativeConstraint(previous.handle);
            const staged = stagedConstraints.get(constraint.id);
            if (staged !== undefined) this.derivedConstraints.set(constraint.id, staged);
          }
          const shapes: DerivedShapeRecord[] = record.input.shapes.map(
            (shape: VoxelShapeInput, index: number) => ({
              input: shape as DerivedShapeRecord['input'],
              colliderHandle: record.nativeColliders[index]?.handle as number,
            }),
          );
          const committed: DerivedBodyRecord = {
            entity: record.input.entity,
            sourceKey: record.input.sourceKey,
            generation: this.backendGeneration,
            revision: record.input.revision,
            bodyType: record.input.bodyType,
            velocityPolicy: record.input.velocityPolicy,
            candidateId: record.token.candidateId,
            shapes,
            seams: [...(record.input.seams ?? [])],
            massProperties: record.input.massProperties,
            constraints: [...(record.input.constraints ?? [])],
          };
          // The sole cross-domain observation boundary: no native operation
          // follows a successful geometry commit before recording this body.
          // A refused commit takes the same complete native rollback below.
          const commitGeometry =
            record === group[group.length - 1]
              ? (record.batch?.commitGeometry ?? record.commitGeometry)
              : undefined;
          if (commitGeometry !== undefined) {
            this.activeDerivedAdmission = record;
            try {
              geometryCommitUncertain = true;
              const geometry = commitGeometry();
              geometryCommitUncertain = false;
              if (!geometry.ok) throw geometry.error;
            } finally {
              this.activeDerivedAdmission = undefined;
            }
            delete record.commitGeometry;
          }
          this.derivedBodies.set(record.input.entity, committed);
          const entityRecord = this.entityMap.get(record.input.entity);
          if (entityRecord !== undefined) {
            entityRecord.automaticAdditionalMass =
              record.input.massProperties?.mode === 'explicit' ? 0 : entityRecord.additionalMass;
          }
          this.derivedBodySources.set(record.input.entity, {
            sourceKey: record.input.sourceKey,
            revision: record.input.revision,
          });
          this.derivedFailures.delete(record.input.entity);
          record.state = 'queued';
          this.pendingDerivedCandidates.delete(id);
          undos.push(rollback);
        } catch (cause) {
          let restored = restore(rollback);
          for (const undo of undos.reverse()) {
            if (!restore(undo)) restored = false;
          }
          const error =
            cause instanceof DerivedPhysicsError
              ? cause
              : new DerivedPhysicsError(
                  'derived-backend-failed',
                  'derived admission either commits completely or preserves the prior body state',
                  'inspect the failure receipt and rebuild the PhysicsWorld if recovery is required',
                  {
                    entity: record.input.entity,
                    candidateId: record.token.candidateId,
                    reason: cause instanceof Error ? cause.message : String(cause),
                  },
                );
          // A thrown consumer callback can have changed ECS state. Native
          // rollback alone cannot certify any member of that combined group.
          if (geometryCommitUncertain) restored = false;
          for (const member of group) {
            if (!restored) {
              this.derivedPoisonedEntities.add(member.input.entity);
              this.derivedBodies.delete(member.input.entity);
              this.derivedPublications.delete(member.input.entity);
            }
            this.rememberDerivedFailure(
              member,
              error,
              restored ? 'old-state-retained' : 'rebuild-required',
            );
          }
          break;
        }
      }
    }
  }

  private publishDerivedCandidates(): void {
    for (const body of this.derivedBodies.values()) {
      const candidate = this.derivedCandidates.get(body.candidateId);
      if (candidate?.state !== 'queued') continue;
      this.derivedPublications.set(
        body.entity,
        Object.freeze({
          candidateId: body.candidateId,
          entity: body.entity,
          revision: body.revision,
          fixedStep: this.fixedStep,
          shapeIds: Object.freeze(body.shapes.map((shape) => shape.input.id)),
          generation: body.generation,
        }),
      );
      // The committed body/publication now own native colliders and identity.
      // Release the private preparation copy and its transient slot.
      this.releaseDerivedCandidate(body.candidateId);
    }
  }

  private retireDerivedBodies(): void {
    for (const body of this.retiredDerivedBodies.splice(0)) {
      for (const shape of body.shapes) this.removeNativeCollider(shape.colliderHandle);
      this.releaseDerivedCandidate(body.candidateId);
    }
  }

  private applyDerivedMass(
    body: RapierRigidBody,
    properties: PhysicsMassProperties | undefined,
    previousWorldCom: { x: number; y: number; z: number },
    velocityPolicy: 'preserve' | 'reset',
    authoredAdditionalMass: number,
    entity: number,
    candidateShapes: readonly VoxelShapeInput[],
    candidateColliders: readonly { readonly handle: number }[],
  ): void {
    const oldVelocity = body.linvel();
    const oldAngularVelocity = body.angvel();
    if (properties?.mode === 'explicit') {
      // Explicit mass is the sole source for this body. Zero every ordinary
      // and derived collider density first so Rapier does not add a hidden
      // density contribution to the authored value.
      this.rememberAuthoredDensity(entity, body);
      for (const collider of this.bodyColliders(body)) {
        if (typeof collider.setDensity === 'function') collider.setDensity(0);
      }
      const frame = properties.principalInertiaLocalFrame ?? [0, 0, 0, 1];
      body.setAdditionalMassProperties(
        properties.mass,
        {
          x: properties.centerOfMass[0],
          y: properties.centerOfMass[1],
          z: properties.centerOfMass[2],
        },
        {
          x: properties.principalInertia[0],
          y: properties.principalInertia[1],
          z: properties.principalInertia[2],
        },
        { x: frame[0], y: frame[1], z: frame[2], w: frame[3] },
        true,
      );
      // Rapier defers additional mass updates. Admission reads worldCom below
      // before stepping, so refresh now or COM restoration shifts the body twice.
      body.recomputeMassPropertiesFromColliders();
    } else {
      this.restoreAutomaticDensities(
        entity,
        body,
        properties?.mode === 'automatic' ? properties.density : undefined,
        candidateShapes,
        candidateColliders,
      );
      this.restoreAutomaticMass(body, authoredAdditionalMass);
    }
    if (velocityPolicy === 'reset') {
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }
    const nextWorldCom = body.worldCom();
    const next = preserveCenterOfMassVelocity(
      [oldVelocity.x, oldVelocity.y, oldVelocity.z],
      [oldAngularVelocity.x, oldAngularVelocity.y, oldAngularVelocity.z],
      [previousWorldCom.x, previousWorldCom.y, previousWorldCom.z],
      [nextWorldCom.x, nextWorldCom.y, nextWorldCom.z],
    );
    body.setLinvel({ x: next[0], y: next[1], z: next[2] }, true);
    body.setAngvel(oldAngularVelocity, true);
  }

  /** Restore the complete committed mass policy after a failed admission. */
  private restoreCommittedMass(
    body: RapierRigidBody,
    previous: DerivedBodyRecord | undefined,
    automaticAdditionalMass: number,
  ): void {
    if (previous?.massProperties?.mode === 'explicit') {
      const frame = previous.massProperties.principalInertiaLocalFrame ?? [0, 0, 0, 1];
      body.setAdditionalMassProperties(
        previous.massProperties.mass,
        {
          x: previous.massProperties.centerOfMass[0],
          y: previous.massProperties.centerOfMass[1],
          z: previous.massProperties.centerOfMass[2],
        },
        {
          x: previous.massProperties.principalInertia[0],
          y: previous.massProperties.principalInertia[1],
          z: previous.massProperties.principalInertia[2],
        },
        { x: frame[0], y: frame[1], z: frame[2], w: frame[3] },
        true,
      );
      body.recomputeMassPropertiesFromColliders();
      return;
    }
    this.restoreAutomaticMass(body, automaticAdditionalMass);
  }

  /**
   * Rapier keeps `setAdditionalMassProperties` as native state even after a
   * collider recompute. Clear that override explicitly before recomputing so
   * automatic candidates and rollback really return to the authored policy.
   */
  private restoreAutomaticMass(body: RapierRigidBody, additionalMass: number): void {
    body.setAdditionalMass(Math.max(0, additionalMass), true);
    body.recomputeMassPropertiesFromColliders();
  }

  private rememberAuthoredDensity(entity: number, body: RapierRigidBody): void {
    const record = this.entityMap.get(entity);
    if (record === undefined || record.authoredDensity !== undefined) return;
    const authored = this.bodyColliders(body).find(
      (collider) => !this.derivedColliderToShape.has(collider.handle),
    );
    const density =
      authored !== undefined && typeof authored.density === 'function'
        ? authored.density()
        : undefined;
    if (density !== undefined && Number.isFinite(density) && density >= 0)
      record.authoredDensity = density;
  }

  private restoreAutomaticDensities(
    entity: number,
    body: RapierRigidBody,
    overrideDensity: number | undefined,
    candidateShapes: readonly VoxelShapeInput[],
    candidateColliders: readonly { readonly handle: number }[],
  ): void {
    const record = this.entityMap.get(entity);
    const candidateDensityByHandle = new Map<number, number>();
    for (const [index, collider] of candidateColliders.entries()) {
      const shape = candidateShapes[index];
      if (shape !== undefined) candidateDensityByHandle.set(collider.handle, shape.density ?? 1);
    }
    const authoredDensity = record?.authoredDensity ?? 1;
    for (const collider of this.bodyColliders(body)) {
      const candidateDensity = candidateDensityByHandle.get(collider.handle);
      const density =
        candidateDensity !== undefined
          ? (overrideDensity ?? candidateDensity)
          : this.derivedColliderToShape.has(collider.handle)
            ? 0
            : (overrideDensity ?? authoredDensity);
      if (typeof collider.setDensity === 'function') collider.setDensity(density);
    }
  }

  private restoreNativeConstraints(
    previous: ReadonlyMap<string, DerivedConstraintRecord>,
  ): boolean {
    for (const [constraintId, record] of previous) {
      const recreated = this.createNativeConstraint(record.input);
      if (!recreated.ok) {
        for (const current of this.derivedConstraints.values())
          this.removeNativeConstraint(current.handle);
        this.derivedConstraints.clear();
        return false;
      }
      this.derivedConstraints.set(constraintId, {
        input: { ...record.input },
        handle: recreated.value.handle,
      });
    }
    return true;
  }

  private bodyColliders(body: RapierRigidBody): RapierWorld[] {
    const result: RapierWorld[] = [];
    for (let index = 0; index < body.numColliders(); index += 1) {
      const collider = body.collider(index);
      if (collider !== null && collider !== undefined) result.push(collider);
    }
    return result;
  }

  private releaseDerivedCandidate(candidateId: string): void {
    const record = this.derivedCandidates.get(candidateId);
    if (record === undefined) return;
    this.derivedCandidateBytes = Math.max(0, this.derivedCandidateBytes - record.bytes);
    this.derivedCandidates.delete(candidateId);
  }

  private sourceForEntity(entity: number): DerivedBodySource {
    return (
      this.derivedBodySources.get(entity) ?? {
        sourceKey: `entity:${entity}`,
        revision: 0,
      }
    );
  }

  /**
   * Project the final source revision of every queued body. Constraint
   * dependencies are checked against this projection, not against whichever
   * queued candidate happens to be processed first.
   */
  private pendingDerivedSources(): Map<number, DerivedBodySource> {
    const sources = new Map<number, DerivedBodySource>();
    for (const candidateId of this.pendingDerivedCandidates) {
      const record = this.derivedCandidates.get(candidateId);
      if (record === undefined || record.state !== 'queued') continue;
      const current = sources.get(record.input.entity);
      if (current === undefined || record.input.revision > current.revision) {
        sources.set(record.input.entity, {
          sourceKey: record.input.sourceKey,
          revision: record.input.revision,
        });
      }
    }
    return sources;
  }

  private newestPendingRevision(entity: number): number | undefined {
    return this.pendingDerivedSources().get(entity)?.revision;
  }

  private recoveryBlocked(): boolean {
    return (
      this.derivedPoisonedEntities.size > 0 || this.syncState?.world.execution.health === 'poisoned'
    );
  }

  private validateConstraintDependencies(
    input: PhysicsConstraintInput,
    candidate?: DerivedPhysicsCandidateInput,
    sourceOverrides?: ReadonlyMap<number, DerivedBodySource>,
  ): DerivedPhysicsError | undefined {
    const endpoints = [
      [input.bodyA, input.bodyASource],
      [input.bodyB, input.bodyBSource],
    ] as const;
    for (const [entity, dependency] of endpoints) {
      if (this.derivedPoisonedEntities.has(entity)) {
        return new DerivedPhysicsError(
          'derived-recovery-invalid',
          'constraint endpoints belong to a healthy PhysicsWorld state',
          'rebuild the PhysicsWorld before recreating constraints',
          { constraintId: input.id, entity },
        );
      }
      if (!this.entityMap.has(entity)) {
        return new DerivedPhysicsError(
          'derived-body-not-found',
          'both constraint endpoint entities have committed bodies',
          'reconcile both endpoint entities before creating or migrating a constraint',
          { constraintId: input.id, entity },
        );
      }
      const expected =
        candidate !== undefined && entity === candidate.entity
          ? { sourceKey: candidate.sourceKey, revision: candidate.revision }
          : (sourceOverrides?.get(entity) ?? this.sourceForEntity(entity));
      if (
        dependency.sourceKey !== expected.sourceKey ||
        dependency.revision !== expected.revision
      ) {
        return new DerivedPhysicsError(
          'derived-constraint-stale',
          'constraint endpoint sourceKey and revision match the committed endpoint',
          'refresh both endpoint dependencies and retry the complete candidate',
          {
            constraintId: input.id,
            entity,
            expected: `${expected.sourceKey}@${expected.revision}`,
            actual: `${dependency.sourceKey}@${dependency.revision}`,
          },
        );
      }
    }
    return undefined;
  }

  private constraintDependenciesMatch(
    input: PhysicsConstraintInput,
    sourceOverrides: ReadonlyMap<number, DerivedBodySource>,
  ): boolean {
    for (const [entity, dependency] of [
      [input.bodyA, input.bodyASource],
      [input.bodyB, input.bodyBSource],
    ] as const) {
      if (!this.entityMap.has(entity)) return false;
      const expected = sourceOverrides.get(entity) ?? this.sourceForEntity(entity);
      if (dependency.sourceKey !== expected.sourceKey || dependency.revision !== expected.revision)
        return false;
    }
    return true;
  }

  private validateDerivedAdmission(
    input: DerivedPhysicsCandidateInput,
    sourceOverrides?: ReadonlyMap<number, DerivedBodySource>,
  ): DerivedPhysicsError | undefined {
    if (
      input.bodyType !== undefined &&
      input.bodyType !== 'static' &&
      input.bodyType !== 'dynamic' &&
      input.bodyType !== 'kinematic'
    ) {
      return new DerivedPhysicsError(
        'derived-candidate-invalid',
        'candidate bodyType is one of static, dynamic, or kinematic',
        'repair the motion type before admission',
        { entity: input.entity, actual: input.bodyType },
      );
    }
    const seen = new Set<string>();
    for (const constraint of input.constraints ?? []) {
      const validation = validateConstraintInput(constraint);
      if (!validation.ok) return validation.error;
      if (seen.has(constraint.id)) {
        return new DerivedPhysicsError(
          'derived-constraint-invalid',
          'candidate contains one constraint update per identity',
          'merge duplicate updates before admission',
          { entity: input.entity, constraintId: constraint.id },
        );
      }
      seen.add(constraint.id);
      const dependencyError = this.validateConstraintDependencies(
        constraint,
        input,
        sourceOverrides,
      );
      if (dependencyError !== undefined) return dependencyError;
      const existing = this.derivedConstraints.get(constraint.id);
      if (existing !== undefined && constraint.revision <= existing.input.revision) {
        return new DerivedPhysicsError(
          'derived-constraint-stale',
          'migrated constraint revision advances the committed revision',
          'submit both endpoint dependencies and a newer constraint revision',
          {
            entity: input.entity,
            constraintId: constraint.id,
            expected: `>${existing.input.revision}`,
            actual: constraint.revision,
          },
        );
      }
    }
    return undefined;
  }

  private constraintsForBody(entity: number): readonly PhysicsConstraintInput[] {
    return [...this.derivedConstraints.values()]
      .filter(
        (constraint) => constraint.input.bodyA === entity || constraint.input.bodyB === entity,
      )
      .map((constraint) => ({ ...constraint.input }));
  }

  private installDerivedConstraint(
    input: PhysicsConstraintInput,
    updating: boolean,
  ): ReturnType<NonNullable<PhysicsWorld['createDerivedConstraint']>> {
    this.assertActive(updating ? 'updateDerivedConstraint' : 'createDerivedConstraint');
    const validation = validateConstraintInput(input);
    if (!validation.ok) return validation;
    const dependencyError = this.validateConstraintDependencies(
      input,
      undefined,
      this.pendingDerivedSources(),
    );
    if (dependencyError !== undefined) return err(dependencyError);
    const existing = this.derivedConstraints.get(input.id);
    if (existing !== undefined && !updating) {
      return err(
        new DerivedPhysicsError(
          'derived-constraint-stale',
          'constraint identity is not already committed when creating it',
          'call updateDerivedConstraint with a newer revision',
          { constraintId: input.id },
        ),
      );
    }
    if (existing !== undefined && input.revision <= existing.input.revision) {
      return err(
        new DerivedPhysicsError(
          'derived-constraint-stale',
          'constraint revision advances monotonically',
          'submit a newer constraint revision',
          {
            constraintId: input.id,
            actual: input.revision,
            expected: `>${existing.input.revision}`,
          },
        ),
      );
    }
    const native = this.createNativeConstraint(input);
    if (!native.ok) return native;
    if (existing !== undefined) this.removeNativeConstraint(existing.handle);
    this.derivedConstraints.set(input.id, { input: { ...input }, handle: native.value.handle });
    return ok({ id: input.id, revision: input.revision });
  }

  private removeNativeConstraint(handle: number): void {
    try {
      const joint = (this.raw as RapierWorld).getImpulseJoint(handle);
      if (joint !== null && joint !== undefined)
        (this.raw as RapierWorld).removeImpulseJoint(joint, true);
    } catch {
      // Cleanup is idempotent across backend teardown and entity removal.
    }
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
    this.assertActive('dispose');
    this.invalidateDerivedShapeCandidates('physics-dispose');
    this.derivedCandidates.clear();
    this.pendingDerivedCandidates.clear();
    this.derivedBodies.clear();
    this.derivedBodySources.clear();
    this.derivedPublications.clear();
    this.derivedFailures.clear();
    this.derivedConstraints.clear();
    this.derivedContacts.length = 0;
    this.derivedPublicationPending = false;
    this.derivedPoisonedEntities.clear();
    this.derivedColliderToShape.clear();
    this.retiredDerivedBodies.length = 0;
    this.derivedCandidateBytes = 0;
    this.backendGeneration += 1;
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
    this.worldIdentity = world;
  }

  /** Release the persistent ECS readers owned by one system registration. */
  clearEcsContext(world: World): void {
    if (this.syncState?.world === world) this.syncState = undefined;
    if (this.moveContext?.world === world) this.moveContext = undefined;
    if (this.worldIdentity === world) this.worldIdentity = undefined;
  }

  moveAndSlide(entity: number, desiredDelta: Vec3): Vec3 {
    this.assertActive('moveAndSlide');
    return this.computeMove(entity, desiredDelta);
  }

  private assertActive(operation: string): void {
    if (this.activeDerivedAdmission !== undefined) {
      throw new DerivedPhysicsError(
        'derived-candidate-pending',
        'physics queries and mutations observe only complete fixed-step states',
        'finish the paired geometry commit before querying or mutating physics',
        { entity: this.activeDerivedAdmission.input.entity, reason: operation },
      );
    }
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

  private reconcilePhysicsDelta(
    state: PhysicsSyncState,
    entity: EntityHandle,
    delta: PhysicsEntityDelta,
  ): void {
    const row = state.queries.map((query) => query.at(entity)).find((entry) => entry !== undefined);
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

    const descriptor = readPhysicsSyncDescriptor(
      row,
      state.transformComponent,
      state.globalTransformComponent,
    );
    if (descriptor === undefined) {
      this.removeEntity(entity);
      return;
    }

    if (this.hasBody(entity) && (delta.colliderChanged || delta.rigidBodyChanged)) {
      // Authored properties share one native-body mutation path with derived
      // shapes, preserving motion and joint identity through ordinary edits.
      this.syncAuthoredEcsMutation(entity, descriptor);
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
        (finalOffset === undefined || !Object.is(cachedOffset, finalOffset))
      ) {
        // Component removal is structural and reaches the full reconcile path.
        // A value change only rebuilds the receipt when its effective offset changed.
        this.removeKccController(entity);
        if (finalOffset !== undefined) this.ensureKcc(entity, finalOffset);
      }
    }
    if (
      !delta.transformChanged &&
      !(delta.characterControllerStructureChanged && !descriptor.hasCharacterController)
    ) {
      return;
    }

    const bodyType = rigidBodyTypeFromF32(descriptor.rigidBody.type);
    if (bodyType === 'static') {
      this.syncAuthoredPose(entity, descriptor.transform, descriptor.collider, 'static');
    } else if (bodyType === 'kinematic' && !descriptor.hasCharacterController) {
      this.syncAuthoredPose(entity, descriptor.transform, descriptor.collider, 'kinematic');
    } else if (bodyType === 'dynamic') {
      this.poseWritebackEntities.add(entity);
    }
  }

  private syncAuthoredEcsMutation(entity: number, descriptor: PhysicsSyncDescriptor): void {
    const body = this.bodyForEntity(entity);
    if (body === undefined) return;
    const bodyType = rigidBodyTypeFromF32(descriptor.rigidBody.type);
    const RAPIER = this.rapierModule as RapierWorld;
    // The native body is shared, but authored and derived colliders have
    // distinct owners. Never address an authored collider by array position.
    let removedAuthoredCollider = false;
    for (const collider of this.bodyColliders(body)) {
      if (!this.derivedColliderToShape.has(collider.handle)) {
        (this.raw as RapierWorld).removeCollider(collider, true);
        removedAuthoredCollider = true;
      }
    }
    const committed = this.derivedBodies.get(entity);
    const record = this.entityMap.get(entity);
    if (record !== undefined) record.authoredDensity = descriptor.collider?.density;
    if (descriptor.collider !== undefined) {
      this.createAuthoredCollider(body, descriptor.transform, {
        ...descriptor.collider,
        density: committed?.massProperties?.mode === 'explicit' ? 0 : descriptor.collider.density,
      });
    } else if (removedAuthoredCollider) {
      this.retireRemovedColliderPairs(entity);
    }
    if (bodyType === 'static') {
      body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      this.syncAuthoredPose(entity, descriptor.transform, descriptor.collider, 'static');
    } else if (bodyType === 'kinematic') {
      body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      this.syncAuthoredPose(entity, descriptor.transform, descriptor.collider, 'kinematic');
    } else {
      body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      if (record !== undefined) record.additionalMass = Math.max(0, descriptor.rigidBody.mass);
      if (committed?.massProperties?.mode !== 'explicit') {
        this.restoreAutomaticMass(body, record?.additionalMass ?? 0);
        if (record !== undefined) record.automaticAdditionalMass = record.additionalMass;
      }
      body.setGravityScale(descriptor.rigidBody.gravityScale, true);
      body.setLinearDamping(descriptor.rigidBody.linearDamping);
      body.setAngularDamping(descriptor.rigidBody.angularDamping);
    }
    body.enableCcd(Boolean(descriptor.rigidBody.ccdEnabled));
    if (committed?.massProperties?.mode === 'explicit') {
      this.restoreCommittedMass(body, committed, 0);
    }
  }

  /** @internal ECS system bridge; consumers should register PhysicsSyncBackend. */
  _syncFromEcs(
    world: World,
    transformComponent: Component,
    globalTransformComponent = world.components.resolve('GlobalTransform'),
  ): void {
    this.assertActive('syncFromEcs');
    this.worldIdentity = world;
    if (globalTransformComponent === undefined) return;
    let state = this.syncState;
    if (
      state === undefined ||
      state.world !== world ||
      state.transformComponent !== transformComponent ||
      state.globalTransformComponent !== globalTransformComponent
    ) {
      const queryResult = world.query({
        read: [Collider],
        optional: [
          transformComponent,
          globalTransformComponent,
          RigidBody,
          CharacterController,
          ChildOf,
        ],
      });
      if (!queryResult.ok) return;
      const bodyQuery = world.query({
        read: [RigidBody],
        without: [Collider],
        optional: [transformComponent, globalTransformComponent, CharacterController, ChildOf],
      });
      if (!bodyQuery.ok) throw bodyQuery.error;
      state = {
        world,
        transformComponent,
        globalTransformComponent,
        queries: [queryResult.value, bodyQuery.value] as unknown as readonly PhysicsSyncQuery[],
        projection: createStateProjection(
          world,
          [
            transformComponent,
            globalTransformComponent,
            Collider,
            RigidBody,
            CharacterController,
            ChildOf,
            Disabled,
          ],
          [Collider, RigidBody],
        ),
        accepted: new Map(),
      };
      this.syncState = state;
    }

    const batch = state.projection.read();
    const updates: { index: number; descriptor: PhysicsSyncDescriptor | undefined }[] = [];
    for (const index of batch.indices) {
      const entity = state.projection.entity(index);
      const previous = state.accepted.get(index);
      if (previous !== undefined && previous.entity !== entity) this.removeEntity(previous.entity);
      if (entity === undefined) {
        updates.push({ index, descriptor: undefined });
        continue;
      }
      let row: PhysicsSyncQueryRow | undefined;
      for (const query of state.queries) {
        row = query.at(entity);
        if (row !== undefined) break;
      }
      if (row === undefined) {
        this.removeEntity(entity);
        updates.push({ index, descriptor: undefined });
        continue;
      }
      const descriptor = readPhysicsSyncDescriptor(
        row,
        transformComponent,
        globalTransformComponent,
      );
      const prior = previous?.entity === entity ? previous : undefined;
      const delta: PhysicsEntityDelta = {
        transformChanged: !samePhysicsValue(prior?.transform, descriptor?.transform),
        colliderChanged:
          descriptor === undefined
            ? state.projection.changed(entity, Collider)
            : !samePhysicsValue(prior?.collider, descriptor.collider),
        rigidBodyChanged:
          descriptor === undefined
            ? state.projection.changed(entity, RigidBody)
            : !samePhysicsValue(prior?.rigidBody, descriptor.rigidBody),
        characterControllerChanged:
          prior?.characterControllerOffset !== descriptor?.characterControllerOffset ||
          prior?.hasCharacterController !== descriptor?.hasCharacterController,
        characterControllerStructureChanged:
          prior?.hasCharacterController !== descriptor?.hasCharacterController,
      };
      this.reconcilePhysicsDelta(state, entity, delta);
      updates.push({ index, descriptor: descriptor ?? (this.hasBody(entity) ? prior : undefined) });
    }
    batch.accept();
    for (const { index, descriptor } of updates) {
      if (descriptor === undefined) state.accepted.delete(index);
      else state.accepted.set(index, descriptor);
    }
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
    collider: PhysicsCollider3D | undefined,
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
    this.registerBody(
      entity,
      body.handle,
      rbType === 'dynamic' ? Math.max(0, rigidBody.mass) : 0,
      collider?.density,
    );
    if (collider === undefined) {
      const record = this.entityMap.get(entity);
      // A new fragment can admit derived shapes in this same fixed step.
      // Resolve Rapier's deferred descriptor mass before rollback captures the
      // baseline, rather than comparing an uninitialized zero to restored mass.
      this.restoreAutomaticMass(body, record?.additionalMass ?? 0);
      if (record !== undefined) record.automaticAdditionalMass = record.additionalMass;
      return;
    }

    this.createAuthoredCollider(body, transform, collider);
  }

  private createAuthoredCollider(
    body: RapierRigidBody,
    transform: PhysicsTransform3D,
    collider: PhysicsCollider3D,
  ): void {
    const RAPIER = this.rapierModule;
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
    collider: PhysicsCollider3D | undefined,
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

    if (collider === undefined) return;
    const rapierCollider = this.bodyColliders(body).find(
      (shape) => !this.derivedColliderToShape.has(shape.handle),
    );
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
  registerBody(
    entity: number,
    bodyHandle: number,
    additionalMass = 0,
    authoredDensity?: number,
  ): void {
    this.entityMap.set(entity, {
      bodyHandle,
      additionalMass: Math.max(0, additionalMass),
      // `ensureBody` registers before its authored collider is attached.
      // Rapier recomputes the body from that collider and clears the
      // descriptor-only additional mass, so the native baseline is zero.
      // A later automatic derived admission records the actual additional
      // contribution after it has been applied. Keeping this separate from
      // `additionalMass` lets rollback restore native state rather than an
      // authored value that Rapier has not applied yet.
      automaticAdditionalMass: 0,
      authoredDensity:
        authoredDensity !== undefined && Number.isFinite(authoredDensity) && authoredDensity >= 0
          ? authoredDensity
          : undefined,
    });
    if (!this.derivedBodySources.has(entity)) {
      this.derivedBodySources.set(entity, { sourceKey: `entity:${entity}`, revision: 0 });
    }
    this.poseWritebackEntities.add(entity);
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
   * Write Rapier dynamic body poses back. Cost is O(awake dynamic bodies):
   * sleeping and fixed bodies are not visited, except for the bodies tracked
   * by `poseWritebackEntities`.
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
    const pending = this.poseWritebackEntities;
    const active = this.activeWritebackEntities;
    (this.raw as RapierWorld).forEachActiveRigidBody(
      (body: { userData: unknown; handle: number }) => {
        const entity = body.userData as number;
        if (this.entityMap.get(entity)?.bodyHandle !== body.handle) return;
        active.add(entity);
        pending.add(entity);
      },
    );
    for (const entity of pending) {
      const record = this.entityMap.get(entity);
      if (record === undefined) continue;
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
    pending.clear();
    this.poseWritebackEntities = active;
    this.activeWritebackEntities = pending;
    return results;
  }

  /**
   * Remove a Rapier body and its colliders when the ECS entity is despawned.
   */
  removeEntity(entity: number): void {
    const record = this.entityMap.get(entity);
    if (!record) return;
    for (const candidate of this.derivedCandidates.values()) {
      if (
        candidate.input.entity !== entity ||
        candidate.batch === undefined ||
        (candidate.state !== 'ready' && candidate.state !== 'queued')
      )
        continue;
      this.rejectPreparedCandidate(
        candidate,
        new DerivedPhysicsError(
          'derived-body-not-found',
          'all grouped bodies remain live until admission',
          'prepare a new complete group after entity reconciliation',
          { entity },
        ),
      );
    }
    const derived = this.derivedBodies.get(entity);
    if (derived !== undefined) {
      for (const shape of derived.shapes) this.removeNativeCollider(shape.colliderHandle);
      this.derivedBodies.delete(entity);
      this.derivedPublications.delete(entity);
    }
    this.derivedFailures.delete(entity);
    this.derivedPoisonedEntities.delete(entity);
    for (const [id, constraint] of this.derivedConstraints) {
      if (constraint.input.bodyA === entity || constraint.input.bodyB === entity) {
        this.removeNativeConstraint(constraint.handle);
        this.derivedConstraints.delete(id);
      }
    }
    for (const [id, candidate] of this.derivedCandidates) {
      if (candidate.input.entity !== entity) continue;
      for (const collider of candidate.nativeColliders) this.removeNativeCollider(collider.handle);
      this.pendingDerivedCandidates.delete(id);
      this.releaseDerivedCandidate(id);
    }
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
    this.derivedBodySources.delete(entity);
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
  globalTransformComponent: Component,
): PhysicsSyncDescriptor | undefined {
  const transformData = row.get(transformComponent) as
    | {
        readonly pos: Float32Array;
        readonly quat: Float32Array;
        readonly scale: Float32Array;
      }
    | undefined;
  const globalTransformData = row.get(globalTransformComponent) as
    | { readonly world: Float32Array }
    | undefined;
  const colliderData = (row.has(Collider) ? row.get(Collider) : undefined) as
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
  if (transformData === undefined || (colliderData === undefined && !row.has(RigidBody)))
    return undefined;

  // Root-local TRS is already a world pose. A ChildOf row, however, must use
  // Scene's derived GlobalTransform world matrix. Matrix contents cannot be a
  // validity sentinel: a legitimate parent/local composition can resolve to
  // identity.
  const useWorldPose = row.has(ChildOf) && hasReadableWorldPose(globalTransformData?.world);
  if (useWorldPose) {
    poseScratchWorld.set(globalTransformData.world);
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
    collider:
      colliderData === undefined
        ? undefined
        : {
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
    const globalTransformComponent = world.components.resolve('GlobalTransform');
    if (transformComponent === undefined || globalTransformComponent === undefined) return;
    let pw: RapierPhysicsWorld3D;
    try {
      pw = world.getResource<RapierPhysicsWorld3D>('PhysicsWorld');
    } catch {
      return; // C-2: PhysicsWorld resource not yet ready — safe early out
    }

    pw.applyPendingTeleports();
    pw._syncFromEcs(world, transformComponent, globalTransformComponent);
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
      const pos = [r.pos.x, r.pos.y, r.pos.z];
      const quat = [r.rotation.x, r.rotation.y, r.rotation.z, r.rotation.w];
      if (transformPoseEquals(world, entity, transformComponent, pos, quat)) continue;
      world.set(entity, transformComponent, { pos, quat });
    }
  },
});

/**
 * Skipping a bit-identical write keeps an unchanged pose out of `changed`
 * filters, so downstream transform propagation stays O(moving bodies).
 */
function transformPoseEquals(
  world: World,
  entity: EntityHandle,
  transform: Component,
  pos: readonly number[],
  quat: readonly number[],
): boolean {
  const current = world.get(entity, transform);
  if (!current.ok) return false;
  const value = current.value as unknown as { pos?: ArrayLike<number>; quat?: ArrayLike<number> };
  return f32ArrayEquals(value.pos, pos) && f32ArrayEquals(value.quat, quat);
}

function f32ArrayEquals(stored: ArrayLike<number> | undefined, next: readonly number[]): boolean {
  if (stored === undefined || stored.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (stored[index] !== Math.fround(next[index] as number)) return false;
  }
  return true;
}

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
    pw.finalizeDerivedFixedStep();
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
