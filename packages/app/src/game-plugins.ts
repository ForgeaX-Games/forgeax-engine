// game-plugins.ts — host-neutral loading of asset-resident game plugins.
//
// Hosts own discovery (filesystem/API in the editor, a Vite URL manifest in
// pure preview). This module owns the shared runtime operation: import each
// module once, record the component/system registration delta, and attach the
// registered systems to a fresh Play World. Keeping this below both hosts is
// what makes defaultScene instantiation observe the same component registry.

import type { World } from '@forgeax/engine-ecs';
import { getRegisteredComponents, getRegisteredSystems, Update } from '@forgeax/engine-ecs';

/** One host-discovered plugin URL and its stable client-facing label. */
export interface GamePluginModule {
  readonly clientPath: string;
  readonly url: string;
}

/** Registration facts shared by editor Play and pure preview. */
export interface LoadedGamePlugin {
  readonly clientPath: string;
  readonly url: string;
  readonly components: string[];
  readonly systems: string[];
}

export interface GamePluginLoad {
  readonly plugins: LoadedGamePlugin[];
  readonly systems: string[];
  readonly components: string[];
  readonly errors: Array<{ clientPath: string; message: string }>;
}

/**
 * Import the supplied plugin modules exactly once for this JS realm.
 *
 * The caller supplies the dynamic import seam because Vite realms differ:
 * editor uses `/@fs`, preview uses its own `/preview` URL space. The registry
 * delta calculation and error contract remain one implementation.
 */
export async function loadGamePluginModules(deps: {
  readonly modules: readonly GamePluginModule[];
  readonly importModule: (url: string) => Promise<unknown>;
}): Promise<GamePluginLoad> {
  const plugins: LoadedGamePlugin[] = [];
  const errors: Array<{ clientPath: string; message: string }> = [];
  const allSystems: string[] = [];
  const allComponents: string[] = [];

  for (const module of deps.modules) {
    const beforeComps = new Map(getRegisteredComponents());
    const beforeSystems = new Map(getRegisteredSystems());
    try {
      await deps.importModule(module.url);
    } catch (error) {
      errors.push({
        clientPath: module.clientPath,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const components: string[] = [];
    for (const name of getRegisteredComponents().keys()) {
      if (!beforeComps.has(name)) components.push(name);
    }
    const systems: string[] = [];
    for (const name of getRegisteredSystems().keys()) {
      if (!beforeSystems.has(name)) systems.push(name);
    }
    plugins.push({ clientPath: module.clientPath, url: module.url, components, systems });
    allComponents.push(...components);
    allSystems.push(...systems);
  }

  return { plugins, systems: allSystems, components: allComponents, errors };
}

/** Convert a plugin import error into the Play startup terminal fact. */
export function getPlayPluginFailure(
  load: Pick<GamePluginLoad, 'errors'>,
): { code: 'play-plugin-failed'; hint: string } | null {
  const first = load.errors[0];
  if (!first) return null;
  return {
    code: 'play-plugin-failed',
    hint: `Play plugin ${first.clientPath} failed to load: ${first.message}`,
  };
}

/** Add the registered game systems to one fresh Play World. */
export function addGamePluginSystems(world: World, load: GamePluginLoad): string[] {
  const added: string[] = [];
  const registry = getRegisteredSystems();
  for (const name of load.systems) {
    const handle = registry.get(name);
    if (handle) {
      world.addSystem(Update, handle).unwrap();
      added.push(name);
    }
  }
  return added;
}
