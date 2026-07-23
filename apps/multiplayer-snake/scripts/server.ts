import { startServer } from '../src/server.ts';

const requestedPort = Number(process.env.FORGEAX_SNAKE_PORT ?? 8787);
if (!Number.isInteger(requestedPort) || requestedPort <= 0 || requestedPort > 65_535)
  throw new Error('FORGEAX_SNAKE_PORT must be an integer between 1 and 65535');

const server = await startServer(requestedPort);
console.log(`Snake authority listening on ws://localhost:${server.port}`);

let stopping = false;
let tickTimer: ReturnType<typeof setInterval> | undefined;
const stop = (exitCode = 0): void => {
  if (stopping) return;
  stopping = true;
  if (tickTimer !== undefined) clearInterval(tickTimer);
  const closed = server.close();
  if (!closed.ok) console.error(`${closed.error.code}: ${closed.error.hint}`);
  process.exit(closed.ok ? exitCode : 1);
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
tickTimer = setInterval(() => {
  const updated = server.world.update(1 / 60);
  if (!updated.ok) {
    console.error(`${updated.error.code}: ${updated.error.hint}`);
    stop(1);
  }
}, 1000 / 60);
await new Promise<void>(() => {});
