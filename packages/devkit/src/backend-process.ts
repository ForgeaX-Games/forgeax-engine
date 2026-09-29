import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostWebSocketClient } from '@forgeax/engine-host/transport';
import type { ToolTerminal } from '@forgeax/engine-tool-runtime';
import { WebSocket } from 'ws';
import { createDevKitBackend, devKitBackendServerPlugin } from './backend.js';

interface BackendState {
  readonly id: string;
  readonly pid: number;
  readonly root: string;
  readonly hostPack?: string;
  readonly phase: 'starting' | 'ready';
  readonly endpoint?: string;
  readonly token?: string;
}

function statePath(root: string): string {
  const key = createHash('sha256').update(resolve(root)).digest('hex');
  return join(tmpdir(), 'forgeax-backend', key, 'session.json');
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readState(root: string): BackendState | undefined {
  const path = statePath(root);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BackendState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function removeState(root: string, id: string): void {
  if (readState(root)?.id === id) rmSync(statePath(root), { force: true });
}

function writeState(state: BackendState): void {
  const path = statePath(state.root);
  const pending = `${path}.${state.id}.tmp`;
  writeFileSync(pending, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(pending, path);
}

async function request(
  root: string,
  service: string,
  payload?: unknown,
  timeout = 120_000,
  signal?: AbortSignal,
) {
  const state = readState(root);
  if (!state || !alive(state.pid) || state.phase !== 'ready' || !state.endpoint || !state.token) {
    throw new Error('Engine backend is not ready. Run forgeax backend start first.');
  }
  const url = new URL(state.endpoint);
  url.searchParams.set('token', state.token);
  const socket = new WebSocket(url.href, { handshakeTimeout: 5000 });
  try {
    const transport = await createHostWebSocketClient(socket);
    try {
      return await transport.request(service, payload, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout),
      });
    } finally {
      transport.close();
    }
  } finally {
    socket.terminate();
  }
}

export async function runDevKitBackendTool(
  root: string,
  operation: string,
  args: unknown = {},
  signal?: AbortSignal,
): Promise<ToolTerminal<unknown>> {
  return (await request(
    root,
    'engine.backend.call',
    { operation, args },
    300_000,
    signal,
  )) as ToolTerminal<unknown>;
}

export async function callDevKitBackend(root: string, operation: string, args: unknown = {}) {
  const terminal = await runDevKitBackendTool(root, operation, args);
  if (terminal.outcome === 'failed') {
    const error = new Error(terminal.failure.hint);
    Object.assign(error, terminal.failure);
    throw error;
  }
  return terminal.result;
}

export async function devKitBackendStatus(rootInput: string) {
  const root = resolve(rootInput);
  const state = readState(root);
  if (!state || !alive(state.pid)) return { root, phase: 'stopped' };
  if (state.phase === 'starting')
    return { root, phase: 'starting', pid: state.pid, hostPack: state.hostPack };
  try {
    await request(root, 'engine.backend.status', undefined, 5000);
    return { root, phase: 'ready', pid: state.pid, hostPack: state.hostPack };
  } catch {
    return { root, phase: 'unreachable', pid: state.pid, hostPack: state.hostPack };
  }
}

export async function stopDevKitBackend(rootInput: string) {
  const root = resolve(rootInput);
  const state = readState(root);
  if (!state) return { root, phase: 'stopped' };
  if (!alive(state.pid)) {
    removeState(root, state.id);
    return { root, phase: 'stopped' };
  }
  await request(root, 'engine.backend.stop', undefined, 5000);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!alive(state.pid) || readState(root)?.id !== state.id) return { root, phase: 'stopped' };
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('Engine backend is still stopping; inspect backend status.');
}

export function devKitBackendHostPack(rootInput: string): string | undefined {
  const state = readState(resolve(rootInput));
  return state && alive(state.pid) ? state.hostPack : undefined;
}

export async function startDevKitBackend(
  rootInput: string,
  options: { readonly hostPack?: string } = {},
) {
  const root = resolve(rootInput);
  const hostPack = options.hostPack === undefined ? undefined : realpathSync(options.hostPack);
  const current = readState(root);
  if (current && alive(current.pid)) {
    if (hostPack !== undefined && current.hostPack !== hostPack)
      throw new Error(
        `Backend already runs with a different host Pack: ${current.hostPack ?? 'none'}`,
      );
    return devKitBackendStatus(root);
  }
  if (current) removeState(root, current.id);
  const path = statePath(root);
  mkdirSync(dirname(path), { recursive: true });
  const id = randomUUID();
  const initial: BackendState = {
    id,
    root,
    pid: process.pid,
    phase: 'starting',
    ...(hostPack === undefined ? {} : { hostPack }),
  };
  const claim = `${path}.${id}.claim`;
  writeFileSync(claim, `${JSON.stringify(initial)}\n`, { mode: 0o600 });
  try {
    linkSync(claim, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const owner = readState(root);
      if (hostPack !== undefined && owner?.hostPack !== hostPack)
        throw new Error(
          `Backend already starts with a different host Pack: ${owner?.hostPack ?? 'none'}`,
        );
      return devKitBackendStatus(root);
    }
    throw error;
  } finally {
    rmSync(claim, { force: true });
  }
  const logPath = join(dirname(path), 'backend.log');
  const log = openSync(logPath, 'a', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./cli.mjs', import.meta.url)), '--__forgeax-backend', root, id],
      {
        detached: true,
        stdio: ['ignore', log, log],
        env: process.env,
      },
    );
  } catch (error) {
    removeState(root, id);
    throw error;
  } finally {
    closeSync(log);
  }
  let failure: Error | undefined;
  child.once('error', (error) => {
    failure = error;
  });
  child.unref();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const state = readState(root);
    if (state?.id === id && state.phase === 'ready') return devKitBackendStatus(root);
    if (failure || !child.pid || !alive(child.pid)) {
      removeState(root, id);
      throw failure ?? new Error(`Engine backend startup failed; inspect ${logPath}`);
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(
    `Engine backend startup is still pending; inspect ${logPath} and backend status.`,
  );
}

export async function runDevKitBackendProcess(root: string, id: string): Promise<void> {
  const claim = readState(root);
  if (claim?.id !== id) throw new Error('Backend startup claim was replaced');
  const hostPack = claim.hostPack;
  writeState({
    root,
    id,
    pid: process.pid,
    phase: 'starting',
    ...(hostPack === undefined ? {} : { hostPack }),
  });
  let stop!: () => void;
  const closed = new Promise<void>((done) => {
    stop = done;
  });
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let backend: Awaited<ReturnType<typeof createDevKitBackend>> | undefined;
  try {
    backend = await createDevKitBackend(root, hostPack === undefined ? {} : { hostPack });
    await (await backend.host.context.plugin(devKitBackendServerPlugin, { stop })).await();
    writeState({
      root,
      id,
      pid: process.pid,
      phase: 'ready',
      ...(hostPack === undefined ? {} : { hostPack }),
      ...backend.host.context.devkitBackendServer,
    });
    await closed;
  } finally {
    try {
      await backend?.dispose();
    } finally {
      removeState(root, id);
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    }
  }
}
