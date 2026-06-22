// @forgeax/engine-physics-rapier2d — Rapier 2D WASM backend barrel.
//
// Re-exports the RapierPhysicsWorld2D class, WASM loader, three-phase tick
// systems, and vector bridge utilities.

export {
  createRapier2DPhysicsWorld,
  RapierPhysicsWorld2D,
  registerPhysicsSystems2D,
} from './rapier-physics-world-2d';
export { fromRapierVec2, toRapierVec2 } from './vector-bridge';
export type { Rapier2DModule } from './wasm-loader';
export { detectSimd2D, loadRapier2D } from './wasm-loader';
