import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(appRoot, '..', '..', '..');
const wrapperPath = 'skills/forgeax-visual/scripts/pwcli-wrapper.py';

function findHarnessRoot(start) {
  let directory = start;
  while (true) {
    for (const candidate of [resolve(directory, '.forgeax-harness'), resolve(directory, 'forgeax-harness')]) {
      if (existsSync(resolve(candidate, wrapperPath))) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

const explicitHarnessRoot = process.env.FORGEAX_HARNESS_ROOT;
const harnessRoot = explicitHarnessRoot !== undefined && existsSync(resolve(explicitHarnessRoot, wrapperPath))
  ? explicitHarnessRoot
  : findHarnessRoot(repoRoot);
if (harnessRoot === undefined) throw new Error('boss-lightning: forgeax-harness checkout not found');
const wrapper = resolve(harnessRoot, wrapperPath);
const session = `boss-lightning-${process.pid}`;
const port = process.env.BOSS_LIGHTNING_PORT ?? '5173';
const mode = process.env.BOSS_LIGHTNING_FALSIFY ?? '';
const pageUrl = `http://127.0.0.1:${port}/?boss-lightning-falsify=${encodeURIComponent(mode)}`;

function cli(...args) {
  const result = spawnSync('python3', [wrapper, `-s=${session}`, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`playwright-cli failed (${args.join(' ')}): ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function probeCode() {
  return `async page => {
    await page.waitForFunction(() => globalThis.__forgeaxBossLightning !== undefined, null, { timeout: 10000 });
    await page.waitForTimeout(1200);
    return await page.evaluate(() => {
      const runtime = globalThis.__forgeaxBossLightning;
      if (runtime === undefined) return { booted: false };
      const diagnostics = runtime.status?.();
      return {
        booted: true,
        seed: 42,
        camera: { position: [0, 1.35, 8.5], target: [0, 0.8, 0] },
        program: runtime.effectAsset === undefined ? undefined : {
          format: runtime.effectAsset.program.format,
          fingerprint: runtime.effectAsset.program.fingerprint,
          emitters: runtime.effectAsset.program.emitters.map(item => ({
            id: item.id,
            renderers: item.renderers.map(renderer => renderer.kind),
            entryPoints: item.reflection.entryPoints,
          })),
        },
        runtime: diagnostics,
        validationErrors: (runtime.validationErrors ?? []).slice(-8),
        readinessTransitions: runtime.readinessTransitions ?? [],
        cameraReady: runtime.cameraReady ?? false,
      };
    });
  }`;
}

function assertNormal(value) {
  if (!value.booted || value.program === undefined) {
    throw new Error('normal path did not expose a GUID-loaded v2 GPU program');
  }
  const kinds = new Set(value.program.emitters.flatMap(item => item.renderers));
  if (!kinds.has('billboard') || !kinds.has('mesh')) {
    throw new Error(`normal path missing billboard/mesh programs: ${JSON.stringify(value.program.emitters)}`);
  }
  if (value.program.format !== 'forgeax-vfx-program-2' || !value.runtime?.hasPlayer) {
    throw new Error(`GPU runtime did not own the player: ${JSON.stringify(value)}`);
  }
  if (!value.cameraReady || value.validationErrors.length !== 0) {
    throw new Error(`active camera or WebGPU validation contract failed: ${JSON.stringify(value)}`);
  }
  if (value.runtime.diagnostics.length !== 0) {
    throw new Error(`GPU runtime diagnostics are non-empty: ${JSON.stringify(value.runtime.diagnostics.slice(0, 4))}`);
  }
}

function assertFalsified(value) {
  if (mode === 'disable-vfx' && value.validationErrors.length !== 0) {
    throw new Error('disabled VFX produced renderer errors');
  }
  if ((mode === 'emitter-zero' || mode === 'material-empty') && !value.runtime?.hasPlayer) {
    throw new Error(`${mode} falsifier lost the explicit player state`);
  }
}

let server;
async function waitForServer(url) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Vite exited before serving ${url} (code=${server.exitCode})`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still booting.
    }
    await new Promise(resolveReady => setTimeout(resolveReady, 100));
  }
  throw new Error(`Vite did not serve ${url} within 30s`);
}

try {
  server = spawn('pnpm', ['--filter', '@forgeax/hello-boss-lightning', 'exec', 'vite', '--host', '127.0.0.1', '--port', port, '--strictPort'], {
    cwd: repoRoot,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  await waitForServer(pageUrl);
  cli('open', pageUrl);
  const value = JSON.parse(cli('--raw', 'run-code', probeCode()));
  if (mode.length === 0) assertNormal(value);
  else assertFalsified(value);
  console.log(`[smoke-browser] PASS mode=${mode || 'normal'} seed=42 frame=${value.camera?.frame ?? 0} ${JSON.stringify(value)}`);
} catch (error) {
  console.error(`[smoke-browser] FAIL mode=${mode || 'normal'} ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  try {
    cli('close');
  } catch {
    // A failed browser launch has no session to close.
  }
  if (server !== undefined && server.exitCode === null) {
    if (process.platform === 'win32') server.kill('SIGTERM');
    else {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        server.kill('SIGTERM');
      }
    }
  }
}
