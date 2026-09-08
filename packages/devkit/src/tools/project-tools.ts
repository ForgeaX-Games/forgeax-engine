import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Context, isToolPlugin, type ToolPlugin } from '@forgeax/engine-plugin';
import {
  type GamePluginEntry,
  installCatalogLoader,
  type PluginCatalog,
  type PluginRealm,
  projectPluginEntries,
} from '@forgeax/engine-plugin/loader';
import { type GameProjectPluginEntry, GameProjectSchema } from '@forgeax/engine-project';
import type {
  ToolContribution,
  ToolEvidenceKind,
  ToolRunOptions,
  ToolTerminal,
} from '@forgeax/engine-tool-runtime';
import { createServer, type ViteDevServer } from 'vite';

export interface ProjectToolBinding {
  readonly contribution: ToolContribution<unknown, unknown>;
  readonly entry: GameProjectPluginEntry;
  readonly moduleName: string;
  readonly realm: PluginRealm;
  readonly toolPlugin?: ToolPlugin;
  readonly loadToolPlugin: () => Promise<ToolPlugin>;
}

export interface ProjectToolModuleLoader {
  readonly load: (name: string) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

export interface ProjectToolDiscoveryOptions {
  readonly moduleLoader?: ProjectToolModuleLoader;
  readonly loadModules?: boolean;
}

interface ProjectPluginLeaf {
  readonly entry: GameProjectPluginEntry;
  readonly moduleName: string;
  readonly realm: PluginRealm;
}

interface StaticToolDeclaration {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly realm: PluginRealm;
  readonly argsSchema?: string;
  readonly resultSchema?: string;
  readonly evidence?: readonly ToolEvidenceKind[];
}

function projectLeaves(
  entries: readonly GameProjectPluginEntry[],
  inheritedRealm: PluginRealm = 'engine',
): ProjectPluginLeaf[] {
  const leaves: ProjectPluginLeaf[] = [];
  for (const entry of entries) {
    const realm = entry.realm ?? inheritedRealm;
    if (entry.disabled === true) continue;
    if (entry.group === true) {
      leaves.push(...projectLeaves(entry.config as readonly GameProjectPluginEntry[], realm));
      continue;
    }
    if (!entry.name.startsWith('cordis:')) {
      leaves.push({ entry, moduleName: entry.name, realm });
    }
  }
  return leaves;
}

function exportedToolPlugin(module: unknown): ToolPlugin | undefined {
  if (isToolPlugin(module)) return module;
  if (typeof module !== 'object' || module === null) return undefined;
  const value = Reflect.get(module, 'default');
  return isToolPlugin(value) ? value : undefined;
}

function staticContributions(
  entry: GameProjectPluginEntry,
): readonly ToolContribution<unknown, unknown>[] {
  if (entry.config === null || typeof entry.config !== 'object') return [];
  const tools = Reflect.get(entry.config, 'tools');
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((candidate: unknown) => {
    if (candidate === null || typeof candidate !== 'object') return [];
    const declaration = candidate as Partial<StaticToolDeclaration>;
    if (
      typeof declaration.id !== 'string' ||
      typeof declaration.title !== 'string' ||
      typeof declaration.summary !== 'string' ||
      (declaration.realm !== 'build' &&
        declaration.realm !== 'host' &&
        declaration.realm !== 'engine')
    )
      return [];
    const descriptor = {
      id: declaration.id,
      title: declaration.title,
      summary: declaration.summary,
      realm: declaration.realm,
      argsSchema: {
        parse: (value: unknown) => ({ ok: true as const, value }),
        ...(declaration.argsSchema === undefined ? {} : { describe: declaration.argsSchema }),
      },
      resultSchema: {
        parse: (value: unknown) => ({ ok: true as const, value }),
        ...(declaration.resultSchema === undefined ? {} : { describe: declaration.resultSchema }),
      },
      evidence: declaration.evidence ?? [],
    };
    return [
      {
        descriptor,
        execute: async () => ({
          ok: false as const,
          error: { code: 'tool-static-descriptor', detail: {} },
        }),
      },
    ];
  });
}

function hasStaticToolDeclarations(entry: GameProjectPluginEntry): boolean {
  if (entry.config === null || typeof entry.config !== 'object') return false;
  return Array.isArray(Reflect.get(entry.config, 'tools'));
}

async function createViteModuleLoader(root: string): Promise<ProjectToolModuleLoader> {
  const server: ViteDevServer = await createServer({
    root,
    appType: 'custom',
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  return {
    load(name) {
      const id = name.startsWith('.') ? `/@fs/${resolve(root, name)}` : name;
      return server.ssrLoadModule(id);
    },
    close: () => server.close(),
  };
}

async function readProjectEntries(root: string): Promise<readonly GameProjectPluginEntry[]> {
  const raw = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')) as unknown;
  const parsed = GameProjectSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TypeError(`Invalid forge.json: ${parsed.error.message}`);
  }
  return parsed.data.plugins ?? [];
}

export async function discoverProjectTools(
  rootInput: string,
  options: ProjectToolDiscoveryOptions = {},
): Promise<readonly ProjectToolBinding[]> {
  const root = resolve(rootInput);
  const loadModules = options.loadModules ?? true;
  const loader = loadModules
    ? (options.moduleLoader ?? (await createViteModuleLoader(root)))
    : undefined;
  try {
    const bindings: ProjectToolBinding[] = [];
    const ids = new Map<string, string>();
    for (const leaf of projectLeaves(await readProjectEntries(root))) {
      if (leaf.realm !== 'build' && leaf.realm !== 'host' && leaf.realm !== 'engine') continue;
      // Gameplay entries are part of the engine closure, not the tool catalog.  They
      // are only evaluated when they explicitly publish static tool declarations;
      // this keeps discovery from importing an unrelated gameplay module.
      if (leaf.realm === 'engine' && !hasStaticToolDeclarations(leaf.entry)) continue;
      const toolPlugin = loadModules
        ? exportedToolPlugin(await (loader as ProjectToolModuleLoader).load(leaf.moduleName))
        : undefined;
      const contributions = toolPlugin?.tools ?? staticContributions(leaf.entry);
      for (const contribution of contributions) {
        if (contribution.descriptor.realm !== leaf.realm) {
          throw new TypeError(
            `Tool ${contribution.descriptor.id} declares ${contribution.descriptor.realm} but Entry ${leaf.entry.id} owns ${leaf.realm}`,
          );
        }
        const existing = ids.get(contribution.descriptor.id);
        if (existing !== undefined) {
          throw new TypeError(
            `Duplicate project tool id ${contribution.descriptor.id} from ${existing} and ${leaf.entry.id}`,
          );
        }
        ids.set(contribution.descriptor.id, leaf.entry.id);
        bindings.push({
          contribution,
          entry: leaf.entry,
          moduleName: leaf.moduleName,
          realm: leaf.realm,
          ...(toolPlugin === undefined ? {} : { toolPlugin }),
          loadToolPlugin: async () => {
            if (toolPlugin !== undefined) return toolPlugin;
            const selectedLoader = options.moduleLoader ?? (await createViteModuleLoader(root));
            try {
              const loaded = exportedToolPlugin(await selectedLoader.load(leaf.moduleName));
              if (loaded === undefined)
                throw new TypeError(`Entry ${leaf.entry.id} does not export a ToolPlugin`);
              return loaded;
            } finally {
              await selectedLoader.close();
            }
          },
        });
      }
    }
    return bindings;
  } finally {
    if (loader !== undefined) await loader.close();
  }
}

function activationFailure(cause: unknown): ToolTerminal<never> {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    outcome: 'failed',
    failure: {
      code: 'tool-domain-failed',
      expected: 'the owning project plugin Fiber to become ready',
      hint: 'Repair the project Entry, plugin dependencies, or plugin apply failure before retrying.',
      detail: { code: 'tool-plugin-activation-failed', payload: message },
    },
    artifacts: [],
  };
}

export async function runProjectTool(
  binding: ProjectToolBinding,
  args: unknown,
  options: ToolRunOptions,
): Promise<ToolTerminal<unknown>> {
  const ctx = new Context();
  try {
    const toolPlugin = await binding.loadToolPlugin();
    const contribution = toolPlugin.tools.find(
      (candidate) => candidate.descriptor.id === binding.contribution.descriptor.id,
    );
    if (contribution === undefined)
      return activationFailure(new Error('selected tool is absent from Entry'));
    const catalog: PluginCatalog = new Map([
      [
        binding.moduleName,
        {
          realm: binding.realm,
          load: async () => ({ default: toolPlugin }),
        },
      ],
    ]);
    const { loader } = await installCatalogLoader(ctx, catalog, binding.realm);
    const entries = projectPluginEntries(
      [binding.entry as GamePluginEntry],
      binding.realm,
      binding.realm,
    );
    await loader.root.update(entries);
    await loader.await();
    const { createToolRuntime } = await import('@forgeax/engine-tool-runtime');
    const { createContextCapabilityResolver } = await import('@forgeax/engine-plugin');
    return await createToolRuntime([contribution]).run(contribution, args, {
      ...options,
      capabilityResolver: createContextCapabilityResolver(ctx),
    }).terminal;
  } catch (cause) {
    return activationFailure(cause);
  } finally {
    await ctx.fiber.dispose();
  }
}
