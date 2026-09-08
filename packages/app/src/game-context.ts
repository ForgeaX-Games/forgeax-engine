// @forgeax/engine-app -- Host service for asset-resident game plugins.
//
// App, Preview, and Devkit provide one realm-local GameHost service. Project
// code default-exports a native Cordis plugin that injects this service and
// owns all non-ECS teardown through Fiber effects.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';
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
  /** Return an optional JSON-shaped result for inspection clients. */
  readonly run: (
    args: GameProjectionValue,
  ) => GameProjectionValue | void | Promise<GameProjectionValue | void>;
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
 * bootstrapping the fresh transient world; registrations are discarded when the run is disposed.
 */
export interface GameProjectionRegistrar {
  registerAction(def: GameActionDef): () => void;
  registerRead(def: GameReadDef): () => void;
}

/** Realm-local Host capability injected into an asset-resident game plugin. */
export interface GameHost {
  /** Presentation canvas owned by this Host realm. */
  readonly canvas: HTMLCanvasElement;
  /** The WebGPU Renderer (optional — some hosts may not expose it). */
  readonly renderer?: Renderer;
  /** The AssetRegistry owned by the Renderer. */
  readonly assets: AssetRegistry;
  /** The App handle for lifecycle introspection. */
  readonly app: App;
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
   * removes this whole container when the run is disposed. Absent means game
   * code falls back to `document.body`.
   */
  readonly uiRoot?: HTMLElement;
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
   * is deliberately absent outside a host that can clear registrations on disposal.
   */
  readonly gameProjection?: GameProjectionRegistrar;
}

/**
 * Provide the Host boundary to a native Cordis game plugin.
 */
export function gameHostPlugin(host: GameHost): Plugin {
  return {
    name: 'game-host',
    provide: 'gameHost',
    apply(ctx) {
      ctx.provide('gameHost', host);
    },
  };
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    gameHost?: GameHost;
  }
}
