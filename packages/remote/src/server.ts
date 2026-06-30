// @forgeax/engine-remote/src/server — in-process remote eval server.
//
// Wire format: JSON-RPC 2.0 with two methods:
//   - introspect()  -> OpenRPC L2 subset doc
//   - eval({script}) -> eval the script against world/renderer/assets
//
// Lifecycle:
//   startServer({ port, host?, world, renderer?, assets? })
//     -> Promise<Result<ConsoleHandle, RemoteError>>
//
// The sandbox layer is dismantled — eval is full-access (route B).

import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { REMOTE_ERROR_CODE_TO_JSONRPC, RemoteError, type RemoteErrorCode } from './errors';
import { executeScript } from './execute';

const REMOTE_TO_JSONRPC = REMOTE_ERROR_CODE_TO_JSONRPC;

const REMOTE_CODE_MESSAGE: Record<RemoteErrorCode, string> = {
  'script-syntax-error': 'Script syntax error',
  'script-runtime-error': 'Script runtime error',
  'server-startup-failed': 'Server startup failed',
  'server-not-running': 'Server not reachable',
};

import { err, ok, type Result } from '@forgeax/engine-types';

export type { Result };

export type ConsoleHandle = {
  readonly port: number;
  readonly close: () => Promise<void>;
};

export type StartServerOptions = {
  readonly port: number;
  readonly host?: string;
  readonly world: unknown;
  readonly renderer?: unknown;
  readonly assets?: unknown;
  /**
   * Live DebugRhiAdapter for eval-scope injection (plan-strategy D-4).
   * When present, eval scripts can call debugAdapter.captureFrame({...})
   * and debugAdapter.inspectAt({...}) — the 4th eval-scope live root.
   * Undefined when FORGEAX_ENGINE_RHI_DEBUG !== '1'.
   */
  readonly debugAdapter?: unknown;
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
  const errors: Record<string, { code: number; message: string }> = {};
  for (const [code, num] of Object.entries(REMOTE_TO_JSONRPC) as Array<[RemoteErrorCode, number]>) {
    errors[code] = { code: num, message: REMOTE_CODE_MESSAGE[code] };
  }
  return {
    openrpc: '1.3.2',
    info: {
      title: '@forgeax/engine-remote remote eval',
      version: '0.0.0',
      description:
        'Remote eval server. Methods: eval / introspect. Errors map to JSON-RPC -32001..-32006.',
    },
    servers: [{ name: 'in-process', url: `ws://${host}:${port}/inspector` }],
    methods: [
      {
        name: 'eval',
        summary: 'Evaluate a JavaScript script against world / renderer / assets.',
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
        World: { type: 'object', description: 'The host World instance.' },
        Renderer: { type: 'object', description: 'The host Renderer instance.' },
        Assets: { type: 'object', description: 'The host AssetRegistry instance.' },
      },
      errors,
    },
  };
}

function inspectorErrorToJsonRpc(e: RemoteError): JsonRpcError {
  const detail = (e as unknown as { detail?: unknown }).detail;
  const data: Record<string, unknown> = {
    code: e.code,
    expected: e.expected,
    hint: e.hint,
    message: e.message,
  };
  if (detail !== undefined) data.detail = detail;
  return {
    code: REMOTE_TO_JSONRPC[e.code],
    message: REMOTE_CODE_MESSAGE[e.code],
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
    world: unknown;
    renderer: unknown;
    assets: unknown;
    debugAdapter: unknown | undefined;
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
  const isNotification = !('id' in parsed);
  const id = isValidId(parsed.id) ? parsed.id : null;

  let response: JsonRpcResponse;
  if (parsed.method === 'introspect') {
    response = respondOk(id, buildIntrospectDoc(ctx.host, ctx.port));
  } else if (parsed.method === 'eval') {
    const params = parsed.params as { script?: unknown } | undefined;
    const script = params?.script;
    if (typeof script !== 'string') {
      response = respondError(id, -32602, 'Invalid params: eval requires { script: string }');
    } else {
      const result = await executeScript(script, {
        world: ctx.world,
        renderer: ctx.renderer,
        assets: ctx.assets,
        debugAdapter: ctx.debugAdapter,
      });
      if (result.ok) {
        response = respondOk(id, result.value);
      } else {
        response = { jsonrpc: '2.0', id, error: inspectorErrorToJsonRpc(result.error) };
      }
    }
  } else {
    response = respondError(id, -32601, `Method not found: ${parsed.method}`);
  }

  return isNotification ? null : response;
}

/**
 * Start the remote eval WebSocket server.
 */
export function startServer(opts: StartServerOptions): Promise<Result<ConsoleHandle, RemoteError>> {
  return new Promise<Result<ConsoleHandle, RemoteError>>((resolve) => {
    const host = opts.host ?? '127.0.0.1';
    if (host !== '127.0.0.1' && host !== 'localhost') {
      console.warn(
        `[@forgeax/engine-remote] WARNING: binding on non-loopback host '${host}'. P0 trusts localhost only.`,
      );
    }
    const wss = new WebSocketServer({
      host,
      port: opts.port,
      path: '/inspector',
      maxPayload: 1 << 20,
      perMessageDeflate: false,
    });

    const world = opts.world;
    const renderer = opts.renderer ?? {};
    const assets = opts.assets ?? {};
    const debugAdapter = opts.debugAdapter;
    let settled = false;
    let boundPort = opts.port;

    wss.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) {
        console.error('[@forgeax/engine-remote] post-startup error:', e);
        return;
      }
      settled = true;
      const errno = e.code ?? 'unknown';
      resolve(
        err(
          new RemoteError({
            code: 'server-startup-failed',
            expected: 'server starts successfully on requested port',
            hint:
              errno === 'EADDRINUSE'
                ? `port ${opts.port} is already in use; lsof -i :${opts.port} or pick a different port`
                : `listen failed with errno ${errno}; check host '${host}' on this machine; port=${opts.port}`,
          }),
        ),
      );
    });

    wss.on('connection', (ws: WebSocket) => {
      ws.on('message', (raw) => {
        const text = typeof raw === 'string' ? raw : raw.toString();
        handleEnvelope(text, {
          world,
          renderer,
          assets,
          debugAdapter,
          host,
          port: boundPort,
        })
          .then((response) => {
            if (response !== null && ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify(response));
            }
          })
          .catch((e: unknown) => {
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
