// @forgeax/engine-app -- GameContext interface + GameEntry type alias.
//
// GameContext is the contract between the preview host (apps/preview/) and
// game templates (templates/game-default/). It exposes exactly 4 readonly
// fields that cover all the surface a game entry point needs: the ECS World,
// the AssetRegistry, the App handle (for lifecycle introspection), and a
// registerUpdate callback registration method.
//
// GameEntry is the template entry signature: async (ctx: GameContext) => void.
// The host awaits the Promise before calling app.start(), so templates can
// safely await async resource loading inside the entry function.
//
// Constraints from upstream:
//   - requirements D-1: GameContext wraps App handle (does NOT own frame-loop)
//   - plan-strategy D-5: GameContext is a pure interface (no factory function);
//     the host manually assembles the ctx object
//   - requirements AC-03/AC-04/AC-05: field types must be World/AssetRegistry/App
//
// Charter awareness:
//   - F1 context-limited: only 4 fields; AI users see the full contract in one screen
//   - P4 consistent abstraction: single ctx object wraps App/World/AssetRegistry

import type { World } from '@forgeax/engine-ecs';
import type { AssetRegistry } from '@forgeax/engine-runtime';

import type { App } from './types';

/**
 * Contract between preview host and game template entry point.
 *
 * Exposes exactly 4 readonly fields covering all the surface a game entry
 * point needs. The host assembles this object manually from the App handle
 * (plan-strategy D-5: no factory function).
 */
export interface GameContext {
  /** The ECS World owned by the App. Templates spawn entities and add systems here. */
  readonly world: World;
  /** The AssetRegistry owned by the Renderer. Templates register materials and load assets here. */
  readonly assets: AssetRegistry;
  /** The App handle for lifecycle introspection (e.g. app.onError). */
  readonly app: App;
  /**
   * Register a per-frame update callback. The callback receives dt (the
   * clamped delta-time in seconds) and executes between Time resource
   * injection and world.update() every frame (plan-strategy D-1).
   *
   * Delegates to FrameLoopHandle.addUpdateCallback through the App proxy
   * (plan-strategy D-2).
   */
  readonly registerUpdate: (fn: (dt: number) => void) => void;
}

/**
 * Game template entry point signature.
 *
 * The host (apps/preview/) calls `await entry(ctx)` on the resolved
 * GameEntry and starts the frame-loop afterward. Templates can safely
 * await async operations (resource loading, dynamic imports) inside
 * the entry function before the first frame runs.
 *
 * A synchronous function `(ctx) => { ... }` naturally satisfies
 * `Promise<void>` -- returning undefined is auto-wrapped by the JS
 * runtime (requirements constraint: no async keyword needed).
 */
export type GameEntry = (ctx: GameContext) => Promise<void>;
