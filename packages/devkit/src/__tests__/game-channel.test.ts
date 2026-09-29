import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transformWithOxc } from 'vite';
import { expect, it, vi } from 'vitest';
import { createViteConfig } from '../host.js';
import { readProjectFacts } from '../project.js';

async function evaluate(source: string, values: Record<string, unknown>, dev: boolean) {
  const transformed = await transformWithOxc(
    source
      .replaceAll('import.meta.env.DEV', String(dev))
      .replaceAll('import.meta.url', JSON.stringify('https://game.test/main.js')),
    'generated-channel.ts',
    { lang: 'ts' },
  );
  return runInNewContext(transformed.code, values);
}

it('connects isolated frontend/source ports through the generated App options and owns cleanup', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-game-channel-'));
  const channels: MessageChannel[] = [];
  const cleanups: Array<() => void> = [];
  try {
    await mkdir(resolve(root, 'assets'));
    await writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'channel-game',
        name: 'Channel game',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    );
    await writeFile(resolve(root, 'package.json'), '{"name":"channel-game"}');
    const facts = await readProjectFacts(root);
    if (!facts.ok) throw facts.error;
    await createViteConfig(facts.value, 'build');
    const generated = await readFile(resolve(root, '.forgeax/generated/main.ts'), 'utf8');
    const bootstrap = await readFile(
      resolve(root, '.forgeax/generated/execution-bootstrap.ts'),
      'utf8',
    );
    const pluginStart = generated.indexOf('const appBootstrapPlugin =');
    const applyStart =
      generated.indexOf('async apply(ctx) {', pluginStart) + 'async apply(ctx) {'.length;
    const callEnd = generated.indexOf('if (!result.ok)', applyStart);
    expect(pluginStart).toBeGreaterThan(-1);
    expect(callEnd).toBeGreaterThan(applyStart);
    const frontendStart = generated.indexOf(
      "const uiRoot = document.querySelector('#game-ui');",
      callEnd,
    );
    const frontendEnd = generated.indexOf("ctx.provide('gameHost', host);", frontendStart);
    const sourceMarker = "ctx.provide('gameHost', ";
    const sourceStart = bootstrap.indexOf(sourceMarker);
    const sourceEnd =
      bootstrap.indexOf('} satisfies GameHost);', sourceStart) + '} satisfies GameHost'.length;
    expect(frontendStart).toBeGreaterThan(callEnd);
    expect(sourceStart).toBeGreaterThan(-1);
    const requests: string[] = [];
    for (const dev of [false, true]) {
      for (const engine of [false, true]) {
        const options = await evaluate(
          `(async () => { ${generated.slice(applyStart, callEnd)} return result; })()`,
          {
            crypto: globalThis.crypto,
            serveRuntimePackDelivery: () => () => {},
            query: new URLSearchParams(),
            bootstrapRoot: 'project-bootstrap',
            resource: undefined,
            recipeValue: null,
            profiler: undefined,
            workerExecution: true,
            executionWorkers: { engine },
            canvas: {},
            gpuPassTiming: undefined,
            cpuProfileRequested: false,
            rhiCaptureRequested: false,
            runtimeScopeBinding: { catalogUrl: 'https://game.test/catalog.json' },
            document: { baseURI: 'https://game.test/' },
            window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
            resizeObserver: { disconnect: vi.fn() },
            URL,
            forgeaxBundlerAdapter: () => ({}),
            ctx: { effect: (effect: () => () => void) => cleanups.push(effect()) },
            MessageChannel: class extends MessageChannel {
              constructor() {
                super();
                channels.push(this);
              }
            },
            createApp: (_canvas: unknown, value: unknown) => value,
          },
          dev,
        );
        expect(options.execution.bootstrapPort).toBeDefined();
        const channel = channels.at(-1);
        if (channel === undefined) throw new Error('generated host did not allocate a channel');
        expect(options.execution.bootstrapPort).toBe(channel.port2);
        expect(options.execution.workers.engine).toBe(engine);
        const sourcePort = engine
          ? structuredClone(channel.port2, { transfer: [channel.port2] })
          : channel.port2;
        const provided = new Map<string, unknown>();
        const frontend = await evaluate(
          `${generated.slice(frontendStart, frontendEnd)} host;`,
          {
            document: { querySelector: () => ({}), body: {} },
            HTMLElement: class {},
            ctx: { provide: (key: string, value: unknown) => provided.set(key, value) },
            app: {},
            assets: {},
            canvas: {},
            gameChannel: channel,
          },
          dev,
        );
        const source = await evaluate(
          `(${bootstrap.slice(sourceStart + sourceMarker.length, sourceEnd)})`,
          {
            ctx: { world: {}, executionBootstrapHost: { port: sourcePort } },
            assets: {},
            gameProjection: {},
          },
          dev,
        );
        expect(frontend.port).toBe(channel.port1);
        expect(source.port).toBe(sourcePort);
        source.port.onmessage = (event: MessageEvent) => {
          requests.push(event.data.id);
          source.port.postMessage({ id: event.data.id, phase: 'playing' });
        };
        const id = `${dev}-${engine}`;
        const response = new Promise((resolveMessage) => {
          frontend.port.onmessage = (event: MessageEvent) => resolveMessage(event.data);
        });
        frontend.port.postMessage({ id, action: 'enter' });
        await expect(response).resolves.toEqual({ id, phase: 'playing' });
        // Keep all previous channels open: a later request must reach only its own source.
        expect(requests).toHaveLength(channels.length);
        if (engine) cleanups.push(() => sourcePort.close());
      }
    }
    const closing = channels.map((channel) => vi.spyOn(channel.port1, 'close'));
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    for (const close of closing) expect(close).toHaveBeenCalledOnce();
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
    await rm(root, { recursive: true, force: true });
  }
});
