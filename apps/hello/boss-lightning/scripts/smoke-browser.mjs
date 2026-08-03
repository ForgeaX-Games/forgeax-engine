import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(appRoot, '..', '..', '..');
const harnessRoot = [
  resolve(repoRoot, '..', 'forgeax-harness'),
  resolve(repoRoot, '..', '..', '..', 'forgeax-harness'),
  resolve(repoRoot, '..', '..', 'forgeax-harness'),
].find(candidate => existsSync(candidate));
if (harnessRoot === undefined) throw new Error('boss-lightning: forgeax-harness checkout not found');
const wrapper = resolve(harnessRoot, 'skills/forgeax-visual/scripts/pwcli-wrapper.py');
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
      const simulation = runtime.world.getResource('ParticleSimulation');
      const observation = simulation?.read(runtime.player);
      const batches = observation?.batches?.batches ?? [];
      const diagnostics = runtime.status?.();
      return {
        booted: true,
        seed: 42,
        camera: { position: [0, 1.2, 7.5], target: [0, 0.8, 0], frame: observation?.tick ?? 0 },
        observation: observation === undefined ? undefined : {
          tick: observation.tick,
          emitters: observation.emitters.map(item => ({ id: item.emitterId, status: item.status, liveCount: item.liveCount })),
          batches: batches.map(item => ({ kind: item.kind, count: item.count })),
          diagnostics: observation.diagnostics.map(item => item.code),
        },
        render: diagnostics === undefined ? undefined : {
          readiness: diagnostics.readiness,
          bucketCount: diagnostics.bucketCount,
          error: diagnostics.error?.code,
        },
        validationErrors: runtime.validationErrors ?? [],
        readinessTransitions: runtime.readinessTransitions ?? [],
        cameraReady: runtime.cameraReady ?? false,
      };
    });
  }`;
}

function assertNormal(value) {
  if (!value.booted || value.observation === undefined) {
    throw new Error('normal path did not expose a GUID-loaded particle observation');
  }
  const kinds = new Set(value.observation.batches.filter(item => item.count > 0).map(item => item.kind));
  if (!kinds.has('billboard') || !kinds.has('mesh')) {
    throw new Error(`normal path missing billboard/mesh buckets: ${JSON.stringify(value.observation.batches)}`);
  }
  if (value.render?.readiness !== 'ready' || value.render.bucketCount < 2) {
    throw new Error(`particle render did not become ready: ${JSON.stringify(value.render)}`);
  }
  if (!value.cameraReady || value.validationErrors.length !== 0) {
    throw new Error(`active camera or WebGPU validation contract failed: ${JSON.stringify(value)}`);
  }
}

function assertFalsified(value) {
  const batches = value.observation?.batches ?? [];
  const hasBillboard = batches.some(item => item.kind === 'billboard' && item.count > 0);
  const hasMesh = batches.some(item => item.kind === 'mesh' && item.count > 0);
  if (mode === 'disable-billboard' && (!hasMesh || hasBillboard)) {
    throw new Error('billboard falsifier did not remove billboard contribution');
  }
  if (mode === 'disable-vfx' && (hasBillboard || hasMesh)) {
    throw new Error('VFX falsifier still exposed particle batches');
  }
  if ((mode === 'emitter-zero' || mode === 'material-empty') && (hasBillboard || hasMesh)) {
    throw new Error(`${mode} falsifier still exposed particle batches`);
  }
}

let server;
try {
  server = spawn('pnpm', ['--filter', '@forgeax/hello-boss-lightning', 'exec', 'vite', '--host', '127.0.0.1', '--port', port], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  await new Promise(resolveReady => setTimeout(resolveReady, 1800));
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
  server?.kill('SIGTERM');
}
