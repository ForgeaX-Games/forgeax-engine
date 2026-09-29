import type { ExecFileOptions } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Pick<ExecFileOptions, 'windowsVerbatimArguments'>;
}

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Node cannot execute Windows .cmd shims directly. Keep that platform detail
 * at one boundary so every DevKit package-manager call behaves the same way.
 */
export function commandInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe',
): CommandInvocation {
  if (platform !== 'win32') {
    return { file: command, args, options: {} };
  }
  return {
    file: comSpec,
    args: ['/d', '/s', '/c', command, ...args],
    options: { windowsVerbatimArguments: false },
  };
}

export function execFileCommand(
  command: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<CommandOutput> {
  const invocation = commandInvocation(command, args);
  return execFileAsync(invocation.file, [...invocation.args], {
    ...options,
    encoding: 'utf8',
    ...invocation.options,
  }).then((result) => ({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }));
}
