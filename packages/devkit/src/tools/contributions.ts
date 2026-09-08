import {
  defineTool,
  type JsonValue,
  type ToolContribution,
  type ToolDomainFailure,
} from '@forgeax/engine-tool-runtime';
import type { BuildOptions, PluginInstallOptions } from '../types.js';
import { authorPluginInstallDescriptor, projectBuildDescriptor } from './catalog.js';
import { createDomainPreviewContributions } from './preview-contributions.js';

// The historical createPreviewContributions helper is private proof code; the
// discoverable default path intentionally uses domain contributions instead.

function commandFailure(error: {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Record<string, unknown>;
}): { readonly ok: false; readonly error: ToolDomainFailure } {
  return { ok: false, error: { ...error, detail: error.detail as unknown as JsonValue } };
}

export function createBuildContribution(
  projectRoot = process.cwd(),
): ToolContribution<BuildOptions, unknown> {
  return defineTool(
    projectBuildDescriptor as typeof projectBuildDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<BuildOptions>;
    },
    async (options) => {
      const { buildCommand } = await import('../commands.js');
      const result = await buildCommand({ ...options, root: options.root ?? projectRoot });
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createAuthorContribution(
  projectRoot = process.cwd(),
): ToolContribution<PluginInstallOptions, unknown> {
  return defineTool(
    authorPluginInstallDescriptor as typeof authorPluginInstallDescriptor & {
      readonly argsSchema: import('@forgeax/engine-tool-runtime').ToolSchema<PluginInstallOptions>;
    },
    async (options) => {
      const { pluginInstallCommand } = await import('../plugin-authoring.js');
      const result = await pluginInstallCommand({ ...options, root: options.root ?? projectRoot });
      return result.ok ? result.value : commandFailure(result.error);
    },
  );
}

export function createDefaultContributions(
  projectRoot = process.cwd(),
): readonly (
  | ToolContribution<BuildOptions, unknown>
  | ToolContribution<PluginInstallOptions, unknown>
  | ToolContribution<unknown, unknown>
)[] {
  return [
    createBuildContribution(projectRoot),
    createAuthorContribution(projectRoot),
    ...createDomainPreviewContributions(),
  ];
}
