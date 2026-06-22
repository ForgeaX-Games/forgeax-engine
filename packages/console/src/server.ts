// @forgeax/engine-console/src/server - in-process inspector server.
//
// Wire format (JSON-RPC 2.0 + OpenRPC L2 subset + InspectorError -> error.code
// segment -32001..-32006, research §3.2 + plan-strategy D-P3 RD-6 / RD-4).
//
// Lifecycle:
//   startConsoleServer({ port, host?, scriptTimeoutMs?, world })
//     -> Promise<Result<ConsoleHandle, InspectorError>>
//   - `port: 0` requests an OS-assigned ephemeral (helpful for tests).
//   - default `host = '127.0.0.1'` (charter proposition 4 + plan R-3 P0
//     trust-localhost baseline; non-loopback host emits a console.warn).
//   - `world` is injected here so AI-user code can `world.inspect()` /
//     `world.query()` inside scripts; engine.startConsole wires the real
//     World instance (T-13).
//
// JSON-RPC dispatch (2 method):
//   - introspect()              -> OpenRPC L2 subset doc (4 top-level
//                                  fields + components.{schemas,errors})
//   - execute({ script })       -> Result<unknown, InspectorError>
//
// Reserved error-code segments (g1 spec evidence):
//   -32700  parse error           (malformed JSON)
//   -32600  invalid request       (missing method field)
//   -32601  method not found      (unknown method)
//   -32602  invalid params        (execute called without script)
//   -32603  internal error        (server panic fallthrough)
//   -32001  script-syntax-error   <- inspector code
//   -32002  script-runtime-error  <- inspector code
//   -32003  script-timeout        <- inspector code
//   -32004  inspector-write-denied
//   -32005  console-startup-failed
//   -32006  console-not-running
//
// charter: proposition 1 (single startConsoleServer entry) + proposition 3
// (machine-readable union > prose) + proposition 4 (Result<T,E> over throw;
// EADDRINUSE returns Result.err verbatim — no silent re-bind) + proposition
// 5 (consistent abstraction — error.data carries the same 4-field structure
// AI users already consume from RhiError).

import type { Handler, Registry } from '@forgeax/engine-types';
import type { WebSocket } from 'ws';
// ws@^8.20 is the locked dependency (plan-strategy D-P3 RD-6). The shim
// stays thin so we can swap to Node 24+ built-in WebSocket once the baseline
// allows (R-4 fallback path).
import { WebSocketServer } from 'ws';
import { INSPECTOR_ERROR_CODE_TO_JSONRPC, InspectorError, type InspectorErrorCode } from './errors';
import { executeScript } from './execute';

/** Inspector code -> JSON-RPC error.code numeric segment lock-in (research §3.2 +
 *  feat-20260513 D-6). The mapping is owned by `./errors` (SSOT) and
 *  re-bound here under the local alias the rest of this file already uses. */
const INSPECTOR_TO_JSONRPC = INSPECTOR_ERROR_CODE_TO_JSONRPC;

const INSPECTOR_CODE_MESSAGE: Record<InspectorErrorCode, string> = {
  'script-syntax-error': 'Script syntax error',
  'script-runtime-error': 'Script runtime error',
  'script-timeout': 'Script timeout',
  'inspector-write-denied': 'Write denied (read-only proxy)',
  'console-startup-failed': 'Console startup failed',
  'console-not-running': 'Console not reachable',
};

// Result<T, E> + ok / err live in `@forgeax/engine-types` (tweak-20260612-result-
// into-types). The local re-export keeps the historical surface; the prior
// "kept local to avoid rhi runtime dep" rationale is preserved by routing
// through types (no rhi link).
import { err, ok, type Result } from '@forgeax/engine-types';

export type { Result };

export type ConsoleHandle = {
  readonly port: number;
  readonly close: () => Promise<void>;
};

/**
 * Options bag for `startConsoleServer`.
 *
 * Two forms (M4 dependency-inversion landing — feat-20260516):
 *
 * 1. **Registry form** (recommended): pass `{ port, registry }` where
 *    `registry` has been wired by `wireDefaultInspectors(reg, ctx)` (or
 *    individual `register*Inspector(reg, ctx)` calls). The server reads
 *    its sandbox roots via `registry.lookupRoot('world' | 'engine' |
 *    'assets')` and dispatches non-builtin JSON-RPC method calls to
 *    `registry.lookupMethod(method)` handlers.
 *
 * 2. **Legacy form** (kept through M4 for AC-13 e2e backward compat;
 *    deleted in M5 alongside `Renderer.startConsole`): pass `{ port,
 *    world, engine?, assets? }`. The server constructs an in-process
 *    `Registry` internally and registers the three roots via
 *    `registerRoot` so the sandbox sees the same shape as the registry
 *    form. No methods are pre-registered in this path; AI users that need
 *    `entities` / `components` / `systems` / `resources` over JSON-RPC
 *    must migrate to the registry form before M5.
 *
 * The two forms are mutually exclusive: `registry` and `world` are not
 * both honoured. When both are supplied the registry form wins (defensive
 * fail-fast against ambiguous wiring).
 */
export type StartConsoleServerOptions =
  | StartConsoleServerOptionsRegistry
  | StartConsoleServerOptionsLegacy;

export type StartConsoleServerOptionsRegistry = {
  readonly port: number;
  readonly host?: string;
  readonly scriptTimeoutMs?: number;
  readonly registry: Registry;
};

export type StartConsoleServerOptionsLegacy = {
  readonly port: number;
  readonly host?: string;
  readonly scriptTimeoutMs?: number;
  readonly world: unknown;
  readonly engine?: unknown;
  readonly assets?: unknown;
};

type JsonRpcRequest = {
  jsonrpc?: unknown;
  method?: unknown;
  params?: unknown;
  id?: unknown;
};

type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number | string | null;
} & ({ result: unknown } | { error: JsonRpcError });

function buildIntrospectDoc(host: string, port: number): unknown {
  // OpenRPC L2 subset (4 top-level + components.{schemas,errors}). Plan
  // strategy D-P3 RD-3 / research §3.3 evidence. Method list mirrors the
  // dispatch table below.
  //
  // Round 2 F-4 nit fix: servers[0].url is composed from the live (host,
  // port) pair rather than hardcoded — AI users that reach introspect()
  // get a URL that connects back to the same instance (charter
  // proposition 3: self-describing schema must reflect runtime state).
  const errors: Record<string, { code: number; message: string }> = {};
  for (const [code, num] of Object.entries(INSPECTOR_TO_JSONRPC) as Array<
    [InspectorErrorCode, number]
  >) {
    errors[code] = { code: num, message: INSPECTOR_CODE_MESSAGE[code] };
  }
  return {
    openrpc: '1.3.2',
    info: {
      title: '@forgeax/engine-console inspector',
      version: '0.0.0',
      description:
        'Inspector P0 server. Methods: execute / introspect. Errors map to JSON-RPC -32001..-32006.',
    },
    servers: [{ name: 'in-process', url: `ws://${host}:${port}/inspector` }],
    methods: [
      {
        name: 'execute',
        summary:
          'Run a JavaScript expression against the read-only world / engine / assets context.',
        params: [
          {
            name: 'script',
            required: true,
            schema: { type: 'string' },
          },
        ],
        result: { name: 'value', schema: { type: 'object' } },
      },
      {
        name: 'introspect',
        summary: 'Return this OpenRPC L2 subset document.',
        params: [],
        result: { name: 'document', schema: { type: 'object' } },
      },
    ],
    components: {
      schemas: {
        World: { type: 'object', description: 'Read-only proxy of the host World.' },
        Engine: { type: 'object', description: 'Read-only proxy of the host Engine.' },
        Assets: { type: 'object', description: 'Read-only proxy of the host AssetRegistry.' },
      },
      errors,
    },
  };
}

function inspectorErrorToJsonRpc(e: InspectorError): JsonRpcError {
  const detail = (e as unknown as { detail?: unknown }).detail;
  const data: Record<string, unknown> = {
    code: e.code,
    expected: e.expected,
    hint: e.hint,
    message: e.message,
  };
  if (detail !== undefined) data.detail = detail;
  return {
    code: INSPECTOR_TO_JSONRPC[e.code],
    message: INSPECTOR_CODE_MESSAGE[e.code],
    data,
  };
}

function respondError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcError = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: '2.0', id, error };
}

function respondOk(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function isValidId(v: unknown): v is number | string | null {
  return typeof v === 'number' || typeof v === 'string' || v === null;
}

async function handleEnvelope(
  raw: string,
  ctx: {
    registry: Registry;
    scriptTimeoutMs: number;
    host: string;
    port: number;
  },
): Promise<JsonRpcResponse | null> {
  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(raw) as JsonRpcRequest;
  } catch {
    return respondError(null, -32700, 'Parse error');
  }
  if (typeof parsed.method !== 'string') {
    const id = isValidId(parsed.id) ? parsed.id : null;
    return respondError(id, -32600, 'Invalid Request');
  }
  // Notifications (no id field) get no response per spec.
  const isNotification = !('id' in parsed);
  const id = isValidId(parsed.id) ? parsed.id : null;

  let response: JsonRpcResponse;
  if (parsed.method === 'introspect') {
    response = respondOk(id, buildIntrospectDoc(ctx.host, ctx.port));
  } else if (parsed.method === 'execute') {
    const params = parsed.params as { script?: unknown } | undefined;
    const script = params?.script;
    if (typeof script !== 'string') {
      response = respondError(id, -32602, 'Invalid params: execute requires { script: string }');
    } else {
      const result = executeScript(script, {
        world: ctx.registry.lookupRoot('world') ?? {},
        engine: ctx.registry.lookupRoot('engine') ?? {},
        assets: ctx.registry.lookupRoot('assets') ?? {},
        scriptTimeoutMs: ctx.scriptTimeoutMs,
        registry: ctx.registry,
      });
      if (result.ok) {
        response = respondOk(id, result.value);
      } else {
        response = { jsonrpc: '2.0', id, error: inspectorErrorToJsonRpc(result.error) };
      }
    }
  } else {
    // Method dispatch via the Registry interface — non-builtin methods
    // route through `registry.lookupMethod(name)` (M4 plan-strategy §2.6
    // ecs / runtime contributor entry points). Handler exceptions surface
    // as -32603 internal error so the closed InspectorErrorCode union
    // does not need a new code (§2.11 wire-protocol freeze).
    const handler: Handler | undefined = ctx.registry.lookupMethod(parsed.method);
    if (handler === undefined) {
      response = respondError(id, -32601, `Method not found: ${parsed.method}`);
    } else {
      try {
        const value = handler(parsed.params ?? null) as unknown;
        response = respondOk(id, value);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        response = respondError(id, -32603, `Internal error: ${message}`);
      }
    }
  }

  return isNotification ? null : response;
}

/**
 * Start the inspector WebSocket server.
 *
 * Returns `Result.ok(handle)` on a successful listen, or `Result.err` with
 * `code: 'console-startup-failed'` if the OS rejects the listen call (e.g.
 * EADDRINUSE). The error path carries the original errno in the hint copy
 * so AI consumers can dispatch on it without parsing the message string
 * (charter proposition 4 explicit failure).
 */
export function startConsoleServer(
  opts: StartConsoleServerOptions,
): Promise<Result<ConsoleHandle, InspectorError>> {
  return new Promise<Result<ConsoleHandle, InspectorError>>((resolve) => {
    // Resolve the registry: the new form supplies one; the legacy form
    // synthesises one from world/engine/assets so the JSON-RPC sandbox
    // sees the same shape regardless of caller style. Legacy form deletes
    // in M5 (feat-20260516-console-dependency-inversion plan-strategy
    // §7 milestone M5).
    const registry: Registry = resolveRegistry(opts);
    const host = opts.host ?? '127.0.0.1';
    if (host !== '127.0.0.1' && host !== 'localhost') {
      // Charter proposition 4: explicit failure > silent assumption. We
      // surface a warning rather than refuse — AI users can opt in to
      // non-loopback hosts but they get a one-line audit trail.
      console.warn(
        `[@forgeax/engine-console] WARNING: binding inspector on non-loopback host '${host}'. P0 trusts localhost only; see plan R-3 + AGENTS.md Inspector / Console section.`,
      );
    }
    const wss = new WebSocketServer({
      host,
      port: opts.port,
      path: '/inspector',
      maxPayload: 1 << 20, // 1 MiB; AI scripts are short
      perMessageDeflate: false, // tiny payloads + per-message overhead > gain
    });

    const scriptTimeoutMs = opts.scriptTimeoutMs ?? 5000;
    let settled = false;
    // Round 2 F-4 nit: capture the live bound port so introspect()
    // self-describing `servers[].url` reflects the OS-assigned ephemeral
    // when callers pass `port: 0`. Updated by the 'listening' handler
    // below; falls back to the requested `opts.port` until then.
    let boundPort = opts.port;

    wss.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) {
        // Post-startup error: surface on stderr; do not crash the host
        // process. Charter proposition 4: visible logging > silent.
        console.error('[@forgeax/engine-console] post-startup error:', e);
        return;
      }
      settled = true;
      const errno = e.code ?? 'unknown';
      resolve(
        err(
          new InspectorError({
            code: 'console-startup-failed',
            expected: 'console server starts successfully on requested port',
            hint:
              errno === 'EADDRINUSE'
                ? `port ${opts.port} is already in use; lsof -i :${opts.port} or pick a different port via engine.startConsole({ port: <other> })`
                : `listen failed with errno ${errno}; check host '${host}' on this machine; port=${opts.port}`,
          }),
        ),
      );
    });

    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw) => {
        const text = typeof raw === 'string' ? raw : raw.toString();
        handleEnvelope(text, {
          registry,
          scriptTimeoutMs,
          host,
          port: boundPort,
        })
          .then((response) => {
            if (response !== null && ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(response));
            }
          })
          .catch((e: unknown) => {
            // Internal panic; surface via -32603 if the socket is still alive
            // so the AI user is not left hanging. Charter proposition 4 again.
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(respondError(null, -32603, `Internal error: ${String(e)}`)));
            }
          });
      });
    });

    wss.on('listening', () => {
      if (settled) {
        return;
      }
      settled = true;
      const address = wss.address();
      const port = typeof address === 'object' && address !== null ? address.port : opts.port;
      boundPort = port;
      const handle: ConsoleHandle = {
        port,
        close: () =>
          new Promise<void>((closeResolve) => {
            // Terminate live clients first so server.close() does not block
            // waiting for them to drain (g7 evidence + plan-strategy D-P3
            // RD-6).
            for (const client of wss.clients) {
              client.terminate();
            }
            wss.close(() => closeResolve());
          }),
      };
      resolve(ok(handle));
    });
  });
}

// In-process Registry view used by the legacy `{ port, world, engine?, assets? }`
// form. Only the lookup half of the interface is consulted; register* is
// stubbed (M5 deletes the legacy form so the partial implementation is
// scope-bounded).
class LegacyRegistryAdapter implements Registry {
  constructor(
    private readonly world: unknown,
    private readonly engine: unknown,
    private readonly assets: unknown,
  ) {}
  registerRoot(): { ok: true; value: void } {
    return { ok: true, value: undefined };
  }
  registerMethod(): { ok: true; value: void } {
    return { ok: true, value: undefined };
  }
  lookupRoot(name: string): unknown {
    if (name === 'world') return this.world;
    if (name === 'engine') return this.engine;
    if (name === 'assets') return this.assets;
    return undefined;
  }
  lookupMethod(): Handler | undefined {
    return undefined;
  }
  // feat-20260517 D-5: stub mutating-methods entries on the legacy adapter.
  // M5 deletes the legacy adapter, so a permissive stub (always-ok register,
  // empty lookup) keeps tsc green without contradicting the contract.
  registerMutatingMethods(): { ok: true; value: void } {
    return { ok: true, value: undefined };
  }
  lookupMutatingMethods(): ReadonlySet<string> {
    return EMPTY_MUTATING_METHODS;
  }
}

const EMPTY_MUTATING_METHODS: ReadonlySet<string> = new Set<string>();

function resolveRegistry(opts: StartConsoleServerOptions): Registry {
  if ('registry' in opts) {
    return opts.registry;
  }
  return new LegacyRegistryAdapter(opts.world, opts.engine ?? {}, opts.assets ?? {});
}
