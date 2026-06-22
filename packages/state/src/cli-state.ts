#!/usr/bin/env node
// @forgeax/engine-state/src/cli-state - forgeax-engine-console-state plugin bin
// (feat-20260616-engine-state-and-state-scoped-entities M6 / m6w2).
//
// Two subcommands:
//   state list  — iterates getRegisteredTokens() and prints name + variants + current state
//   state get <name> — calls getState and prints the variant string
//
// Discovery: kubectl 4th-path. The base bin `forgeax-engine-console` finds
// this binary on PATH via the `forgeax-engine-console-` prefix scan and
// forwards stdio + exit code (see packages/console/src/discoverPlugins.ts).
//
// The `connect` field in DispatchOptions is optional — this CLI plugin reads
// from a directly supplied World reference (not through JSON-RPC over WS)
// because state introspection is a local ECS operation, not a remote inspector
// call. When the bin is invoked via PATH discovery from the base console CLI,
// stdin forwarding is the standard plugin channel; the World reference is
// provided by `world` in the script context injected via `vm.runInContext`.
//
// Decision anchors:
// - M6 spec: console state list iterates getRegisteredTokens()
// - M6 spec: console state get <name> calls getState and prints variant string
// - plan-strategy: cli-state reflects the state registry (M2) + current state (M2)
// - Console plugin pattern: argv-based dispatch with stdoutWrite/stderrWrite

import type { World } from '@forgeax/engine-ecs';
import type { StateToken } from './define-state';
import { getRegisteredTokens } from './define-state';
import { countScopedEntitiesByVariant } from './scoped-component';
import { getPreviousState, getState } from './set-next-state';

// ─── Dispatch options (test-injectable) ─────────────────────────────────────

export interface DispatchOptions {
  readonly argv: readonly string[];
  readonly stdoutWrite: (line: string) => void;
  readonly stderrWrite: (line: string) => void;
  readonly world: World;
}

// ─── Help renderer ──────────────────────────────────────────────────────────

function helpBody(): string {
  return [
    'forgeax-engine-console-state - inspect forgeax state machines',
    '',
    'Usage:',
    '  forgeax-engine-console-state <subcommand> [args]',
    '',
    'Subcommands:',
    '  list           list all registered tokens: name, current, previous, default, variants',
    '  get <name>     print one token: current, previous, default, variants + per-variant scoped entity counts',
    '',
    'Flags:',
    '  --help, -h     show this help and exit 0',
    '',
    'Examples:',
    '  forgeax-engine-console-state list',
    '  forgeax-engine-console-state get LevelId',
    '',
  ].join('\n');
}

function subcommandHelp(subcommand: string): string {
  if (subcommand === 'list') {
    return [
      'forgeax-engine-console-state list - list all registered state tokens',
      '',
      'Usage:',
      '  forgeax-engine-console-state list',
      '',
      'Output format: one line per token:',
      '  <tokenName>: <current> (previous: <previous>, default: <default>, variants: <v1>, <v2>, ...)',
      '',
      'Examples:',
      '  forgeax-engine-console-state list',
      '',
    ].join('\n');
  }
  if (subcommand === 'get') {
    return [
      'forgeax-engine-console-state get - inspect one state token',
      '',
      'Usage:',
      '  forgeax-engine-console-state get <tokenName>',
      '',
      'Output: current / previous / default variant, the full variants list,',
      'and the count of ScopedTo entities currently scoped to each variant.',
      '',
      'Examples:',
      '  forgeax-engine-console-state get LevelId',
      '  #   current:  main-menu',
      '  #   previous: main-menu',
      '  #   default:  main-menu',
      '  #   variants: main-menu (0), tutorial (0), street-a (0)',
      '',
    ].join('\n');
  }
  return helpBody();
}

// ─── Subcommand impl ────────────────────────────────────────────────────────

function runList(world: World, stdout: (line: string) => void): void {
  const tokens = getRegisteredTokens();
  if (tokens.size === 0) {
    stdout('(no state tokens registered)');
    return;
  }
  for (const [, token] of tokens) {
    const current = getCurrentStateString(world, token);
    const previous = getPreviousStateString(world, token);
    const variantsStr = (token.variants as readonly string[]).join(', ');
    stdout(
      `${token.name}: ${current} (previous: ${previous}, default: ${token.defaultValue}, variants: ${variantsStr})`,
    );
  }
}

function runGet(
  world: World,
  tokenName: string,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): number {
  const tokens = getRegisteredTokens();
  const token = tokens.get(tokenName);
  if (token === undefined) {
    stderr(
      [
        `forgeax: unknown state token "${tokenName}"`,
        `  expected: one of ${[...tokens.keys()].map((k) => `"${k}"`).join(', ') || '(none registered)'}`,
        "  hint:     use 'forgeax-engine-console-state list' to see registered tokens",
      ].join('\n'),
    );
    return 1;
  }

  const result = getState(world, token);
  if (!result.ok) {
    stderr(
      [
        `forgeax: ${result.error.code}`,
        `  expected: ${result.error.expected}`,
        `  hint:     ${result.error.hint}`,
      ].join('\n'),
    );
    return 1;
  }

  const previous = getPreviousStateString(world, token);
  const counts = countScopedEntitiesByVariant(world, token);
  const variantsLine = (token.variants as readonly string[])
    .map((v, i) => `${v} (${counts[i] ?? 0})`)
    .join(', ');

  stdout(`current:  ${result.value}`);
  stdout(`previous: ${previous}`);
  stdout(`default:  ${token.defaultValue}`);
  stdout(`variants: ${variantsLine}`);
  return 0;
}

function getCurrentStateString(world: World, token: StateToken): string {
  const result = getState(world, token);
  if (result.ok) return result.value;
  return '<error>';
}

function getPreviousStateString(world: World, token: StateToken): string {
  const result = getPreviousState(world, token);
  if (result.ok) return result.value;
  return '<error>';
}

// ─── Dispatch (test-injectable) ─────────────────────────────────────────────

export async function dispatch(opts: DispatchOptions): Promise<number> {
  const { argv, stdoutWrite, stderrWrite, world } = opts;
  // argv[0] = node, argv[1] = script path; subcommand starts at argv[2].
  const args = argv.slice(2);
  const subcommand = args[0];

  if (subcommand === undefined) {
    stderrWrite('forgeax: expected subcommand (list or get); use --help for usage');
    return 1;
  }

  if (subcommand === '--help' || subcommand === '-h') {
    stdoutWrite(helpBody());
    return 0;
  }

  if (subcommand === 'list') {
    const listArgs = args.slice(1);
    if (listArgs[0] === '--help' || listArgs[0] === '-h') {
      stdoutWrite(subcommandHelp('list'));
      return 0;
    }
    runList(world, stdoutWrite);
    return 0;
  }

  if (subcommand === 'get') {
    const getArgs = args.slice(1);
    if (getArgs[0] === '--help' || getArgs[0] === '-h') {
      stdoutWrite(subcommandHelp('get'));
      return 0;
    }
    const tokenName = getArgs[0];
    if (tokenName === undefined) {
      stderrWrite(
        [
          'forgeax: state get requires a <tokenName> positional argument',
          '  expected: forgeax-engine-console-state get <tokenName>',
          "  hint:     use 'forgeax-engine-console-state list' to see registered tokens",
        ].join('\n'),
      );
      return 1;
    }
    return runGet(world, tokenName, stdoutWrite, stderrWrite);
  }

  stderrWrite(
    [
      `forgeax: unknown subcommand "${subcommand}"`,
      '  expected: list or get',
      "  hint:     run 'forgeax-engine-console-state --help' for usage",
    ].join('\n'),
  );
  return 1;
}
