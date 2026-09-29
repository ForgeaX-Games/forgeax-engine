import { once } from 'node:events';
import { Context } from '@forgeax/engine-plugin';
import { describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createBackendHost } from '../backend.js';
import { createFrontendHost } from '../frontend.js';
import {
  attachHostWebSocketServer,
  createHostTransport,
  createHostWebSocketClient,
} from '../index';
import { createHostAssembly, validateHostAssembly } from '../protocol.js';
import {
  HOST_ACTIVATION_REPORT_SERVICE,
  HOST_ASSEMBLY_CHANGED_TOPIC,
  HOST_ASSEMBLY_SERVICE,
} from '../transport.js';

const assembly = () =>
  createHostAssembly({
    root: { program: 'game#main', codeRevision: 'one', config: { answer: 42 } },
  });
describe('native root Host assembly', () => {
  it('validates the versioned JSON projection and rejects old Entries', () => {
    const value = assembly();
    expect(validateHostAssembly(JSON.parse(JSON.stringify(value))).ok).toBe(true);
    expect(validateHostAssembly({ ...value, entries: [] }).ok).toBe(false);
    expect(validateHostAssembly({ ...value, sessionGeneration: 2 }).ok).toBe(false);
    expect(() => createHostAssembly({ config: { nan: NaN } })).toThrow();
  });
  it('waits outside the native parent and cleans only its own contributions', async () => {
    const ctx = new Context();
    let disposed = 0;
    const host = await createFrontendHost({
      context: ctx,
      assembly: assembly(),
      resolveRoot: async () => ({
        apply(ctx: Context, config: { answer: number }) {
          ctx.provide('answer', config.answer);
          ctx.plugin({
            inject: ['answer'],
            apply(ctx: Context) {
              expect(ctx.get('answer')).toBe(42);
              ctx.effect(() => () => {
                disposed++;
              });
            },
          });
        },
      }),
    });
    expect(host.status.state).toBe('active');
    expect(host.assembly.inspection.every((row) => row.state === 'active')).toBe(true);
    await host.dispose();
    expect(disposed).toBe(1);
    expect(ctx.fiber.uid).not.toBeNull();
    await ctx.fiber.dispose();
  });
  it('does not finish activation after disposal while its status reporter is pending', async () => {
    let release = () => {};
    let entered = () => {};
    const reporting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = await createFrontendHost({
      autoActivate: false,
      assembly: assembly(),
      resolveRoot: async () => () => {},
      reportStatus: async (status) => {
        if (status.state === 'active') {
          entered();
          await pending;
        }
      },
    });
    const activation = host.activate();
    const rejected = expect(activation).rejects.toBeDefined();
    await reporting;
    await host.dispose();
    release();
    await rejected;
    expect(host.status.state).toBe('disposed');
  });
  it('requires a new environment before replacing the root session', async () => {
    const host = await createFrontendHost({
      assembly: assembly(),
      resolveRoot: async () => () => {},
    });
    const next = createHostAssembly({
      sessionGeneration: 2,
      root: { program: 'game#main', codeRevision: 'two' },
    });
    await expect(host.update(next)).rejects.toMatchObject({
      code: 'host-assembly-reload-required',
    });
    expect(host.status.state).toBe('active');
    await host.dispose();
  });
  it('retains backend authority and rejects stale activation reports', async () => {
    const backend = await createBackendHost({ assembly: assembly() });
    const client = backend.transport.connect();
    await client.request(HOST_ACTIVATION_REPORT_SERVICE, {
      state: 'active',
      revision: backend.assembly.current.revision,
      sessionGeneration: 1,
    });
    const old = backend.assembly.current;
    if (!old.root) throw new Error('fixture root missing');
    await backend.update({ root: old.root }, { expectedRevision: old.revision });
    await expect(
      client.request(HOST_ACTIVATION_REPORT_SERVICE, {
        state: 'active',
        revision: old.revision,
        sessionGeneration: 1,
      }),
    ).rejects.toBeDefined();
    await backend.dispose();
  });
  it('bounds a resolver that ignores cancellation and never reports it as active', async () => {
    const host = await createFrontendHost({
      assembly: assembly(),
      autoActivate: false,
      startupTimeoutMs: 20,
      cleanupTimeoutMs: 50,
      resolveRoot: () => new Promise(() => {}),
    });
    await expect(host.activate()).rejects.toMatchObject({
      code: 'host-assembly-activation-timeout',
    });
    expect(host.status.state).toBe('failed');
    await host.dispose();
  });
  it('rejects sparse JSON and freezes the validated wire snapshot', () => {
    expect(() => createHostAssembly({ config: new Array(2) })).toThrow();
    const input = assembly();
    const decoded = JSON.parse(JSON.stringify(input));
    const checked = validateHostAssembly(decoded);
    expect(checked.ok).toBe(true);
    decoded.root.config.answer = 0;
    if (checked.ok) {
      expect(checked.value.root?.config).toEqual({ answer: 42 });
      expect(Object.isFrozen(checked.value.root?.config)).toBe(true);
    }
  });
});

describe('Host cancellation ownership', () => {
  it('disposes partially installed roots when a custom activation never settles', async () => {
    const context = new Context();
    let disposed = 0;
    const host = await createFrontendHost({
      context,
      assembly: assembly(),
      autoActivate: false,
      startupTimeoutMs: 20,
      async activateRoot(ctx) {
        ctx.plugin({
          apply(ctx) {
            ctx.effect(() => () => {
              disposed++;
            });
          },
        });
        return new Promise(() => {});
      },
    });
    await expect(host.activate()).rejects.toMatchObject({
      code: 'host-assembly-activation-timeout',
    });
    expect(disposed).toBe(1);
    await host.dispose();
    expect(context.fiber.uid).not.toBeNull();
    await context.fiber.dispose();
  });
  it('revokes frontend contributions when the transport disconnects', async () => {
    const backend = await createBackendHost({ assembly: assembly() });
    const client = backend.transport.connect();
    let released = false;
    const host = await createFrontendHost({
      transport: client,
      resolveRoot: async () => ({
        apply(ctx) {
          ctx.effect(() => () => {
            released = true;
          });
        },
      }),
    });
    await backend.dispose();
    await expect.poll(() => released).toBe(true);
    await host.dispose();
  });
});

it('binds, replaces and withdraws connection projections without changing backend assembly or peers', async () => {
  const backend = await createBackendHost();
  const defaultClient = backend.transport.connect({ kind: 'frontend', sourceId: 'default' });
  const targetClient = backend.transport.connect({ kind: 'frontend', sourceId: 'target' });
  const initial = createHostAssembly({ config: { phase: 'initial' } });
  const complete = createHostAssembly({ config: { phase: 'complete' } });
  const events: unknown[] = [];
  targetClient.subscribe(HOST_ASSEMBLY_CHANGED_TOPIC, (value) => events.push(value));
  try {
    expect(() =>
      backend.bindProjection(
        { ...targetClient.caller, capability: 'forged' },
        { assembly: initial },
      ),
    ).toThrow();
    expect(events).toEqual([]);
    const old = backend.bindProjection(targetClient.caller, {
      assembly: complete,
    });
    expect(await targetClient.request(HOST_ASSEMBLY_SERVICE, undefined)).toEqual(complete);
    expect(await defaultClient.request(HOST_ASSEMBLY_SERVICE, undefined)).toEqual(
      backend.assembly.current,
    );
    for (const revision of [complete.revision]) {
      await expect(
        targetClient.request(HOST_ACTIVATION_REPORT_SERVICE, {
          state: 'active',
          revision,
          sessionGeneration: 1,
        }),
      ).resolves.toEqual({ accepted: true });
      await expect(
        defaultClient.request(HOST_ACTIVATION_REPORT_SERVICE, {
          state: 'active',
          revision,
          sessionGeneration: 1,
        }),
      ).rejects.toMatchObject({ code: 'host-assembly-revision-mismatch' });
    }
    await expect(
      targetClient.request(HOST_ACTIVATION_REPORT_SERVICE, {
        state: 'active',
        revision: backend.assembly.current.revision,
      }),
    ).rejects.toMatchObject({ code: 'host-assembly-revision-mismatch' });
    await backend.update({ config: { phase: 'default-updated' } });
    expect(events).toEqual([complete]);
    expect(await targetClient.request(HOST_ASSEMBLY_SERVICE, undefined)).toEqual(complete);
    const replacement = backend.bindProjection(targetClient.caller, { assembly: initial });
    old();
    await expect(
      targetClient.request(HOST_ACTIVATION_REPORT_SERVICE, {
        state: 'active',
        revision: complete.revision,
        sessionGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: 'host-assembly-revision-mismatch' });
    expect(await targetClient.request(HOST_ASSEMBLY_SERVICE, undefined)).toEqual(initial);
    replacement();
    replacement();
    await expect(targetClient.request(HOST_ASSEMBLY_SERVICE, undefined)).rejects.toMatchObject({
      code: 'host-assembly-service-unavailable',
    });
    expect(await defaultClient.request(HOST_ASSEMBLY_SERVICE, undefined)).toEqual(
      backend.assembly.current,
    );
  } finally {
    defaultClient.close();
    targetClient.close();
    expect(() => backend.bindProjection(targetClient.caller, { assembly: initial })).toThrow();
    await backend.dispose();
  }
});

it('preserves unknown remote business codes across the real WebSocket boundary', async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('WebSocket port missing');
  const failures = {
    capability: {
      code: 'plugin-capability-unavailable',
      expected: 'Engine workspace capability project.open to be installed',
      hint: 'Build and install the matching Engine workspace plugin before opening a project.',
      detail: { capability: 'project.open' },
    },
    asset: {
      code: 'plugin-asset-unsupported',
      expected: 'Engine asset.open to support asset kind material',
      hint: 'Use an Engine type-preview capability for this asset kind.',
      detail: { kind: 'material' },
    },
  } as const;
  const transport = createHostTransport();
  const unregister = transport.register('plugin.workspace.call', ({ payload }) => {
    const failure =
      (payload as { readonly operation?: unknown }).operation === 'asset.open'
        ? failures.asset
        : failures.capability;
    throw Object.assign(new Error(failure.hint), failure);
  });
  server.on('connection', (socket) => attachHostWebSocketServer(socket, transport));
  let client: Awaited<ReturnType<typeof createHostWebSocketClient>> | undefined;
  try {
    client = await createHostWebSocketClient(new WebSocket(`ws://127.0.0.1:${address.port}`));
    for (const failure of [failures.capability, failures.asset]) {
      await expect(
        client.request('plugin.workspace.call', {
          operation: failure === failures.asset ? 'asset.open' : 'project.open',
        }),
      ).rejects.toMatchObject({
        code: 'host-transport-failure',
        expected: failure.expected,
        hint: failure.hint,
        detail: {
          service: 'host/socket',
          remoteCode: failure.code,
          ...failure.detail,
        },
      });
    }
  } finally {
    client?.close();
    unregister();
    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('exercises the WebSocket host boundary with request, cancellation, and close', async () => {
  const server = new WebSocketServer({ port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('WebSocket port missing');
  const transport = createHostTransport();
  let cancelled = false;
  let resolveCancellation: (() => void) | undefined;
  const cancellationObserved = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  transport.register('echo', ({ payload }) => payload);
  transport.register(
    'pending',
    ({ signal }) =>
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => {
          cancelled = true;
          resolveCancellation?.();
          reject(new Error('cancelled'));
        });
      }),
  );
  server.on('connection', (socket) => attachHostWebSocketServer(socket, transport));
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const client = await createHostWebSocketClient(socket);
  const unsubscribe = client.subscribe('fixture.topic', () => {});
  await expect(client.request('echo', { ok: true })).resolves.toEqual({ ok: true });
  const preAborted = new AbortController();
  preAborted.abort();
  await expect(
    client.request('echo', undefined, { signal: preAborted.signal }),
  ).rejects.toMatchObject({ code: 'host-assembly-request-aborted' });
  const controller = new AbortController();
  const pending = client.request('pending', undefined, { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'host-assembly-request-aborted' });
  await cancellationObserved;
  expect(cancelled).toBe(true);
  client.close();
  const sendAfterClose = vi.spyOn(socket, 'send');
  unsubscribe();
  unsubscribe();
  expect(sendAfterClose).not.toHaveBeenCalled();
  sendAfterClose.mockRestore();
  const closeClient = await createHostWebSocketClient(
    new WebSocket(`ws://127.0.0.1:${address.port}`),
  );
  const pendingOnClose = closeClient.request('pending', undefined);
  closeClient.close('test close');
  await expect(pendingOnClose).rejects.toMatchObject({ code: 'host-transport-failure' });
  transport.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
