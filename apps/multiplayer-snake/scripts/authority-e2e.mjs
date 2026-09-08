import { build } from 'esbuild';
import { fork } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function createAuthorityBundle(directory) {
  const outfile = join(directory, 'authority.cjs');
  await build({
    absWorkingDir: root,
    entryPoints: ['src/server.ts'],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    packages: 'bundle',
    sourcemap: false,
    logLevel: 'silent',
  });
  return outfile;
}

export async function startAuthority({ timeoutMs = 10_000, tickMs = 16, observablePeerChangeDelayMs = 0 } = {}) {
  const directory = await mkdtemp(join(dirname(root), '.authority-'));
  const bundle = await createAuthorityBundle(directory);
  const entry = join(directory, 'entry.cjs');
  await writeFile(
    entry,
    `const { startServer } = require(${JSON.stringify(bundle)});\n` +
      `(async () => {\n` +
      `const port = Number(process.env.FORGEAX_AUTHORITY_PORT || 0);\n` +
      `const server = await startServer(port);\n` +
      `process.stdout.write(JSON.stringify({ port: server.port }) + '\\n');\n` +
      `const session = server.world.getResource('net-session');\n` +
      `let previousObservation = '';\n` +
      `let previousPeerCount = -1;\n` +
      `let publishBlockedUntil = 0;\n` +
      `let heldAfterFirstPublication = false;\n` +
      `const writeObservation = () => {\n` +
      `  const recovery = session.getRecoverySnapshot();\n` +
      `  const observation = JSON.stringify({\n` +
      `    kind: 'authority-net-session',\n` +
      `    state: recovery.state.kind,\n` +
      `    sessionId: recovery.sessionId,\n` +
      `    epoch: recovery.epoch,\n` +
      `    sequence: recovery.sequence,\n` +
      `    acknowledgedSequence: recovery.acknowledgedSequence,\n` +
      `    pendingPackets: recovery.pendingPackets,\n` +
`    ownedResources: recovery.ownedResources,\n` +
`    peerIds: session.getPeerSnapshot().peerIds,\n` +
`    game: {\n` +
`      tick: server.game.tick,\n` +
`      started: server.game.started,\n` +
`      gameplayTick: server.game.gameplayTick,\n` +
`      snakes: [...server.game.snakes.values()].map((snake) => ({ sessionId: snake.sessionId, cells: snake.cells.length })),\n` +
`    },\n` +
`  });\n` +
      `  if (observation !== previousObservation) {\n` +
      `    previousObservation = observation;\n` +
      `    process.stdout.write(observation + '\\n');\n` +
      `  }\n` +
      `};\n` +
      `const interval = setInterval(() => {\n` +
      `  writeObservation();\n` +
      `  session.receiveEvents();\n` +
      `  writeObservation();\n` +
      `  const peerCount = session.getPeerSnapshot().peerIds.length;\n` +
      `  if (peerCount !== previousPeerCount) {\n` +
      `    previousPeerCount = peerCount;\n` +
      `    publishBlockedUntil = Date.now() + ${JSON.stringify(observablePeerChangeDelayMs)};\n` +
      `    heldAfterFirstPublication = false;\n` +
      `  }\n` +
      `  if (Date.now() < publishBlockedUntil) return;\n` +
      `  if (session.getRecoverySnapshot().pendingPackets > 0) {\n` +
      `    writeObservation();\n` +
      `    return;\n` +
      `  }\n` +
      `  const updated = server.world.update(1 / 60);\n` +
      `  if (!updated.ok) {\n` +
      `    process.stdout.write(JSON.stringify({ kind: 'authority-world-update-failed', error: updated.error }) + '\\n');\n` +
      `    return;\n` +
      `  }\n` +
      `  if (!heldAfterFirstPublication) {\n` +
      `    heldAfterFirstPublication = true;\n` +
      `    publishBlockedUntil = Date.now() + ${JSON.stringify(observablePeerChangeDelayMs)};\n` +
      `  }\n` +
      `  session.receiveEvents();\n` +
      `  writeObservation();\n` +
      `}, ${tickMs});\n` +
      `process.on('SIGTERM', () => { clearInterval(interval); server.close(); process.exit(0); });\n` +
      `})();\n`,
  );
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = fork(entry, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, FORGEAX_AUTHORITY_PORT: String(port) },
  });
  let stdout = '';
  let stderr = '';
  const observations = [];
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('authority ready timeout')), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length === 0) continue;
        try {
          const record = JSON.parse(line);
          if (!settled && Number.isInteger(record.port) && record.port > 0) {
            clearTimeout(timer);
            settled = true;
            resolve(record);
          } else if (settled) observations.push(record);
        } catch {
          // Wait for a complete JSON line.
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      if (!settled) { clearTimeout(timer); reject(error); }
    });
    child.once('exit', (code) => {
      if (!settled) { clearTimeout(timer); reject(new Error(`authority exited (${code}): ${stderr}`)); }
    });
  });
  try {
    const record = await ready;
    const kill = async () => stopAuthority(child, { directory });
    return {
      process: child,
      port: record.port,
      kill,
      observations: () => [...observations],
    };
  } catch (error) {
    await stopAuthority(child, { directory });
    throw error;
  }
}

export async function stopAuthority(proc, { directory, timeoutMs = 3_000 } = {}) {
  if (proc.exitCode === null) proc.kill('SIGTERM');
  if (proc.exitCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, timeoutMs);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
}
