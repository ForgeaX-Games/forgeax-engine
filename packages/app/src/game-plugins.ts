// game-plugins.ts — host-neutral loading of asset-resident game plugins.
//
// Hosts own discovery (filesystem/API in the editor, a Vite URL manifest in
// pure preview). This module owns the shared runtime operation: import each
// module once, record the component/system registration delta, and attach the
// registered systems to a fresh Play World. Keeping this below both hosts is
// what makes defaultScene instantiation observe the same component registry.

import type { World } from '@forgeax/engine-ecs';
import { getRegisteredComponents, getRegisteredSystems, Update } from '@forgeax/engine-ecs';
import {
  GAMEPLAY_PRODUCER_CONTRACT,
  GAMEPLAY_PRODUCER_CONTRACT_VERSION,
  type GamePluginDescriptor,
  type GamePluginDiagnostic,
  type GamePluginProducer,
  type GamePluginReloadResult,
  type GameProjectionRegistrar,
} from './game-context';

/** One host-discovered plugin URL and its stable client-facing label. */
export interface GamePluginModule {
  readonly clientPath: string;
  readonly url: string;
  readonly revision?: string;
}

/** Registration facts shared by editor Play and pure preview. */
export interface LoadedGamePlugin {
  readonly clientPath: string;
  readonly url: string;
  readonly components: string[];
  readonly systems: string[];
  readonly descriptor?: GamePluginDescriptor;
  readonly producer?: GamePluginProducer;
}

export interface GamePluginLoad {
  readonly plugins: LoadedGamePlugin[];
  readonly systems: string[];
  readonly components: string[];
  readonly errors: Array<{ clientPath: string; message: string }>;
}

export interface GamePluginSystemDiagnostic {
  readonly pluginId: string;
  readonly system: string;
  readonly status: 'registered' | 'attached' | 'missing';
}

export interface GamePluginInstallation {
  readonly descriptors: readonly GamePluginDescriptor[];
  diagnostics(): readonly GamePluginDiagnostic[];
  reload(): Promise<GamePluginReloadResult>;
  dispose(): void;
}

export type GamePluginInstallResult =
  | { readonly ok: true; readonly value: GamePluginInstallation }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: 'game-plugin-registration-failed';
        readonly pluginId: string;
        readonly hint: string;
      };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateProducer(
  value: unknown,
):
  | { readonly ok: true; readonly producer: GamePluginProducer }
  | { readonly ok: false; readonly message: string } {
  if (!isRecord(value) || typeof value.register !== 'function' || !isRecord(value.descriptor)) {
    return { ok: false, message: 'gameplay export must provide descriptor and register(context)' };
  }
  const descriptor = value.descriptor;
  if (descriptor.contract !== GAMEPLAY_PRODUCER_CONTRACT) {
    return {
      ok: false,
      message: `unsupported gameplay producer contract: ${String(descriptor.contract)}`,
    };
  }
  if (descriptor.version !== GAMEPLAY_PRODUCER_CONTRACT_VERSION) {
    return {
      ok: false,
      message: `unsupported gameplay producer contract version: ${String(descriptor.version)}`,
    };
  }
  if (typeof descriptor.id !== 'string' || descriptor.id.trim() === '') {
    return { ok: false, message: 'gameplay producer descriptor.id must be non-empty' };
  }
  if (typeof descriptor.title !== 'string' || descriptor.title.trim() === '') {
    return { ok: false, message: 'gameplay producer descriptor.title must be non-empty' };
  }
  return { ok: true, producer: value as unknown as GamePluginProducer };
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
    let imported: unknown;
    try {
      imported = await deps.importModule(module.url);
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
    let descriptor: GamePluginDescriptor | undefined;
    let producer: GamePluginProducer | undefined;
    const gameplay = isRecord(imported) ? imported.gameplay : undefined;
    if (gameplay !== undefined) {
      const validation = validateProducer(gameplay);
      if (!validation.ok) {
        errors.push({ clientPath: module.clientPath, message: validation.message });
      } else {
        producer = validation.producer;
        descriptor = producer.descriptor;
      }
    }
    plugins.push({
      clientPath: module.clientPath,
      url: module.url,
      components,
      systems,
      ...(descriptor !== undefined ? { descriptor } : {}),
      ...(producer !== undefined ? { producer } : {}),
    });
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

/** Describe every system contributed by a discovered plugin and its Play state. */
export function describeGamePluginSystems(
  load: GamePluginLoad,
  attachedSystems: readonly string[],
): readonly GamePluginSystemDiagnostic[] {
  const registered = getRegisteredSystems();
  const attached = new Set(attachedSystems);
  return load.plugins
    .flatMap((plugin) => {
      const pluginId = plugin.descriptor?.id ?? plugin.clientPath;
      return plugin.systems.map(
        (system) =>
          ({
            pluginId,
            system,
            status: attached.has(system)
              ? 'attached'
              : registered.has(system)
                ? 'registered'
                : 'missing',
          }) satisfies GamePluginSystemDiagnostic,
      );
    })
    .sort((a, b) => `${a.pluginId}:${a.system}`.localeCompare(`${b.pluginId}:${b.system}`));
}

/** Install producer-owned actions/reads and lifecycle hooks for one Play World. */
export async function installGamePluginProducers(
  load: GamePluginLoad,
  deps: { readonly world: World; readonly gameProjection?: GameProjectionRegistrar },
): Promise<GamePluginInstallResult> {
  const diagnostics: GamePluginDiagnostic[] = [];
  const cleanups: Array<{ readonly pluginId: string; readonly fn: () => void }> = [];
  const reloads: Array<{ readonly pluginId: string; readonly fn: () => void | Promise<void> }> = [];
  const descriptors = load.plugins.flatMap((plugin) =>
    plugin.descriptor ? [plugin.descriptor] : [],
  );
  let disposed = false;

  const installation: GamePluginInstallation = {
    descriptors,
    diagnostics: () => [...diagnostics],
    reload: async () => {
      if (disposed) {
        return {
          ok: false,
          error: {
            code: 'game-plugin-reload-failed',
            pluginId: 'gameplay',
            hint: 'gameplay producers are unavailable because Play has stopped',
          },
        };
      }
      const firstReload = reloads[0];
      if (!firstReload) {
        return {
          ok: false,
          error: {
            code: 'game-plugin-reload-unsupported',
            pluginId: descriptors[0]?.id ?? 'gameplay',
            hint: 'no producer-owned reload handler was registered',
          },
        };
      }
      for (const reload of reloads) {
        try {
          await reload.fn();
        } catch (error) {
          const hint = error instanceof Error ? error.message : String(error);
          diagnostics.push({
            code: 'producer-reload-failed',
            severity: 'error',
            pluginId: reload.pluginId,
            message: hint,
          });
          return {
            ok: false,
            error: { code: 'game-plugin-reload-failed', pluginId: reload.pluginId, hint },
          };
        }
      }
      return { ok: true, value: { pluginId: firstReload.pluginId, status: 'reloaded' } };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (let index = cleanups.length - 1; index >= 0; index--) {
        const cleanup = cleanups[index];
        if (!cleanup) continue;
        try {
          cleanup.fn();
        } catch (error) {
          diagnostics.push({
            code: 'producer-dispose-failed',
            severity: 'error',
            pluginId: cleanup.pluginId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      cleanups.length = 0;
      reloads.length = 0;
    },
  };

  for (const plugin of load.plugins) {
    if (!plugin.producer || !plugin.descriptor) continue;
    const pluginId = plugin.descriptor.id;
    try {
      await plugin.producer.register({
        world: deps.world,
        ...(deps.gameProjection !== undefined ? { gameProjection: deps.gameProjection } : {}),
        lifecycle: {
          registerCleanup: (fn) => {
            cleanups.push({ pluginId, fn });
            return () => {
              const index = cleanups.findIndex(
                (entry) => entry.pluginId === pluginId && entry.fn === fn,
              );
              if (index >= 0) cleanups.splice(index, 1);
            };
          },
          registerReload: (fn) => {
            reloads.push({ pluginId, fn });
            return () => {
              const index = reloads.findIndex(
                (entry) => entry.pluginId === pluginId && entry.fn === fn,
              );
              if (index >= 0) reloads.splice(index, 1);
            };
          },
        },
        report: (diagnostic) => diagnostics.push({ ...diagnostic, pluginId }),
      });
    } catch (error) {
      const hint = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        code: 'producer-registration-failed',
        severity: 'error',
        pluginId,
        message: hint,
      });
      installation.dispose();
      return { ok: false, error: { code: 'game-plugin-registration-failed', pluginId, hint } };
    }
  }
  return { ok: true, value: installation };
}
