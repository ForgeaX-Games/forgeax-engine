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

export async function startAuthority({ timeoutMs = 10_000, tickMs = 16 } = {}) {
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
      `setInterval(() => server.world.update(1 / 60), ${tickMs});\n` +
      `process.on('SIGTERM', () => { server.close(); process.exit(0); });\n` +
      `})();\n`,
  );
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = fork(entry, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, FORGEAX_AUTHORITY_PORT: String(port) },
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('authority ready timeout')), timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      const line = stdout.split('\n')[0];
      try {
        const record = JSON.parse(line);
        if (Number.isInteger(record.port) && record.port > 0) {
          clearTimeout(timer);
          settled = true;
          resolve(record);
        }
      } catch {
        // Wait for a complete JSON line.
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
    return { process: child, port: record.port, kill };
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
