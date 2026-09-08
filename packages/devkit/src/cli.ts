import { agentOnboardingLines, renderForgeaxUsage, sdkUpdateLines } from './cli-output.js';
import {
  assetAddCommand,
  assetInspectCommand,
  assetListCommand,
  assetVerifyCommand,
  browserCaptureCommand,
  buildCommand,
  createCliRhiDebugOperationContext,
  devCommand,
  doctorCommand,
  engineDoctorCommand,
  engineStatusCommand,
  engineUnlinkCommand,
  engineUseLocalCommand,
  initCommand,
  newCommand,
  packageCommand,
  pluginInstallCommand,
  pluginUninstallCommand,
  previewCommand,
  renderRhiDebugHelp,
  runRhiDebugCommand,
  sdkInstallCommand,
  shaderCheckCommand,
  skillInstallCommand,
  skillVerifyCommand,
  testCommand,
} from './commands.js';
import type { ArtifactRef } from './rhi-debug/operations.js';
import { describeCommand, execCommand, listCommand, runCommand } from './tools/commands.js';
import {
  type CommandEnvelope,
  type CommandResult,
  type ForgeaXCommand,
  type ProjectCommandOptions,
  parseProjectPortOption,
} from './types.js';

const rawArgs = process.argv.slice(2);
const args = [...rawArgs];
const primary = args.shift();
const nested =
  primary === 'asset' ||
  primary === 'shader' ||
  primary === 'plugin' ||
  primary === 'skill' ||
  primary === 'sdk' ||
  primary === 'engine'
    ? args.shift()
    : undefined;
const command = (
  primary === 'asset' ||
  primary === 'shader' ||
  primary === 'plugin' ||
  primary === 'skill' ||
  primary === 'sdk' ||
  primary === 'engine'
    ? `${primary}.${nested ?? ''}`
    : primary
) as ForgeaXCommand | undefined;
const json = args.includes('--json');
const dryRun = args.includes('--dry-run');
const noInstall = args.includes('--no-install');
const help = rawArgs.includes('--help') || rawArgs.includes('-h');

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

const optionValueIndexes = new Set(
  [
    '--artifact',
    '--base',
    '--backend',
    '--browser',
    '--digest',
    '--id',
    '--realm',
    '--dependency',
    '--out-dir',
    '--input',
    '--output',
    '--root',
    '--port',
    '--template',
    '--height',
    '--version',
    '--wait-ms',
    '--width',
    '--work-index',
  ].flatMap((name) => {
    const index = args.indexOf(name);
    return index < 0 ? [] : [index + 1];
  }),
);
const positionals = args.filter(
  (value, index) => !value.startsWith('--') && !optionValueIndexes.has(index),
);
const scopedRoot = option('--root') ?? process.cwd();
const projectRoot = positionals[0] ?? scopedRoot;
const commands: readonly ForgeaXCommand[] = [
  'new',
  'init',
  'doctor',
  'test',
  'dev',
  'build',
  'package',
  'capture',
  'engine.status',
  'engine.use-local',
  'engine.unlink',
  'engine.doctor',
  'serve',
  'preview',
  'run',
  'plugin.install',
  'plugin.uninstall',
  'skill.install',
  'skill.verify',
  'sdk.install',
  'asset.add',
  'asset.verify',
  'asset.inspect',
  'asset.list',
  'shader.check',
  'list',
  'describe',
  'exec',
];

function projectServerOptions(): CommandResult<ProjectCommandOptions> {
  const parsedPort = parseProjectPortOption(option('--port'), args.includes('--port'));
  if (!parsedPort.ok) return parsedPort;
  return {
    ok: true,
    value: {
      root: projectRoot,
      json,
      ...(parsedPort.value === undefined ? {} : { port: parsedPort.value }),
    },
  };
}

async function run(value: ForgeaXCommand): Promise<CommandResult<unknown>> {
  switch (value) {
    case 'new': {
      const template = option('--template');
      return newCommand({
        root: projectRoot,
        dryRun,
        ...(template === undefined ? {} : { template }),
      });
    }
    case 'init':
      return initCommand({ root: projectRoot, dryRun, install: !noInstall });
    case 'doctor':
      return doctorCommand({ root: projectRoot, json });
    case 'test':
      return testCommand({ root: projectRoot, json });
    case 'dev': {
      const options = projectServerOptions();
      return options.ok ? devCommand(options.value) : options;
    }
    case 'build': {
      const base = option('--base');
      const outDir = option('--out-dir');
      return buildCommand({
        root: projectRoot,
        json,
        ...(base === undefined ? {} : { base }),
        ...(outDir === undefined ? {} : { outDir }),
      });
    }
    case 'package': {
      const output = option('--output');
      return packageCommand({
        root: projectRoot,
        json,
        ...(output === undefined ? {} : { output }),
      });
    }
    case 'capture': {
      const parsedPort = parseProjectPortOption(option('--port'), args.includes('--port'));
      if (!parsedPort.ok) return parsedPort;
      const software = args.includes('--software');
      const requestedBackend = option('--backend');
      if (
        requestedBackend !== undefined &&
        requestedBackend !== 'auto' &&
        requestedBackend !== 'software' &&
        requestedBackend !== 'hardware'
      ) {
        return {
          ok: false,
          error: {
            code: 'cli-parse-error',
            expected: '--backend to be auto, software, or hardware',
            hint: 'Use auto for a portable capture, or assert one browser rendering lane explicitly.',
            detail: { option: '--backend', received: requestedBackend },
          },
        };
      }
      if (software && requestedBackend !== undefined && requestedBackend !== 'software') {
        return {
          ok: false,
          error: {
            code: 'cli-parse-error',
            expected: '--software and --backend to select the same capture lane',
            hint: 'Use --backend software (or only the legacy --software flag).',
            detail: { software: true, backend: requestedBackend },
          },
        };
      }
      const parseInteger = (
        name: '--width' | '--height' | '--wait-ms',
        fallback: number,
        minimum: number,
        maximum: number,
      ): CommandResult<number> => {
        const raw = option(name);
        if (raw === undefined) return { ok: true, value: fallback };
        const parsed = Number(raw);
        return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
          ? { ok: true, value: parsed }
          : {
              ok: false,
              error: {
                code: 'cli-parse-error',
                expected: `${name} to be an integer from ${minimum} to ${maximum}`,
                hint: 'Pass a bounded deterministic capture value.',
                detail: { option: name, received: raw },
              },
            };
      };
      const width = parseInteger('--width', 1280, 64, 8192);
      if (!width.ok) return width;
      const height = parseInteger('--height', 720, 64, 8192);
      if (!height.ok) return height;
      const waitMs = parseInteger('--wait-ms', 4000, 0, 120_000);
      if (!waitMs.ok) return waitMs;
      const output = option('--output');
      const browser = option('--browser');
      return browserCaptureCommand({
        root: projectRoot,
        json,
        backend: requestedBackend ?? (software ? 'software' : 'auto'),
        ...(software ? { software: true } : {}),
        width: width.value,
        height: height.value,
        waitMs: waitMs.value,
        requireUi: args.includes('--require-ui'),
        deterministic: args.includes('--deterministic'),
        ...(args.includes('--headless') ? { headless: true } : {}),
        ...(parsedPort.value === undefined ? {} : { port: parsedPort.value }),
        ...(output === undefined ? {} : { output }),
        ...(browser === undefined ? {} : { browser }),
      });
    }
    case 'engine.status':
      return engineStatusCommand({ root: scopedRoot, json });
    case 'engine.use-local': {
      const path = positionals[0];
      if (path === undefined) {
        return {
          ok: false,
          error: {
            code: 'cli-parse-error',
            expected: 'forgeax engine use-local <engine-directory>',
            hint: 'Pass the local Engine source checkout or SDK source directory.',
            detail: {},
          },
        };
      }
      return engineUseLocalCommand({ root: scopedRoot, path, dryRun, json });
    }
    case 'engine.unlink':
      return engineUnlinkCommand({ root: scopedRoot, dryRun, json });
    case 'engine.doctor':
      return engineDoctorCommand({ root: scopedRoot, json });
    case 'preview': {
      const options = projectServerOptions();
      return options.ok ? previewCommand(options.value) : options;
    }
    case 'serve': {
      const options = projectServerOptions();
      return options.ok ? devCommand(options.value) : options;
    }
    case 'plugin.install': {
      const module = positionals[0];
      const id = option('--id');
      const realm = option('--realm');
      const dependency = option('--dependency');
      if (
        module === undefined ||
        id === undefined ||
        (realm !== undefined && realm !== 'host' && realm !== 'engine' && realm !== 'build')
      ) {
        return {
          ok: false,
          error: {
            code: 'cli-parse-error',
            expected: 'forgeax plugin install <module> --id <id> [--realm host|engine|build]',
            hint: 'Pass a stable Entry id and an optional physical realm.',
            detail: {},
          },
        };
      }
      return pluginInstallCommand({
        root: option('--root') ?? process.cwd(),
        module,
        id,
        dryRun,
        ...(realm === undefined ? {} : { realm }),
        ...(dependency === undefined ? {} : { dependency }),
      });
    }
    case 'plugin.uninstall': {
      const id = positionals[0];
      const dependency = option('--dependency');
      if (id === undefined) {
        return {
          ok: false,
          error: {
            code: 'cli-parse-error',
            expected: 'forgeax plugin uninstall <entry-id>',
            hint: 'Pass the stable Entry id stored in forge.json#plugins.',
            detail: {},
          },
        };
      }
      return pluginUninstallCommand({
        root: option('--root') ?? process.cwd(),
        id,
        dryRun,
        ...(dependency === undefined ? {} : { dependency }),
      });
    }
    case 'skill.install':
      return skillInstallCommand({ root: scopedRoot, json });
    case 'skill.verify':
      return skillVerifyCommand({ root: scopedRoot, json });
    case 'sdk.install': {
      const root = positionals[0];
      if (root === undefined) {
        return {
          ok: false,
          error: {
            code: 'cli-parse-error',
            expected: 'forgeax sdk install <directory> [--version VERSION]',
            hint: 'Pass an empty destination outside existing SDK and game directories.',
            detail: {},
          },
        };
      }
      const version = option('--version');
      return sdkInstallCommand({ root, ...(version === undefined ? {} : { version }) });
    }
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
    case 'list':
      return listCommand(scopedRoot);
    case 'describe':
      return describeCommand({
        root: scopedRoot,
        ...(positionals[0] === undefined ? {} : { id: positionals[0] }),
      });
    case 'exec':
      return execCommand({
        root: scopedRoot,
        ...(positionals[0] === undefined ? {} : { program: positionals[0] }),
      });
    case 'run': {
      const operation = positionals[0];
      if (operation === undefined || args.includes('--help')) {
        return { ok: true, value: { help: renderRhiDebugHelp() } };
      }
      if (!operation.startsWith('rhi.')) {
        const input = option('--input');
        return runCommand({
          root: scopedRoot,
          id: operation,
          ...(input === undefined ? {} : { input }),
        });
      }
      if (
        operation !== 'rhi.capture' &&
        operation !== 'rhi.summary' &&
        operation !== 'rhi.inspect'
      ) {
        return {
          ok: false,
          error: {
            code: 'cli-parse-error',
            expected: 'rhi.capture, rhi.summary, or rhi.inspect',
            hint: 'Run forgeax run --help to discover the three RHI debug operations.',
            detail: { operation },
          },
        };
      }
      const context = createCliRhiDebugOperationContext();
      if (operation === 'rhi.capture') return runRhiDebugCommand(operation, {}, context);
      const path = option('--artifact');
      const digest = option('--digest');
      if (path === undefined || digest === undefined) {
        return {
          ok: false,
          error: {
            code: 'cli-parse-error',
            expected: '--artifact PATH and --digest DIGEST',
            hint: 'Pass the same ArtifactRef path and digest returned by capture.',
            detail: {},
          },
        };
      }
      const artifact: ArtifactRef = { kind: 'rhi-tape', digest, source: 'forgeax', path };
      if (operation === 'rhi.summary') {
        return runRhiDebugCommand(operation, { artifact }, context);
      }
      const workIndex = Number(option('--work-index'));
      if (!Number.isInteger(workIndex) || workIndex < 0) {
        return {
          ok: false,
          error: {
            code: 'cli-parse-error',
            expected: '--work-index to be a non-negative integer',
            hint: 'Choose workIndex from rhi.summary output.',
            detail: { workIndex: option('--work-index') ?? null },
          },
        };
      }
      const fieldsOption = option('--fields');
      const fields = fieldsOption
        ?.split(',')
        .map((field) => field.trim())
        .filter((field) => field.length > 0);
      const allowedFields = new Set(['bindings', 'pipeline', 'pixels']);
      if (fields?.some((field) => !allowedFields.has(field))) {
        return {
          ok: false,
          error: {
            code: 'cli-parse-error',
            expected: '--fields to contain pipeline, bindings, and/or pixels',
            hint: 'Use a comma-separated subset such as --fields pipeline,bindings.',
            detail: { fields: fieldsOption },
          },
        };
      }
      return runRhiDebugCommand(
        operation,
        {
          artifact,
          workIndex,
          ...(fields === undefined
            ? {}
            : { fields: fields as ('bindings' | 'pipeline' | 'pixels')[] }),
        },
        context,
      );
    }
  }
}

if (help && primary !== 'run') {
  process.stdout.write(renderForgeaxUsage());
} else if (command === undefined || !commands.includes(command)) {
  process.stderr.write(renderForgeaxUsage());
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
  else if (result.ok) {
    process.stdout.write(`[forgeax] ${command} ready\n`);
    for (const line of agentOnboardingLines(result.value)) process.stdout.write(`${line}\n`);
    for (const line of sdkUpdateLines(result.value)) process.stdout.write(`${line}\n`);
    if (command === 'sdk.install') {
      const value = result.value as {
        readonly next?: { readonly cwd?: unknown; readonly argv?: readonly unknown[] };
      };
      if (
        typeof value.next?.cwd === 'string' &&
        Array.isArray(value.next.argv) &&
        value.next.argv.every((part) => typeof part === 'string')
      ) {
        process.stdout.write(`[forgeax] next cwd: ${value.next.cwd}\n`);
        process.stdout.write(`[forgeax] next: ${value.next.argv.join(' ')}\n`);
      }
    }
  } else process.stderr.write(`[forgeax] ${result.error.code}: ${result.error.hint}\n`);
  if (!result.ok) process.exitCode = result.error.code === 'cli-parse-error' ? 2 : 1;
}
