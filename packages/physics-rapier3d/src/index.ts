// @forgeax/engine-physics-rapier3d — Rapier 3D WASM backend barrel.
//
// Re-exports the RapierPhysicsWorld3D class, WASM loader, and three-phase tick
// systems.

export type { Rapier3DCollisionEvent } from './rapier-physics-world-3d';
export {
  createRapier3DPhysicsWorld,
  RapierPhysicsWorld3D,
  registerPhysicsSystems,
} from './rapier-physics-world-3d';
export type {
  Rapier3DBodyState,
  Rapier3DColliderState,
  Rapier3DKinematicControllerState,
  Rapier3DSimulationBody,
  Rapier3DSimulationCollider,
  Rapier3DSimulationJoint,
  Rapier3DSimulationParticipantOptions,
  Rapier3DSimulationState,
} from './simulation-participant';
export { createRapier3DSimulationParticipant } from './simulation-participant';
export type { Rapier3DModule } from './wasm-loader';
export { loadRapier3D } from './wasm-loader';
