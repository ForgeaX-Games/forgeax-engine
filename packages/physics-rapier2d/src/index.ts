// @forgeax/engine-physics-rapier2d — Rapier 2D WASM backend barrel.
//
// Re-exports the RapierPhysicsWorld2D class, WASM loader, and three-phase tick
// systems.

export {
  createRapier2DPhysicsWorld,
  RapierPhysicsWorld2D,
  registerPhysicsSystems2D,
} from './rapier-physics-world-2d';
export type { Rapier2DModule } from './wasm-loader';
export { loadRapier2D } from './wasm-loader';
