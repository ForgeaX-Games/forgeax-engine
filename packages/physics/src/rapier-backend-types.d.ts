// @forgeax/engine-physics -- ambient type declarations for rapier backend dynamic imports.
//
// physicsPlugin (plugin-factory.ts) dynamic-imports the rapier 2D / 3D
// backends at build-time. The rapier packages CANNOT be added as tsconfig
// project references (would form a package dependency cycle -- the backends
// depend on @forgeax/engine-physics), so tsc has no visibility into their
// .d.ts files at typecheck time. Without these ambient module declarations
// the dynamic import result degrades to any and noImplicitAny fires TS7016.
//
// This is a script .d.ts (no top-level import/export), so `declare module`
// introduces new module shapes rather than augmenting existing ones (TS2665).
// Type references use import() type-expressions to reach external package
// types without making this file a module.
//
// SSOT for actual signatures:
//   packages/physics-rapier3d/src/index.ts
//   packages/physics-rapier2d/src/index.ts

declare module '@forgeax/engine-physics-rapier3d' {
  export function loadRapier3D(): Promise<unknown>;
  export function createRapier3DPhysicsWorld(
    rapier: unknown,
  ): import('./physics-world').PhysicsWorld;
  export function registerPhysicsSystems(world: import('@forgeax/engine-ecs').World): void;
}

declare module '@forgeax/engine-physics-rapier2d' {
  export function loadRapier2D(): Promise<unknown>;
  export function createRapier2DPhysicsWorld(
    rapier: unknown,
  ): import('./physics-world').PhysicsWorld2D;
  export function registerPhysicsSystems2D(world: import('@forgeax/engine-ecs').World): void;
}
