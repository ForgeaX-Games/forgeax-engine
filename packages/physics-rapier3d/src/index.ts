// @forgeax/engine-physics-rapier3d — Rapier 3D WASM backend barrel.
//
// Re-exports the RapierPhysicsWorld3D class, WASM loader, and three-phase tick
// systems.

export {
  createRapier3DPhysicsWorld,
  RapierPhysicsWorld3D,
  registerPhysicsSystems,
} from './rapier-physics-world-3d';
export type { Rapier3DModule } from './wasm-loader';
export { loadRapier3D } from './wasm-loader';
