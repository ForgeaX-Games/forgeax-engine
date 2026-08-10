import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginPack } from '../index.js';

interface RecordedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

interface MiddlewareServer {
  middlewares: { use(handler: Middleware): void };
  ws: { send(payload: { type: string } & Record<string, unknown>): void; calls: unknown[] };
}

type Middleware = (
  req: { url?: string; method?: string },
  res: RecordedResponse & {
    setHeader(name: string, value: string): void;
    end(body?: string | Uint8Array): void;
  },
  next: () => void,
) => void | Promise<void>;

function createServer(): MiddlewareServer & { handler?: Middleware } {
  const server: MiddlewareServer & { handler?: Middleware } = {
    middlewares: {
      use(handler) {
        server.handler = handler;
      },
    },
    ws: {
      calls: [],
      send(payload) {
        server.ws.calls.push(payload);
      },
    },
  };
  return server;
}

async function request(server: MiddlewareServer & { handler?: Middleware }, url: string) {
  const response: RecordedResponse = { statusCode: 200, headers: {}, body: undefined };
  const handler = server.handler;
  if (handler === undefined) throw new Error('plugin middleware was not registered');
  await handler(
    { url, method: 'GET' },
    {
      headers: response.headers,
      body: response.body,
      get statusCode() {
        return response.statusCode;
      },
      set statusCode(value: number) {
        response.statusCode = value;
      },
      setHeader(name, value) {
        response.headers[name] = value;
      },
      end(body) {
        response.body = body;
      },
    },
    () => {},
  );
  return response;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('expected lifecycle event was not observed');
}

describe('Pack plugin lifecycle characterization', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('keeps serve startup, watcher, routes, and build emission observable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-lifecycle-'));
    temporaryRoots.push(root);
    const assets = join(root, 'assets');
    await mkdir(assets);
    const server = createServer();
    const plugin = pluginPack({ roots: [assets] });
    plugin.configureServer(server);
    const binding = createStandaloneRuntimeAssetBinding('pack-lifecycle');
    await plugin.rebind(binding, [assets]);

    const initialIndex = await request(server, binding.catalogUrl);
    expect(initialIndex.statusCode).toBe(200);
    expect(initialIndex.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(initialIndex.body)).entries).toEqual([]);

    const missing = await request(
      server,
      '/__pack/scopes/pack-lifecycle/1/asset/__pack/lookup/unknown-guid',
    );
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(String(missing.body))).toEqual({
      error: 'not-found',
      guid: 'unknown-guid',
    });

    await writeFile(join(assets, 'level.reel.json'), '{"version":1}');
    await waitFor(() =>
      server.ws.calls.some((payload) => (payload as { type?: string }).type === 'full-reload'),
    );
    await plugin.closeBundle();

    const emitted: Array<{ fileName?: string; source?: string | Uint8Array }> = [];
    const buildPlugin = pluginPack({ roots: [] });
    await buildPlugin.generateBundle.call({
      emitFile(asset) {
        emitted.push(asset);
        return asset.fileName ?? asset.name ?? 'asset';
      },
      getFileName(referenceId) {
        return referenceId;
      },
    });
    const packIndex = emitted.find((asset) => asset.fileName === 'pack-index.json');
    expect(packIndex).toBeDefined();
    expect(JSON.parse(String(packIndex?.source))).toEqual([]);
  });

  it('keeps the characterization fixture free of producer readiness policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-lifecycle-source-'));
    temporaryRoots.push(root);
    const source = join(root, 'asset.pack.json');
    await writeFile(source, JSON.stringify({ schemaVersion: '2.0.0', assets: [] }));
    expect(await readFile(source, 'utf8')).toContain('schemaVersion');
  });
});
