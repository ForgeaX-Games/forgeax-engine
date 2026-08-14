import {
  assetAddCommand,
  assetInspectCommand,
  assetListCommand,
  assetVerifyCommand,
  buildCommand,
  devCommand,
  doctorCommand,
  initCommand,
  newCommand,
  previewCommand,
  shaderCheckCommand,
  testCommand,
} from './commands.js';
import type { CommandEnvelope, CommandResult, ForgeaXCommand } from './types.js';

const args = process.argv.slice(2);
const primary = args.shift();
const nested = primary === 'asset' || primary === 'shader' ? args.shift() : undefined;
const command = (
  primary === 'asset' || primary === 'shader' ? `${primary}.${nested ?? ''}` : primary
) as ForgeaXCommand | undefined;
const json = args.includes('--json');
const dryRun = args.includes('--dry-run');
const noInstall = args.includes('--no-install');

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

const optionValueIndexes = new Set(
  ['--base'].flatMap((name) => {
    const index = args.indexOf(name);
    return index < 0 ? [] : [index + 1];
  }),
);
const positionals = args.filter(
  (value, index) => !value.startsWith('--') && !optionValueIndexes.has(index),
);
const root = positionals[0] ?? process.cwd();
const commands: readonly ForgeaXCommand[] = [
  'new',
  'init',
  'doctor',
  'test',
  'dev',
  'build',
  'preview',
  'asset.add',
  'asset.verify',
  'asset.inspect',
  'asset.list',
  'shader.check',
];

async function run(value: ForgeaXCommand): Promise<CommandResult<unknown>> {
  switch (value) {
    case 'new':
      return newCommand({ root, dryRun });
    case 'init':
      return initCommand({ root, dryRun, install: !noInstall });
    case 'doctor':
      return doctorCommand({ root, json });
    case 'test':
      return testCommand({ root, json });
    case 'dev':
      return devCommand({ root, json });
    case 'build': {
      const base = option('--base');
      return buildCommand({ root, json, ...(base === undefined ? {} : { base }) });
    }
    case 'preview':
      return previewCommand({ root, json });
    case 'asset.add': {
      const path = positionals[0];
      if (path === undefined) {
        return {
          ok: false,
          error: {
            code: 'cli-parse-error',
            expected: 'forgeax asset add <path>',
            hint: 'Pass one source file or directory.',
            detail: {},
          },
        };
      }
      return assetAddCommand({ root: process.cwd(), path, dryRun, json });
    }
    case 'asset.verify':
      return assetVerifyCommand({ root: process.cwd(), json });
    case 'asset.inspect': {
      const subject = positionals[0];
      if (subject === undefined) {
        return {
          ok: false,
          error: {
            code: 'cli-parse-error',
            expected: 'forgeax asset inspect <guid-or-name>',
            hint: 'Pass a stable asset GUID or an unambiguous name.',
            detail: {},
          },
        };
      }
      return assetInspectCommand({ root: process.cwd(), subject, json });
    }
    case 'asset.list':
      return assetListCommand({ root: process.cwd(), json });
    case 'shader.check':
      return shaderCheckCommand({
        root: process.cwd(),
        json,
        ...(positionals[0] === undefined ? {} : { path: positionals[0] }),
      });
  }
}

if (command === undefined || !commands.includes(command)) {
  process.stderr.write(
    'Usage: forgeax <new|init|doctor|test|dev|build|preview> [directory]\n' +
      '       forgeax asset <add|verify|inspect|list> [subject]\n' +
      '       forgeax shader check [path]\n',
  );
  process.exitCode = 2;
} else {
  const stdoutWrite = process.stdout.write;
  if (json) {
    process.stdout.write = ((...writeArgs: Parameters<typeof process.stdout.write>) =>
      Reflect.apply(
        process.stderr.write,
        process.stderr,
        writeArgs,
      ) as boolean) as typeof process.stdout.write;
  }
  let result: CommandResult<unknown>;
  try {
    result = await run(command);
  } finally {
    process.stdout.write = stdoutWrite;
  }
  const envelope: CommandEnvelope = result.ok
    ? { schemaVersion: '1.0.0', command, ok: true, value: result.value }
    : { schemaVersion: '1.0.0', command, ok: false, error: result.error };
  if (json) stdoutWrite.call(process.stdout, `${JSON.stringify(envelope)}\n`);
  else if (result.ok) process.stdout.write(`[forgeax] ${command} ready\n`);
  else process.stderr.write(`[forgeax] ${result.error.code}: ${result.error.hint}\n`);
  if (!result.ok) process.exitCode = result.error.code === 'cli-parse-error' ? 2 : 1;
}
