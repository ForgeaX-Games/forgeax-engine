// @forgeax/engine-physics -- physicsPlugin(backend) factory (M2 / w10, plan-strategy D-5 / D-7).
//
// physicsPlugin lives in @forgeax/engine-physics (the interface package, C-9)
// and accepts an interface->backend dependency inversion (R1 / D-5): its async
// build dynamic-imports the rapier 2D / 3D backend on demand. The backends are
// declared as devDependencies in this package's package.json (a regular
// dependency would form a physics <-> rapier cycle since the backends depend on
// the interface package); the consuming app declares the real runtime dep.
//
// On WASM load / world creation failure the build returns
// err(new PluginError({ code: 'plugin-build-failed', ... })) carrying the
// originating exception as detail.cause -- this replaces the old fire-and-forget
// silent catch in create-app.ts (charter P3: physics failure is no longer
// swallowed; AI users distinguish "no physics" from "physics WASM did not
// load"). Constructing a PluginError here is the exact reason the protocol
// types had to move to the L1.5 @forgeax/engine-plugin package (R8): a bare
// structured object is not an Error instance and would not satisfy the
// Plugin.build Result<void, PluginError> contract.
//
// Plugin / PluginError / PLUGIN_EXPECTED / PLUGIN_ERROR_HINTS come from
// @forgeax/engine-plugin (L1.5); ok / err from @forgeax/engine-ecs.
//
// charter awareness:
//   P3 explicit failure: WASM load failure surfaces as a structured
//       PluginError with .code / .detail.cause, never a silent skip.
//   P4 consistent abstraction: physicsPlugin shares the same Plugin shape as
//       transform / audio -- one mental model covers every wiring.

import { err, ok } from '@forgeax/engine-ecs';
import {
  PLUGIN_ERROR_HINTS,
  PLUGIN_EXPECTED,
  type Plugin,
  PluginError,
} from '@forgeax/engine-plugin';

/** Rapier backend selector (mirrors the old CreateAppOptions.physics literal). */
export type PhysicsBackend = 'rapier-2d' | 'rapier-3d';

/**
 * Render a thrown value into a flat cause string for PluginError.detail.cause.
 *
 * The dynamic import + WASM init can throw any value (rapier WASM errors,
 * resolver failures); we surface the message when present and fall back to
 * String() so the cause is always a non-empty human-readable string.
 */
function causeString(e: unknown): string {
  if (e instanceof Error) {
    return e.message.length > 0 ? `${e.name}: ${e.message}` : e.name;
  }
  return String(e);
}

function buildFailed(cause: string): PluginError {
  return new PluginError({
    code: 'plugin-build-failed',
    expected: PLUGIN_EXPECTED['plugin-build-failed'],
    hint: PLUGIN_ERROR_HINTS['plugin-build-failed'],
    detail: {
      pluginName: 'physics',
      cause,
      failures: [{ pluginName: 'physics', cause }],
    },
  });
}

/**
 * physicsPlugin(backend) -- async build dynamic-imports the rapier backend,
 * loads the WASM module, creates the PhysicsWorld, inserts it as the
 * 'PhysicsWorld' world resource, and registers the three-phase tick systems.
 *
 * Equivalent to the old create-app.ts fire-and-forget physics block
 * (:682-723) -- but the failure is now structured (PluginError) rather than a
 * silent catch (D-5 / D-7). The resource is inserted BEFORE registering the
 * systems so moveAndSlide's moveContext resolves the 'PhysicsWorld' resource on
 * the first tick (feat-20260617 G-2 ordering).
 *
 * @param backend 'rapier-2d' or 'rapier-3d'
 */
export function physicsPlugin(backend: PhysicsBackend): Plugin {
  return {
    name: 'physics',
    async build(world) {
      try {
        if (backend === 'rapier-3d') {
          const { loadRapier3D, createRapier3DPhysicsWorld, registerPhysicsSystems } = await import(
            '@forgeax/engine-physics-rapier3d'
          );
          const rapier = await loadRapier3D();
          const pw = createRapier3DPhysicsWorld(rapier);
          world.insertResource('PhysicsWorld', pw);
          registerPhysicsSystems(world);
        } else {
          const { loadRapier2D, createRapier2DPhysicsWorld, registerPhysicsSystems2D } =
            await import('@forgeax/engine-physics-rapier2d');
          const rapier = await loadRapier2D();
          const pw = createRapier2DPhysicsWorld(rapier);
          world.insertResource('PhysicsWorld', pw);
          registerPhysicsSystems2D(world);
        }
      } catch (e) {
        return err(buildFailed(causeString(e)));
      }
      return ok(undefined);
    },
  };
}
