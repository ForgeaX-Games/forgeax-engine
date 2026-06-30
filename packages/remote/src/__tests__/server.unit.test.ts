// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=1):
//   - packages/console/src/__tests__/server.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RemoteError } from '../errors';
import { type ConsoleHandle, startServer } from '../server';

{
  // --- from server.test.ts ---
  // Route B (2026-06-29): eval is full-access, no sandbox, no registry.
  // startServer takes { world, renderer?, assets? } — no engine/registry.

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
        expected: string;
        hint: string;
        message?: string;
      };
    };
    id: number | string | null;
  };

  async function connect(port: number): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/inspector`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (e) => reject(e));
    });
    return ws;
  }

  async function send(ws: WebSocket, msg: JsonRpcRequest): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const handler = (raw: WebSocket.RawData): void => {
        ws.off('message', handler);
        try {
          const parsed = JSON.parse(raw.toString()) as JsonRpcResponse;
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify(msg));
    });
  }

  async function withServer(
    fn: (handle: ConsoleHandle) => Promise<void>,
    opts: {
      port?: number;
      world?: unknown;
      renderer?: unknown;
      assets?: unknown;
    } = {},
  ): Promise<void> {
    const startResult = await startServer({
      port: opts.port ?? 0,
      host: '127.0.0.1',
      world: opts.world ?? {},
      renderer: opts.renderer,
      assets: opts.assets,
    });
    if (!startResult.ok) {
      throw startResult.error;
    }
    const handle = startResult.value;
    try {
      await fn(handle);
    } finally {
      await handle.close();
    }
  }

  describe('startServer happy path', () => {
    it('returns Result.ok with a ConsoleHandle exposing .port + .close', async () => {
      await withServer(async (handle) => {
        expect(typeof handle.port).toBe('number');
        expect(handle.port).toBeGreaterThan(0);
        expect(typeof handle.close).toBe('function');
      });
    });
  });

  describe('JSON-RPC envelope shape', () => {
    it('response carries jsonrpc + id and either result or error (mutually exclusive)', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, { jsonrpc: '2.0', method: 'introspect', id: 1 });
        expect(resp.jsonrpc).toBe('2.0');
        expect(resp.id).toBe(1);
        expect(resp.result).toBeDefined();
        expect(resp.error).toBeUndefined();
        ws.close();
      });
    });

    it('unknown method returns -32601 method-not-found on the response error envelope', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, { jsonrpc: '2.0', method: 'no-such-method', id: 2 });
        expect(resp.error).toBeDefined();
        expect(resp.error?.code).toBe(-32601);
        expect(resp.error?.message.toLowerCase()).toContain('method');
        ws.close();
      });
    });

    it('malformed JSON returns -32700 parse-error (server stays alive)', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const responsePromise = new Promise<JsonRpcResponse>((resolve) => {
          ws.once('message', (raw) => {
            resolve(JSON.parse(raw.toString()) as JsonRpcResponse);
          });
        });
        ws.send('this is not json');
        const resp = await responsePromise;
        expect(resp.error?.code).toBe(-32700);
        ws.close();
      });
    });

    it('missing method field returns -32600 invalid-request', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const responsePromise = new Promise<JsonRpcResponse>((resolve) => {
          ws.once('message', (raw) => {
            resolve(JSON.parse(raw.toString()) as JsonRpcResponse);
          });
        });
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3 }));
        const resp = await responsePromise;
        expect(resp.error?.code).toBe(-32600);
        ws.close();
      });
    });
  });

  describe('introspect() OpenRPC L2 subset', () => {
    it('returns the 4 top-level fields + components.{schemas,errors}', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, { jsonrpc: '2.0', method: 'introspect', id: 10 });
        const doc = resp.result as Record<string, unknown>;
        expect(typeof doc.openrpc).toBe('string');
        expect(doc.info).toBeDefined();
        expect(Array.isArray(doc.servers)).toBe(true);
        expect(Array.isArray(doc.methods)).toBe(true);
        const components = doc.components as Record<string, unknown>;
        expect(components).toBeDefined();
        expect(components.schemas).toBeDefined();
        expect(components.errors).toBeDefined();
        ws.close();
      });
    });

    it('methods[] lists `eval` + `introspect` (route B rename)', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, { jsonrpc: '2.0', method: 'introspect', id: 11 });
        const doc = resp.result as { methods: Array<{ name: string }> };
        const names = new Set(doc.methods.map((m) => m.name));
        expect(names.has('eval')).toBe(true);
        expect(names.has('introspect')).toBe(true);
        ws.close();
      });
    });

    it('components.errors carries all 4 RemoteErrorCode members', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, { jsonrpc: '2.0', method: 'introspect', id: 12 });
        const doc = resp.result as { components: { errors: Record<string, { code: number }> } };
        const errCodes = new Set<number>();
        for (const key of Object.keys(doc.components.errors)) {
          const entry = doc.components.errors[key];
          if (entry !== undefined) {
            errCodes.add(entry.code);
          }
        }
        expect(errCodes.has(-32001)).toBe(true);
        expect(errCodes.has(-32002)).toBe(true);
        expect(errCodes.has(-32003)).toBe(true);
        expect(errCodes.has(-32004)).toBe(true);
        ws.close();
      });
    });
  });

  describe('eval dispatch -- route B (full-access, no sandbox)', () => {
    it('world.spawn() succeeds via eval (no server-startup-failed in route B)', async () => {
      const writableWorld = {
        spawn(): { entity: number } {
          return { entity: 1 };
        },
      };
      await withServer(
        async (handle) => {
          const ws = await connect(handle.port);
          const resp = await send(ws, {
            jsonrpc: '2.0',
            method: 'eval',
            params: { script: 'world.spawn()' },
            id: 20,
          });
          expect(resp.result).toBeDefined();
          expect(resp.error).toBeUndefined();
          ws.close();
        },
        { world: writableWorld },
      );
    });

    it('renderer read returns real field value', async () => {
      const stubRenderer = { backend: 'webgpu', isReady: true };
      await withServer(
        async (handle) => {
          const ws = await connect(handle.port);
          const resp = await send(ws, {
            jsonrpc: '2.0',
            method: 'eval',
            params: { script: 'renderer.backend' },
            id: 21,
          });
          expect(resp.result).toBe('webgpu');
          ws.close();
        },
        { world: {}, renderer: stubRenderer },
      );
    });

    it('script-syntax-error maps to JSON-RPC -32001', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, {
          jsonrpc: '2.0',
          method: 'eval',
          params: { script: 'world.inspect((' },
          id: 22,
        });
        expect(resp.error).toBeDefined();
        expect(resp.error?.code).toBe(-32001);
        expect(resp.error?.data).toBeDefined();
        ws.close();
      });
    });

    it('script-runtime-error maps to JSON-RPC -32002', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, {
          jsonrpc: '2.0',
          method: 'eval',
          params: { script: 'throw new Error("boom")' },
          id: 23,
        });
        expect(resp.error).toBeDefined();
        expect(resp.error?.code).toBe(-32002);
        ws.close();
      });
    });
  });

  describe('EADDRINUSE -> server-startup-failed (no silent fallback)', () => {
    it('second server on same port returns Result.err with code server-startup-failed', async () => {
      await withServer(async (handle) => {
        const portInUse = handle.port;
        const second = await startServer({
          port: portInUse,
          host: '127.0.0.1',
          world: {},
        });
        expect(second.ok).toBe(false);
        if (!second.ok) {
          expect(second.error).toBeInstanceOf(RemoteError);
          expect(second.error.code).toBe('server-startup-failed');
          expect(second.error.hint.length).toBeGreaterThan(0);
        }
      });
    });
  });

  describe('renderer + assets context surfaces through eval (route B)', () => {
    it('renderer.spawn() succeeds (full-access, no sandbox)', async () => {
      const stubRenderer = {
        spawn(): { ok: boolean } {
          return { ok: true };
        },
        backend: 'webgpu',
      };
      await withServer(
        async (handle) => {
          const ws = await connect(handle.port);
          const resp = await send(ws, {
            jsonrpc: '2.0',
            method: 'eval',
            params: { script: 'renderer.spawn()' },
            id: 50,
          });
          expect(resp.result).toBeDefined();
          expect(resp.result).toEqual({ ok: true });
          ws.close();
        },
        { world: {}, renderer: stubRenderer },
      );
    });

    it('assets.register() succeeds (full-access, no sandbox)', async () => {
      const stubAssets = {
        register(_a: unknown): number {
          return 42;
        },
      };
      await withServer(
        async (handle) => {
          const ws = await connect(handle.port);
          const resp = await send(ws, {
            jsonrpc: '2.0',
            method: 'eval',
            params: { script: 'assets.register({ kind: "mesh" })' },
            id: 51,
          });
          expect(resp.result).toBe(42);
          ws.close();
        },
        { world: {}, assets: stubAssets },
      );
    });

    it('renderer read returns real field value', async () => {
      await withServer(
        async (handle) => {
          const ws = await connect(handle.port);
          const resp = await send(ws, {
            jsonrpc: '2.0',
            method: 'eval',
            params: { script: 'renderer.backend' },
            id: 52,
          });
          expect(resp.result).toBe('webgpu');
          ws.close();
        },
        { world: {}, renderer: { backend: 'webgpu' } },
      );
    });
  });

  describe('introspect() servers[].url reflects opts.port + opts.host (Round 2 F-4)', () => {
    // Round 2 F-4 nit: previously hardcoded ws://127.0.0.1:5732/inspector;
    // the OpenRPC self-describing schema must reflect the live binding so
    // AI users that reach introspect() can connect back to the same URL.
    it('servers[0].url uses the bound port returned in ConsoleHandle', async () => {
      await withServer(async (handle) => {
        const ws = await connect(handle.port);
        const resp = await send(ws, { jsonrpc: '2.0', method: 'introspect', id: 60 });
        const doc = resp.result as { servers: ReadonlyArray<{ url: string }> };
        const url = doc.servers[0]?.url ?? '';
        expect(url).toContain(String(handle.port));
        expect(url).toMatch(/^ws:\/\//);
        ws.close();
      });
    });
  });

  describe('close() releases port + terminates clients', () => {
    it('after close() the same port is rebindable + connected clients are dropped', async () => {
      const start1 = await startServer({ port: 0, host: '127.0.0.1', world: {} });
      if (!start1.ok) {
        throw start1.error;
      }
      const handle1 = start1.value;
      const port = handle1.port;
      const ws = await connect(port);
      const closedPromise = new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
      });
      await handle1.close();
      // Existing client should observe close (force-terminated by the server).
      await closedPromise;
      // Rebind the same port immediately — this proves the server.close
      // completed before the Promise resolved (g7 evidence: server.close +
      // clients.forEach(terminate) is the correct ordering).
      const start2 = await startServer({ port, host: '127.0.0.1', world: {} });
      expect(start2.ok).toBe(true);
      if (start2.ok) {
        await start2.value.close();
      }
    });
  });
}
