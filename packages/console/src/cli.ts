#!/usr/bin/env node
// @forgeax/engine-console/src/cli - forgeax CLI binary entry (feat-20260517 D-3
// + D-4: inspect-subcommand removed; only built-in `script` / `eval`
// remain; every other subcommand routes through PATH-prefix plugin
// discovery; defaultConnect SSOT lives in `@forgeax/engine-types/inspector-
// client` and is re-exported here for the legacy import surface).
//
// Two-subcommand built-in dispatch:
//   - forgeax-engine-console script  <file>
//   - forgeax-engine-console eval    <inline-script>
//
// Plugin discovery (kubectl 4th path; research §Finding 4): any other
// subcommand (`ecs entities`, `gltf import`, `asset scan`, etc.) is matched
// against the PATH-resolved set of `forgeax-engine-console-<sub>` shims.
// Unknown / unhealthy subcommands surface a `console-startup-failed` triple
// stderr block whose hint gently routes the user to the new plugin form
// (`did you mean 'forgeax-engine-console-ecs <subcommand>'?` for the legacy
// `inspect <target>` muscle memory; AC-12).
//
// WebSocket client (D-3 / w18): the in-cli ~80-line `defaultConnect`
// implementation was extracted to `@forgeax/engine-types/inspector-client`
// so the engine-console base CLI and the engine-ecs `cli-ecs` plugin bin
// (M3) share one client recipe. The Result-form `execute(script)` /
// `dispose()` surface replaces the legacy `request(method,params)` /
// `close()` shape that lived inside cli.ts.
//
// Argparse via stdlib `node:util.parseArgs` (no commander / sade / cac
// dep). Help body is produced by the package-internal `defineSubcommand`
// DSL (plan-strategy D-4 + D-7).

import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { InspectorError as InspectorErrorShape } from '@forgeax/engine-types';
import {
  type ConnectFn,
  defaultConnect,
  type InspectorClient,
} from '@forgeax/engine-types/inspector-client';
import { defineSubcommand, renderHelp, type SubcommandSpec } from './defineSubcommand';
import { discoverPlugins, type Plugin } from './discoverPlugins';

export type { ConnectFn, InspectorClient };
export { defaultConnect };

const DEFAULT_PORT = 5732;
const DEFAULT_HOST = 'localhost';

// Legacy `inspect <target>` migration map (AC-12). Each former built-in
// target now lives in the `forgeax-engine-console-ecs` plugin bin shipped
// by `@forgeax/engine-ecs`; the CLI surfaces a "did you mean" hint when AI
// users type the deleted form. Closed string set so a typo of the legacy
// target produces only a top-level fallthrough with no special hint.
const LEGACY_INSPECT_TARGETS: ReadonlySet<string> = new Set<string>([
  'entities',
  'components',
  'systems',
  'resources',
  'world',
  'packs',
]);

// ─── Subcommand spec tree (sade utils.js form) ───────────────────────────────

const R1_WARNING =
  'Inspector mutations route through a read-only Proxy. Wrapping calls in a try/catch swallows the denial InspectorError; the server-side accumulator deferred to v2 (feat-future-inspector-denial-accumulator) will record swallowed denials in `result.metadata.deniedOps`. Write raw script bodies without try/catch unless you intend to fallback.';

export const FORGEAX_CLI_SPEC: SubcommandSpec = defineSubcommand({
  name: 'forgeax-engine-console',
  description: 'inspector P0 CLI - observe a running forgeax engine via JSON-RPC over WS',
  options: [
    {
      flag: '--port <n>',
      description: `Inspector WebSocket port (default ${DEFAULT_PORT}; monitor uses 5731)`,
    },
    { flag: '--host <s>', description: `Host name (default ${DEFAULT_HOST})` },
    { flag: '--help, -h', description: 'Show this help and exit 0' },
  ],
  subcommands: [
    defineSubcommand({
      name: 'script',
      description: 'run a script file against the world (vm.runInContext)',
      options: [{ flag: '--help, -h', description: 'Show this help and exit 0' }],
      examples: [
        {
          usage: 'forgeax-engine-console script ./inspect.mjs',
          description: 'execute a local script file',
        },
      ],
    }),
    defineSubcommand({
      name: 'eval',
      description: 'evaluate an inline expression against the world',
      options: [{ flag: '--help, -h', description: 'Show this help and exit 0' }],
      examples: [
        {
          usage: 'forgeax-engine-console eval "world.inspect().entityCount"',
          description: 'inline read of world.inspect()',
        },
      ],
    }),
  ],
  extraNotes: [
    `WARNING (R-1): ${R1_WARNING}`,
    'External plugins land via PATH-prefix discovery (kubectl 4th path): a binary named forgeax-engine-console-<sub> is exposed as `forgeax-engine-console <sub>` and inherits stdio + exit code.',
    'See also: AGENTS.md "Inspector / Console" section + AI User Charter.',
  ],
});

// ─── Top-level help renderer (built-in vs discovered grouping) ───────────────

function renderTopLevelHelp(plugins: readonly Plugin[]): string {
  const lines: string[] = [];
  lines.push(`${FORGEAX_CLI_SPEC.name} - ${FORGEAX_CLI_SPEC.description}`);
  lines.push('');
  lines.push('Usage:');
  lines.push(`  ${FORGEAX_CLI_SPEC.name} <subcommand> [args]`);
  lines.push('');

  lines.push('Built-in commands:');
  const builtIns = FORGEAX_CLI_SPEC.subcommands ?? [];
  const builtInWidth = builtIns.reduce((m, s) => Math.max(m, s.name.length), 0);
  for (const s of builtIns) {
    const pad = ' '.repeat(builtInWidth - s.name.length + 4);
    lines.push(`  ${s.name}${pad}${s.description}`);
  }
  lines.push('');

  lines.push('Discovered plugins:');
  if (plugins.length === 0) {
    lines.push('  (none discovered on PATH; install a forgeax-engine-console-* binary)');
  } else {
    const pluginWidth = plugins.reduce((m, p) => Math.max(m, p.subcommand.length), 0);
    for (const p of plugins) {
      const pad = ' '.repeat(pluginWidth - p.subcommand.length + 4);
      const tag = p.health === 'unhealthy' ? ' [unhealthy]' : '';
      lines.push(`  ${p.subcommand}${pad}${p.path}${tag}`);
    }
  }
  lines.push('');

  if (FORGEAX_CLI_SPEC.options && FORGEAX_CLI_SPEC.options.length > 0) {
    lines.push('Options:');
    const optWidth = FORGEAX_CLI_SPEC.options.reduce((m, o) => Math.max(m, o.flag.length), 0);
    for (const o of FORGEAX_CLI_SPEC.options) {
      const pad = ' '.repeat(optWidth - o.flag.length + 4);
      lines.push(`  ${o.flag}${pad}${o.description}`);
    }
    lines.push('');
  }

  if (FORGEAX_CLI_SPEC.extraNotes && FORGEAX_CLI_SPEC.extraNotes.length > 0) {
    lines.push('Notes:');
    for (const note of FORGEAX_CLI_SPEC.extraNotes) {
      lines.push(`  ${note}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

// ─── Plugin spawn dispatch (kubectl 4th path; research §Finding 4) ───────────

function spawnPlugin(plugin: Plugin, restArgv: readonly string[]): Promise<number> {
  return new Promise<number>((resolve) => {
    const useCmdShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(plugin.path);
    const child = useCmdShim
      ? spawn('cmd.exe', ['/c', plugin.path, ...restArgv], { stdio: 'inherit' })
      : spawn(plugin.path, [...restArgv], { stdio: 'inherit' });

    const forward = (sig: NodeJS.Signals): void => {
      if (!child.killed) child.kill(sig);
    };
    const onSigint = (): void => forward('SIGINT');
    const onSigterm = (): void => forward('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    child.on('error', (err) => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        renderConsoleStartupFailed({
          subcommand: plugin.subcommand,
          path: plugin.path,
          reason: `spawn error: ${msg}`,
        }),
      );
      resolve(1);
    });
    child.on('close', (code, signal) => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      resolve(signal ? 1 : (code ?? 0));
    });
  });
}

/**
 * Compose the 3-field `console-startup-failed` stderr block. The hint copy
 * upgrades to a "did you mean forgeax-engine-console-ecs <target>" suggestion
 * whenever the offending subcommand chain is the legacy `inspect <target>`
 * form (feat-20260517 D-4 / AC-12).
 */
function renderConsoleStartupFailed(args: {
  subcommand: string;
  path?: string;
  reason: string;
  knownBuiltIns?: readonly string[];
  discovered?: readonly Plugin[];
  legacyInspectTarget?: string;
}): string {
  const builtIns = args.knownBuiltIns ?? ['script', 'eval'];
  const discoveredNames = (args.discovered ?? []).map((p) => p.subcommand);
  const knownList = [...builtIns, ...discoveredNames].join(', ');
  let hint: string;
  if (args.legacyInspectTarget !== undefined) {
    hint = `did you mean 'forgeax-engine-console-ecs ${args.legacyInspectTarget}'? (the inspect <target> built-in was removed; ECS introspection now ships as a kubectl-style plugin)`;
  } else if (args.path !== undefined) {
    hint = `chmod +x ${args.path} or reinstall the providing package; run 'forgeax-engine-console --help' to list discovered plugins`;
  } else {
    hint = `run 'forgeax-engine-console --help' to list built-in subcommands and PATH-discovered plugins (currently: ${knownList})`;
  }
  return [
    `forgeax: console-startup-failed`,
    `  expected: subcommand '${args.subcommand}' is built-in or matches a forgeax-engine-console-* binary on PATH`,
    `  hint:     ${hint}`,
    `  detail:   ${args.reason}`,
    '',
  ].join('\n');
}

// ─── Dispatch (test-injectable) ─────────────────────────────────────────────

export interface DispatchOptions {
  readonly argv: readonly string[];
  readonly stdoutWrite: (line: string) => void;
  readonly stderrWrite: (line: string) => void;
  readonly connect: ConnectFn;
  readonly fileReader?: (path: string) => Promise<string>;
}

const defaultFileReader = async (path: string): Promise<string> => {
  return await readFile(path, 'utf8');
};

export async function dispatch(opts: DispatchOptions): Promise<number> {
  const { argv, stdoutWrite, stderrWrite, connect } = opts;
  const fileReader = opts.fileReader ?? defaultFileReader;
  const plugins = discoverPlugins();
  const [, , subcommand, ...rest] = argv;

  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    stdoutWrite(renderTopLevelHelp(plugins));
    return 0;
  }

  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  const filteredRest: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--port') {
      const next = rest[i + 1];
      if (typeof next === 'string') {
        const parsed = Number(next);
        if (!Number.isNaN(parsed) && parsed > 0) {
          port = parsed;
          i++;
          continue;
        }
      }
    }
    if (arg === '--host') {
      const next = rest[i + 1];
      if (typeof next === 'string') {
        host = next;
        i++;
        continue;
      }
    }
    if (typeof arg === 'string') filteredRest.push(arg);
  }

  switch (subcommand) {
    case 'script':
      return runScript(filteredRest, {
        stdoutWrite,
        stderrWrite,
        connect,
        port,
        host,
        fileReader,
      });
    case 'eval':
      return runEval(filteredRest, { stdoutWrite, stderrWrite, connect, port, host });
    default: {
      const match = plugins.find((p) => p.subcommand === subcommand);
      if (match === undefined) {
        // Legacy inspect-subcommand muscle memory (feat-20260517 D-4 / AC-12).
        // Detect `forgeax-engine-console inspect <legacy-target>` and surface
        // the "did you mean" routing hint.
        const legacyInspectTarget =
          subcommand === 'inspect' &&
          typeof filteredRest[0] === 'string' &&
          LEGACY_INSPECT_TARGETS.has(filteredRest[0])
            ? filteredRest[0]
            : undefined;
        stderrWrite(
          renderConsoleStartupFailed({
            subcommand,
            reason: `no matching forgeax-engine-console-${subcommand} on PATH and not a built-in subcommand`,
            discovered: plugins,
            ...(legacyInspectTarget !== undefined ? { legacyInspectTarget } : {}),
          }).replace(/\n$/, ''),
        );
        return 1;
      }
      if (match.health === 'unhealthy') {
        stderrWrite(
          renderConsoleStartupFailed({
            subcommand,
            path: match.path,
            reason: `discovered binary at ${match.path} but it is not executable (chmod +x missing or wrong owner)`,
            discovered: plugins,
          }).replace(/\n$/, ''),
        );
        return 1;
      }
      return spawnPlugin(match, filteredRest);
    }
  }
}

interface RunCtx {
  readonly stdoutWrite: (line: string) => void;
  readonly stderrWrite: (line: string) => void;
  readonly connect: ConnectFn;
  readonly port: number;
  readonly host: string;
}

interface RunScriptCtx extends RunCtx {
  readonly fileReader: (path: string) => Promise<string>;
}

function inspectorErrorToStderr(e: InspectorErrorShape): string {
  return [`forgeax: ${e.code}`, `  expected: ${e.expected}`, `  hint:     ${e.hint}`].join('\n');
}

async function runScript(rest: string[], ctx: RunScriptCtx): Promise<number> {
  const [file] = rest;
  if (file === '--help' || file === '-h') {
    ctx.stdoutWrite(renderHelp(FORGEAX_CLI_SPEC, ['script']));
    return 0;
  }
  if (typeof file !== 'string') {
    ctx.stderrWrite(
      [
        'forgeax: script requires a <file> positional argument',
        '  expected: forgeax-engine-console script <path-to-js-file>',
        "  hint:     e.g. 'forgeax-engine-console script ./inspect.mjs'",
      ].join('\n'),
    );
    return 1;
  }
  let body: string;
  try {
    body = await ctx.fileReader(file);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.stderrWrite(
      [
        `forgeax: script file unreadable: ${file}`,
        '  expected: file exists and is readable',
        `  hint:     check path; underlying error: ${message}`,
      ].join('\n'),
    );
    return 1;
  }
  return invokeExecute(body, ctx);
}

async function runEval(rest: string[], ctx: RunCtx): Promise<number> {
  const [script] = rest;
  if (script === '--help' || script === '-h') {
    ctx.stdoutWrite(renderHelp(FORGEAX_CLI_SPEC, ['eval']));
    return 0;
  }
  if (typeof script !== 'string') {
    ctx.stderrWrite(
      [
        'forgeax: eval requires an inline <script> positional argument',
        '  expected: forgeax-engine-console eval "<expression>"',
        '  hint:     e.g. \'forgeax-engine-console eval "world.inspect().entityCount"\'',
      ].join('\n'),
    );
    return 1;
  }
  return invokeExecute(script, ctx);
}

async function invokeExecute(script: string, ctx: RunCtx): Promise<number> {
  const url = `ws://${ctx.host}:${ctx.port}/inspector`;
  const connectResult = await ctx.connect(url);
  if (!connectResult.ok) {
    ctx.stderrWrite(inspectorErrorToStderr(connectResult.error));
    return 1;
  }
  const client = connectResult.value;
  try {
    const result = await client.execute(script);
    ctx.stdoutWrite(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (isInspectorError(e)) {
      ctx.stderrWrite(inspectorErrorToStderr(e));
      return 1;
    }
    const message = e instanceof Error ? e.message : String(e);
    ctx.stderrWrite(
      [
        'forgeax: execute failed',
        '  expected: server-side execute() resolves Result.ok',
        `  hint:     underlying: ${message}`,
      ].join('\n'),
    );
    return 1;
  } finally {
    await client.dispose();
  }
}

function isInspectorError(e: unknown): e is InspectorErrorShape {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { expected?: unknown }).expected === 'string' &&
    typeof (e as { hint?: unknown }).hint === 'string'
  );
}

// ─── Bin entry — only runs when this module is the process entry ────────────

const isBinEntry = await (async () => {
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string') return false;
  const argv1Real = await realpath(argv1).catch(() => argv1);
  const selfReal = await realpath(fileURLToPath(import.meta.url)).catch(() =>
    fileURLToPath(import.meta.url),
  );
  return argv1Real === selfReal;
})();

if (isBinEntry) {
  const exitCode = await dispatch({
    argv: process.argv,
    stdoutWrite: (line: string) => process.stdout.write(`${line}\n`),
    stderrWrite: (line: string) => process.stderr.write(`${line}\n`),
    connect: defaultConnect,
  });
  process.exit(exitCode);
}
