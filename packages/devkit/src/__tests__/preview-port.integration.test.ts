import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { writeDistManifest } from '../dist.js';
import type { ProjectFacts } from '../types.js';

const execFileAsync = promisify(execFile);
const cliPath = resolve(import.meta.dirname, '../../dist/cli.mjs');
const activeProcesses = new Set<RunningCli>();

type PreviewCommand = 'dev' | 'serve' | 'preview';

interface RunningCli {
  readonly child: ChildProcessWithoutNullStreams;
  readonly root: string;
  readonly stdout: { value: string };
  readonly stderr: { value: string };
}

interface ReadyEvidence {
  readonly pid: number;
  readonly cwd: string;
  readonly port: number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-preview-port-'));
  const facts: ProjectFacts = {
    root,
    id: 'preview-port-fixture',
    name: 'Preview Port Fixture',
    entry: 'main.ts',
    plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
    assetRoots: [],
    packageJson: { name: 'preview-port-fixture' },
  };
  await Promise.all([
    writeFile(
      resolve(root, 'forge.json'),
      `${JSON.stringify({
        id: facts.id,
        name: facts.name,
        schemaVersion: '1.0.0',
        entry: facts.entry,
        plugins: facts.plugins,
      })}\n`,
    ),
    writeFile(
      resolve(root, 'package.json'),
      `${JSON.stringify({
        name: 'preview-port-fixture',
        forgeax: { assets: { roots: [] } },
      })}\n`,
    ),
    writeFile(resolve(root, 'main.ts'), 'export default {};\n'),
    mkdir(resolve(root, 'dist', 'shaders'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(root, 'dist', 'index.html'), '<!doctype html><title>fixture</title>\n'),
    writeFile(resolve(root, 'dist', 'pack-index.json'), '{}\n'),
    writeFile(resolve(root, 'dist', 'shaders', 'manifest.json'), '{}\n'),
  ]);
  await writeDistManifest(facts, '/');
  return realpath(root);
}

function startCli(command: PreviewCommand, root: string, port?: number | string): RunningCli {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const dnsOption = '--dns-result-order=ipv4first';
  const inheritedNodeOptions = process.env.NODE_OPTIONS?.trim();
  const child = spawn(
    process.execPath,
    [
      cliPath,
      command,
      '--root',
      root,
      '--json',
      ...(port === undefined ? [] : ['--port', `${port}`]),
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_OPTIONS:
          inheritedNodeOptions === undefined || inheritedNodeOptions.length === 0
            ? dnsOption
            : `${inheritedNodeOptions} ${dnsOption}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout.value += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr.value += chunk;
  });
  const running = { child, root, stdout, stderr };
  activeProcesses.add(running);
  return running;
}

function envelopeError(
  stdout: string,
): { readonly code?: unknown; readonly detail?: unknown } | undefined {
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const envelope = JSON.parse(line) as {
        readonly ok?: unknown;
        readonly error?: { readonly code?: unknown; readonly detail?: unknown };
      };
      if (envelope.ok === false) return envelope.error;
    } catch {
      // Vite diagnostics are routed to stderr; ignore any non-envelope stdout defensively.
    }
  }
  return undefined;
}

function envelopePort(stdout: string): number | undefined {
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const envelope = JSON.parse(line) as {
        readonly ok?: unknown;
        readonly value?: { readonly urls?: { readonly local?: readonly string[] | null } };
      };
      const local = envelope.value?.urls?.local?.[0];
      if (envelope.ok !== true || local === undefined) continue;
      const parsed = Number(new URL(local).port);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    } catch {
      // Vite diagnostics are routed to stderr; ignore any non-envelope stdout defensively.
    }
  }
  return undefined;
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = new Socket();
    const finish = (connected: boolean) => {
      socket.destroy();
      resolveConnect(connected);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1', () => finish(true));
  });
}

async function processCwd(pid: number): Promise<string> {
  if (process.platform === 'linux') return readlink(`/proc/${pid}/cwd`);
  const { stdout } = await execFileAsync('/usr/sbin/lsof', [
    '-a',
    '-p',
    `${pid}`,
    '-d',
    'cwd',
    '-Fn',
  ]);
  const cwd = stdout
    .split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1);
  if (cwd === undefined) throw new Error(`cwd evidence unavailable for pid ${pid}`);
  return cwd;
}

async function waitForReady(
  running: RunningCli,
  timeoutMilliseconds = 20_000,
): Promise<ReadyEvidence> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const port = envelopePort(running.stdout.value);
    if (port !== undefined && (await canConnect(port))) {
      const pid = running.child.pid;
      if (pid === undefined) throw new Error('preview process has no pid');
      return { pid, cwd: await processCwd(pid), port };
    }
    if (running.child.exitCode !== null) {
      throw new Error(
        `preview process exited ${running.child.exitCode}; stdout=${running.stdout.value}; stderr=${running.stderr.value}`,
      );
    }
    await delay(50);
  }
  throw new Error(`preview listener timed out; state=${JSON.stringify(processState(running))}`);
}

function processState(running: RunningCli): Record<string, unknown> {
  const { child } = running;
  return {
    pid: child.pid ?? null,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    killed: child.killed,
    connected: child.connected,
    stdout: running.stdout.value,
    stderr: running.stderr.value,
  };
}

async function waitForExit(
  running: RunningCli,
  timeoutMilliseconds = 20_000,
): Promise<number | null> {
  if (running.child.exitCode !== null) return running.child.exitCode;
  return new Promise((resolveExit, rejectExit) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      running.child.removeListener('exit', onExit);
      resolveExit(code);
    };
    const onExit = (code: number | null) => finish(code);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      running.child.removeListener('exit', onExit);
      rejectExit(
        new Error(`preview process exit timed out; state=${JSON.stringify(processState(running))}`),
      );
    }, timeoutMilliseconds);
    running.child.once('exit', onExit);
    // Close the race where the child exits between the initial check and listener registration.
    if (running.child.exitCode !== null) onExit(running.child.exitCode);
  });
}

async function waitForPortClosed(
  running: RunningCli,
  port: number,
  timeoutMilliseconds = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!(await canConnect(port))) return;
    await delay(50);
  }
  throw new Error(
    `preview listener release timed out; port=${port}; state=${JSON.stringify(processState(running))}`,
  );
}

async function stop(running: RunningCli, observedPort?: number): Promise<void> {
  if (running.child.exitCode === null) {
    running.child.kill('SIGTERM');
    try {
      await waitForExit(running, 3_000);
    } catch {
      running.child.kill('SIGKILL');
      await waitForExit(running);
    }
  }
  activeProcesses.delete(running);
  if (observedPort !== undefined) await waitForPortClosed(running, observedPort);
}

async function randomAvailablePort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
  });
  if (port <= 0 || port === 5173) return randomAvailablePort();
  return port;
}

afterEach(async () => {
  await Promise.all([...activeProcesses].map((running) => stop(running)));
});

describe('DevKit preview port listener contract', () => {
  it.each([
    '-1',
    '1.5',
    '65536',
    'not-a-port',
  ])('rejects invalid --port %s as a structured CLI parse error before listening', async (port) => {
    const root = await fixture();
    try {
      const running = startCli('dev', root, port);
      const exit = await waitForExit(running);
      expect(exit).toBe(2);
      expect(envelopePort(running.stdout.value)).toBeUndefined();
      expect(envelopeError(running.stdout.value)).toMatchObject({
        code: 'cli-parse-error',
        detail: { option: '--port', received: port },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each<PreviewCommand>([
    'dev',
    'serve',
    'preview',
  ])('%s defaults to a real listener on 5173 with observable pid/cwd and cleanup', async (command) => {
    const root = await fixture();
    try {
      const running = startCli(command, root);
      const evidence = await waitForReady(running);
      expect(evidence).toMatchObject({ pid: running.child.pid, cwd: root, port: 5173 });
      await stop(running, evidence.port);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each<PreviewCommand>([
    'dev',
    'serve',
    'preview',
  ])('%s binds an explicit positive port exactly', async (command) => {
    const root = await fixture();
    try {
      const port = await randomAvailablePort();
      const running = startCli(command, root, port);
      const evidence = await waitForReady(running);
      expect(evidence).toMatchObject({ pid: running.child.pid, cwd: root, port });
      await stop(running, port);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each<PreviewCommand>([
    'dev',
    'serve',
    'preview',
  ])('%s treats explicit zero as the only random-port request', async (command) => {
    const root = await fixture();
    try {
      const running = startCli(command, root, 0);
      const evidence = await waitForReady(running);
      expect(evidence.pid).toBe(running.child.pid);
      expect(evidence.cwd).toBe(root);
      expect(evidence.port).toBeGreaterThan(0);
      expect(evidence.port).not.toBe(5173);
      await stop(running, evidence.port);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each<PreviewCommand>([
    'dev',
    'serve',
    'preview',
  ])('%s fails a second explicit listener and reuses the exact port after cleanup', async (command) => {
    const root = await fixture();
    const port = await randomAvailablePort();
    try {
      const first = startCli(command, root, port);
      const firstEvidence = await waitForReady(first);
      const second = startCli(command, root, port);
      const secondExit = await waitForExit(second);
      if (secondExit === undefined) await stop(second);
      await stop(first, firstEvidence.port);

      const released = startCli(command, root, port);
      const releasedEvidence = await waitForReady(released);
      await stop(released, releasedEvidence.port);

      expect(firstEvidence).toMatchObject({ pid: first.child.pid, cwd: root, port });
      expect(secondExit).not.toBeUndefined();
      expect(secondExit).not.toBe(0);
      expect(releasedEvidence).toMatchObject({
        pid: released.child.pid,
        cwd: root,
        port,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
