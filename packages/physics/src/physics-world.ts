// @forgeax/engine-physics — PhysicsWorld Resource interface.
//
// The physics backend (RapierPhysicsWorld3D / RapierPhysicsWorld2D) implements
// this interface and registers as the 'PhysicsWorld' World Resource.
// AI users obtain it via `world.getResource<PhysicsWorld>('PhysicsWorld')`.

import type { Vec2, Vec3 } from '@forgeax/engine-math';

/**
 * Raycast hit result — returned by `PhysicsWorld.raycast()`.
 *
 * `entity`: the entity whose collider was hit.
 * `point`: world-space hit point.
 * `normal`: world-space surface normal at hit point.
 * `timeOfImpact`: ray parameter t (origin + direction * toi = hit point).
 */
export interface RaycastHit {
  entity: number;
  point: Vec3;
  normal: Vec3;
  timeOfImpact: number;
}

/**
 * PhysicsWorld Resource interface — the engine-side API surface for physics
 * operations. Backend implementations (RapierPhysicsWorld3D/2D) satisfy this
 * contract.
 *
 * Inserted as `'PhysicsWorld'` resource by `createApp` when `opts.physics`
 * is set. AI users retrieve via `world.getResource<PhysicsWorld>('PhysicsWorld')`.
 *
 * All mutation methods are synchronous; physics step is driven by the tick
 * systems (syncBackend → stepSimulation → writeback), not by user calls.
 */
export interface PhysicsWorld {
  /** Set world gravity vector. */
  setGravity(gravity: Vec3): void;

  /** Get current world gravity vector. */
  getGravity(): Vec3;

  /**
   * Cast a ray into the physics world and return the first hit.
   *
   * @param origin - world-space ray origin.
   * @param direction - normalized world-space ray direction.
   * @param maxDist - maximum ray distance (0 = infinite).
   * @param filterMask - 32-bit packed collision filter mask (optional).
   * @returns RaycastHit on hit, undefined on miss.
   */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDist: number,
    filterMask?: number,
  ): RaycastHit | undefined;

  /**
   * Teleport a dynamic body to a position instantly, zeroing velocity.
   *
   * Use for spawning entities at specific locations or resetting after
   * out-of-bounds. Does not accumulate velocity from the displacement
   * (unlike `world.set(entity, Transform, { translation: ... })` on
   * dynamic bodies, which would cause a velocity spike).
   *
   * @param entity - the entity (must have RigidBody + Collider).
   * @param position - new world-space position.
   */
  teleport(entity: number, position: Vec3): void;

  /**
   * Move a kinematic character with collision response, slope handling,
   * auto-step, and ground-snap, then write the resolved position back to the
   * entity's `Transform` and `CharacterController.grounded`.
   *
   * This is the engine's unopinionated movement primitive (modeled on Unity
   * `CharacterController.Move`): the game layer computes `desiredDelta` from
   * input + gravity + jump, and `moveAndSlide` resolves it against the world
   * geometry. The entity must carry a `RigidBody({ type: 'kinematic' })`, a
   * `Collider`, and a `CharacterController` component.
   *
   * Tuning (offset / slope / auto-step / ground-snap) is read from the
   * `CharacterController` component each call; there is no per-call options
   * object and no `dt` parameter (the delta already encodes elapsed time).
   *
   * @param entity       the character entity (kinematic RigidBody + Collider + CharacterController).
   * @param desiredDelta the requested world-space displacement for this step.
   * @returns the actual displacement applied after collision resolution.
   * @throws PhysicsError `body-not-found` if the entity has no Rapier body,
   *   `collider-not-found` if the body has no collider,
   *   `controller-requires-kinematic` if the body is not kinematic.
   */
  moveAndSlide(entity: number, desiredDelta: Vec3): Vec3;

  /** Advance the physics simulation by one timestep. */
  step(deltaTime: number): void;

  /** Return the number of active rigid bodies in the physics world. */
  getBodyCount(): number;

  /**
   * Check whether a Rapier body exists for `entity`.
   *
   * Returns `true` after `ensureBody` has created a Rapier body for the entity
   * (which happens asynchronously via WASM fire-and-forget load + tick pipeline).
   * Always returns `false` for entities that have no `RigidBody` + `Collider`.
   *
   * AI-user contract: before calling `moveAndSlide` inside a per-frame driver,
   * guard with `if (!pw.hasBody(entity)) return;` to avoid `body-not-found`
   * errors during the window between `app.start()` and the first
   * `physicsSyncBackend` tick that builds the body.
   */
  hasBody(entity: number): boolean;
}

/** 2D raycast hit result. */
export interface RaycastHit2D {
  entity: number;
  point: Vec2;
  normal: Vec2;
  timeOfImpact: number;
}

/** 2D PhysicsWorld Resource interface. */
export interface PhysicsWorld2D {
  setGravity(gravity: Vec2): void;
  getGravity(): Vec2;
  raycast(
    origin: Vec2,
    direction: Vec2,
    maxDist: number,
    filterMask?: number,
  ): RaycastHit2D | undefined;
  teleport(entity: number, position: Vec2, rotation: number): void;
  /**
   * Move a kinematic character with collision response, slope handling,
   * auto-step, and ground-snap (2D variant of {@link PhysicsWorld.moveAndSlide}).
   *
   * Resolves `desiredDelta` against the world geometry, writes the resolved
   * position back to the entity's `Transform` and `CharacterController.grounded`,
   * and returns the actual 2D displacement. The entity must carry a
   * `RigidBody({ type: 'kinematic' })`, a `Collider`, and a `CharacterController`.
   *
   * @param entity       the character entity (kinematic RigidBody + Collider + CharacterController).
   * @param desiredDelta the requested world-space 2D displacement for this step.
   * @returns the actual 2D displacement applied after collision resolution.
   * @throws PhysicsError `body-not-found`, `collider-not-found`, or
   *   `controller-requires-kinematic` (same contract as the 3D primitive).
   */
  moveAndSlide(entity: number, desiredDelta: Vec2): Vec2;
  step(deltaTime: number): void;
  getBodyCount(): number;

  /**
   * Check whether a Rapier 2D body exists for `entity`.
   *
   * See {@link PhysicsWorld.hasBody} for the full contract — the 2D variant
   * follows the same semantics.
   */
  hasBody(entity: number): boolean;
}
