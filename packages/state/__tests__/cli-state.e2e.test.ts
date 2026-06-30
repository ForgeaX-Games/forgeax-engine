// @forgeax/engine-state -- CLI state e2e tests (M6 / m6w1)
//
// Text-based E2E: forgeax engine-console state list (shows all registered
// tokens with name + variants + current state), forgeax engine-console state
// get <tokenName> (shows current variant string).
//
// These tests exercise the real World (with state plugin registered) via
// the dispatch function of cli-state.ts. They import the plugin bin directly
// (not via PATH discovery) to stay fast and deterministic.
//
// TDD red phase: until m6w2 ships cli-state.ts with a dispatch() export,
// the import will fail — this is the expected TDD red state.
//
// Decision anchors:
// - requirements: state list shows all registered tokens
// - requirements: state get prints the current variant string
// - M6 spec: cli-state.ts exports dispatch(dirOptions) + has bin entry
// - Console plugin pattern: argv-based dispatch with stdoutWrite/stderrWrite

import { describe, expect, it } from 'vitest';
import { defineState } from '../src/define-state';
import { registerStatesPlugin } from '../src/register-plugin';
import { despawnOnExit } from '../src/scoped-component';
import { setNextState } from '../src/set-next-state';
import { World } from '@forgeax/engine-ecs';
import { dispatch } from '../src/cli-state';

// ── Test-level state-machine definitions (local to this module) ────────────

const LevelId = defineState('LevelId', ['main-menu', 'tutorial', 'street-a'] as const);
const GameMode = defineState('GameMode', ['menu', 'playing'] as const);

// ── Helpers ─────────────────────────────────────────────────────────────────

interface CapturedIO {
  stdout: string[];
  stderr: string[];
}

function makeWorldWithPlugin(): World {
  const world = new World();
  registerStatesPlugin(world);
  return world;
}

async function runCommand(
  world: World,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const io: CapturedIO = { stdout: [], stderr: [] };
  const exitCode = await dispatch({
    argv: ['node', 'forgeax-engine-remote-state', ...args],
    stdoutWrite: (line: string) => io.stdout.push(line),
    stderrWrite: (line: string) => io.stderr.push(line),
    world,
  });
  return {
    exitCode,
    stdout: io.stdout.join('\n'),
    stderr: io.stderr.join('\n'),
  };
}

// ── describe blocks ─────────────────────────────────────────────────────────

describe('cli-state e2e: state list', () => {
  it('prints all registered tokens with name and variants', async () => {
    const world = makeWorldWithPlugin();
    const r = await runCommand(world, ['list']);

    expect(r.exitCode).toBe(0);

    // Should mention both registered tokens
    expect(r.stdout).toContain('LevelId');
    expect(r.stdout).toContain('GameMode');
  });

  it('state list shows current state value for each token', async () => {
    const world = makeWorldWithPlugin();
    const r = await runCommand(world, ['list']);

    expect(r.exitCode).toBe(0);

    // Both tokens should show their default values
    expect(r.stdout).toContain('main-menu');
    expect(r.stdout).toContain('menu');
  });

  it('state list shows all variants for each token', async () => {
    const world = makeWorldWithPlugin();
    const r = await runCommand(world, ['list']);

    expect(r.exitCode).toBe(0);

    // LevelId variants
    expect(r.stdout).toContain('main-menu');
    expect(r.stdout).toContain('tutorial');
    expect(r.stdout).toContain('street-a');
    // GameMode variants
    expect(r.stdout).toContain('playing');
  });

  it('state list reflects current state after a transition', async () => {
    const world = makeWorldWithPlugin();
    setNextState(world, LevelId, 'tutorial');
    world.update();

    const r = await runCommand(world, ['list']);

    expect(r.exitCode).toBe(0);

    // LevelId should show 'tutorial' as current
    expect(r.stdout).toContain('tutorial');
  });

  it('state list shows current, previous and default per token (AC-15)', async () => {
    const world = makeWorldWithPlugin();
    setNextState(world, LevelId, 'tutorial');
    world.update();

    const r = await runCommand(world, ['list']);

    expect(r.exitCode).toBe(0);
    // LevelId line: current=tutorial, previous=main-menu, default=main-menu
    const levelLine = r.stdout.split('\n').find((l) => l.startsWith('LevelId:'));
    expect(levelLine).toBeDefined();
    expect(levelLine).toContain('tutorial');
    expect(levelLine).toMatch(/previous:\s*main-menu/);
    expect(levelLine).toMatch(/default:\s*main-menu/);
  });

  it('state list with --help flag exits 0 and prints usage', async () => {
    const world = makeWorldWithPlugin();
    const r = await runCommand(world, ['list', '--help']);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/usage|Usage/i);
  });
});

describe('cli-state e2e: state get', () => {
  it('state get <tokenName> prints the current variant string', async () => {
    const world = makeWorldWithPlugin();
    const r = await runCommand(world, ['get', 'LevelId']);

    expect(r.exitCode).toBe(0);

    // Should print the current state value (default is 'main-menu')
    expect(r.stdout).toContain('main-menu');
  });

  it('state get <tokenName> reflects the current value after transition', async () => {
    const world = makeWorldWithPlugin();
    setNextState(world, LevelId, 'street-a');
    world.update();

    const r = await runCommand(world, ['get', 'LevelId']);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('street-a');
  });

  it('state get <unknownToken> exits non-zero and prints error on stderr', async () => {
    const world = makeWorldWithPlugin();
    const r = await runCommand(world, ['get', 'UnknownState']);

    // Should fail because UnknownState is not a registered token
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/UnknownState|unknown|not found|not registered/i);
  });

  it('state get without token name exits non-zero and prints usage', async () => {
    const world = makeWorldWithPlugin();
    const r = await runCommand(world, ['get']);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it('state get --help exits 0 and prints usage', async () => {
    const world = makeWorldWithPlugin();
    const r = await runCommand(world, ['get', '--help']);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/usage|Usage/i);
  });

  it('state get prints current/previous/default/variants (AC-15)', async () => {
    const world = makeWorldWithPlugin();
    setNextState(world, LevelId, 'tutorial');
    world.update();

    const r = await runCommand(world, ['get', 'LevelId']);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/current:\s*tutorial/);
    expect(r.stdout).toMatch(/previous:\s*main-menu/);
    expect(r.stdout).toMatch(/default:\s*main-menu/);
    // All variants listed with a per-variant scoped count in parentheses
    expect(r.stdout).toMatch(/variants:.*main-menu \(\d+\).*tutorial \(\d+\).*street-a \(\d+\)/);
  });

  it('state get reports per-variant ScopedTo entity counts (AC-15)', async () => {
    const world = makeWorldWithPlugin();
    // Scope two entities to exit 'tutorial' and one to exit 'street-a'.
    const a = world.spawn().unwrap();
    const b = world.spawn().unwrap();
    const c = world.spawn().unwrap();
    despawnOnExit(world, a, LevelId, 'tutorial');
    despawnOnExit(world, b, LevelId, 'tutorial');
    despawnOnExit(world, c, LevelId, 'street-a');

    const r = await runCommand(world, ['get', 'LevelId']);

    expect(r.exitCode).toBe(0);
    // tutorial -> 2 scoped, street-a -> 1 scoped, main-menu -> 0
    expect(r.stdout).toMatch(/tutorial \(2\)/);
    expect(r.stdout).toMatch(/street-a \(1\)/);
    expect(r.stdout).toMatch(/main-menu \(0\)/);
  });
});

describe('cli-state e2e: top-level help', () => {
  it('state --help prints top-level usage with subcommands list+get', async () => {
    const world = makeWorldWithPlugin();
    const r = await runCommand(world, ['--help']);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/list|get/);
    expect(r.stdout).toMatch(/usage|Usage/i);
  });

  it('state with no arguments exits non-zero and prints usage', async () => {
    const world = makeWorldWithPlugin();
    const r = await runCommand(world, []);

    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
  });

  it('state unknown-subcommand exits non-zero with error message', async () => {
    const world = makeWorldWithPlugin();
    const r = await runCommand(world, ['bogus-subcommand']);

    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});