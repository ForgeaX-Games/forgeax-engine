// @forgeax/engine-app -- GameContext / BootstrapContext + GameEntry / BootstrapEntry type aliases.
//
// GameContext is the narrow contract between the preview host (apps/preview/)
// and game templates (templates/game-default/). It exposes exactly 4 readonly
// fields: the ECS World, the AssetRegistry, the App handle, and a
// registerUpdate callback registration method.
//
// BootstrapContext is the wider contract for the bootstrap(world, ctx?) entry
// hook (D-2: world as first-class parameter, ctx carries non-world startup
// context — renderer / defaultSceneRoot / defaultScene). The host assembles
// this object from the resolved + instantiated defaultScene before calling
// bootstrap(world, ctx).
//
// GameEntry is the legacy template entry signature: async (ctx: GameContext) => void.
// BootstrapEntry is the new entry signature: (world: World, ctx?: BootstrapContext) => void | Promise<void>.
//
// Constraints from upstream:
//   - requirements D-1: GameContext wraps App handle (does NOT own frame-loop)
//   - plan-strategy D-2: bootstrap(world, ctx?) — world first param, ctx? preserves non-world startup context
//   - plan-strategy D-5: GameContext/BootstrapContext are pure interfaces (no factory function);
//     the host manually assembles the ctx object
//
// Charter awareness:
//   - F1 context-limited: BootstrapEntry AI users see the full contract in one screen
//   - P4 consistent abstraction: single ctx object wraps App/AssetRegistry, world as explicit first param

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-runtime';
import type { SceneAsset } from '@forgeax/engine-types';

import type { App } from './types';

/** JSON-shaped data a game may intentionally project through a host bridge. */
export type GameProjectionValue =
  | null
  | boolean
  | number
  | string
  | GameProjectionValue[]
  | { [key: string]: GameProjectionValue };

/** Lightweight, host-agnostic argument schema for a game-owned action. */
export interface GameActionArgsSchema {
  readonly type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  readonly properties?: Record<string, GameActionArgsSchema>;
  readonly required?: string[];
  readonly enum?: GameProjectionValue[];
  readonly items?: GameActionArgsSchema;
  readonly nullable?: boolean;
  readonly description?: string;
}

/**
 * A Play-only capability owned by game code. The host may discover and invoke it,
 * but never supplies its gameplay semantics or reaches into the game World.
 */
export interface GameActionDef {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly argsSchema?: GameActionArgsSchema;
  readonly run: (args: GameProjectionValue) => void | Promise<void>;
}

/** A named, serializable Play-only read projection owned by game code. */
export interface GameReadDef {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly read: () => GameProjectionValue | Promise<GameProjectionValue>;
}

/**
 * Host-provided registration sink for one Play run. Games receive this only while
 * bootstrapping the fresh transient world; registrations are discarded on Stop.
 */
export interface GameProjectionRegistrar {
  registerAction(def: GameActionDef): () => void;
  registerRead(def: GameReadDef): () => void;
}

/**
 * Narrow contract between preview host and game template entry point.
 *
 * Exposes exactly 4 readonly fields covering all the surface a legacy
 * GameEntry needs. The host assembles this object manually from the App
 * handle (plan-strategy D-5: no factory function).
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
  /**
   * Controlled UI container for this run. Games must mount their DOM UI here
   * (`(ctx.uiRoot ?? document.body).appendChild(el)`) instead of appending
   * directly to `document.body`. In the embedded editor viewport the host
   * removes this whole container on ■ Stop — a single disposable boundary that
   * makes UI-remnant-after-stop structurally impossible (the ECS-surgical undo
   * in run-lifecycle cannot reach DOM). Absent → fall back to `document.body`.
   */
  readonly uiRoot?: HTMLElement;
  /**
   * Register a teardown callback for non-DOM side effects that outlive the ECS
   * world (`removeEventListener` / `AudioContext.close` / `clearTimeout` /
   * `cancelAnimationFrame`). The host flushes these on ■ Stop, in reverse
   * registration order. Absent → the host does not support teardown (e.g. a
   * reload-on-stop host); games should still register defensively.
   */
  readonly registerCleanup?: (fn: () => void) => void;
}

/**
 * Wider context for the bootstrap(world, ctx?) entry hook (plan-strategy D-2).
 *
 * world is the first parameter of bootstrap — not a field of this context.
 * The remaining surface is everything a game needs from the host after the
 * world already carries the defaultScene entities: the Renderer (optional,
 * some hosts may not provide it), the AssetRegistry, the App handle, and a
 * registerUpdate callback. Optional defaultSceneRoot / defaultScene fields
 * carry the host-instantiated scene when a defaultScene exists in forge.json.
 */
export interface BootstrapContext {
  /** The WebGPU Renderer (optional — some hosts may not expose it). */
  readonly renderer?: Renderer;
  /** The AssetRegistry owned by the Renderer. */
  readonly assets: AssetRegistry;
  /** The App handle for lifecycle introspection. */
  readonly app: App;
  /** Register a per-frame update callback (delegates to FrameLoopHandle). */
  readonly registerUpdate: (fn: (dt: number) => void) => void;
  /** Synthetic root entity of the host-instantiated defaultScene. Carries the
   * SceneInstance component. Absent when the game has no defaultScene. */
  readonly defaultSceneRoot?: EntityHandle;
  /** The loaded SceneAsset payload for the defaultScene. Contains the
   * author-side entity list with Name components. Absent when the game has
   * no defaultScene. */
  readonly defaultScene?: SceneAsset;
  /**
   * Controlled UI container for this run. Games must mount their DOM UI here
   * (`(ctx.uiRoot ?? document.body).appendChild(el)`) instead of appending
   * directly to `document.body`. In the embedded editor viewport the host
   * removes this whole container on ■ Stop — a single disposable boundary that
   * makes UI-remnant-after-stop structurally impossible (the ECS-surgical undo
   * in run-lifecycle cannot reach DOM). Absent → fall back to `document.body`.
   */
  readonly uiRoot?: HTMLElement;
  /**
   * Register a teardown callback for non-DOM side effects that outlive the ECS
   * world (`removeEventListener` / `AudioContext.close` / `clearTimeout` /
   * `cancelAnimationFrame`). The host flushes these on ■ Stop, in reverse
   * registration order. Absent → the host does not support teardown (e.g. a
   * reload-on-stop host); games should still register defensively.
   */
  readonly registerCleanup?: (fn: () => void) => void;
  /**
   * M2 D-3: command-set pointer-lock gate. The game template calls this
   * when the view mode changes (e.g. `setPointerLockAllowed(mode === 'fps')`
   * to allow lock in FPS, disallow in top-down). The host wires this to
   * App.input.setPointerLockAllowed?.() which delegates to the input backend.
   * Absent → the host does not support pointer-lock gating (e.g. a host
   * that only runs top-down games).
   */
  readonly setPointerLockAllowed?: (allowed: boolean) => void;
  /**
   * Optional Play-only projection seam. A game registers its own action and read
   * capabilities here; the host may only discover/invoke/read those closures. It
   * is deliberately absent outside a host that can clear registrations on Stop.
   */
  readonly gameProjection?: GameProjectionRegistrar;
}

/**
 * Legacy game template entry point signature.
 *
 * The host (apps/preview/) calls `await entry(ctx)` on the resolved
 * GameEntry and starts the frame-loop afterward.
 */
export type GameEntry = (ctx: GameContext) => Promise<void>;

/**
 * New bootstrap entry hook signature (plan-strategy D-2).
 *
 * World is the first-class parameter. The optional second parameter carries
 * non-world startup context (renderer, defaultSceneRoot, defaultScene, etc.).
 * The host must call bootstrap AFTER instantiating the defaultScene (when one
 * exists), and must pass the world that already contains the instantiated
 * entities.
 *
 * A synchronous function `(world, ctx) => { ... }` naturally satisfies
 * `void | Promise<void>` — returning undefined is auto-wrapped by the JS
 * runtime.
 */
export type BootstrapEntry = (world: World, ctx?: BootstrapContext) => void | Promise<void>;
