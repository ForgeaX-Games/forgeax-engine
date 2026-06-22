// @forgeax/engine-physics-rapier3d — Rapier 3D WASM backend barrel.
//
// Re-exports the RapierPhysicsWorld3D class, WASM loader, three-phase tick
// systems, and vector bridge utilities.

export {
  createRapier3DPhysicsWorld,
  RapierPhysicsWorld3D,
  registerPhysicsSystems,
} from './rapier-physics-world-3d';
export { fromRapierQuat, fromRapierVec3, toRapierQuat, toRapierVec3 } from './vector-bridge';
export type { Rapier3DModule } from './wasm-loader';
export { detectSimd3D, loadRapier3D } from './wasm-loader';
