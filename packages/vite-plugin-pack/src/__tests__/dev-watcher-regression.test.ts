// @perf-budget-skip: intentional real file-watcher integration regression gate.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_DELTA_EVENT } from '../catalog-transport.js';
import { createPluginPackInternal as pluginPack } from '../plugin-pack.js';

interface RecordedMessage {
  readonly type: string;
  readonly payload: {
    readonly type: string;
    readonly event?: string;
    readonly data?: unknown;
  };
}

function mockServer(): {
  readonly middlewares: { use(handler: unknown): void };
  readonly ws: {
    send(payload: { type: string } & Record<string, unknown>): void;
    calls: RecordedMessage[];
  };
} {
  const calls: RecordedMessage[] = [];
  return {
    middlewares: { use: () => {} },
    ws: {
      calls,
      send(payload) {
        calls.push({ type: payload.type, payload });
      },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('watcher event was not observed');
}

describe('dev watcher regression', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-pack-watcher-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'hud.ui.html'), '<div>HUD</div>');
    await writeFile(join(root, 'assets', 'hud.ui.css'), '.hud { color: white; }');
    await writeFile(join(root, 'assets', 'hero.png'), new Uint8Array([1]));
    await writeFile(join(root, 'assets', 'level.reel.json'), '{"version":1}');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('retains UI classification and full reload for non-UI consumers', async () => {
    const server = mockServer();
    pluginPack({ roots: [join(root, 'assets')] }).configureServer(server);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await writeFile(join(root, 'assets', 'hud.ui.html'), '<div>HUD v2</div>');
    await waitFor(() => server.ws.calls.some((call) => call.type === 'full-reload'));
    expect(server.ws.calls.some((call) => call.payload.event === CATALOG_DELTA_EVENT)).toBe(false);

    server.ws.calls.length = 0;
    await writeFile(join(root, 'assets', 'hud.ui.css'), '.hud { color: black; }');
    await waitFor(() => server.ws.calls.some((call) => call.type === 'full-reload'));
    expect(server.ws.calls.some((call) => call.payload.event === CATALOG_DELTA_EVENT)).toBe(false);

    server.ws.calls.length = 0;
    await writeFile(join(root, 'assets', 'hero.png'), new Uint8Array([2]));
    await waitFor(() => server.ws.calls.some((call) => call.type === 'full-reload'));
    expect(server.ws.calls.some((call) => call.payload.event === CATALOG_DELTA_EVENT)).toBe(false);

    server.ws.calls.length = 0;
    await writeFile(join(root, 'assets', 'level.reel.json'), '{"version":2}');
    await waitFor(() => server.ws.calls.some((call) => call.type === 'full-reload'));
    expect(server.ws.calls.some((call) => call.payload.event === CATALOG_DELTA_EVENT)).toBe(false);
  });
});
