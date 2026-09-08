import type { Plugin } from '@deepseek-ai/cordis';
import type { ToolContribution } from '@forgeax/engine-tool-runtime';

/** A native Cordis plugin plus the tool contributions it exposes. */
export interface ToolPlugin {
  readonly plugin: Plugin;
  readonly tools: readonly ToolContribution<unknown, unknown>[];
}

export function defineToolPlugin(
  plugin: Plugin,
  tools: readonly ToolContribution<unknown, unknown>[],
): ToolPlugin {
  return { plugin, tools: [...tools] };
}

export function isToolPlugin(value: unknown): value is ToolPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ToolPlugin>;
  return candidate.plugin !== undefined && Array.isArray(candidate.tools);
}
