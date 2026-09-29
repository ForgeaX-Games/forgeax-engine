import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  createApp,
  createEngineWorkspaceRuntime,
  ENGINE_WORKSPACE_COMMAND_TOPIC,
  type EngineWorkspaceRuntimePackRequest,
  type EngineWorkspaceTarget,
  engineWorkspaceBrowserPlugin,
  engineWorkspaceResultService,
} from '@forgeax/engine-app';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBackendHost } from '@forgeax/engine-host/backend';
import type { HostTransportClient } from '@forgeax/engine-host/transport';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import { definePackageId } from '@forgeax/engine-pack/source';
import { startPluginAsset } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';
import type { ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createViteConfig: vi.fn(async () => ({})),
}));

vi.mock('../host.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../host.js')>()),
  createViteConfig: mocks.createViteConfig,
}));

import { validateHostBinding } from '../host-binding.js';
import { createDevKitWorkspaceProvider, waitForRuntimeCatalog } from '../workspace-provider.js';

const roots: string[] = [];

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-workspace-provider-'));
  roots.push(root);
  await Promise.all([
    writeFile(
      resolve(root, 'forge.json'),
      JSON.stringify({
        id: 'workspace-game',
        name: 'Workspace Game',
        schemaVersion: '3.0.0',
        roots: {},
      }),
    ),
    writeFile(
      resolve(root, 'package.json'),
      JSON.stringify({ name: 'workspace-game', forgeax: {} }),
    ),
  ]);
  return root;
}

afterEach(async () => {
  mocks.createViteConfig.mockClear();
  vi.unstubAllGlobals();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

function fakeServer() {
  return {
    resolvedUrls: { local: ['http://127.0.0.1:43123/'] },
    httpServer: undefined,
    listen: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as ViteDevServer;
}

async function ready(client: HostTransportClient, target: EngineWorkspaceTarget, root: string) {
  client.subscribe(ENGINE_WORKSPACE_COMMAND_TOPIC, (value) => {
    const command = value as WorkspaceCommandFixture;
    if (
      command.kind !== 'command' ||
      command.operation !== 'closeWorkspace' ||
      command.sessionId !== target.sessionId
    )
      return;
    void client.request(engineWorkspaceResultService(target.targetId), {
      kind: 'result',
      id: command.id,
      sessionId: target.sessionId,
      targetId: target.targetId,
      ok: true,
      value: { cleanup: 'completed' },
    });
  });
  await client.request(engineWorkspaceResultService(target.targetId), {
    kind: 'ready',
    id: target.sessionId,
    sessionId: target.sessionId,
    targetId: target.targetId,
    project: { id: 'workspace-game', root: await realpath(root), name: 'Workspace Game' },
    target,
  });
}

function frontendPage(
  backend: Awaited<ReturnType<typeof createBackendHost>>,
  target: EngineWorkspaceTarget,
): HostTransportClient {
  return backend.transport.connect({
    kind: 'frontend',
    sourceId: `forgeax-workspace:${target.sessionId}:${target.targetId}`,
  });
}

type WorkspaceCommandFixture = {
  readonly kind: 'command' | 'cancel';
  readonly id: string;
  readonly sessionId: string;
  readonly operation?: string;
  readonly input?: {
    readonly asset?: unknown;
    readonly previewOwner?: string;
    readonly targetId?: string;
    readonly previewTargetId?: string;
    readonly worldId?: string;
    readonly request?: EngineWorkspaceRuntimePackRequest;
    readonly connectionId?: string;
  };
};

describe('DevKit workspace provider', () => {
  it.each([
    false,
    true,
  ])('retires an unacknowledged close after losing its original connection (reconnect: %s)', async (reconnect) => {
    const root = await projectRoot();
    const backend = await createBackendHost({});
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      readyTimeoutMs: 50,
      viteServerFactory: async () => fakeServer(),
    });
    const runtime = createEngineWorkspaceRuntime(provider);
    let page: HostTransportClient | undefined;
    let replacement: HostTransportClient | undefined;
    try {
      const opened = await runtime.openProject({ root });
      assert(opened.target);
      const target = { ...opened.target, worldId: 'unacknowledged-world' };
      page = frontendPage(backend, target);
      let acknowledge!: () => void;
      const sent = new Promise<void>((resolve) => {
        acknowledge = resolve;
      });
      page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
        if (command.kind === 'command' && command.operation === 'closeWorkspace') acknowledge();
      });
      await page.request(engineWorkspaceResultService(target.targetId), {
        kind: 'ready',
        id: target.sessionId,
        sessionId: target.sessionId,
        targetId: target.targetId,
        project: opened.project,
        target,
      });
      const closing = expect(runtime.closeProject(opened)).rejects.toMatchObject({
        code: 'engine-workspace-result-timeout',
      });
      await sent;
      if (reconnect) replacement = frontendPage(backend, target);
      await closing;
      page.close();
      const reopened = await runtime.openProject({
        root,
        expectedTargetId: target.targetId,
        expectedTargetState: 'lost',
      });
      expect(reopened.target?.sessionId).not.toBe(target.sessionId);
      expect(opened.failure).toMatchObject({
        code: 'engine-workspace-page-lost',
        detail: { cleanup: 'unconfirmed' },
      });
    } finally {
      replacement?.close();
      page?.close();
      await runtime.dispose().catch(() => {});
      await backend.dispose();
    }
  });
  it('retains an incomplete close as the authority for later reopen and dispose attempts', async () => {
    const root = await projectRoot();
    const backend = await createBackendHost({});
    const servers = vi.fn(async () => fakeServer());
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: servers,
    });
    let page: HostTransportClient | undefined;
    try {
      const opened = await provider.openProject({ root });
      assert(opened.target);
      const target = { ...opened.target, worldId: 'cleanup-world' };
      page = frontendPage(backend, target);
      const client = page;
      client.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
        if (command.kind !== 'command' || command.operation !== 'closeWorkspace') return;
        void client.request(engineWorkspaceResultService(target.targetId), {
          kind: 'result',
          id: command.id,
          sessionId: target.sessionId,
          targetId: target.targetId,
          ok: false,
          error: {
            code: 'engine-workspace-plugin-cleanup-timeout',
            expected: 'Native cleanup to complete',
            hint: 'Cleanup is not complete',
            detail: { cleanup: 'timeout' },
          },
        });
      });
      await client.request(engineWorkspaceResultService(target.targetId), {
        kind: 'ready',
        id: target.sessionId,
        sessionId: target.sessionId,
        targetId: target.targetId,
        project: opened.project,
        target,
      });
      await expect(provider.closeProject(opened)).rejects.toMatchObject({
        code: 'engine-workspace-plugin-cleanup-timeout',
      });
      client.close();
      await expect(provider.openProject({ root })).rejects.toMatchObject({
        code: 'engine-workspace-plugin-cleanup-timeout',
      });
      expect(servers).toHaveBeenCalledOnce();
      await expect(provider.dispose?.()).rejects.toMatchObject({
        code: 'engine-workspace-plugin-cleanup-timeout',
      });
    } finally {
      page?.close();
      await Promise.resolve(provider.dispose?.()).catch(() => {});
      await backend.dispose();
    }
  });
  it.each([
    'healthy',
    'failed',
    'lost',
  ] as const)('closes pre-preview Workspace installations in a %s borrowed page while retaining the game App across project reopen', async (health) => {
    const root = await projectRoot();
    const backend = await createBackendHost({});
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: async () => fakeServer(),
    });
    const world = new World();
    const runtime = createEngineWorkspaceRuntime(provider);
    world.insertResource('project-plugin-fibers', new Set<number>());
    const app = (
      await createApp({
        world,
        assets: new AssetRegistry({} as never),
        assetCatalog: createCatalogSource({ entries: [] }),
        renderer: {
          ready: Promise.resolve({ ok: true, value: undefined }),
          draw: () => ({ ok: true, value: undefined }),
          onError: () => () => {},
          onLost: () => () => {},
          dispose() {},
        } as unknown as Renderer,
        pluginPrograms: {
          sessionId: 'test',
          contextId: 'engine',
          sessionGeneration: 1,
          target: 'engine',
          tools: new Map(),
          programs: new Map(),
          definitions: new Map(),
        },
        runtimePacks: { scopeId: 'workspace-close-test' },
      })
    ).unwrap();
    let page: HostTransportClient | undefined;
    try {
      const opened = await runtime.openProject({ root });
      assert(opened.target && provider.runtimePack);
      page = frontendPage(backend, opened.target);
      const target = { ...opened.target, worldId: world.identity };
      const browser = await app.pluginContext.plugin(engineWorkspaceBrowserPlugin, {
        app,
        project: opened.project,
        target,
        transport: page,
        canvas: {
          ownerDocument: { documentElement: { dataset: {}, removeAttribute() {} } },
        } as unknown as HTMLCanvasElement,
      });
      await browser.await();
      const packageId = '01900000-0000-7000-8000-000000000361';
      const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'behavior'));
      const input = {
        ...opened,
        targetId: target.targetId,
        worldId: target.worldId,
        connectionId: 'view-connection',
      };
      await provider.runtimePack({
        ...input,
        request: {
          operation: 'admit',
          content: {
            source: {
              schemaVersion: '3.0.0',
              packageId,
              assets: {
                behavior: { kind: 'plugin', payload: { module: { specifier: './behavior.js' } } },
              },
            },
            programs: {
              'project:workspace-close.js#default': {
                artifact: preparePackProgram({
                  entry: 'behavior.js',
                  export: 'default',
                  modules: {
                    'behavior.js': `export default { inject: ['world'], apply(ctx) {
            const entries = ctx.world.getResource('project-plugin-fibers'); const id = ctx.fiber.uid;
            ctx.effect(() => { entries.add(id); return () => entries.delete(id); });
          } };`,
                  },
                }).unwrap(),
              },
            },
          },
        },
      });
      const game = (await startPluginAsset(app.pluginContext, guid)).unwrap();
      expect(
        await provider.runtimePack({ ...input, request: { operation: 'plugin-install', guid } }),
      ).toMatchObject({ state: 'active' });
      const entries = world.getResource<Set<number>>('project-plugin-fibers');
      expect(entries?.size).toBe(2);
      if (health === 'failed')
        await page.request(engineWorkspaceResultService(target.targetId), {
          kind: 'failed',
          id: 'world-failed',
          sessionId: target.sessionId,
          targetId: target.targetId,
          error: {
            code: 'app-system-update-failed',
            expected: 'A healthy World',
            hint: 'Repair the failed system',
          },
        });
      if (health === 'lost') {
        page.close();
        await vi.waitFor(() => expect(entries?.size).toBe(1));
      } else await runtime.closeProject(opened);
      expect(entries?.size).toBe(1);
      assert(game.uid !== null);
      expect(entries?.has(game.uid)).toBe(true);
      expect(page.connected).toBe(health !== 'lost');
      expect(app.pluginContext.runtimePacks?.producer.inspect().packs).toHaveLength(1);
      const reopened = await runtime.openProject({
        root,
        ...(health === 'lost'
          ? {
              expectedTargetId: target.targetId,
              expectedTargetState: 'lost' as const,
            }
          : {}),
      });
      if (health === 'lost')
        expect(opened.failure).toMatchObject({
          code: 'engine-workspace-page-lost',
          detail: { cleanup: 'unconfirmed', reason: 'transport-lost' },
        });
      await expect(
        provider.runtimePack({ ...input, request: { operation: 'plugin-install', guid } }),
      ).rejects.toMatchObject({ code: 'engine-workspace-session-closed' });
      expect(reopened.target?.sessionId).not.toBe(target.sessionId);
      assert(game.uid !== null);
      expect(entries?.has(game.uid)).toBe(true);
      await runtime.closeProject(reopened);
      await game.dispose();
      await browser.dispose();
    } finally {
      page?.close();
      await runtime.dispose();
      await app.dispose();
      await backend.dispose();
    }
  });
  it('prepares TS on the producer and sends only portable runtime content to the ready actual World', async () => {
    const root = await projectRoot();
    const backend = await createBackendHost({});
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: async () => fakeServer(),
    });
    let page: HostTransportClient | undefined;
    try {
      const project = await provider.openProject({ root });
      assert(project.target && provider.runtimePack && provider.prepareRuntimePackProgram);
      page = frontendPage(backend, project.target);
      const target = { ...project.target, worldId: 'actual-content-world' };
      const prepared = await provider.prepareRuntimePackProgram({
        ...project,
        source: {
          entry: 'generator.ts',
          export: 'build',
          modules: {
            'generator.ts': 'export function build(value: number): number { return value * 2; }',
          },
        },
      });
      expect(prepared).toMatchObject({
        source: { entry: 'generator.ts' },
        artifact: {
          entry: 'generator.js',
          modules: { 'generator.js': expect.not.stringContaining(': number') },
        },
      });
      const commands: WorkspaceCommandFixture[] = [];
      const contentPage = page;
      const cancel = new Promise<void>((resolve) => {
        contentPage.subscribe(ENGINE_WORKSPACE_COMMAND_TOPIC, (value) => {
          const command = value as WorkspaceCommandFixture;
          if (command.operation === 'closeWorkspace') return;
          commands.push(command);
          if (command.kind === 'cancel') {
            resolve();
            return;
          }
          if (command.input?.request?.operation === 'generate') return;
          void contentPage.request(engineWorkspaceResultService(target.targetId), {
            kind: 'result',
            id: command.id,
            sessionId: target.sessionId,
            targetId: target.targetId,
            ok: true,
            value: { imports: {}, packs: [], executions: [] },
          });
        });
      });
      const input = {
        ...project,
        targetId: target.targetId,
        worldId: target.worldId,
        connectionId: 'view-connection',
      };
      const inspection = provider.runtimePack({ ...input, request: { operation: 'inspect' } });
      expect(commands).toHaveLength(0);
      await ready(page, target, root);
      await expect(inspection).resolves.toEqual({ imports: {}, packs: [], executions: [] });
      expect(project.target.worldId).toBe(target.worldId);
      expect(commands[0]?.input).toEqual({
        targetId: target.targetId,
        worldId: target.worldId,
        connectionId: 'view-connection',
        request: { operation: 'inspect' },
      });
      await expect(
        provider.runtimePack({
          ...input,
          worldId: 'pending:old-world',
          request: { operation: 'inspect' },
        }),
      ).rejects.toMatchObject({ code: 'engine-workspace-target-stale' });
      expect(commands).toHaveLength(1);
      const controller = new AbortController();
      const generating = provider.runtimePack({
        ...input,
        signal: controller.signal,
        request: {
          operation: 'generate',
          instance: {
            schemaVersion: '3.0.0',
            packageId: '01900000-0000-7000-8000-000000000351',
            parent: '01900000-0000-7000-8000-000000000350',
            values: {},
          },
        },
      });
      await vi.waitFor(() => expect(commands).toHaveLength(2));
      controller.abort();
      await expect(generating).rejects.toBeDefined();
      await cancel;
      expect(commands.at(-1)).toMatchObject({ kind: 'cancel', id: commands[1]?.id });
    } finally {
      page?.close();
      await provider.dispose?.();
      await backend.dispose();
    }
  });
  it.each([
    undefined,
    0,
    41234,
  ])('materializes the requested port %s before Vite starts', async (port) => {
    const root = await projectRoot();
    const provider = createDevKitWorkspaceProvider({
      ...(port === undefined ? {} : { port }),
      viteServerFactory: async () => fakeServer(),
    });
    try {
      await provider.openProject({ root });
      const call = mocks.createViteConfig.mock.calls[0] as unknown as [
        unknown,
        unknown,
        unknown,
        { server: { port: number; strictPort: boolean } },
      ];
      const options = call[3];
      expect(options.server.port).toBeGreaterThan(0);
      expect(options.server.strictPort).toBe(true);
      if (port) expect(options.server.port).toBe(port);
    } finally {
      await provider.dispose?.();
    }
  });

  it('keeps editor and current-project Play sessions on one backend through repeated stop and restart', async () => {
    const root = await projectRoot();
    const backend = await createBackendHost({});
    const servers: ViteDevServer[] = [];
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 500,
      hostBinding: { backend },
      viteServerFactory: async () => {
        const server = fakeServer();
        servers.push(server);
        return server;
      },
    });
    try {
      const project = await provider.openProject({ root });
      assert(project.target && provider.startPlay);
      const editor = frontendPage(backend, project.target);
      await ready(editor, { ...project.target, worldId: 'editor-world' }, root);
      const oldAssembly = backend.assembly.current.revision;
      for (let cycle = 0; cycle < 10; cycle++) {
        const game = await provider.startPlay(project);
        assert(game.tools && game.close && game.target.url);
        expect(game.target.targetId).not.toBe(project.target.targetId);
        expect(new URL(game.target.url).searchParams.get('forgeaxWorkspace')).toBe('game');
        const call = mocks.createViteConfig.mock.calls.at(-1) as unknown as [
          { root: string },
          string,
          string,
          {
            host: {
              backend: unknown;
              frontendAssembly?: unknown;
              workspace: { execution: string };
            };
          },
        ];
        expect(call[0].root).toBe(await realpath(root));
        expect(call[3].host.backend).toBe(backend);
        expect(call[3].host.frontendAssembly).toBeUndefined();
        expect(call[3].host.workspace.execution).toBe('game');
        const page = frontendPage(backend, game.target);
        const unsubscribe = page.subscribe(ENGINE_WORKSPACE_COMMAND_TOPIC, (payload) => {
          const command = payload as WorkspaceCommandFixture;
          if (command.operation === 'closeWorkspace') return;
          if (command.sessionId !== game.target.sessionId || command.kind !== 'command') return;
          void page.request(engineWorkspaceResultService(game.target.targetId), {
            kind: 'result',
            id: command.id,
            sessionId: game.target.sessionId,
            targetId: game.target.targetId,
            ok: true,
            value:
              command.operation === 'resize'
                ? {
                    target: {
                      ...game.target,
                      width: (command.input as { width: number }).width,
                      height: (command.input as { height: number }).height,
                    },
                  }
                : { marker: 'actual-game' },
          });
        });
        await ready(page, { ...game.target, worldId: `game-${cycle}` }, call[0].root);
        await game.ready();
        expect(game.target.worldId).toBe(`game-${cycle}`);
        expect(await game.tools.inspect({ entityId: 'entity' })).toEqual({
          marker: 'actual-game',
        });
        expect(game.resize).toBeDefined();
        const resized = await game.resize?.({
          targetId: game.target.targetId,
          width: 777,
          height: 444,
        });
        expect(resized).toMatchObject({ width: 777, height: 444 });
        expect(game.target).toMatchObject({ width: 777, height: 444 });
        await game.close();
        await game.close();
        expect(servers.at(-1)?.close).toHaveBeenCalledOnce();
        expect(servers[0]?.close).not.toHaveBeenCalled();
        expect(backend.assembly.current.revision).toBe(oldAssembly);
        unsubscribe();
        page.close();
      }
      await provider.closeProject(project);
      expect(servers[0]?.close).toHaveBeenCalledOnce();
      editor.close();
    } finally {
      await provider.dispose?.();
      await backend.dispose();
    }
  });
  it('stops catalog polling on a terminal producer failure and preserves its source', async () => {
    let requests = 0;
    const diagnostic = JSON.stringify({
      error: 'scan-failed',
      cause: { detail: { sourcePath: 'assets/character.pack.ts', timeoutMs: 120_000 } },
    });
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(diagnostic);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address !== null && typeof address !== 'string');
    try {
      await expect(
        waitForRuntimeCatalog(`http://127.0.0.1:${address.port}`, 'game', 120_000),
      ).rejects.toMatchObject({
        code: 'engine-workspace-catalog-not-ready',
        detail: { lastStatus: 500, lastResponseBody: diagnostic },
      });
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 5000);

  it('retains the bounded producer body when catalog readiness expires', async () => {
    const diagnostic = JSON.stringify({
      code: 'pack-producer-failed',
      stage: 'cook',
      detail: 'bad source',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(diagnostic, {
            status: 503,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await expect(
      waitForRuntimeCatalog('http://127.0.0.1:43123/', 'workspace-game', 25),
    ).rejects.toMatchObject({
      code: 'engine-workspace-catalog-not-ready',
      detail: expect.objectContaining({
        lastStatus: 503,
        lastResponseBody: diagnostic,
      }),
    });
  });

  it('cancels the real Pack catalog readiness probe with the caller signal', async () => {
    const root = await projectRoot();
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort(new Error('catalog probe cancelled'));
      return { status: 503, ok: false, body: null };
    });
    vi.stubGlobal('fetch', fetchMock);
    let server: ReturnType<typeof fakeServer> | undefined;
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 1_000,
      backendFactory: async () => createBackendHost(),
      viteServerFactory: async () => {
        server = { ...fakeServer(), httpServer: {} } as ReturnType<typeof fakeServer>;
        return server;
      },
    });
    const pending = provider.openProject({ root, signal: controller.signal });
    await expect(pending).rejects.toThrow('catalog probe cancelled');
    expect(fetchMock).toHaveBeenCalled();
    expect(server?.close).toHaveBeenCalledOnce();
  });

  it('returns a provisional loopback target and uses the display host page as the only browser realm', async () => {
    const root = await projectRoot();
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    let server: ReturnType<typeof fakeServer> | undefined;
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 500,
      backendFactory: async () => {
        backend = await createBackendHost();
        return backend;
      },
      viteServerFactory: async () => {
        server = fakeServer();
        return server;
      },
    });

    const opened = await provider.openProject({ root });
    const canonicalRoot = await realpath(root);
    expect(opened.project).toEqual({
      id: 'workspace-game',
      root: canonicalRoot,
      name: 'Workspace Game',
    });
    const target = opened.target;
    if (target === undefined) throw new Error('provider fixture did not return a target');
    expect(target.url).toMatch(/^http:\/\/127\.0\.0\.1:43123\/\?forgeaxWorkspace=1/);
    expect(target.worldId).toMatch(/^pending:workspace-/);
    expect(server?.listen).toHaveBeenCalledOnce();
    expect(mocks.createViteConfig).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'workspace-game', root: canonicalRoot }),
      'serve',
      '/',
      expect.objectContaining({ host: expect.objectContaining({ backend }) }),
    );

    if (backend === undefined) throw new Error('provider fixture did not open');
    const page = frontendPage(backend, target);
    const commands: unknown[] = [];
    page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
      if (command.operation === 'closeWorkspace') return;
      commands.push(command);
      if (typeof command !== 'object' || command === null || command.kind !== 'command') return;
      const value =
        command.operation === 'listAssets'
          ? [{ guid: 'scene-guid', kind: 'scene', name: 'Scene', previewable: true }]
          : command.operation === 'openPreview'
            ? {
                target: { ...target, worldId: 'world-1', width: 800, height: 600 },
                asset: command.input?.asset,
                previewOwner: command.id,
              }
            : command.operation === 'capture'
              ? {
                  targetId: target.targetId,
                  frameId: 17,
                  width: 800,
                  height: 600,
                  png: 'data:image/png;base64,fixture',
                }
              : command.operation === 'camera.get'
                ? { camera: { position: [0, 1, 2] }, version: 0 }
                : command.operation === 'target.pick'
                  ? { entityId: 'entity', frameId: 17 }
                  : { closed: true, targetId: target.targetId };
      void page.request(engineWorkspaceResultService(target.targetId), {
        kind: 'result',
        id: command.id,
        sessionId: command.sessionId,
        targetId: target.targetId,
        ok: true,
        value,
      });
    });
    const firstAssets = provider.listAssets({ project: opened.project, handle: opened.handle });
    const secondAssets = provider.listAssets({ project: opened.project, handle: opened.handle });
    await ready(page, { ...target, worldId: 'world-1' }, root);

    const [assets, concurrentAssets] = await Promise.all([firstAssets, secondAssets]);
    expect(assets).toEqual([
      { guid: 'scene-guid', kind: 'scene', name: 'Scene', previewable: true },
    ]);
    expect(concurrentAssets).toEqual(assets);
    const preview = await provider.openPreview({
      project: opened.project,
      projectHandle: opened.handle,
      asset:
        assets[0] ??
        (() => {
          throw new Error('fixture did not return an asset');
        })(),
      width: 800,
      height: 600,
    });
    expect(preview.target).toMatchObject({
      targetId: target.targetId,
      worldId: 'world-1',
      width: 800,
      height: 600,
    });
    const pickEvents: unknown[] = [];
    const unsubscribePick = page.subscribe('engine.workspace.picked', (event) =>
      pickEvents.push(event),
    );
    const previewOwner = (commands as WorkspaceCommandFixture[]).find(
      (command) => command.operation === 'openPreview',
    )?.id;
    for (const kind of ['picked', 'pick-error']) {
      await page.request(engineWorkspaceResultService(target.targetId), {
        kind,
        sessionId: target.sessionId,
        targetId: target.targetId,
        previewOwner,
        result: { entityId: 'entity' },
        error: { code: 'engine-workspace-frame-unavailable' },
      });
    }
    expect(pickEvents).toEqual([]);
    unsubscribePick();
    expect(await preview.tools?.pick?.({ x: 12, y: 34 })).toEqual({
      entityId: 'entity',
      frameId: 17,
    });
    expect((commands.at(-1) as WorkspaceCommandFixture).operation).toBe('target.pick');
    expect(await preview.getCamera({ targetId: preview.target.targetId })).toEqual({
      camera: { position: [0, 1, 2] },
      version: 0,
    });
    if (preview.capture === undefined) throw new Error('provider fixture did not return capture');
    expect(await preview.capture({ targetId: preview.target.targetId })).toEqual({
      targetId: target.targetId,
      frameId: 17,
      width: 800,
      height: 600,
      png: 'data:image/png;base64,fixture',
    });
    await provider.closeProject({ project: opened.project, handle: opened.handle });
    const commandsAfterClose = commands.length;
    await expect(
      preview.revokeConnection?.({
        targetId: preview.target.targetId,
        connectionId: 'disconnected-browser',
      }),
    ).resolves.toBeUndefined();
    expect(commands).toHaveLength(commandsAfterClose);
    expect(
      commands.some((command) => (command as WorkspaceCommandFixture).operation === 'openPreview'),
    ).toBe(true);
    expect(server?.close).toHaveBeenCalledOnce();
    expect(page.connected).toBe(false);
  });

  it.each([
    { failChild: false, failClose: false, scene: false },
    { failChild: true, failClose: false, scene: false },
    { failChild: false, failClose: true, scene: false },
    { failChild: false, failClose: false, scene: true },
  ])('keeps previews independent and reports close completion: %j', async ({
    failChild,
    failClose,
    scene,
  }) => {
    const root = await projectRoot();
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 500,
      backendFactory: async () => {
        backend = await createBackendHost();
        return backend;
      },
      viteServerFactory: async () => fakeServer(),
    });
    const opened = await provider.openProject({ root });
    const openedTarget = opened.target;
    if (backend === undefined || openedTarget === undefined)
      throw new Error('provider fixture did not open');
    const page = frontendPage(backend, openedTarget);
    const commands: WorkspaceCommandFixture[] = [];
    page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
      if (command.operation === 'closeWorkspace') return;
      commands.push(command);
      if (command.kind !== 'command') return;
      if (command.operation === 'resize' || command.operation === 'listAssets') return;
      if (failClose && command.operation === 'closePreview') {
        void page.request(engineWorkspaceResultService(openedTarget.targetId), {
          kind: 'result',
          id: command.id,
          sessionId: command.sessionId,
          targetId: openedTarget.targetId,
          ok: false,
          error: {
            code: 'engine-workspace-session-closed',
            expected: 'The preview owner to acknowledge cleanup',
            hint: 'The owner was lost before cleanup completed.',
          },
        });
        return;
      }
      const value =
        command.operation === 'openPreview'
          ? {
              target: {
                ...openedTarget,
                targetId: command.input?.previewTargetId,
                worldId: 'world-1',
                width: 320,
                height: 240,
              },
              asset: command.input?.asset,
              previewOwner: command.id,
            }
          : command.operation === 'camera.get'
            ? { camera: { position: [0, 1, 2] }, version: 0 }
            : command.operation === 'capture'
              ? {
                  targetId: openedTarget.targetId,
                  frameId: 3,
                  width: 320,
                  height: 240,
                  png: 'data:image/png;base64,replacement',
                }
              : { closed: true, targetId: openedTarget.targetId };
      void page.request(engineWorkspaceResultService(openedTarget.targetId), {
        kind: 'result',
        id: command.id,
        sessionId: command.sessionId,
        targetId:
          command.operation === 'closePreview' ? command.input?.targetId : openedTarget.targetId,
        ok: true,
        value,
      });
    });
    await ready(page, { ...openedTarget, worldId: 'world-1' }, root);

    const first = await provider.openPreview({
      project: opened.project,
      projectHandle: opened.handle,
      asset: { guid: 'mesh-a', kind: scene ? 'scene' : 'mesh' },
      width: 320,
      height: 240,
    });
    const replacement = await provider.openPreview({
      project: opened.project,
      projectHandle: opened.handle,
      asset: { guid: 'mesh-b', kind: 'mesh' },
      width: 320,
      height: 240,
    });

    expect(first.target.targetId === openedTarget.targetId).toBe(scene);
    expect(replacement.target.targetId).not.toBe(openedTarget.targetId);
    expect(replacement.target.targetId).not.toBe(first.target.targetId);
    expect(await replacement.getCamera({ targetId: replacement.target.targetId })).toMatchObject({
      version: 0,
    });
    expect(commands.at(-1)?.input?.targetId).toBe(replacement.target.targetId);
    if (failChild) {
      await page.request(engineWorkspaceResultService(openedTarget.targetId), {
        kind: 'failed',
        id: 'child-failure',
        sessionId: openedTarget.sessionId,
        targetId: replacement.target.targetId,
        error: {
          code: 'app-system-update-failed',
          expected: 'A healthy target',
          hint: 'Close this preview.',
        },
      });
      await expect(
        Promise.resolve().then(() =>
          replacement.getCamera({ targetId: replacement.target.targetId }),
        ),
      ).rejects.toMatchObject({ code: 'app-system-update-failed' });
    }
    expect(await first.getCamera({ targetId: first.target.targetId })).toMatchObject({
      version: 0,
    });
    const projectAssets = Promise.resolve(
      provider.listAssets({ project: opened.project, handle: opened.handle }),
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.waitFor(() =>
      expect(commands.some((command) => command.operation === 'listAssets')).toBe(true),
    );
    const resizing = first
      .resize?.({ targetId: first.target.targetId, width: 640, height: 360 })
      .then(
        () => undefined,
        (error) => error,
      );
    await vi.waitFor(() =>
      expect(commands.some((command) => command.operation === 'resize')).toBe(true),
    );
    const queuedResize = first
      .resize?.({ targetId: first.target.targetId, width: 800, height: 450 })
      .then(
        () => undefined,
        (error) => error,
      );
    for (let attempt = 0; attempt < 2; attempt++) {
      if (failClose)
        await expect(first.close?.()).rejects.toMatchObject({
          code: 'engine-workspace-session-closed',
        });
      else await first.close?.();
    }
    expect(await resizing).toMatchObject({ code: 'engine-workspace-preview-closed' });
    expect(await queuedResize).toMatchObject({ code: 'engine-workspace-preview-closed' });
    const assetRequest = commands.find((command) => command.operation === 'listAssets');
    if (!assetRequest) throw new Error('missing held project request');
    await page.request(engineWorkspaceResultService(openedTarget.targetId), {
      kind: 'result',
      id: assetRequest.id,
      sessionId: openedTarget.sessionId,
      targetId: openedTarget.targetId,
      ok: true,
      value: [],
    });
    expect(await projectAssets).toEqual({ value: [] });
    expect(
      commands.some((command) => command.kind === 'cancel' && command.id === assetRequest.id),
    ).toBe(false);
    expect(commands.filter((command) => command.operation === 'resize')).toHaveLength(1);
    const resize = commands.find((command) => command.operation === 'resize');
    expect(commands.some((command) => command.kind === 'cancel' && command.id === resize?.id)).toBe(
      true,
    );
    const beforeStale = commands.length;
    await expect(
      Promise.resolve().then(() => first.getCamera({ targetId: first.target.targetId })),
    ).rejects.toMatchObject({ code: 'engine-workspace-preview-closed' });
    expect(commands.length).toBe(beforeStale);
    if (!failChild)
      expect(await replacement.getCamera({ targetId: replacement.target.targetId })).toMatchObject({
        version: 0,
      });
    await provider.closeProject({ project: opened.project, handle: opened.handle });
    const closes = commands.filter((command) => command.operation === 'closePreview');
    expect(closes).toHaveLength(2);
    expect(closes.map((command) => command.input?.targetId)).toEqual([
      first.target.targetId,
      replacement.target.targetId,
    ]);
    expect(page.connected).toBe(false);
  });

  it('cancels readiness without publishing a command and cleans the Host/server session', async () => {
    const root = await projectRoot();
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    let server: ReturnType<typeof fakeServer> | undefined;
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 500,
      backendFactory: async () => {
        backend = await createBackendHost();
        return backend;
      },
      viteServerFactory: async () => {
        server = fakeServer();
        return server;
      },
    });
    const opened = await provider.openProject({ root });
    if (backend === undefined) throw new Error('provider fixture did not open');
    const target = opened.target;
    if (target === undefined) throw new Error('provider fixture did not return a target');
    const page = frontendPage(backend, target);
    const commands: unknown[] = [];
    page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) =>
      commands.push(command),
    );
    const controller = new AbortController();
    const pending = provider.listAssets({
      project: opened.project,
      handle: opened.handle,
      signal: controller.signal,
    });
    controller.abort(new Error('test cancellation'));
    await expect(pending).rejects.toThrow('test cancellation');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ kind: 'cancel', sessionId: opened.target?.sessionId });
    await provider.closeProject({ project: opened.project, handle: opened.handle });
    expect(server?.close).toHaveBeenCalledOnce();
    expect(page.connected).toBe(false);
  });

  it.each([
    'message',
    'disconnect',
    'failure',
  ])('treats browser page loss through %s as terminal without replay', async (loss) => {
    const root = await projectRoot();
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    let server: ReturnType<typeof fakeServer> | undefined;
    const changed = vi.fn();
    const provider = createDevKitWorkspaceProvider({
      onTargetChanged: changed,
      readyTimeoutMs: 500,
      backendFactory: async () => {
        backend = await createBackendHost();
        return backend;
      },
      viteServerFactory: async () => {
        server = fakeServer();
        return server;
      },
    });
    const opened = await provider.openProject({ root });
    if (backend === undefined || opened.target === undefined)
      throw new Error('provider fixture did not open');
    const page = frontendPage(backend, opened.target);
    const commands: unknown[] = [];
    page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) =>
      commands.push(command),
    );
    await ready(page, { ...opened.target, worldId: 'world-1' }, root);
    expect(changed).toHaveBeenCalledOnce();
    expect(opened.failure).toBeUndefined();
    if (loss === 'disconnect') page.close();
    else
      await page.request(engineWorkspaceResultService(opened.target.targetId), {
        kind: loss === 'failure' ? 'failed' : 'lost',
        error: {
          code: 'app-system-update-failed',
          expected: 'A healthy World',
          hint: 'Stop the failed run.',
        },
        id: `page-lost:${opened.target.sessionId}`,
        sessionId: opened.target.sessionId,
        targetId: opened.target.targetId,
      });
    const failure = {
      code: loss === 'failure' ? 'app-system-update-failed' : 'engine-workspace-page-lost',
    };
    await vi.waitFor(() => expect(opened.failure).toMatchObject(failure));
    expect(commands).toHaveLength(0);
    await expect(
      provider.listAssets({ project: opened.project, handle: opened.handle }),
    ).rejects.toMatchObject(failure);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(commands).toHaveLength(0);
    const observer = backend.transport.connect();
    expect(observer.connected).toBe(true);
    observer.close();
    await provider.closeProject({ project: opened.project, handle: opened.handle });
    expect(server?.close).toHaveBeenCalledOnce();
    expect(page.connected).toBe(false);
  });

  it('rejects workspace results from an old or unassociated caller', async () => {
    const root = await projectRoot();
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    const provider = createDevKitWorkspaceProvider({
      backendFactory: async () => {
        backend = await createBackendHost();
        return backend;
      },
      viteServerFactory: async () => fakeServer(),
    });
    const opened = await provider.openProject({ root });
    if (backend === undefined || opened.target === undefined)
      throw new Error('provider fixture did not open');
    const oldPage = backend.transport.connect({
      kind: 'frontend',
      sourceId: `forgeax-workspace:old:${opened.target.targetId}`,
    });
    await expect(
      oldPage.request(engineWorkspaceResultService(opened.target.targetId), {
        kind: 'ready',
        id: opened.target.sessionId,
        sessionId: opened.target.sessionId,
        targetId: opened.target.targetId,
        project: opened.project,
        target: opened.target,
      }),
    ).rejects.toMatchObject({ code: 'engine-workspace-caller-mismatch' });
    oldPage.close();
    await provider.dispose?.();
  });

  it('closes a server acquired after the borrowed host has shut down', async () => {
    const root = await projectRoot();
    const backend = await createBackendHost();
    let releaseServer: ((server: ViteDevServer) => void) | undefined;
    let serverStarted: (() => void) | undefined;
    const serverStart = new Promise<void>((resolve) => {
      serverStarted = resolve;
    });
    const serverReady = new Promise<ViteDevServer>((resolve) => {
      releaseServer = resolve;
    });
    const provider = createDevKitWorkspaceProvider({
      hostBinding: { backend },
      viteServerFactory: async () => {
        serverStarted?.();
        return serverReady;
      },
    });
    const opening = provider.openProject({ root });
    await serverStart;
    await backend.dispose();
    const lateServer = fakeServer();
    releaseServer?.(lateServer);
    await expect(opening).rejects.toMatchObject({ code: 'engine-workspace-session-closed' });
    expect(lateServer.close).toHaveBeenCalledOnce();
    await provider.dispose?.();
  });

  it('waits for an opening session before completing provider disposal', async () => {
    const root = await projectRoot();
    let releaseBackend:
      | ((backend: Awaited<ReturnType<typeof createBackendHost>>) => void)
      | undefined;
    let backendStarted: (() => void) | undefined;
    const backendStart = new Promise<void>((resolve) => {
      backendStarted = resolve;
    });
    const backendReady = new Promise<Awaited<ReturnType<typeof createBackendHost>>>((resolve) => {
      releaseBackend = resolve;
    });
    let backend: Awaited<ReturnType<typeof createBackendHost>> | undefined;
    const provider = createDevKitWorkspaceProvider({
      backendFactory: async () => {
        backendStarted?.();
        backend = await backendReady;
        return backend;
      },
      viteServerFactory: async () => fakeServer(),
    });
    const opening = provider.openProject({ root });
    await backendStart;
    const disposing = provider.dispose?.();
    if (releaseBackend === undefined)
      throw new Error('provider fixture did not expose backend gate');
    releaseBackend(await createBackendHost());
    await expect(opening).rejects.toMatchObject({
      code: 'engine-workspace-provider-disposed',
    });
    await disposing;
    expect(backend?.assembly.activation.state).toBe('disposed');
  });
});

describe('DevKit workspace provider borrowed host lifecycle', () => {
  it('keeps the borrowed Host alive across session close and rebind', async () => {
    const root = await projectRoot();
    const backend = await createBackendHost({});
    const binding = { backend };
    const ownerClient = backend.transport.connect();
    const servers: ReturnType<typeof fakeServer>[] = [];
    const provider = createDevKitWorkspaceProvider({
      readyTimeoutMs: 500,
      hostBinding: binding,
      viteServerFactory: async () => {
        const server = fakeServer();
        servers.push(server);
        return server;
      },
    });
    try {
      const first = await provider.openProject({ root });
      expect(mocks.createViteConfig).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'workspace-game' }),
        'serve',
        '/',
        // The provider derives a per-session workspace identity over the
        // borrowed binding; the Host itself stays the borrowed instance.
        expect.objectContaining({ host: expect.objectContaining({ backend }) }),
      );
      const firstTarget = first.target;
      if (firstTarget === undefined) throw new Error('borrowed fixture did not return a target');
      const page = frontendPage(backend, firstTarget);
      page.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
        if (command.operation === 'closeWorkspace') return;
        // The borrowed Host keeps this page connected after closeProject, so
        // the subscription must only answer ITS session's commands; commands
        // broadcast for a later session belong to the new page.
        if (command.kind !== 'command' || command.sessionId !== firstTarget.sessionId) return;
        void page.request(engineWorkspaceResultService(firstTarget.targetId), {
          kind: 'result',
          id: command.id,
          sessionId: command.sessionId,
          targetId: firstTarget.targetId,
          ok: true,
          value: [{ guid: 'scene-guid', kind: 'scene', name: 'Scene', previewable: true }],
        });
      });
      const firstAssets = provider.listAssets({ project: first.project, handle: first.handle });
      await ready(page, firstTarget, root);
      expect(await firstAssets).toEqual([
        { guid: 'scene-guid', kind: 'scene', name: 'Scene', previewable: true },
      ]);

      await provider.closeProject({ project: first.project, handle: first.handle });
      expect(servers[0]?.close).toHaveBeenCalledOnce();
      // The borrowed Host outlives the session: prior owner connections stay
      // up and the transport still accepts new clients.
      expect(ownerClient.connected).toBe(true);
      expect(page.connected).toBe(true);

      const second = await provider.openProject({ root });
      const secondTarget = second.target;
      if (secondTarget === undefined) throw new Error('borrowed rebind did not return a target');
      expect(secondTarget.sessionId).not.toBe(firstTarget.sessionId);
      const secondPage = frontendPage(backend, secondTarget);
      secondPage.subscribe<WorkspaceCommandFixture>(ENGINE_WORKSPACE_COMMAND_TOPIC, (command) => {
        if (command.operation === 'closeWorkspace') return;
        if (command.kind !== 'command' || command.sessionId !== secondTarget.sessionId) return;
        void secondPage.request(engineWorkspaceResultService(secondTarget.targetId), {
          kind: 'result',
          id: command.id,
          sessionId: command.sessionId,
          targetId: secondTarget.targetId,
          ok: true,
          value: [],
        });
      });
      const secondAssets = provider.listAssets({
        project: second.project,
        handle: second.handle,
      });
      await ready(secondPage, secondTarget, root);
      expect(await secondAssets).toEqual([]);
      await provider.closeProject({ project: second.project, handle: second.handle });
      expect(ownerClient.connected).toBe(true);
      expect(servers).toHaveLength(2);
      await provider.dispose?.();
      expect(ownerClient.connected).toBe(true);
      expect(backend.assembly.activation.state).not.toBe('disposed');
    } finally {
      ownerClient.close();
      await provider.dispose?.();
      await backend.dispose();
    }
  });

  it('rejects a malformed borrowed frontend projection before attaching a session', async () => {
    const backend = await createBackendHost();
    try {
      expect(() =>
        validateHostBinding({
          backend,
          frontendAssembly: { ...backend.assembly.current, revision: 'tampered' },
        }),
      ).toThrow();
    } finally {
      await backend.dispose();
    }
  });
});

it('inspects authored asset identity and source revision without any View or browser', async () => {
  const root = await projectRoot();
  const packageId = '01900000-0000-7000-8000-000000000091';
  const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'scene/main'));
  await mkdir(resolve(root, 'assets'));
  await writeFile(
    resolve(root, 'assets/direct.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId,
      assets: { 'scene/main': { kind: 'scene', payload: { exposure: 1.25 }, refs: [] } },
    }),
  );
  const provider = createDevKitWorkspaceProvider();
  if (!provider.inspectAsset) throw new Error('production provider must expose inspection');
  try {
    const inspection = await provider.inspectAsset({
      project: { id: 'workspace-game', root },
      guid,
    });
    expect(inspection).toMatchObject({
      guid,
      asset: { guid, kind: 'scene', sourceKey: 'scene/main' },
      source: { path: 'assets/direct.pack.json', revision: expect.any(String) },
      meta: { packageId, format: 'direct', properties: { exposure: 1.25 } },
      revision: expect.any(String),
    });
    expect((inspection as { meta: Record<string, unknown> }).meta).toEqual({
      packageId,
      format: 'direct',
      properties: { exposure: 1.25 },
    });
  } finally {
    await provider.dispose?.();
  }
});

it('attaches the open pack payload when a live catalog row has a disk source', async () => {
  const root = await projectRoot();
  const packageId = '01900000-0000-7000-8000-000000000092';
  const guid = AssetGuid.format(AssetGuid.derive(definePackageId(packageId), 'material/main'));
  await mkdir(resolve(root, 'assets'));
  await writeFile(
    resolve(root, 'assets/material.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId,
      assets: {
        'material/main': { kind: 'material', payload: { roughness: 0.4, metallic: 0 }, refs: [] },
        'material/other': { kind: 'material', payload: { roughness: 0.9 }, refs: [] },
      },
    }),
  );
  const project = { id: 'workspace-game', root };
  const asset = {
    guid,
    kind: 'material',
    sourceKey: 'material/main',
    path: 'assets/material.pack.json',
  };
  const handle = {
    project,
    inspectAsset: async () => ({ guid, asset, meta: { vertexCount: 24 } }),
    listAssets: async () => [asset],
    target: { targetId: 'workspace-target' },
  };
  const provider = createDevKitWorkspaceProvider();
  try {
    const inspection = await provider.inspectAsset?.({ project, handle, guid });
    expect(inspection).toMatchObject({
      guid,
      asset,
      source: { path: asset.path, revision: expect.any(String) },
      meta: { vertexCount: 24, properties: { roughness: 0.4, metallic: 0 } },
      revision: expect.any(String),
    });
    expect((inspection as { meta: Record<string, unknown> }).meta).not.toHaveProperty('assets');
    expect((inspection as { meta: Record<string, unknown> }).meta).not.toHaveProperty('payload');
  } finally {
    await provider.dispose?.();
  }
});

it('rejects a Pack source whose output GUID does not match the live Catalog row', async () => {
  const root = await projectRoot();
  const sourcePackageId = '01900000-0000-7000-8000-000000000093';
  const catalogPackageId = '01900000-0000-7000-8000-000000000094';
  const guid = AssetGuid.format(
    AssetGuid.derive(definePackageId(catalogPackageId), 'material/main'),
  );
  await mkdir(resolve(root, 'assets'));
  await writeFile(
    resolve(root, 'assets/material.pack.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      packageId: sourcePackageId,
      assets: {
        'material/main': { kind: 'material', payload: { roughness: 0.9 }, refs: [] },
      },
    }),
  );
  const project = { id: 'workspace-game', root };
  const asset = {
    guid,
    kind: 'material',
    sourceKey: 'material/main',
    path: 'assets/material.pack.json',
  };
  const handle = {
    project,
    inspectAsset: async () => ({ guid, asset }),
    listAssets: async () => [asset],
    target: { targetId: 'workspace-target' },
  };
  const provider = createDevKitWorkspaceProvider();
  try {
    await expect(provider.inspectAsset?.({ project, handle, guid })).rejects.toMatchObject({
      code: 'asset-inspect-identity-mismatch',
    });
  } finally {
    await provider.dispose?.();
  }
});

it('reports an unreadable direct Pack source during live asset inspection', async () => {
  const root = await projectRoot();
  const project = { id: 'workspace-game', root };
  const guid = '24365a15-380e-5b19-9ea2-c9123e6cc045';
  const asset = {
    guid,
    kind: 'material',
    sourceKey: 'material/main',
    path: 'assets/missing.pack.json',
  };
  const handle = {
    project,
    inspectAsset: async () => ({ guid, asset }),
    listAssets: async () => [asset],
    target: { targetId: 'workspace-target' },
  };
  const provider = createDevKitWorkspaceProvider();
  try {
    await expect(provider.inspectAsset?.({ project, handle, guid })).rejects.toMatchObject({
      code: 'pack-source-not-found',
      expected: expect.any(String),
      hint: expect.any(String),
    });
  } finally {
    await provider.dispose?.();
  }
});

it('inspects the active catalog without requiring a filesystem Pack index', async () => {
  const root = await projectRoot();
  const project = { id: 'workspace-game', root };
  const asset = {
    guid: '24365a15-380e-5b19-9ea2-c9123e6cc045',
    kind: 'scene',
    path: 'assets/proof.pack.ts',
  };
  const inspection = {
    guid: asset.guid,
    asset,
    source: { path: asset.path },
    meta: { materialSlots: [] },
  };
  const inspectAsset = vi.fn(async ({ guid }: { guid: string }) => {
    if (guid !== asset.guid) throw Object.assign(new Error('missing'), { code: 'asset-not-found' });
    return inspection;
  });
  const handle = {
    project,
    inspectAsset,
    listAssets: () => [asset],
    target: { targetId: 'workspace-target' },
  };
  const provider = createDevKitWorkspaceProvider();
  try {
    expect(await provider.inspectAsset?.({ project, handle, guid: asset.guid })).toEqual(
      inspection,
    );
    expect(inspectAsset).toHaveBeenCalledOnce();
    await expect(
      provider.inspectAsset?.({ project, handle, guid: 'missing' }),
    ).rejects.toMatchObject({ code: 'asset-not-found' });
    inspectAsset.mockRejectedValueOnce(new Error('engine-workspace-page-lost'));
    await expect(provider.inspectAsset?.({ project, handle, guid: asset.guid })).rejects.toThrow(
      'engine-workspace-page-lost',
    );
  } finally {
    await provider.dispose?.();
  }
});
