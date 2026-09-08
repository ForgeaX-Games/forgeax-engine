import {
  createToolRuntime,
  type ToolContribution,
  type ToolRunOptions,
  type ToolTerminal,
} from '@forgeax/engine-tool-runtime';

export function runLibraryTool<TArgs, TResult>(
  contribution: ToolContribution<TArgs, TResult>,
  args: TArgs,
  options?: ToolRunOptions,
): Promise<ToolTerminal<TResult>> {
  return createToolRuntime([contribution]).run(contribution, args, options).terminal;
}
