import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';

import previewConfig from '../vite.config';

const previewRoot = dirname(fileURLToPath(new URL('../vite.config.ts', import.meta.url)));
const templateAssets = join(previewRoot, '..', '..', 'templates', 'game-default', 'assets');
const sourceMaterial = join(templateAssets, 'base-material.pack.json');
const probeMaterial = join(templateAssets, 'catalog-host-refresh-probe.pack.json');

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the preview host refresh event.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('preview host catalog refresh', () => {
  afterEach(async () => {
    await rm(probeMaterial, { force: true });
  });

  it('observes a watched preview asset mutation and requests the configured host reload', async () => {
    const baseline = await readFile(sourceMaterial, 'utf8');
    await writeFile(probeMaterial, baseline);
    const server = await createServer({
      ...previewConfig,
      configFile: false,
      root: previewRoot,
      logLevel: 'error',
      server: { ...previewConfig.server, port: 0, strictPort: true },
    });
    const events: unknown[] = [];
    const ws = server.ws as unknown as { send(payload: unknown): void };
    const send = ws.send.bind(ws);
    ws.send = (payload: unknown): void => {
      events.push(payload);
      send(payload);
    };

    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await writeFile(probeMaterial, `${baseline}\n`);
      await waitFor(() => events.some((event) => (
        typeof event === 'object' && event !== null && 'type' in event && event.type === 'full-reload'
      )));
      expect(events).toContainEqual(expect.objectContaining({ type: 'full-reload' }));
    } finally {
      await server.close();
    }
  });

  it('falsifies the host-refresh assertion when the preview watcher has no policy', async () => {
    const baseline = await readFile(sourceMaterial, 'utf8');
    await writeFile(probeMaterial, baseline);
    const server = await createServer({
      configFile: false,
      root: previewRoot,
      logLevel: 'error',
      plugins: [pluginPack({ roots: [templateAssets] })],
    });
    const events: unknown[] = [];
    const ws = server.ws as unknown as { send(payload: unknown): void };
    const send = ws.send.bind(ws);
    ws.send = (payload: unknown): void => {
      events.push(payload);
      send(payload);
    };

    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await writeFile(probeMaterial, `${baseline}\n`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(events.some((event) => (
        typeof event === 'object' && event !== null && 'type' in event && event.type === 'full-reload'
      ))).toBe(false);
    } finally {
      await server.close();
    }
  });
});
