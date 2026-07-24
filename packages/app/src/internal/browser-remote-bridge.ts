// @forgeax/engine-app/internal/browser-remote-bridge — DEV-only page-side bridge
// that makes a live BROWSER engine drivable over a loopback relay.
//
// WHY: @forgeax/engine-remote's only external transport is a Node WebSocket
// server (packages/remote/src/server.ts). A browser page cannot bind a listening
// socket, so createApp's startServer attempt throws on ws's browser shim and
// app.remote stays undefined — the running engine is unreachable in a real
// `pnpm --filter <app> dev` browser. But a page CAN dial OUT. So we open a
// WebSocket CLIENT to the loopback relay
// (skills/forgeax-engine-cli/scripts/remote-bridge-server.mjs) and run
// @forgeax/engine-remote/execute (the ws-free eval core) in the page realm
// against the live world/renderer/assets/debugAdapter. A CLI POSTs to the relay;
// the relay forwards to us; we eval and reply. This is the engine-side mirror of
// the editor's ViewportComponent DEV bridge.
//
// This module is reached only via a DEV-gated dynamic import from create-app.ts,
// so production (import.meta.env.DEV === false) never bundles it (tree-shake /
// zero-injection). It carries NO static @forgeax/engine-remote dependency — the
// eval core is pulled by a further dynamic import, keeping @forgeax/engine-app
// free of a runtime dep on @forgeax/engine-remote (same discipline as the
// createApp startServer path).

import { Update, type World } from '@forgeax/engine-ecs';

type ExecuteResult = { ok: true; value: unknown } | { ok: false; error: unknown };

type ExecuteModule = {
  executeScript: (
    script: string,
    ctx: {
      world: unknown;
      renderer: unknown;
      assets: unknown;
      debugAdapter?: unknown;
      importModule?: (specifier: string) => Promise<unknown>;
    },
  ) => Promise<ExecuteResult>;
};

type ComponentLike = { readonly name: string };

/**
 * Project component exports onto the tokens already stored by this World.
 *
 * WHY: Vite may evaluate a workspace package once through the host package's
 * dist graph and once through a source graph. Component ids are process-local,
 * so equal `{ name, schema }` objects are not interchangeable with World
 * access. The bridge is the one place that can reconcile the public module
 * recipe with the live World's archetype SSOT.
 */
function canonicalRuntimeModule(moduleValue: unknown, world: World): unknown {
  if (moduleValue === null || typeof moduleValue !== 'object') return moduleValue;
  const componentsByName = new Map<string, ComponentLike>();
  for (const archetype of world._getGraph().archetypes) {
    for (const component of archetype.components) {
      if (!componentsByName.has(component.name)) componentsByName.set(component.name, component);
    }
  }
  const projected: Record<string, unknown> = { ...(moduleValue as Record<string, unknown>) };
  for (const [key, value] of Object.entries(projected)) {
    if (value === null || typeof value !== 'object' || !('name' in value)) continue;
    const canonical = componentsByName.get((value as ComponentLike).name);
    if (canonical !== undefined) projected[key] = canonical;
  }
  return projected;
}

export interface BrowserRemoteBridgeDeps {
  readonly world: World;
  readonly renderer: unknown;
  readonly assets: unknown;
  /** The host's already-loaded runtime namespace; preserves component-token identity. */
  readonly runtimeModule: unknown;
  readonly debugAdapter?: unknown;
  /** Relay port. */
  readonly port: string;
}

/** Serialize a RemoteError-shaped object (or any thrown value) into a JSON-safe
 *  {code, expected, hint, detail?} envelope. AI users branch on error.code by
 *  property access, so the four structured fields must survive the wire. */
function serializeError(error: unknown): Record<string, unknown> {
  if (error !== null && typeof error === 'object') {
    const e = error as {
      code?: unknown;
      expected?: unknown;
      hint?: unknown;
      detail?: unknown;
      message?: unknown;
    };
    const out: Record<string, unknown> = {
      code: typeof e.code === 'string' ? e.code : 'script-runtime-error',
    };
    if (typeof e.expected === 'string') out.expected = e.expected;
    if (typeof e.hint === 'string') out.hint = e.hint;
    if (e.detail !== undefined) out.detail = e.detail;
    if (out.hint === undefined && typeof e.message === 'string') out.hint = e.message;
    return out;
  }
  return { code: 'script-runtime-error', hint: String(error) };
}

/**
 * Install the DEV-only browser remote bridge. Idempotent per call site; the
 * caller gates on import.meta.env.DEV so this never runs in production.
 *
 * Returns a teardown function that stops reconnection and closes the socket —
 * the caller wires it to import.meta.hot.dispose so a vite HMR of the host app
 * does not stack duplicate bridges.
 */
export async function installBrowserRemoteBridge(
  deps: BrowserRemoteBridgeDeps,
): Promise<() => void> {
  const { world, renderer, assets, debugAdapter, port } = deps;

  // The ws-free eval core. Dynamic import keeps @forgeax/engine-app free of a
  // static @forgeax/engine-remote dependency (@vite-ignore mirrors the
  // startServer path in create-app.ts).
  const mod = (await import(/* @vite-ignore */ '@forgeax/engine-remote/execute')) as ExecuteModule;
  const executeScript = mod.executeScript;
  const importModule = (specifier: string): Promise<unknown> => {
    // The host app and the bridge must share the same component-token objects.
    // Vite can otherwise serve `/@id/@forgeax/engine-runtime` as a second
    // module graph entry, so `world.get(entity, Transform)` sees a different
    // Component id even though the token has the same name and schema.
    if (specifier === '@forgeax/engine-runtime')
      return Promise.resolve(canonicalRuntimeModule(deps.runtimeModule, world));
    const browserSpecifier = specifier.startsWith('@') ? `/@id/${specifier}` : specifier;
    return import(/* @vite-ignore */ browserSpecifier);
  };

  let ws: WebSocket | null = null;
  let backoff = 1000;
  let stopped = false;

  // Frame-start eval queue: a WebSocket `message` fires at an arbitrary phase of
  // the rAF tick, so running eval inline would land world writes at an
  // unpredictable phase. Enqueue instead and drain from Update system (frame
  // start) so every bridge write passes through this frame's systems.
  const evalQueue: Array<{ id: number; code: string }> = [];

  const drainEvalQueue = (): void => {
    if (evalQueue.length === 0) return;
    // Snapshot + clear so an eval that enqueues runs next frame, not in an
    // unbounded same-frame loop.
    const jobs = evalQueue.splice(0, evalQueue.length);
    for (const job of jobs) {
      const reply = (payload: unknown): void => {
        // Reply on the CURRENT socket (it may have reconnected since enqueue).
        // The relay keys replies by request id, so the live socket resolves it.
        try {
          ws?.send(JSON.stringify({ type: 'result', id: job.id, payload }));
        } catch {
          /* socket gone; relay times the request out */
        }
      };
      void (async () => {
        let res: ExecuteResult;
        try {
          res = await executeScript(job.code, {
            world,
            renderer,
            assets,
            debugAdapter,
            importModule,
          });
        } catch (e) {
          reply({
            ok: false,
            error: { code: 'BRIDGE_EVAL_THREW', hint: String((e as Error)?.message ?? e) },
          });
          return;
        }
        const envelope = res.ok
          ? { ok: true as const, value: res.value }
          : { ok: false as const, error: serializeError(res.error) };
        // JSON-guard: non-serializable values (opaque engine handles, cycles)
        // degrade to a marker so one bad field never wedges the channel.
        try {
          JSON.stringify(envelope);
          reply(envelope);
        } catch {
          reply({ ok: true, value: '[unserializable value — inspect in the live window]' });
        }
      })();
    }
  };
  world
    .addSystem(Update, {
      name: 'browser-remote-bridge-drain-eval-queue',
      queries: [],
      fn: drainEvalQueue,
    })
    .unwrap();

  const connect = (): void => {
    if (stopped) return;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
    } catch {
      return;
    }
    ws.addEventListener('open', () => {
      backoff = 1000;
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { type?: string; id?: number; code?: string };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (msg?.type !== 'eval' || typeof msg.id !== 'number' || typeof msg.code !== 'string')
        return;
      evalQueue.push({ id: msg.id, code: msg.code });
    });
    const retry = (): void => {
      ws = null;
      if (stopped) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 15000);
    };
    ws.addEventListener('close', retry);
    ws.addEventListener('error', () => {
      try {
        ws?.close();
      } catch {
        /* */
      }
    });
  };
  connect();

  const teardown = (): void => {
    stopped = true;
    const s = ws;
    ws = null;
    if (s) {
      try {
        s.onclose = null;
        s.close();
      } catch {
        /* */
      }
    }
  };

  // Self-register HMR teardown so a vite HMR of the host app does not stack
  // duplicate bridges. Kept here (not in create-app.ts) so create-app.ts carries
  // no import.meta.hot reference — the rhi-debug guard gate requires every
  // import.meta.hot there to sit inside the FORGEAX_ENGINE_RHI_DEBUG block.
  const hot = (import.meta as { hot?: { dispose(cb: () => void): void } }).hot;
  if (hot) hot.dispose(teardown);

  return teardown;
}
