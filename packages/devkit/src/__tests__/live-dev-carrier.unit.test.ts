import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserCarrierAdapter } from '../tools/display-carrier.js';

const snapshotFixture = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../run-snapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../run-snapshot.js')>()),
  createRunSnapshot: snapshotFixture.create,
}));

const fixtures = vi.hoisted(() => {
  const emitter = () => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
      on(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return this;
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        const wrapped = (...args: unknown[]) => {
          listeners.set(
            event,
            (listeners.get(event) ?? []).filter((candidate) => candidate !== wrapped),
          );
          listener(...args);
        };
        return this.on(event, wrapped);
      },
      off(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((candidate) => candidate !== listener),
        );
        return this;
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) listener(...args);
        return true;
      },
      setEncoding() {
        return this;
      },
    };
  };
  const target = {
    leaseId: 'live-lease-1',
    targetId: 'live-target-1',
    kind: 'browser-page',
    surfaceId: 'live-surface-1',
    run: { serviceId: 'live-service-1', runId: 'live-run-1' },
    generation: 2,
    width: 1280,
    height: 720,
    gpu: 'hardware' as const,
  };
  const page = {
    waitForFunction: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => undefined),
    bringToFront: vi.fn(async () => undefined),
  };
  const frame = {
    waitForFunction: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => '9'),
    waitForTimeout: vi.fn(async () => undefined),
  };
  const session = {
    page,
    execution: undefined as unknown,
    close: vi.fn(async () => undefined),
    report: vi.fn(() => ({
      backend: 'hardware' as const,
      carrier: 'borrowed' as 'borrowed' | 'private-browser',
      carrierTarget: target as typeof target | undefined,
      carrierFallbackReason: undefined as string | undefined,
      pageErrors: [],
    })),
  };
  const browser = {
    open: vi.fn(async (_options: unknown) => session),
    close: vi.fn(async () => undefined),
  };
  const child = Object.assign(emitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdout: emitter(),
    stderr: { pipe: vi.fn() },
    kill: vi.fn(),
  });
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = emitter();
  child.stderr = { pipe: vi.fn() };
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    return true;
  });
  const spawn = vi.fn((_command: string, args: readonly string[]) => {
    const generation = Number(args[3]);
    queueMicrotask(() => {
      child.stdout.emit(
        'data',
        `${JSON.stringify({ ready: true, generation, url: 'http://127.0.0.1:43124/' })}\n`,
      );
    });
    return child;
  });
  const createBrowserCapture = vi.fn(() => browser);
  const readLiveProjectInputs = vi.fn(async () => 'fixture-inputs');
  return {
    target,
    page,
    frame,
    session,
    browser,
    child,
    spawn,
    createBrowserCapture,
    readLiveProjectInputs,
  };
});

vi.mock('node:child_process', () => ({ spawn: fixtures.spawn }));
vi.mock('../software-capture.js', () => ({ createBrowserCapture: fixtures.createBrowserCapture }));
vi.mock('../live-project-inputs.js', () => ({
  readLiveProjectInputs: fixtures.readLiveProjectInputs,
}));

import { liveDevStatus, runLiveDevDaemon, startLiveDev } from '../live-dev.js';

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing fixture port');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function request(port: number, path: string, method: 'GET' | 'POST'): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { connection: 'close' },
  });
  return response.json();
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.browser.open.mockImplementation(async () => fixtures.session);
  fixtures.session.report.mockImplementation(() => ({
    backend: 'hardware' as const,
    carrier: 'borrowed' as const,
    carrierTarget: fixtures.target,
    carrierFallbackReason: undefined,
    pageErrors: [],
  }));
});

describe('live DevKit borrowed carrier boundary', () => {
  it('composes the existing live owner in process and waits for host cancellation cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-in-process-'));
    const lifetime = new AbortController();
    let closed: Promise<void> | undefined;
    const carrier = {} as BrowserCarrierAdapter;
    try {
      const started = await startLiveDev(root, {
        headless: false,
        inProcess: {
          carrier,
          signal: lifetime.signal,
          onStart: (value) => {
            closed = value;
          },
        },
      });
      expect(started).toMatchObject({
        ok: false,
        error: {
          code: 'live-not-ready',
          detail: { status: { phase: 'waiting', pid: process.pid } },
        },
      });
      expect(fixtures.browser.open.mock.calls[0]?.[0]).toMatchObject({ carrier, headless: false });
      const ownerStarted = vi.fn();
      await startLiveDev(root, {
        headless: false,
        inProcess: { signal: lifetime.signal, onStart: ownerStarted },
      });
      expect(ownerStarted).not.toHaveBeenCalled();
      expect(fixtures.browser.open).toHaveBeenCalledOnce();
      lifetime.abort();
      await closed;
      expect(fixtures.session.close).toHaveBeenCalledOnce();
      expect(fixtures.browser.close).toHaveBeenCalledOnce();
      expect(await liveDevStatus(root)).toMatchObject({ ok: true, value: { phase: 'stopped' } });
    } finally {
      lifetime.abort();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns when stopped while the borrowed browser is still opening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-stop-opening-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    let finishOpen = () => {};
    const opening = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    fixtures.browser.open.mockImplementation(async () => {
      await opening;
      return fixtures.session;
    });
    let finished = false;
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier: {} as BrowserCarrierAdapter,
    }).then(() => {
      finished = true;
    });
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledOnce());
      await request(port, '/stop', 'POST');
      finishOpen();
      await vi.waitFor(() => expect(finished).toBe(true));
      await daemon;
      expect(fixtures.session.close).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      finishOpen();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the control owner stable while assigning the project child an ephemeral port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-carrier-'));
    const carrier = {} as BrowserCarrierAdapter;
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier,
      carrierRun: fixtures.target.run,
    });
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      const openOptions = fixtures.browser.open.mock.calls[0]?.[0];
      expect(openOptions).toMatchObject({
        carrier,
        carrierRun: fixtures.target.run,
        carrierGeneration: fixtures.target.generation,
        headless: false,
      });
      const projectArgs = fixtures.spawn.mock.calls[0]?.[1];
      expect(projectArgs).toEqual([
        expect.any(String),
        '--__forgeax-live-project',
        root,
        expect.any(String),
        '0',
      ]);
      const status = await request(port, '/status', 'GET');
      expect(status).toMatchObject({
        ok: true,
        value: {
          endpoint: `http://127.0.0.1:${port}`,
          pid: process.pid,
          carrier: 'borrowed',
          carrierTarget: fixtures.target,
          backend: 'hardware',
        },
      });
      expect(fixtures.page.bringToFront).not.toHaveBeenCalled();
      await request(port, '/stop', 'POST');
      await daemon;
      expect(fixtures.session.close).toHaveBeenCalled();
      expect(fixtures.browser.close).toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains foregrounding for the private-browser fallback', async () => {
    fixtures.session.report.mockReturnValueOnce({
      backend: 'hardware' as const,
      carrier: 'private-browser' as const,
      carrierTarget: undefined,
      carrierFallbackReason: 'display host did not admit the run',
      pageErrors: [],
    });
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-private-browser-'));
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'));
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      await vi.waitFor(() => expect(fixtures.page.bringToFront).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      await request(port, '/stop', 'POST');
      await daemon;
      expect(exit).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('observes the execution frame while keeping the owner page untouched', async () => {
    fixtures.session.execution = {
      kind: 'frame',
      ownerPage: fixtures.page,
      realm: fixtures.frame,
      surfaceSelector: '#display-frame',
    } as never;
    const root = await mkdtemp(join(tmpdir(), 'forgeax-live-frame-'));
    const carrier = {} as BrowserCarrierAdapter;
    const port = await freePort();
    await mkdir(join(root, '.forgeax'), { recursive: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const daemon = runLiveDevDaemon(root, port, join(root, '.forgeax', 'session.json'), {
      carrier,
      carrierRun: fixtures.target.run,
    });
    try {
      await vi.waitFor(() => expect(fixtures.browser.open).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      await vi.waitFor(() => expect(fixtures.frame.waitForFunction).toHaveBeenCalled(), {
        timeout: 5_000,
      });
      expect(fixtures.page.waitForFunction).not.toHaveBeenCalled();
      expect(fixtures.frame.evaluate).toHaveBeenCalled();
      expect(fixtures.page.evaluate).not.toHaveBeenCalled();
      await request(port, '/stop', 'POST');
      await daemon;
      expect(exit).not.toHaveBeenCalled();
    } finally {
      fixtures.session.execution = undefined;
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('rejects a second snapshot owner and cleans a snapshot completed after startup cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-snapshot-cancel-'));
  const previous = process.env.FORGEAX_RUNS_DIR;
  process.env.FORGEAX_RUNS_DIR = join(directory, 'runs');
  const { runStateDirectory } = await import('../run-snapshot.js');
  const lifetime = new AbortController();
  let complete: (value: unknown) => void = () => {};
  snapshotFixture.create.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const dispose = vi.fn(async () => {});
  const daemon = runLiveDevDaemon(directory, await freePort(), undefined, {
    snapshot: true,
    signal: lifetime.signal,
  });
  try {
    await vi.waitFor(() => expect(snapshotFixture.create).toHaveBeenCalledOnce());
    await expect(
      runLiveDevDaemon(directory, await freePort(), undefined, { snapshot: true }),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    lifetime.abort();
    complete({ root: join(directory, 'snapshot'), version: 'sha256:fixture', dispose });
    await daemon;
    expect(dispose).toHaveBeenCalled();
    expect(fixtures.browser.open).not.toHaveBeenCalled();
    await expect(access(join(runStateDirectory(directory), 'owner.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    lifetime.abort();
    complete({ root: join(directory, 'snapshot'), version: 'sha256:fixture', dispose });
    await daemon;
    if (previous === undefined) delete process.env.FORGEAX_RUNS_DIR;
    else process.env.FORGEAX_RUNS_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
