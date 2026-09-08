import {
  createToolRuntime,
  type ToolContribution,
  type ToolRunOptions,
  type ToolTerminal,
} from '@forgeax/engine-tool-runtime';
import {
  createProjectToolCatalogAuthority,
  createRealmDispatch,
  describeTool,
  listTools,
  loadToolCatalog,
  type ToolCatalogEntry,
  type ToolRealmOwner,
} from './catalog.js';
import { decorateResourcePreviewTerminal } from './cli-adapter.js';
import { retiredPreviewTool } from './preview-migration.js';
import type { ProjectToolBinding, ProjectToolDiscoveryOptions } from './project-tools.js';

export interface ToolClientOptions extends ProjectToolDiscoveryOptions {
  readonly projectRoot: string;
  /** Optional physical realm owners used by a host/carrier integration. */
  readonly realmOwners?: readonly ToolRealmOwner[];
  /** Injectable builtins for physical host tests and alternate Engine adapters. */
  readonly baseContributions?: readonly ToolContribution[];
  readonly projectDiscovery?: (projectRoot: string) => Promise<readonly ProjectToolBinding[]>;
}

export interface ToolClient {
  readonly list: () => readonly ToolCatalogEntry[];
  readonly describe: (id: string) => ToolCatalogEntry | undefined;
  readonly run: <TResult = unknown>(
    id: string,
    args: unknown,
    options?: ToolRunOptions,
  ) => Promise<ToolTerminal<TResult>>;
}

function missingTool(id: string): ToolTerminal<never> {
  return {
    outcome: 'failed',
    failure: {
      code: 'tool-capability-unavailable',
      expected: `tool ${id} to exist in the project-derived catalog`,
      hint: 'Run tool list and choose one of the discovered operation ids.',
      detail: { capability: `tool:${id}`, realm: 'build' },
    },
    artifacts: [],
  };
}

export async function createToolClient(options: ToolClientOptions): Promise<ToolClient> {
  const projectDiscovery = options.projectDiscovery;
  const runProjectTool =
    projectDiscovery === undefined
      ? (await import('./project-tools.js')).runProjectTool
      : undefined;
  const builtins =
    options.baseContributions ??
    (await import('./contributions.js')).createDefaultContributions(options.projectRoot);
  const project =
    projectDiscovery === undefined
      ? await (await import('./project-tools.js')).discoverProjectTools(
          options.projectRoot,
          options,
        )
      : await projectDiscovery(options.projectRoot);
  const contributions = [...builtins, ...project.map(({ contribution }) => contribution)];
  const runtime =
    options.baseContributions === undefined
      ? (await import('./runtime.js')).createDevkitToolRuntime(contributions as readonly unknown[])
      : createToolRuntime(contributions as readonly unknown[]);
  const realmDispatch =
    options.realmOwners === undefined
      ? undefined
      : createRealmDispatch(contributions as readonly ToolContribution[], options.realmOwners);
  const bindingById = new Map<string, ProjectToolBinding>(
    project.map((binding) => [binding.contribution.descriptor.id, binding]),
  );
  const descriptors = runtime.list();
  const loaded = await loadToolCatalog(
    createProjectToolCatalogAuthority(options.projectRoot, descriptors),
    descriptors,
  );
  if (!loaded.ok) throw loaded.error;
  return {
    list: () => listTools(loaded.value),
    describe: (id) => describeTool(loaded.value, id),
    async run<TResult = unknown>(id: string, args: unknown, runOptions: ToolRunOptions = {}) {
      if (id === 'preview.run') return retiredPreviewTool() as ToolTerminal<TResult>;
      const contribution = runtime.get(id);
      if (contribution === undefined) return missingTool(id) as ToolTerminal<TResult>;
      const binding = bindingById.get(id);
      const terminal =
        binding !== undefined && runProjectTool !== undefined
          ? await runProjectTool(binding, args, runOptions)
          : realmDispatch === undefined
            ? await runtime.run(contribution, args, runOptions).terminal
            : await realmDispatch.run(id, args, runOptions);
      return decorateResourcePreviewTerminal(terminal as ToolTerminal<TResult>);
    },
  };
}
