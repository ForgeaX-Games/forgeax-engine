#!/usr/bin/env node
// @forgeax/engine-ecs/src/cli-ecs - forgeax-engine-remote-ecs plugin bin
// (feat-20260517-console-ecs-plugin-extraction · M3 w11).
//
// Migrated from @forgeax/engine-remote/src/inspect-scripts.ts (commit
// 2439e0f0~1, deleted in M2 w17). The 5 ECS IIFE script literals
// (entitiesScriptByNames / componentsScript / systemsScript /
// resourcesScript / worldScript) are carried over byte-identical so the
// W10 fixture diff stays empty under cosmetic-rename normalization.
// `packsScript` is intentionally NOT migrated - that target lives in
// `forgeax-engine-remote-asset` (@forgeax/engine-pack since 2026-05-14).
//
// Discovery: kubectl 4th-path. The base bin `forgeax-engine-console` finds
// this binary on PATH via the `forgeax-engine-remote-` prefix scan and
// forwards stdio + exit code (see packages/console/src/discoverPlugins.ts).
//
// 5 subcommands: entities / components / systems / resources / world.
// Filter flags: --with <name>, --without <name>, --port <n>, --host <s>.
//
// WS client: imports `defaultConnect` from
// `@forgeax/engine-types/inspector-client` (D-3 SSOT extracted in M1 w5)
// so cli-ecs and the console base CLI share one client recipe.

import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type ConnectFn, defaultConnect } from '@forgeax/engine-types/inspector-client';

const DEFAULT_PORT = 5732;
const DEFAULT_HOST = 'localhost';

const SUBCOMMANDS = ['entities', 'components', 'systems', 'resources', 'world'] as const;
export type EcsSubcommand = (typeof SUBCOMMANDS)[number];

// Script builders (byte-identical migration; see fixture
// packages/ecs/__tests__/__fixtures__/inspect-scripts.snapshot.ts).

export function buildEntitiesScript(
  withNames: ReadonlyArray<string>,
  withoutNames: ReadonlyArray<string>,
  componentName?: string,
): string {
  const withJson = JSON.stringify(withNames);
  const withoutJson = JSON.stringify(withoutNames);
  const compJson = JSON.stringify(componentName ?? null);
  return [
    '(() => {',
    '  const inspection = world.inspect();',
    `  const withNames = ${withJson};`,
    `  const withoutNames = ${withoutJson};`,
    `  const componentName = ${compJson};`,
    '  const matchingArchetypes = inspection.archetypes.filter((a) => {',
    '    const has = (n) => a.componentNames.includes(n);',
    '    const withOk = withNames.every(has);',
    '    const withoutOk = withoutNames.every((n) => !has(n));',
    '    return withOk && withoutOk;',
    '  });',
    '  const baseRow = (a) => ({',
    '    key: a.key,',
    '    componentNames: a.componentNames,',
    '    entityCount: a.entityCount,',
    '  });',
    '  if (componentName !== null) {',
    '    return {',
    '      matchedArchetypeCount: matchingArchetypes.length,',
    '      withFilter: withNames,',
    '      withoutFilter: withoutNames,',
    '      componentFilter: componentName,',
    '      archetypes: matchingArchetypes',
    '        .filter((a) => a.componentNames.includes(componentName))',
    '        .map(baseRow),',
    '    };',
    '  }',
    '  return {',
    '    matchedArchetypeCount: matchingArchetypes.length,',
    '    withFilter: withNames,',
    '    withoutFilter: withoutNames,',
    '    archetypes: matchingArchetypes.map(baseRow),',
    '  };',
    '})()',
  ].join('\n');
}

export function buildComponentsScript(): string {
  return [
    '(() => {',
    '  const inspection = world.inspect();',
    '  const perComponent = {};',
    '  for (const name of inspection.activeComponents) {',
    '    perComponent[name] = { name, archetypeCount: 0, entityCount: 0 };',
    '  }',
    '  for (const a of inspection.archetypes) {',
    '    for (const name of a.componentNames) {',
    '      if (!perComponent[name]) {',
    '        perComponent[name] = { name, archetypeCount: 0, entityCount: 0 };',
    '      }',
    '      perComponent[name].archetypeCount += 1;',
    '      perComponent[name].entityCount += a.entityCount;',
    '    }',
    '  }',
    '  return {',
    '    componentCount: inspection.activeComponents.length,',
    '    components: Object.values(perComponent),',
    '  };',
    '})()',
  ].join('\n');
}

export function buildSystemsScript(): string {
  return [
    '(() => {',
    '  const inspection = world.inspect();',
    '  return {',
    '    systemCount: inspection.systemCount,',
    '    systems: inspection.systems ?? [],',
    '  };',
    '})()',
  ].join('\n');
}

export function buildResourcesScript(): string {
  return [
    '(() => {',
    '  const inspection = world.inspect();',
    '  return {',
    '    resourceCount: inspection.resourceKeys.length,',
    '    resourceKeys: inspection.resourceKeys,',
    '  };',
    '})()',
  ].join('\n');
}

export function buildWorldScript(): string {
  return 'world.inspect()';
}

// Help renderer (consumed by the (g) test in
// packages/ecs/__tests__/cli-ecs-scripts.test.ts).
export function helpBody(): string {
  return [
    'forgeax-engine-remote-ecs - inspect a running forgeax ECS world via JSON-RPC over WS',
    '',
    'Usage:',
    '  forgeax-engine-remote-ecs <subcommand> [flags]',
    '',
    'Subcommands:',
    '  entities    list archetypes filtered by --with / --without component names',
    '  components  list registered components with archetype + entity rollup',
    '  systems     list registered systems (count + name list)',
    '  resources   list resource keys',
    '  world       full world.inspect() snapshot',
    '',
    'Flags:',
    '  --with <name>        include archetypes that contain <name> (entities only; repeatable)',
    '  --filter[=]<name>    alias of --with (entities only; repeatable; AC-29)',
    '  --without <name>     exclude archetypes that contain <name> (entities only; repeatable)',
    '  --component[=]<name> entities only: keep archetypes that include <name> (AC-29)',
    '  --port <n>           inspector WebSocket port (default 5732)',
    '  --host <s>           inspector host (default localhost)',
    '  --help, -h           show this help and exit 0',
    '',
    'Examples:',
    '  forgeax-engine-remote-ecs entities --with Transform',
    '  forgeax-engine-remote-ecs entities --filter=SceneInstance',
    '  forgeax-engine-remote-ecs entities --filter=SceneInstance --component=SceneInstance',
    '  forgeax-engine-remote-ecs components',
    '  forgeax-engine-remote-ecs eval-equivalent: \'forgeax-engine-console eval "world.inspect()"\' for the same payload',
    '',
  ].join('\n');
}

// ─── Argument parsing ───────────────────────────────────────────────────────

interface ParsedArgs {
  readonly subcommand: EcsSubcommand | 'help';
  readonly withNames: string[];
  readonly withoutNames: string[];
  /**
   * R2/F-1 (AC-29): when set, the `entities` subcommand restricts the
   * archetype list to those that include `componentName`. Set via the
   * `--component=<Name>` flag.
   */
  readonly componentName: string | undefined;
  readonly port: number;
  readonly host: string;
}

interface ParseResult {
  readonly ok: true;
  readonly value: ParsedArgs;
}

interface ParseError {
  readonly ok: false;
  readonly code: 'cli-parse-error' | 'unknown-subcommand';
  readonly message: string;
}

export function parseCliArgs(argv: readonly string[]): ParseResult | ParseError {
  const [first, ...rest] = argv;
  if (first === undefined || first === '--help' || first === '-h') {
    return {
      ok: true,
      value: {
        subcommand: 'help',
        withNames: [],
        withoutNames: [],
        componentName: undefined,
        port: DEFAULT_PORT,
        host: DEFAULT_HOST,
      },
    };
  }
  if (!SUBCOMMANDS.includes(first as EcsSubcommand)) {
    return {
      ok: false,
      code: 'unknown-subcommand',
      message: `unknown subcommand: ${first}; expected one of ${SUBCOMMANDS.join(', ')}`,
    };
  }
  const sub = first as EcsSubcommand;
  const withNames: string[] = [];
  const withoutNames: string[] = [];
  let componentName: string | undefined;
  let port = DEFAULT_PORT;
  let host = DEFAULT_HOST;
  // R2/F-1 (AC-29): support both space-separated and `=`-separated forms.
  // `--filter=<Name>` is an alias of `--with <Name>` (single-shot, replaces
  // the named-list semantic in the AC-29 phrasing); `--component=<Name>`
  // narrows the archetype list to those carrying <Name> AND adds it to the
  // returned rows. Both `--filter Name` and `--filter=Name` parse.
  const splitEq = (raw: string): { flag: string; value: string | undefined } => {
    const eq = raw.indexOf('=');
    if (eq === -1) return { flag: raw, value: undefined };
    return { flag: raw.slice(0, eq), value: raw.slice(eq + 1) };
  };
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    if (typeof raw !== 'string') continue;
    const { flag, value: inlineValue } = splitEq(raw);
    const next = inlineValue ?? rest[i + 1];
    const advance = inlineValue === undefined;
    if (flag === '--help' || flag === '-h') {
      return {
        ok: true,
        value: { subcommand: 'help', withNames, withoutNames, componentName, port, host },
      };
    }
    if (flag === '--with' || flag === '--filter') {
      if (typeof next !== 'string') {
        return {
          ok: false,
          code: 'cli-parse-error',
          message: `${flag} requires a component name`,
        };
      }
      withNames.push(next);
      if (advance) i++;
      continue;
    }
    if (flag === '--without') {
      if (typeof next !== 'string') {
        return {
          ok: false,
          code: 'cli-parse-error',
          message: '--without requires a component name',
        };
      }
      withoutNames.push(next);
      if (advance) i++;
      continue;
    }
    if (flag === '--component') {
      if (typeof next !== 'string') {
        return {
          ok: false,
          code: 'cli-parse-error',
          message: '--component requires a component name',
        };
      }
      componentName = next;
      if (advance) i++;
      continue;
    }
    if (flag === '--port') {
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return {
          ok: false,
          code: 'cli-parse-error',
          message: '--port requires a positive integer',
        };
      }
      port = parsed;
      if (advance) i++;
      continue;
    }
    if (flag === '--host') {
      if (typeof next !== 'string') {
        return {
          ok: false,
          code: 'cli-parse-error',
          message: '--host requires a host name',
        };
      }
      host = next;
      if (advance) i++;
      continue;
    }
    return {
      ok: false,
      code: 'cli-parse-error',
      message: `unrecognised flag: ${String(raw)}`,
    };
  }
  return {
    ok: true,
    value: { subcommand: sub, withNames, withoutNames, componentName, port, host },
  };
}

export function buildScriptForSubcommand(args: ParsedArgs): string {
  switch (args.subcommand) {
    case 'entities':
      return buildEntitiesScript(args.withNames, args.withoutNames, args.componentName);
    case 'components':
      return buildComponentsScript();
    case 'systems':
      return buildSystemsScript();
    case 'resources':
      return buildResourcesScript();
    case 'world':
      return buildWorldScript();
    case 'help':
      return '';
  }
}

// ─── Dispatch (test-injectable) ─────────────────────────────────────────────

export interface DispatchOptions {
  readonly argv: readonly string[];
  readonly stdoutWrite: (line: string) => void;
  readonly stderrWrite: (line: string) => void;
  readonly connect: ConnectFn;
}

export async function dispatch(opts: DispatchOptions): Promise<number> {
  const { argv, stdoutWrite, stderrWrite, connect } = opts;
  // argv[0] = node, argv[1] = script path; subcommand starts at argv[2].
  const parsed = parseCliArgs(argv.slice(2));
  if (!parsed.ok) {
    stderrWrite(
      [
        `forgeax: ${parsed.code}`,
        `  expected: forgeax-engine-remote-ecs <${SUBCOMMANDS.join('|')}> [flags]`,
        `  hint:     run 'forgeax-engine-remote-ecs --help' for usage`,
        `  detail:   ${parsed.message}`,
      ].join('\n'),
    );
    return 1;
  }
  if (parsed.value.subcommand === 'help') {
    stdoutWrite(helpBody());
    return 0;
  }
  const script = buildScriptForSubcommand(parsed.value);
  const url = `ws://${parsed.value.host}:${parsed.value.port}/inspector`;
  const connectResult = await connect(url);
  if (!connectResult.ok) {
    stderrWrite(
      [
        `forgeax: ${connectResult.error.code}`,
        `  expected: ${connectResult.error.expected}`,
        `  hint:     ${connectResult.error.hint}`,
      ].join('\n'),
    );
    return 1;
  }
  const client = connectResult.value;
  try {
    const result = await client.eval(script);
    stdoutWrite(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    if (isRemoteError(e)) {
      stderrWrite(
        [`forgeax: ${e.code}`, `  expected: ${e.expected}`, `  hint:     ${e.hint}`].join('\n'),
      );
      return 1;
    }
    const message = e instanceof Error ? e.message : String(e);
    stderrWrite(
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

function isRemoteError(e: unknown): e is { code: string; expected: string; hint: string } {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { expected?: unknown }).expected === 'string' &&
    typeof (e as { hint?: unknown }).hint === 'string'
  );
}

// ─── Bin entry ──────────────────────────────────────────────────────────────

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
