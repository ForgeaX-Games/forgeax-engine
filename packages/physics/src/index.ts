// @forgeax/engine-physics — physics interface package barrel.
//
// ECS component schemas (RigidBody / Collider / CollisionEvent),
// PhysicsWorld Resource interface, PhysicsErrorCode union.
//
// Dependencies: @forgeax/engine-ecs (Component / event token),
// @forgeax/engine-math (Vec2 / Vec3 / Quat),
// @forgeax/engine-types (type utilities).

export type { CollisionEventPayload } from './collision-event';
export { CollisionEvent } from './collision-event';
export type { ColliderShape, RigidBodyType } from './components';
export {
  CharacterController,
  COLLIDER_SHAPE_CAPSULE,
  COLLIDER_SHAPE_CUBOID,
  COLLIDER_SHAPE_SPHERE,
  Collider,
  ColliderShapeValue,
  CollidingEntities,
  colliderShapeFromF32,
  RIGID_BODY_TYPE_DYNAMIC,
  RIGID_BODY_TYPE_KINEMATIC,
  RIGID_BODY_TYPE_STATIC,
  RigidBody,
  RigidBodyTypeValue,
  registerColliderRemoveListener,
  rigidBodyTypeFromF32,
} from './components';
export type { PhysicsErrorCode, PhysicsErrorDetail } from './errors';

export { PHYSICS_ERROR_HINTS, PhysicsError } from './errors';
export type { PhysicsWorld, PhysicsWorld2D, RaycastHit, RaycastHit2D } from './physics-world';
export type { PhysicsBackend } from './plugin-factory';
export { physicsPlugin } from './plugin-factory';
