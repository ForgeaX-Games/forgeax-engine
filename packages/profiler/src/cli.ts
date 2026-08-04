import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProfileModel } from './model.js';
import { buildProfileModel } from './model.js';

export interface ProfilerCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

type CliCommand =
  | { readonly kind: 'summary' }
  | { readonly kind: 'frame'; readonly frameId: number }
  | { readonly kind: 'phase'; readonly source: 'app' | 'render'; readonly phase: string };

type CliArguments = {
  readonly command: CliCommand;
  readonly filePath?: string;
};

type CliError = {
  readonly code:
    | 'cli-arguments-invalid'
    | 'cli-input-empty'
    | 'cli-input-file-read-failed'
    | 'cli-input-invalid-json'
    | 'cli-query-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly argument?: string; readonly path?: string; readonly message: string };
};

function output(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function parsePositiveSafeInteger(value: string, argument: string): number | CliError {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return {
      code: 'cli-query-invalid',
      expected: `${argument} is a positive safe integer`,
      hint: `Pass a positive safe integer to ${argument}.`,
      detail: { argument, message: `received ${value}` },
    };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return {
      code: 'cli-query-invalid',
      expected: `${argument} is a positive safe integer`,
      hint: `Pass a positive safe integer to ${argument}.`,
      detail: { argument, message: `received ${value}` },
    };
  }
  return parsed;
}

type ParseState = {
  kind: 'summary' | 'frame' | 'phase';
  frameId: number | undefined;
  source: 'app' | 'render' | undefined;
  phase: string | undefined;
  filePath: string | undefined;
};

function consumeFlag(args: readonly string[], index: number, state: ParseState): number | CliError {
  const argument = args[index] as string;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    return {
      code: 'cli-arguments-invalid',
      expected: `${argument} is followed by a value`,
      hint: `Provide a value after ${argument}.`,
      detail: { argument, message: 'missing argument value' },
    };
  }
  if (argument === '--file') state.filePath = value;
  if (argument === '--frame-id') {
    const parsed = parsePositiveSafeInteger(value, argument);
    if (typeof parsed !== 'number') return parsed;
    state.frameId = parsed;
  }
  if (argument === '--source') {
    if (value !== 'app' && value !== 'render') {
      return {
        code: 'cli-arguments-invalid',
        expected: '--source is app or render',
        hint: 'Pass app or render as the phase source.',
        detail: { argument, message: `received ${value}` },
      };
    }
    state.source = value;
  }
  if (argument === '--phase') state.phase = value;
  return index + 2;
}

function validateCommand(state: ParseState): CliError | undefined {
  if (
    state.kind === 'summary' &&
    (state.frameId !== undefined || state.source !== undefined || state.phase !== undefined)
  ) {
    return {
      code: 'cli-arguments-invalid',
      expected: 'summary has no frame or phase selectors',
      hint: 'Use frame or phase when selecting a lower-level projection.',
      detail: { message: 'summary received a lower-level selector' },
    };
  }
  if (
    state.kind === 'frame' &&
    (state.frameId === undefined || state.source !== undefined || state.phase !== undefined)
  ) {
    return {
      code: 'cli-arguments-invalid',
      expected: 'frame requires --frame-id and no phase selectors',
      hint: 'Pass frame --frame-id <positive-safe-integer>.',
      detail: { message: 'invalid frame selector' },
    };
  }
  if (
    state.kind === 'phase' &&
    (state.source === undefined || state.phase === undefined || state.frameId !== undefined)
  ) {
    return {
      code: 'cli-arguments-invalid',
      expected: 'phase requires --source and --phase and no frame selector',
      hint: 'Pass phase --source <app|render> --phase <name>.',
      detail: { message: 'invalid phase selector' },
    };
  }
  return undefined;
}

function toCliArguments(state: ParseState): CliArguments {
  if (state.kind === 'summary') {
    return {
      command: { kind: state.kind },
      ...(state.filePath === undefined ? {} : { filePath: state.filePath }),
    };
  }
  if (state.kind === 'frame') {
    return {
      command: { kind: state.kind, frameId: state.frameId as number },
      ...(state.filePath === undefined ? {} : { filePath: state.filePath }),
    };
  }
  return {
    command: {
      kind: state.kind,
      source: state.source as 'app' | 'render',
      phase: state.phase as string,
    },
    ...(state.filePath === undefined ? {} : { filePath: state.filePath }),
  };
}

function parseArguments(args: readonly string[]): CliArguments | CliError {
  const state: ParseState = {
    kind: 'summary',
    frameId: undefined,
    source: undefined,
    phase: undefined,
    filePath: undefined,
  };
  let index = 0;
  const first = args[0];
  if (first === 'summary' || first === 'frame' || first === 'phase') {
    state.kind = first;
    index = 1;
  } else if (first !== undefined && !first.startsWith('--')) {
    return {
      code: 'cli-arguments-invalid',
      expected: 'command is summary, frame, or phase',
      hint: 'Use summary, frame --frame-id <id>, or phase --source <source> --phase <name>.',
      detail: { argument: first, message: 'unknown command' },
    };
  }
  while (index < args.length) {
    const argument = args[index] as string;
    if (!['--file', '--frame-id', '--source', '--phase'].includes(argument)) {
      return {
        code: 'cli-arguments-invalid',
        expected: 'all arguments are declared CLI flags',
        hint: 'Remove the unknown flag and use the documented summary, frame, or phase form.',
        detail: { argument, message: 'unknown argument' },
      };
    }
    const nextIndex = consumeFlag(args, index, state);
    if (typeof nextIndex !== 'number') return nextIndex;
    index = nextIndex;
  }
  return validateCommand(state) ?? toCliArguments(state);
}

function readArtifact(filePath: string | undefined, stdin: string): string | CliError {
  if (filePath !== undefined) {
    try {
      return readFileSync(filePath, 'utf8');
    } catch (error) {
      return {
        code: 'cli-input-file-read-failed',
        expected: 'the requested artifact file is readable',
        hint: 'Check the artifact path and permissions, or omit --file to read stdin.',
        detail: {
          path: filePath,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  if (stdin.trim().length === 0) {
    return {
      code: 'cli-input-empty',
      expected: 'stdin contains one ProfileCapture JSON object',
      hint: 'Pipe a ProfileCapture artifact to stdin or pass --file <path>.',
      detail: { message: 'no artifact input was provided' },
    };
  }
  return stdin;
}

function parseArtifact(input: string): unknown | CliError {
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    return {
      code: 'cli-input-invalid-json',
      expected: 'input is one JSON object',
      hint: 'Regenerate the artifact as JSON and retry.',
      detail: { message: error instanceof Error ? error.message : String(error) },
    };
  }
}

function isCliError(value: unknown): value is CliError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string' &&
    value.code.startsWith('cli-')
  );
}

function projectModel(command: CliCommand, model: ProfileModel): Record<string, unknown> {
  if (command.kind === 'summary') {
    return { query: 'summary', ...model.summary, phases: model.phases };
  }
  if (command.kind === 'frame') {
    return {
      query: 'frame',
      schemaVersion: model.summary.schemaVersion,
      captureId: model.summary.captureId,
      timeUnit: model.summary.timeUnit,
      frameId: command.frameId,
      completeness: model.completeness,
      frame: model.frames.find((entry) => entry.frameId === command.frameId) ?? null,
    };
  }
  return {
    query: 'phase',
    schemaVersion: model.summary.schemaVersion,
    captureId: model.summary.captureId,
    timeUnit: model.summary.timeUnit,
    source: command.source,
    phase: command.phase,
    completeness: model.completeness,
    phaseSummary:
      model.phases.find(
        (entry) => entry.source === command.source && entry.phase === command.phase,
      ) ?? null,
  };
}

export function runProfilerCli(args: readonly string[], stdin: string): ProfilerCliResult {
  const parsedArguments = parseArguments(args);
  if ('code' in parsedArguments) {
    return { stdout: '', stderr: output({ error: parsedArguments }), exitCode: 2 };
  }
  const input = readArtifact(parsedArguments.filePath, stdin);
  if (typeof input !== 'string') {
    return { stdout: '', stderr: output({ error: input }), exitCode: 2 };
  }
  const artifact = parseArtifact(input);
  if (isCliError(artifact)) return { stdout: '', stderr: output({ error: artifact }), exitCode: 2 };
  const model = buildProfileModel(artifact);
  if (!model.ok) return { stdout: '', stderr: output({ error: model.error }), exitCode: 1 };
  return {
    stdout: output(projectModel(parsedArguments.command, model.value)),
    stderr: '',
    exitCode: 0,
  };
}

function main(): void {
  const result = runProfilerCli(process.argv.slice(2), readFileSync(0, 'utf8'));
  if (result.stdout !== '') process.stdout.write(result.stdout);
  if (result.stderr !== '') process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  main();
}
