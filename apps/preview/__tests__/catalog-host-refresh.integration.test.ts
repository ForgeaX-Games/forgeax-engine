// @perf-budget-skip: real Preview configuration, Pack producer, and filesystem watcher.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, type PluginPack } from '@forgeax/engine-vite-plugin-pack';

import previewConfig from '../vite.config';

const previewRoot = dirname(fileURLToPath(new URL('../vite.config.ts', import.meta.url)));
const previewConfigSource = new URL('../vite.config.ts', import.meta.url);

async function loadPreviewConfig(): Promise<NonNullable<Parameters<typeof createServer>[0]>> {
  return await (typeof previewConfig === 'function'
    ? previewConfig({ command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false })
    : previewConfig);
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the preview host refresh event.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function observeRefresh(configured: boolean): Promise<unknown[]> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-preview-refresh-'));
  await writeFile(join(root, 'package.json'), '{"name":"preview-refresh-fixture"}');
  const assets = join(root, 'assets');
  await mkdir(assets);
  const source = join(assets, 'behavior.pack.json');
  const packSource = (speed: number) => JSON.stringify({
    schemaVersion: '3.0.0', packageId: '01900000-0000-7000-8000-000000000161',
    assets: { 'plugin/root': { kind: 'plugin', payload: {
      module: { specifier: './behavior.ts' }, config: { speed },
    } } },
  });
  await writeFile(source, packSource(1));
  await writeFile(join(assets, 'behavior.ts'), 'export default { apply() {} };');
  const config = configured ? await loadPreviewConfig() : { plugins: [pluginPack({ roots: [assets] })] };
  const server = await createServer({
    ...config, configFile: false, root: previewRoot, logLevel: 'error',
    // This integration exercises producer publication, not dependency optimization.
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...config.server, port: 0, strictPort: true },
  });
  const events: unknown[] = [];
  const ws = server.ws as unknown as { send(payload: unknown): void };
  const send = ws.send.bind(ws);
  ws.send = (payload: unknown): void => { events.push(payload); send(payload); };
  try {
    const pack = server.config.plugins.find((plugin) => plugin.name === 'forgeax:pack') as PluginPack;
    if (!pack) throw new Error('Preview must expose its Pack producer');
    await pack.rebind(createStandaloneRuntimeAssetBinding('preview-refresh-test'), [assets]);
    await pack.ready();
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('missing Preview server address');
    const binding = pack.runtimeBinding();
    if (!binding) throw new Error('missing Pack runtime binding');
    const response = await fetch(`http://localhost:${address.port}${binding.catalogUrl}`);
    expect(response.ok).toBe(true);
    expect(await response.json()).toMatchObject({ authority: 'authoritative', entries: [expect.objectContaining({ kind: 'plugin' })] });
    events.length = 0;
    await writeFile(source, packSource(2));
    // A negative reload assertion is meaningful only after the same successful
    // publication that triggers the configured policy, not after an arbitrary sleep.
    await waitFor(() => events.some((event) => typeof event === 'object' && event !== null &&
      'event' in event && event.event === 'forgeax:catalog-delta'));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'custom', event: 'forgeax:catalog-delta',
      data: expect.objectContaining({ changed: expect.arrayContaining([expect.objectContaining({ kind: 'plugin' })]) }),
    }));
    if (configured) await waitFor(() => events.some((event) =>
      typeof event === 'object' && event !== null && 'type' in event && event.type === 'full-reload'), 1_000);
    return events;
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('preview host catalog refresh', () => {
  it('uses the generated VFX catalog producer without an app-owned module map', async () => {
    const source = await readFile(previewConfigSource, 'utf8');
    expect(source).toContain('createParticleCodeNativeCookerFromRoots');
    expect(source).not.toContain('vfxModules');
  });
  it('reloads the configured host after a watched Pack publication', async () => {
    expect(await observeRefresh(true)).toContainEqual(expect.objectContaining({ type: 'full-reload' }));
  }, 120_000);
  it('publishes the same change without reloading when the host has no policy', async () => {
    expect(await observeRefresh(false)).not.toContainEqual(expect.objectContaining({ type: 'full-reload' }));
  }, 120_000);
});
