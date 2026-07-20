#!/usr/bin/env node
// @forgeax/engine-remote/src/cli - forgeax CLI binary entry (feat-20260517 D-3
// + D-4: inspect-subcommand removed; only built-in `script` / `eval`
// remain. M2 w8: plugin discovery (discoverPlugins) deleted alongside
// routing layer removal. defaultConnect SSOT lives in
// `@forgeax/engine-types/inspector-client` and is re-exported here
// for the legacy import surface).
//
// Two-subcommand built-in dispatch:
//   - forgeax-engine-remote script  <file>
//   - forgeax-engine-remote eval    <inline-script>
//
// WebSocket client (D-3 / w18): the in-cli ~80-line `defaultConnect`
// implementation was extracted to `@forgeax/engine-types/inspector-client`
// so the engine-remote base CLI and the engine-ecs `cli-ecs` plugin bin
// (M3) share one client recipe. The Result-form `eval(script)` /
// `dispose()` surface replaces the legacy `request(method,params)` /
// `close()` shape that lived inside cli.ts.
//
// Argparse via stdlib `node:util.parseArgs` (no commander / sade / cac
// dep). Help body is produced by the package-internal `defineSubcommand`
// DSL (plan-strategy D-4 + D-7).

import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { RemoteError as RemoteErrorShape } from '@forgeax/engine-types';
import {
  type ConnectFn,
  defaultConnect,
  type InspectorClient,
} from '@forgeax/engine-types/inspector-client';
import { defineSubcommand, renderHelp, type SubcommandSpec } from './defineSubcommand';

export type { ConnectFn, InspectorClient };
export { defaultConnect };

const DEFAULT_PORT = 5732;
const DEFAULT_HOST = 'localhost';

// w8: LEGACY_INSPECT_TARGETS removed alongside plugin discovery deletion.
// ─── Subcommand spec tree (sade utils.js form) ───────────────────────────────

export const FORGEAX_CLI_SPEC: SubcommandSpec = defineSubcommand({
  name: 'forgeax-engine-remote',
  description: 'remote eval CLI - drive a running forgeax engine via JSON-RPC over WS',
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
      description: 'eval a script file against the live world/renderer/assets',
      options: [{ flag: '--help, -h', description: 'Show this help and exit 0' }],
      examples: [
        {
          usage: 'forgeax-engine-remote script ./inspect.mjs',
          description: 'eval a local script file',
        },
      ],
    }),
    defineSubcommand({
      name: 'eval',
      description: 'evaluate an inline expression against the world',
      options: [{ flag: '--help, -h', description: 'Show this help and exit 0' }],
      examples: [
        {
          usage: 'forgeax-engine-remote eval "world.inspect().entityCount"',
          description: 'inline read of world.inspect()',
        },
      ],
    }),
  ],
  extraNotes: [
    'eval is full read/write access to the live world/renderer/assets/debugAdapter; the only security boundary is whether the host started the server.',
    'Plugin discovery via PATH-prefix removed in M2 (routing layer deletion).',
    'See also: packages/remote/README.md (eval API, live roots, security model) + AI User Charter.',
  ],
});

// w8: Plugin discovery (discoverPlugins) removed alongside routing layer deletion.
// renderTopLevelHelp no longer takes plugins — only built-in commands displayed.

function renderTopLevelHelp(): string {
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

// w8: renderConsoleStartupFailed (plugin-discovery error rendering) removed.
// For unknown subcommands, a simple stderr fallback is used inline.

// --- Dispatch (test-injectable) ---

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
  const [, , subcommand, ...rest] = argv;

  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    stdoutWrite(renderTopLevelHelp());
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
      // CLI argument error (not a RemoteErrorCode — that closed union is the
      // wire/eval failure vocabulary, not a usage-error channel). Plain
      // usage message mirrors the script/eval missing-arg errors above.
      stderrWrite(
        `forgeax: unknown subcommand '${subcommand}'\n  expected: subcommand is one of: script, eval\n  hint: run 'forgeax-engine-remote --help' for usage\n  detail: '${subcommand}' is not a built-in subcommand (plugin discovery removed in M2)\n`,
      );
      return 1;
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

function inspectorErrorToStderr(e: RemoteErrorShape): string {
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
        '  expected: forgeax-engine-remote script <path-to-js-file>',
        "  hint:     e.g. 'forgeax-engine-remote script ./inspect.mjs'",
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
        '  expected: forgeax-engine-remote eval "<expression>"',
        '  hint:     e.g. \'forgeax-engine-remote eval "world.inspect().entityCount"\'',
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
    const result = await client.eval(script);
    ctx.stdoutWrite(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (isRemoteError(e)) {
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

function isRemoteError(e: unknown): e is RemoteErrorShape {
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
