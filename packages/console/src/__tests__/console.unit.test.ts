// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=8):
//   - packages/console/src/__tests__/check-no-ecs-literal-residue.test.ts
//   - packages/console/src/__tests__/cli-no-inspect.test.ts
//   - packages/console/src/__tests__/cli.test.ts
//   - packages/console/src/__tests__/error-codes.test.ts
//   - packages/console/src/__tests__/errors.test.ts
//   - packages/console/src/__tests__/passthrough-policy.test.ts
//   - packages/console/src/__tests__/wire-default-inspectors.test.ts
//   - packages/console/test/e2e/pack-inspect.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RegisterRootResult } from '@forgeax/engine-types';
import type { ConnectFn } from '@forgeax/engine-types/inspector-client';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { dispatch, FORGEAX_CLI_SPEC } from '../cli';
import {
  INSPECTOR_ERROR_CODE_TO_JSONRPC,
  InspectorError,
  type InspectorErrorCode,
} from '../errors';
import { Registry, Registry as RegistryImpl } from '../registry';
import { MUTATION_BLACKLIST, wrapReadOnly } from '../sandbox';
import { type ConsoleHandle, startConsoleServer } from '../server';

{
  // --- from check-no-ecs-literal-residue.test.ts ---
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..', '..', '..');
  const gateScript = resolve(
    repoRoot,
    'packages',
    'console',
    'scripts',
    'check-no-ecs-literal-residue.mjs',
  );

  function runGate(): { status: number; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [gateScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
    });
    return {
      status: r.status ?? -1,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    };
  }

  describe('check-no-ecs-literal-residue gate (feat-20260517 D-8)', () => {
    it('(a)+(b)+(c) gate exits 0 with [ok] when console source is clean', () => {
      const r = runGate();
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/\[ok\]/);
    });

    it('(b) gate would surface INSPECT_TARGETS / inspect-scripts residue (gate stdout names them)', () => {
      const r = runGate();
      // Gate stdout/stderr documents the deny-list it enforces; the [ok] line
      // names the two literals so AI users grep stdout to learn the contract.
      const combined = `${r.stdout}\n${r.stderr}`;
      expect(combined).toMatch(/INSPECT_TARGETS/);
      expect(combined).toMatch(/inspect-scripts/);
    });

    it('(c) gate would surface ECS-only literal residue (gate stdout names ECS_ONLY)', () => {
      const r = runGate();
      const combined = `${r.stdout}\n${r.stderr}`;
      expect(combined).toMatch(/ECS_ONLY/);
    });

    it('(d) gate fails fast when @forgeax/engine-ecs build artefact is missing (smoke test via missing-build env override)', () => {
      // Smoke test: the gate must exit non-zero when an explicit override path
      // points at a non-existent ECS module.  We pass an env var the gate
      // honours (FORGEAX_ECS_BUILD_PATH); when the path does not resolve,
      // the gate exits 1 and surfaces a structured error pointing at the
      // missing build.
      const r = spawnSync(process.execPath, [gateScript], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          FORGEAX_ECS_BUILD_PATH: '/this/path/definitely/does/not/exist/index.mjs',
        },
      });
      expect(r.status).not.toBe(0);
      const combined = `${r.stdout}\n${r.stderr}`;
      expect(combined).toMatch(/ECS_MUTATING_METHODS|engine-ecs|fail-fast/);
    });
  });
}

{
  // --- from cli-no-inspect.test.ts ---
  const here = dirname(fileURLToPath(import.meta.url));
  const cliSourcePath = resolve(here, '..', 'cli.ts');
  const cliSource = readFileSync(cliSourcePath, 'utf8');

  describe('cli.ts inspect-subcommand removal (feat-20260517 D-4)', () => {
    it('(a) FORGEAX_CLI_SPEC.subcommands length === 2 (script / eval only)', () => {
      const subs = FORGEAX_CLI_SPEC.subcommands ?? [];
      expect(subs.length).toBe(2);
      const names = subs.map((s) => s.name).sort();
      expect(names).toEqual(['eval', 'script']);
    });

    it("(b1) cli.ts source contains 0 occurrences of `case 'inspect'`", () => {
      expect(cliSource).not.toMatch(/case\s+'inspect'/);
    });

    it("(b2) cli.ts source contains 0 occurrences of `name: 'inspect'`", () => {
      expect(cliSource).not.toMatch(/name:\s*'inspect'/);
    });

    it('(c) `forgeax-engine-console inspect entities` -> plugin fallthrough -> console-startup-failed', async () => {
      const stderr: string[] = [];
      const stdout: string[] = [];
      // No connect needed: dispatch sees 'inspect' is not a built-in nor a
      // discovered plugin (no forgeax-engine-console-inspect on PATH in test
      // env) and exits non-zero with the structured triple.
      const exitCode = await dispatch({
        argv: ['node', 'forgeax', 'inspect', 'entities'],
        stdoutWrite: (line: string) => stdout.push(line),
        stderrWrite: (line: string) => stderr.push(line),
        connect: async () => ({
          ok: true,
          value: {
            execute: async () => null,
            dispose: async () => {},
          },
        }),
      });
      expect(exitCode).not.toBe(0);
      const joined = stderr.join('\n');
      expect(joined).toContain('console-startup-failed');
      // The 'did you mean' hint surfaces the ECS plugin form per AC-12.
      expect(joined).toMatch(/forgeax-engine-console-ecs\s+entities/);
    });

    it('(d) renderTopLevelHelp Built-in section lists only script + eval', async () => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await dispatch({
        argv: ['node', 'forgeax', '--help'],
        stdoutWrite: (line: string) => stdout.push(line),
        stderrWrite: (line: string) => stderr.push(line),
        connect: async () => ({
          ok: true,
          value: {
            execute: async () => null,
            dispose: async () => {},
          },
        }),
      });
      expect(exitCode).toBe(0);
      const joined = stdout.join('\n');
      expect(joined).toContain('Built-in commands:');
      expect(joined).toContain('script');
      expect(joined).toContain('eval');
      // The Built-in section must not advertise `inspect`. Match an indented
      // bullet ('  inspect' at start of line) rather than every prose mention.
      expect(joined).not.toMatch(/^\s\s+inspect\b/m);
    });
  });
}

{
  // --- from cli.test.ts ---
  const here = dirname(fileURLToPath(import.meta.url));
  const cliSourcePath = resolve(here, '..', 'cli.ts');
  const cliSource = readFileSync(cliSourcePath, 'utf8');

  type DispatchEnv = {
    argv: string[];
    stdout: string[];
    stderr: string[];
    connect?: ConnectFn;
  };

  // Build a minimal InspectorError-shaped object satisfying the structural
  // interface (the runtime class lives in ../errors but tests stay package-
  // internal here; the shape is what matters).
  function makeInspectorError(
    code: InspectorErrorCode,
    expected: string,
    hint: string,
  ): InspectorError {
    return Object.assign(
      new Error(`[InspectorError ${code}] expected: ${expected}; hint: ${hint}`),
      {
        name: 'InspectorError',
        code,
        expected,
        hint,
      },
    ) as unknown as InspectorError;
  }

  async function run(env: DispatchEnv): Promise<{ exitCode: number }> {
    const stdoutWrite = (line: string): void => {
      env.stdout.push(line);
    };
    const stderrWrite = (line: string): void => {
      env.stderr.push(line);
    };
    const connect: ConnectFn =
      env.connect ??
      (async () => ({
        ok: false,
        error: makeInspectorError(
          'console-not-running',
          'console server is reachable at ws://localhost:5732',
          'start the demo first: pnpm --filter inspector-demo dev; verify the host called startConsoleServer({port, registry}); pass --port to override default 5732',
        ),
      }));
    const exitCode = await dispatch({
      argv: env.argv,
      stdoutWrite,
      stderrWrite,
      connect,
    });
    return { exitCode };
  }

  describe('cli spec shape (feat-20260517 D-4 inspect removal)', () => {
    it('FORGEAX_CLI_SPEC.subcommands exposes exactly script + eval (zero inspect)', () => {
      const subs = FORGEAX_CLI_SPEC.subcommands ?? [];
      const names = subs.map((s) => s.name).sort();
      expect(names).toEqual(['eval', 'script']);
    });

    it('cli.ts source uses node:util parseArgs (no commander / sade dep)', () => {
      expect(cliSource).toContain('parseArgs');
    });

    it('cli.ts client connect path uses the @forgeax/engine-types/inspector-client SSOT', () => {
      expect(cliSource).toContain('@forgeax/engine-types/inspector-client');
    });
  });

  describe('dispatch happy paths (with stubbed connect)', () => {
    it('`forgeax-engine-console script /tmp/x.js` invokes execute with the file body', async () => {
      let executedScript: string | undefined;
      const env: DispatchEnv = {
        argv: ['node', 'forgeax', 'script', '/tmp/__cli_test_does_not_exist__.js'],
        stdout: [],
        stderr: [],
        connect: async () => ({
          ok: true,
          value: {
            execute: async (s: string): Promise<unknown> => {
              executedScript = s;
              return null;
            },
            dispose: async (): Promise<void> => {},
          },
        }),
      };
      const r = await run(env);
      // Missing file -> non-zero exit before connect is even reached.
      expect(r.exitCode).not.toBe(0);
      expect(executedScript).toBeUndefined();
      const joined = env.stderr.join('\n');
      expect(joined.toLowerCase()).toContain('script');
    });

    it('`forgeax-engine-console eval "world.inspect().entityCount"` forwards the inline script', async () => {
      let executedScript: string | undefined;
      const env: DispatchEnv = {
        argv: ['node', 'forgeax', 'eval', 'world.inspect().entityCount'],
        stdout: [],
        stderr: [],
        connect: async () => ({
          ok: true,
          value: {
            execute: async (s: string): Promise<unknown> => {
              executedScript = s;
              return 7;
            },
            dispose: async (): Promise<void> => {},
          },
        }),
      };
      const r = await run(env);
      expect(r.exitCode).toBe(0);
      expect(executedScript).toBe('world.inspect().entityCount');
      const joined = env.stdout.join('\n');
      expect(joined).toContain('7');
    });
  });

  describe('plugin fallthrough on unknown subcommand', () => {
    it('`forgeax-engine-console bogus` exits non-zero + stderr hints the discovered list', async () => {
      const env: DispatchEnv = { argv: ['node', 'forgeax', 'bogus'], stdout: [], stderr: [] };
      const r = await run(env);
      expect(r.exitCode).not.toBe(0);
      const joined = env.stderr.join('\n');
      expect(joined).toContain('console-startup-failed');
      expect(joined).toContain('script');
      expect(joined).toContain('eval');
    });
  });

  describe('console-not-running path (CLI cannot connect)', () => {
    it('Result.err with code console-not-running prints the structured triple', async () => {
      const env: DispatchEnv = {
        argv: ['node', 'forgeax', 'eval', 'world.inspect().entityCount'],
        stdout: [],
        stderr: [],
        connect: async () => ({
          ok: false,
          error: makeInspectorError(
            'console-not-running',
            'console server is reachable at ws://localhost:5732',
            'start the demo first: pnpm --filter inspector-demo dev; verify the host called startConsoleServer({port, registry}); pass --port to override default 5732',
          ),
        }),
      };
      const r = await run(env);
      expect(r.exitCode).not.toBe(0);
      const joined = env.stderr.join('\n');
      expect(joined).toContain('console-not-running');
      expect(joined).toContain('expected:');
      expect(joined).toContain('hint:');
      expect(joined).toContain('inspector-demo');
    });
  });
}

{
  // --- from error-codes.test.ts ---

  const CLOSED_6: ReadonlyArray<InspectorErrorCode> = [
    'script-syntax-error',
    'script-runtime-error',
    'script-timeout',
    'inspector-write-denied',
    'console-startup-failed',
    'console-not-running',
  ];

  const WIRE_SEGMENT: Readonly<Record<InspectorErrorCode, number>> = {
    'script-syntax-error': -32001,
    'script-runtime-error': -32002,
    'script-timeout': -32003,
    'inspector-write-denied': -32004,
    'console-startup-failed': -32005,
    'console-not-running': -32006,
  };

  describe('InspectorErrorCode closed union (6 members) + 4-field surface', () => {
    it('all 6 members instantiate with .code / .expected / .hint / .message', () => {
      for (const code of CLOSED_6) {
        const e = new InspectorError({
          code,
          expected: `expected for ${code}`,
          hint: `hint for ${code}`,
        });
        expect(e.code).toBe(code);
        expect(e.expected).toBe(`expected for ${code}`);
        expect(e.hint).toBe(`hint for ${code}`);
        expect(e.message).toContain(code);
        expect(e.name).toBe('InspectorError');
      }
    });
  });

  describe('INSPECTOR_ERROR_CODE_TO_JSONRPC wire segment -32001..-32006', () => {
    it('maps every closed-union member to the locked numeric', () => {
      for (const code of CLOSED_6) {
        expect(INSPECTOR_ERROR_CODE_TO_JSONRPC[code]).toBe(WIRE_SEGMENT[code]);
      }
    });

    it('table key set equals the 6-member closed union (no add-only drift)', () => {
      const tableKeys = Object.keys(INSPECTOR_ERROR_CODE_TO_JSONRPC).sort();
      const expectedKeys = [...CLOSED_6].sort();
      expect(tableKeys).toEqual(expectedKeys);
    });
  });
}

{
  // --- from errors.test.ts ---
  const INSPECTOR_ERROR_CODES_6: ReadonlySet<InspectorErrorCode> = new Set([
    'script-syntax-error',
    'script-runtime-error',
    'script-timeout',
    'inspector-write-denied',
    'console-startup-failed',
    'console-not-running',
  ]);

  describe('InspectorError runtime - construction + 4-field surface', () => {
    it('all 6 members instantiate with three readonly string fields + auto-composed message', () => {
      for (const code of INSPECTOR_ERROR_CODES_6) {
        const e = new InspectorError({
          code,
          expected: `expected for ${code}`,
          hint: `hint for ${code}`,
        });
        expect(e).toBeInstanceOf(InspectorError);
        expect(e).toBeInstanceOf(Error);
        expect(e.code).toBe(code);
        expect(typeof e.expected).toBe('string');
        expect(typeof e.hint).toBe('string');
        expect(e.expected.length).toBeGreaterThan(0);
        expect(e.hint.length).toBeGreaterThan(0);
        expect(typeof e.message).toBe('string');
        expect(e.message).toContain(code);
        expect(e.message).toContain(e.expected);
        expect(e.message).toContain(e.hint);
        expect(e.name).toBe('InspectorError');
      }
    });

    it('AI-user consumption contract: read .code / .expected / .hint / .message via property access', () => {
      const e = new InspectorError({
        code: 'script-syntax-error',
        expected: 'script body is valid JavaScript',
        hint: 'check syntax position in errMessage; fix and resubmit; use forgeax inspect sugar for closed-form queries',
      });
      expect(e.code).toBe('script-syntax-error');
      expect(e.expected).toBe('script body is valid JavaScript');
      expect(e.hint).toBe(
        'check syntax position in errMessage; fix and resubmit; use forgeax inspect sugar for closed-form queries',
      );
    });
  });

  // 10.2 templates locked in requirements (feat-20260513 plan-decisions round 2 F-1).
  // Drift is caught at the static layer by grep-console-errors.mjs; this fixture
  // drives runtime composition checks (.message contains the literal copy).
  const TEMPLATES_6 = {
    'script-syntax-error': {
      expected: 'script body is valid JavaScript',
      hint: 'check syntax position in errMessage; fix and resubmit; use forgeax inspect sugar for closed-form queries',
    },
    'script-runtime-error': {
      expected: 'script executes without throwing',
      hint: 'inspect stack trace in errMessage; verify symbol availability via forgeax introspect; remember world / engine / assets are read-only Proxy',
    },
    'script-timeout': {
      expected:
        'script completes within 5000ms (default; configurable via engine.startConsole({ port, scriptTimeoutMs }))',
      hint: 'simplify query or split into smaller scripts; check for unbounded loops; raise timeout via engine.startConsole({ port, scriptTimeoutMs })',
    },
    'inspector-write-denied': {
      expected: 'world / engine / assets context is read-only in P0',
      hint: 'write API is deferred to asset-system-v1 loop (todo-079); use inspect / script / eval for read-only introspection only',
    },
    'console-startup-failed': {
      expected: 'console server starts successfully on requested port',
      hint: 'check if port is already in use (default 5732, monitor uses 5731); pass different port via engine.startConsole({ port }); or kill existing process holding the port',
    },
    'console-not-running': {
      expected: 'console server is reachable at ws://localhost:<port>',
      hint: 'start the demo first: pnpm --filter inspector-demo dev; verify engine.startConsole({port}) was called in your wiring; pass --port to override default 5732',
    },
  } as const satisfies Record<
    InspectorErrorCode,
    { readonly expected: string; readonly hint: string }
  >;

  describe('InspectorError runtime - 10.2 templates compose into .message', () => {
    for (const code of INSPECTOR_ERROR_CODES_6) {
      it(`'${code}' template composes .expected / .hint into .message`, () => {
        const t = TEMPLATES_6[code];
        const e = new InspectorError({ code, expected: t.expected, hint: t.hint });
        expect(e.code).toBe(code);
        expect(e.expected).toBe(t.expected);
        expect(e.hint).toBe(t.hint);
        expect(e.message).toContain(code);
        expect(e.message).toContain(t.expected);
        expect(e.message).toContain(t.hint);
      });
    }
  });

  describe('InspectorError runtime - JSON.stringify field preservation', () => {
    it('JSON.stringify preserves all four fields (Error class defaults drop these)', () => {
      const e = new InspectorError({
        code: 'inspector-write-denied',
        expected: 'world / engine / assets context is read-only in P0',
        hint: 'write API is deferred to asset-system-v1 loop (todo-079); use inspect / script / eval for read-only introspection only',
      });
      const serialized = JSON.stringify(e);
      const parsed = JSON.parse(serialized) as {
        code: string;
        expected: string;
        hint: string;
        message: string;
      };
      expect(parsed.code).toBe('inspector-write-denied');
      expect(parsed.expected).toBe('world / engine / assets context is read-only in P0');
      expect(parsed.hint).toContain('write API is deferred to asset-system-v1 loop');
      expect(typeof parsed.message).toBe('string');
      expect(parsed.message.length).toBeGreaterThan(0);
      expect(parsed.message).toContain('inspector-write-denied');
    });

    it('JSON.stringify is roundtrip-stable across two passes', () => {
      const original = new InspectorError({
        code: 'script-timeout',
        expected: TEMPLATES_6['script-timeout'].expected,
        hint: TEMPLATES_6['script-timeout'].hint,
      });
      const first = JSON.stringify(original);
      const reparsed = JSON.parse(first) as {
        code: InspectorErrorCode;
        expected: string;
        hint: string;
        message: string;
      };
      const second = JSON.stringify(reparsed);
      expect(JSON.parse(second)).toEqual(JSON.parse(first));
    });

    it('JSON.stringify within an array preserves all 4 fields per entry (JSON-RPC batch payload contract)', () => {
      const errs = [
        new InspectorError({
          code: 'script-syntax-error',
          expected: TEMPLATES_6['script-syntax-error'].expected,
          hint: TEMPLATES_6['script-syntax-error'].hint,
        }),
        new InspectorError({
          code: 'console-not-running',
          expected: TEMPLATES_6['console-not-running'].expected,
          hint: TEMPLATES_6['console-not-running'].hint,
        }),
      ];
      const out = JSON.parse(JSON.stringify(errs)) as Array<{
        code: string;
        expected: string;
        hint: string;
        message: string;
      }>;
      expect(out).toHaveLength(2);
      expect(out[0]?.code).toBe('script-syntax-error');
      expect(out[1]?.code).toBe('console-not-running');
      for (const entry of out) {
        expect(entry).toHaveProperty('code');
        expect(entry).toHaveProperty('expected');
        expect(entry).toHaveProperty('hint');
        expect(entry).toHaveProperty('message');
      }
    });
  });

  describe('InspectorError runtime - instanceof guards', () => {
    it('instances are detected via instanceof InspectorError (try/catch boundary)', () => {
      const e = new InspectorError({
        code: 'console-startup-failed',
        expected: TEMPLATES_6['console-startup-failed'].expected,
        hint: TEMPLATES_6['console-startup-failed'].hint,
      });
      let caught: unknown = null;
      try {
        throw e;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InspectorError);
      expect(caught).toBeInstanceOf(Error);
      expect(caught).toBe(e);
    });

    it('non-InspectorError throws are NOT mis-detected', () => {
      const plain = new Error('not an InspectorError');
      expect(plain).toBeInstanceOf(Error);
      expect(plain).not.toBeInstanceOf(InspectorError);
    });
  });

  // Closed-ness runtime mirror of the static grep gate. tsc strict-mode reports
  // 'Function lacks ending return statement' if a future commit adds a member
  // without updating this switch (charter proposition 4 explicit failure +
  // proposition 3 machine-readable union > prose).
  function describeCode(code: InspectorErrorCode): string {
    switch (code) {
      case 'script-syntax-error':
        return 'syntax';
      case 'script-runtime-error':
        return 'runtime';
      case 'script-timeout':
        return 'timeout';
      case 'inspector-write-denied':
        return 'write-denied';
      case 'console-startup-failed':
        return 'startup-failed';
      case 'console-not-running':
        return 'not-running';
    }
  }

  describe('InspectorErrorCode exhaustive switch (closed-ness runtime mirror)', () => {
    it('every member maps to a distinct describeCode() result', () => {
      const results = new Set<string>();
      for (const code of INSPECTOR_ERROR_CODES_6) {
        const r = describeCode(code);
        expect(typeof r).toBe('string');
        expect(r.length).toBeGreaterThan(0);
        results.add(r);
      }
      expect(results.size).toBe(INSPECTOR_ERROR_CODES_6.size);
    });
  });
}

{
  // --- from passthrough-policy.test.ts ---
  describe('AC-13 passthrough policy: addSystem / removeSystem / replaceSystem', () => {
    it('addSystem is NOT in the 17-method MUTATION_BLACKLIST', () => {
      expect(MUTATION_BLACKLIST.has('addSystem')).toBe(false);
    });

    it('removeSystem is NOT in the 17-method MUTATION_BLACKLIST', () => {
      expect(MUTATION_BLACKLIST.has('removeSystem')).toBe(false);
    });

    it('replaceSystem is NOT in the 17-method MUTATION_BLACKLIST', () => {
      expect(MUTATION_BLACKLIST.has('replaceSystem')).toBe(false);
    });

    it('a stub world wrapped in wrapReadOnly executes addSystem without inspector-write-denied', () => {
      let observed = 0;
      const stubWorld = {
        addSystem(_descriptor: unknown): void {
          observed += 1;
        },
      };
      const wrapped = wrapReadOnly(stubWorld);
      // No try/catch — if the apply trap fires it throws InspectorError and
      // the test fails (charter proposition 4 explicit failure).
      wrapped.addSystem({ name: 'noop', queries: [], fn: (): void => {} });
      expect(observed).toBe(1);
    });

    it('removeSystem and replaceSystem stubs pass through the same wrapper', () => {
      let removeCount = 0;
      let replaceCount = 0;
      const stubWorld = {
        removeSystem(_name: string): void {
          removeCount += 1;
        },
        replaceSystem(_name: string, _descriptor: unknown): void {
          replaceCount += 1;
        },
      };
      const wrapped = wrapReadOnly(stubWorld);
      wrapped.removeSystem('any');
      wrapped.replaceSystem('any', { name: 'any', queries: [], fn: (): void => {} });
      expect(removeCount).toBe(1);
      expect(replaceCount).toBe(1);
    });
  });

  describe('AC-13 negative: generic 9-name MUTATION_BLACKLIST byte-for-byte (feat-20260517 D-2)', () => {
    // feat-20260517 D-2: the static MUTATION_BLACKLIST shrinks to the generic
    // JS-container 9 names (push/pop/shift/unshift/splice/sort/reverse/set/
    // clear/delete). ECS-domain mutating method names enter the trap via
    // Registry.lookupMutatingMethods at wrap-time; this test still asserts
    // the legacy spawn/insertResource/flush denial behaviour by injecting a
    // Registry seeded with the ECS demo names (host-assembly equivalent).
    const EXPECTED_GENERIC_9 = new Set<string>([
      'push',
      'pop',
      'shift',
      'unshift',
      'splice',
      'sort',
      'reverse',
      'set',
      'clear',
      'delete',
    ]);

    it('the blacklist size is exactly 10 (9 unique + cross-surface clear/delete)', () => {
      expect(MUTATION_BLACKLIST.size).toBe(EXPECTED_GENERIC_9.size);
    });

    it('every expected member is present (no contraction)', () => {
      for (const name of EXPECTED_GENERIC_9) {
        expect(MUTATION_BLACKLIST.has(name)).toBe(true);
      }
    });

    it('no unexpected member is present (no growth)', () => {
      for (const name of MUTATION_BLACKLIST) {
        expect(EXPECTED_GENERIC_9.has(name)).toBe(true);
      }
    });

    it('spawn / insertResource / flush still throw inspector-write-denied (Registry-injected)', () => {
      const stubWorld = {
        spawn(): never {
          throw new Error('should not reach');
        },
        insertResource(): never {
          throw new Error('should not reach');
        },
        flush(): never {
          throw new Error('should not reach');
        },
      };
      const reg = new Registry();
      reg.registerMutatingMethods(new Set(['spawn', 'insertResource', 'flush']));
      const wrapped = wrapReadOnly(stubWorld, reg);
      for (const method of ['spawn', 'insertResource', 'flush'] as const) {
        let caught: unknown = null;
        try {
          (wrapped as unknown as Record<string, () => void>)[method]?.();
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(InspectorError);
        expect((caught as InspectorError).code).toBe('inspector-write-denied');
      }
    });
  });
}

{
  // --- from wire-default-inspectors.test.ts ---
  const HERE = fileURLToPath(new URL('.', import.meta.url));

  // Minimal stub for the Renderer reference passed into registerRuntimeInspector;
  // only the field the contributor reads needs to exist.
  function makeStubEngine(): unknown {
    return { backend: 'webgpu' };
  }

  // Minimal stub for the World reference passed into registerEcsInspector;
  // the contributor reads world.inspect() lazily so the stub returns the
  // plan-strategy §3.3 four-section snapshot directly.
  function makeStubWorld(): unknown {
    return {
      inspect(): unknown {
        return {
          entityCount: 0,
          archetypes: [],
          activeComponents: [],
          systemCount: 0,
          systems: [],
          resourceKeys: [],
          sceneInstances: [],
        };
      },
    };
  }

  // Stub injector — registers a single spy method per call so the test can
  // verify the helper invoked the function on the supplied registry. Returns
  // Result.ok by default; tests can override by passing a custom impl.
  function makeStubInjectors(): {
    registerEcsInspector: (reg: Registry, world: unknown) => RegisterRootResult;
    registerRuntimeInspector: (reg: Registry, engine: unknown) => RegisterRootResult;
    ecsCalls: Array<{ reg: Registry; world: unknown }>;
    runtimeCalls: Array<{ reg: Registry; engine: unknown }>;
  } {
    const ecsCalls: Array<{ reg: Registry; world: unknown }> = [];
    const runtimeCalls: Array<{ reg: Registry; engine: unknown }> = [];
    return {
      ecsCalls,
      runtimeCalls,
      registerEcsInspector(reg, world) {
        ecsCalls.push({ reg, world });
        reg.registerMethod('entities', () => undefined);
        reg.registerMethod('components', () => undefined);
        reg.registerMethod('systems', () => undefined);
        reg.registerMethod('resources', () => undefined);
        return { ok: true, value: undefined };
      },
      registerRuntimeInspector(reg, engine) {
        runtimeCalls.push({ reg, engine });
        reg.registerMethod('renderer.info', () => undefined);
        return { ok: true, value: undefined };
      },
    };
  }

  describe('wireDefaultInspectors — one-shot wiring (AC-08)', () => {
    it('registers world / engine / assets roots and invokes injected ecs + runtime registrars', async () => {
      const { wireDefaultInspectors } = await import('../wire-default-inspectors');
      const reg = new RegistryImpl();
      const stubs = makeStubInjectors();
      const stubWorld = makeStubWorld();
      const stubEngine = makeStubEngine();
      const result = wireDefaultInspectors(
        reg,
        { world: stubWorld, engine: stubEngine, assets: { kind: 'asset-registry-stub' } },
        {
          registerEcsInspector: stubs.registerEcsInspector,
          registerRuntimeInspector: stubs.registerRuntimeInspector,
        },
      );
      expect(result.ok).toBe(true);
      // Roots present (registered by wireDefaultInspectors directly).
      expect(reg.lookupRoot('world')).toBe(stubWorld);
      expect(reg.lookupRoot('engine')).toBe(stubEngine);
      expect(reg.lookupRoot('assets')).toEqual({ kind: 'asset-registry-stub' });
      // Methods present (registered through injected stubs — proves the helper
      // routed the calls through the third argument, not through a static
      // value-import inside the console package).
      expect(typeof reg.lookupMethod('entities')).toBe('function');
      expect(typeof reg.lookupMethod('components')).toBe('function');
      expect(typeof reg.lookupMethod('systems')).toBe('function');
      expect(typeof reg.lookupMethod('resources')).toBe('function');
      expect(typeof reg.lookupMethod('renderer.info')).toBe('function');
      // Injectors received the correct ctx fields (world + engine).
      expect(stubs.ecsCalls).toHaveLength(1);
      expect(stubs.ecsCalls[0]?.world).toBe(stubWorld);
      expect(stubs.runtimeCalls).toHaveLength(1);
      expect(stubs.runtimeCalls[0]?.engine).toBe(stubEngine);
    });
  });

  describe('wireDefaultInspectors — short-circuit on first failure (R-REG-CONFLICT)', () => {
    it('returns Result.err verbatim on the first failing step', async () => {
      const { wireDefaultInspectors } = await import('../wire-default-inspectors');
      const reg = new RegistryImpl();
      // Pre-register world to force a duplicate on the first wireDefaultInspectors
      // step; this models the R-REG-CONFLICT fallback path where a host
      // accidentally registers a root twice across reloads.
      const pre = reg.registerRoot('world', { kind: 'pre-existing' });
      expect(pre.ok).toBe(true);
      const stubs = makeStubInjectors();
      const result = wireDefaultInspectors(
        reg,
        {
          world: makeStubWorld(),
          engine: makeStubEngine(),
          assets: { kind: 'asset-registry-stub' },
        },
        {
          registerEcsInspector: stubs.registerEcsInspector,
          registerRuntimeInspector: stubs.registerRuntimeInspector,
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.error.code).toBe('console-startup-failed');
      // Short-circuits on the first conflict (world); engine/assets not registered.
      expect(reg.lookupRoot('engine')).toBeUndefined();
      expect(reg.lookupRoot('assets')).toBeUndefined();
      // Injectors never invoked because short-circuit happened before the ecs
      // / runtime steps — this is the function-injection equivalent of the
      // round 1 "ecs/runtime methods unregistered" assertion.
      expect(stubs.ecsCalls).toHaveLength(0);
      expect(stubs.runtimeCalls).toHaveLength(0);
      expect(reg.lookupMethod('entities')).toBeUndefined();
      expect(reg.lookupMethod('renderer.info')).toBeUndefined();
    });
  });

  describe('inspect-scripts.ts removal (feat-20260517 D-4)', () => {
    it('packages/console/src/inspect-scripts.ts no longer exists', () => {
      const path = `${HERE}../inspect-scripts.ts`;
      let exists = true;
      try {
        readFileSync(path, 'utf8');
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    });
  });

  describe('wire-default-inspectors.ts — 0-import regression (AC-01 / AC-02)', () => {
    // Round 2 invariant: after the function-injection refactor, the console
    // package source file wire-default-inspectors.ts must never name any of
    // the four deny-listed engine packages. Grep-based byte-level assertion
    // as defence-in-depth: complements the reverse gate
    // check-console-not-import-engine.mjs (which scans the whole console/src
    // tree at CI time), failing at vitest unit run rather than at the gate
    // step so regressions surface in fast-iteration loops.
    const DENY_LITERALS = [
      '@forgeax/engine-ecs',
      '@forgeax/engine-runtime',
      '@forgeax/engine-pack',
      '@forgeax/engine-gltf',
    ];

    it('wire-default-inspectors.ts contains 0 occurrence of @forgeax/engine-{ecs,runtime,pack,gltf}', () => {
      const src = readFileSync(`${HERE}../wire-default-inspectors.ts`, 'utf8');
      const lines = src.split(/\r?\n/);
      for (const literal of DENY_LITERALS) {
        const hits = lines
          .map((line, i) => ({ line, i }))
          // Skip line comments (`//`) and JSDoc block-comment continuation
          // lines (`*` or `* …`) — the grep gate's reverse counterpart
          // applies the same `// + space-asterisk` exclusion so the test
          // and the gate stay aligned (string-literal references inside
          // documentation reference the deny-list names by design).
          .filter(({ line }) => {
            const t = line.trimStart();
            return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
          })
          .filter(({ line }) => line.includes(literal));
        expect(
          hits,
          `wire-default-inspectors.ts must not import or reference '${literal}' in non-comment lines (round 2 AC-01 / AC-02 strict 4-deny-list — round 1 F-1 P1 root cause). Hits: ${JSON.stringify(hits.map((h) => `L${h.i + 1}: ${h.line.trim()}`))}`,
        ).toEqual([]);
      }
    });
  });
}

{
  // --- from pack-inspect.test.ts ---

  type JsonRpcRequest = {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
    id?: number | string | null;
  };

  type JsonRpcResponse = {
    jsonrpc: '2.0';
    result?: unknown;
    error?: {
      code: number;
      message: string;
      data?: {
        code: string;
        expected?: string;
        hint?: string;
        message?: string;
      };
    };
    id: number | string | null;
  };

  async function connect(port: number): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/inspector`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return ws;
  }

  async function rpc(ws: WebSocket, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve) => {
      ws.once('message', (raw) => {
        resolve(JSON.parse(raw.toString()) as JsonRpcResponse);
      });
      ws.send(JSON.stringify(req));
    });
  }

  // Mock assets object that exposes guidToHandle map for inspect packs
  function makeMockAssetsWithGuids(guids: string[]): object {
    const guidToHandle = new Map<string, unknown>();
    for (let i = 0; i < guids.length; i++) {
      guidToHandle.set(guids[i] ?? '', i + 1);
    }
    return {
      guidToHandle,
      // Expose iterableEntries for the packs handler script
      _packEntries: guids.map((guid, i) => ({ guid, handle: i + 1 })),
    };
  }

  describe('inspect packs e2e', () => {
    it('happy path: 2 GUIDs registered → result contains 2 entries', async () => {
      const guid1 = 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
      const guid2 = 'ffffffff-aaaa-7bbb-9ccc-111111111111';
      const assets = makeMockAssetsWithGuids([guid1, guid2]);

      const result = await startConsoleServer({ port: 0, world: {}, assets });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const handle: ConsoleHandle = result.value;

      const ws = await connect(handle.port);

      // Execute the packs inspect script via execute() method
      const script = `
      (() => {
        const entries = assets._packEntries;
        return { count: entries.length, entries };
      })()
    `;
      const resp = await rpc(ws, {
        jsonrpc: '2.0',
        method: 'execute',
        params: { script },
        id: 1,
      });

      ws.close();
      await handle.close();

      expect(resp.error).toBeUndefined();
      const r = resp.result as { count: number; entries: { guid: string }[] };
      expect(r.count).toBe(2);
      expect(r.entries).toHaveLength(2);
      const guids = r.entries.map((e) => e.guid);
      expect(guids).toContain(guid1);
      expect(guids).toContain(guid2);
    });

    it('collision path: scanner pack-guid-collision → JSON-RPC error with pack-guid-collision code', async () => {
      // Simulate the packs inspect handler receiving a collision error
      // The handler exposes collision errors as JSON-RPC errors with
      // error.data.code = 'pack-guid-collision'
      const assets = {
        _packCollision: {
          code: 'pack-guid-collision' as const,
          paths: ['/a/foo.pack.json', '/b/foo.pack.json'],
          guid: 'aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee',
        },
        _packEntries: null as unknown as unknown[],
      };

      const result = await startConsoleServer({ port: 0, world: {}, assets });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const handle: ConsoleHandle = result.value;

      const ws = await connect(handle.port);

      // Execute script that returns collision error signal
      // The packs handler (w25) should detect collision and surface it as JSON-RPC error
      // For TDD purposes: script that surfaces collision from assets context
      const script = `
      (() => {
        if (assets._packCollision) {
          // Throw a structured error that the server can translate to JSON-RPC error
          const e = new Error('pack-guid-collision');
          e.code = assets._packCollision.code;
          e.detail = assets._packCollision;
          throw e;
        }
        return { count: 0, entries: [] };
      })()
    `;
      const resp = await rpc(ws, {
        jsonrpc: '2.0',
        method: 'execute',
        params: { script },
        id: 2,
      });

      ws.close();
      await handle.close();

      // Script-runtime-error is expected because we throw from the script
      // The JSON-RPC error should have data containing info about the failure
      expect(resp.error).toBeDefined();
      expect(typeof resp.error?.code).toBe('number');
      // The error code should be in the inspector range -32001..-32006
      expect(resp.error?.code).toBeGreaterThanOrEqual(-32006);
      expect(resp.error?.code).toBeLessThanOrEqual(-32001);
    });
  });
}
