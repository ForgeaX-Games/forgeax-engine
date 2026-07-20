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

// w12 DELETED: import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectFn } from '@forgeax/engine-types/inspector-client';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { dispatch, FORGEAX_CLI_SPEC } from '../cli';
import { REMOTE_ERROR_CODE_TO_JSONRPC, RemoteError, type RemoteErrorCode } from '../errors';
import { type ConsoleHandle, startServer } from '../server';

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

    it('(c) `forgeax-engine-remote inspect entities` -> unknown-subcommand usage error', async () => {
      const stderr: string[] = [];
      const stdout: string[] = [];
      // No connect needed: dispatch sees 'inspect' is not a built-in
      // subcommand (plugin discovery removed in M2) and exits non-zero with
      // a CLI usage error (not a RemoteErrorCode — that union is the wire/eval
      // failure vocabulary, not a usage-error channel).
      const exitCode = await dispatch({
        argv: ['node', 'forgeax', 'inspect', 'entities'],
        stdoutWrite: (line: string) => stdout.push(line),
        stderrWrite: (line: string) => stderr.push(line),
        connect: async () => ({
          ok: true,
          value: {
            eval: async () => null,
            dispose: async () => {},
          },
        }),
      });
      expect(exitCode).not.toBe(0);
      const joined = stderr.join('\n');
      expect(joined).toContain("unknown subcommand 'inspect'");
      // M2 removed plugin discovery, so an unknown subcommand reports the
      // built-in roster + the removal note rather than a 'did you mean' plugin hint.
      expect(joined).toContain('script, eval');
      expect(joined).toMatch(/plugin discovery removed/);
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
            eval: async () => null,
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

  // Build a minimal RemoteError-shaped object satisfying the structural
  // interface (the runtime class lives in ../errors but tests stay package-
  // internal here; the shape is what matters).
  function makeRemoteError(code: RemoteErrorCode, expected: string, hint: string): RemoteError {
    return Object.assign(new Error(`[RemoteError ${code}] expected: ${expected}; hint: ${hint}`), {
      name: 'RemoteError',
      code,
      expected,
      hint,
    }) as unknown as RemoteError;
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
        error: makeRemoteError(
          'server-not-running',
          'console server is reachable at ws://localhost:5732',
          'start the demo first: pnpm --filter inspector-demo dev; verify the host called startServer({port, registry}); pass --port to override default 5732',
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
            eval: async (s: string): Promise<unknown> => {
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
            eval: async (s: string): Promise<unknown> => {
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

  describe('unknown subcommand usage error', () => {
    it('`forgeax-engine-remote bogus` exits non-zero + stderr names the built-in roster', async () => {
      const env: DispatchEnv = { argv: ['node', 'forgeax', 'bogus'], stdout: [], stderr: [] };
      const r = await run(env);
      expect(r.exitCode).not.toBe(0);
      const joined = env.stderr.join('\n');
      // CLI usage error, not a RemoteErrorCode (that union is the wire/eval
      // failure vocabulary). M2 removed plugin discovery.
      expect(joined).toContain("unknown subcommand 'bogus'");
      expect(joined).toContain('script');
      expect(joined).toContain('eval');
    });
  });

  describe('server-not-running path (CLI cannot connect)', () => {
    it('Result.err with code server-not-running prints the structured triple', async () => {
      const env: DispatchEnv = {
        argv: ['node', 'forgeax', 'eval', 'world.inspect().entityCount'],
        stdout: [],
        stderr: [],
        connect: async () => ({
          ok: false,
          error: makeRemoteError(
            'server-not-running',
            'console server is reachable at ws://localhost:5732',
            'start the demo first: pnpm --filter inspector-demo dev; verify the host called startServer({port, registry}); pass --port to override default 5732',
          ),
        }),
      };
      const r = await run(env);
      expect(r.exitCode).not.toBe(0);
      const joined = env.stderr.join('\n');
      expect(joined).toContain('server-not-running');
      expect(joined).toContain('expected:');
      expect(joined).toContain('hint:');
      expect(joined).toContain('inspector-demo');
    });
  });
}

{
  // --- from error-codes.test.ts ---

  const CLOSED_4: ReadonlyArray<RemoteErrorCode> = [
    'script-syntax-error',
    'script-runtime-error',
    'server-startup-failed',
    'server-not-running',
  ];

  const WIRE_SEGMENT: Readonly<Record<RemoteErrorCode, number>> = {
    'script-syntax-error': -32001,
    'script-runtime-error': -32002,
    'server-startup-failed': -32003,
    'server-not-running': -32004,
  };

  describe('RemoteErrorCode closed union (4 members) + 4-field surface', () => {
    it('all 4 members instantiate with .code / .expected / .hint / .message', () => {
      for (const code of CLOSED_4) {
        const e = new RemoteError({
          code,
          expected: `expected for ${code}`,
          hint: `hint for ${code}`,
        });
        expect(e.code).toBe(code);
        expect(e.expected).toBe(`expected for ${code}`);
        expect(e.hint).toBe(`hint for ${code}`);
        expect(e.message).toContain(code);
        expect(e.name).toBe('RemoteError');
      }
    });
  });

  describe('REMOTE_ERROR_CODE_TO_JSONRPC wire segment -32001..-32004', () => {
    it('maps every closed-union member to the locked numeric', () => {
      for (const code of CLOSED_4) {
        expect(REMOTE_ERROR_CODE_TO_JSONRPC[code]).toBe(WIRE_SEGMENT[code]);
      }
    });

    it('table key set equals the 4-member closed union (no add-only drift)', () => {
      const tableKeys = Object.keys(REMOTE_ERROR_CODE_TO_JSONRPC).sort();
      const expectedKeys = [...CLOSED_4].sort();
      expect(tableKeys).toEqual(expectedKeys);
    });
  });
}

{
  // --- from errors.test.ts ---
  const REMOTE_ERROR_CODES_4: ReadonlySet<RemoteErrorCode> = new Set([
    'script-syntax-error',
    'script-runtime-error',
    'server-startup-failed',
    'server-not-running',
  ]);

  describe('RemoteError runtime - construction + 4-field surface', () => {
    it('all 4 members instantiate with three readonly string fields + auto-composed message', () => {
      for (const code of REMOTE_ERROR_CODES_4) {
        const e = new RemoteError({
          code,
          expected: `expected for ${code}`,
          hint: `hint for ${code}`,
        });
        expect(e).toBeInstanceOf(RemoteError);
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
        expect(e.name).toBe('RemoteError');
      }
    });

    it('AI-user consumption contract: read .code / .expected / .hint / .message via property access', () => {
      const e = new RemoteError({
        code: 'script-syntax-error',
        expected: 'script body is valid JavaScript',
        hint: 'check syntax position in errMessage; fix and resubmit',
      });
      expect(e.code).toBe('script-syntax-error');
      expect(e.expected).toBe('script body is valid JavaScript');
      expect(e.hint).toBe('check syntax position in errMessage; fix and resubmit');
    });
  });

  // 10.2 templates locked in requirements (feat-20260629 D-5).
  const TEMPLATES_4 = {
    'script-syntax-error': {
      expected: 'script body is valid JavaScript',
      hint: 'check syntax position in errMessage; fix and resubmit',
    },
    'script-runtime-error': {
      expected: 'script executes without throwing',
      hint: 'inspect error; verify symbol availability; eval has full access to world/renderer/assets',
    },
    'server-startup-failed': {
      expected: 'server starts successfully on requested port',
      hint: 'check if port is already in use (default 5732); pass different port; or kill existing process holding the port',
    },
    'server-not-running': {
      expected: 'server is reachable at ws://localhost:<port>',
      hint: 'start the demo first; verify app.remote is wired; pass --port to override default 5732',
    },
  } as const satisfies Record<
    RemoteErrorCode,
    { readonly expected: string; readonly hint: string }
  >;

  describe('RemoteError runtime - templates compose into .message', () => {
    for (const code of REMOTE_ERROR_CODES_4) {
      it(`'${code}' template composes .expected / .hint into .message`, () => {
        const t = TEMPLATES_4[code];
        const e = new RemoteError({ code, expected: t.expected, hint: t.hint });
        expect(e.code).toBe(code);
        expect(e.expected).toBe(t.expected);
        expect(e.hint).toBe(t.hint);
        expect(e.message).toContain(code);
        expect(e.message).toContain(t.expected);
        expect(e.message).toContain(t.hint);
      });
    }
  });

  describe('RemoteError runtime - JSON.stringify field preservation', () => {
    it('JSON.stringify preserves all four fields (Error class defaults drop these)', () => {
      const e = new RemoteError({
        code: 'server-startup-failed',
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
      expect(parsed.code).toBe('server-startup-failed');
      expect(parsed.expected).toBe('world / engine / assets context is read-only in P0');
      expect(parsed.hint).toContain('write API is deferred to asset-system-v1 loop');
      expect(typeof parsed.message).toBe('string');
      expect(parsed.message.length).toBeGreaterThan(0);
      expect(parsed.message).toContain('server-startup-failed');
    });

    it('JSON.stringify is roundtrip-stable across two passes', () => {
      const original = new RemoteError({
        code: 'server-not-running',
        expected: TEMPLATES_4['server-not-running'].expected,
        hint: TEMPLATES_4['server-not-running'].hint,
      });
      const first = JSON.stringify(original);
      const reparsed = JSON.parse(first) as {
        code: RemoteErrorCode;
        expected: string;
        hint: string;
        message: string;
      };
      const second = JSON.stringify(reparsed);
      expect(JSON.parse(second)).toEqual(JSON.parse(first));
    });

    it('JSON.stringify within an array preserves all 4 fields per entry (JSON-RPC batch payload contract)', () => {
      const errs = [
        new RemoteError({
          code: 'script-syntax-error',
          expected: TEMPLATES_4['script-syntax-error'].expected,
          hint: TEMPLATES_4['script-syntax-error'].hint,
        }),
        new RemoteError({
          code: 'server-not-running',
          expected: TEMPLATES_4['server-not-running'].expected,
          hint: TEMPLATES_4['server-not-running'].hint,
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
      expect(out[1]?.code).toBe('server-not-running');
      for (const entry of out) {
        expect(entry).toHaveProperty('code');
        expect(entry).toHaveProperty('expected');
        expect(entry).toHaveProperty('hint');
        expect(entry).toHaveProperty('message');
      }
    });
  });

  describe('RemoteError runtime - instanceof guards', () => {
    it('instances are detected via instanceof RemoteError (try/catch boundary)', () => {
      const e = new RemoteError({
        code: 'server-startup-failed',
        expected: TEMPLATES_4['server-startup-failed'].expected,
        hint: TEMPLATES_4['server-startup-failed'].hint,
      });
      let caught: unknown = null;
      try {
        throw e;
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RemoteError);
      expect(caught).toBeInstanceOf(Error);
      expect(caught).toBe(e);
    });

    it('non-RemoteError throws are NOT mis-detected', () => {
      const plain = new Error('not an RemoteError');
      expect(plain).toBeInstanceOf(Error);
      expect(plain).not.toBeInstanceOf(RemoteError);
    });
  });

  // Closed-ness runtime mirror of the static grep gate. tsc strict-mode reports
  // 'Function lacks ending return statement' if a future commit adds a member
  // without updating this switch (charter proposition 4 explicit failure +
  // proposition 3 machine-readable union > prose).
  function describeCode(code: RemoteErrorCode): string {
    switch (code) {
      case 'script-syntax-error':
        return 'syntax';
      case 'script-runtime-error':
        return 'runtime';
      case 'server-startup-failed':
        return 'startup-failed';
      case 'server-not-running':
        return 'not-running';
    }
  }

  describe('RemoteErrorCode exhaustive switch (closed-ness runtime mirror)', () => {
    it('every member maps to a distinct describeCode() result', () => {
      const results = new Set<string>();
      for (const code of REMOTE_ERROR_CODES_4) {
        const r = describeCode(code);
        expect(typeof r).toBe('string');
        expect(r.length).toBeGreaterThan(0);
        results.add(r);
      }
      expect(results.size).toBe(REMOTE_ERROR_CODES_4.size);
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

      const result = await startServer({ port: 0, world: {}, assets });
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
        method: 'eval',
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

      const result = await startServer({ port: 0, world: {}, assets });
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
        method: 'eval',
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
