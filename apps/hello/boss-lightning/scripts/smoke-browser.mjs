import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

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
const captureDelayMs = Number.parseInt(process.env.BOSS_LIGHTNING_CAPTURE_DELAY_MS ?? '1200', 10);
const eventScenario = 'event-sub-emitter';
const pageUrl = `http://127.0.0.1:${port}/?boss-lightning-falsify=${encodeURIComponent(mode)}`;
const visualExpectationIds = [
  'advanced-renderers-visible',
  'live-patch-continuity',
  'event-sub-emitter-visible',
  'hmr-last-known-good-visible',
];

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

function topologyPixelEvidence(path) {
  const png = PNG.sync.read(readFileSync(path));
  const counts = { ribbon: 0, trail: 0, beam: 0 };
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const red = png.data[offset] / 255;
    const green = png.data[offset + 1] / 255;
    const blue = png.data[offset + 2] / 255;
    if (blue > 0.45 && green > red * 1.35) counts.ribbon += 1;
    if (red > 0.45 && red > green * 1.1 && green > blue * 1.25) counts.trail += 1;
    if (blue > 0.45 && red > green * 1.35 && blue > green * 1.35) counts.beam += 1;
  }
  return counts;
}

function probeCode() {
  return `async page => {
    await page.waitForFunction(() => globalThis.__forgeaxBossLightning !== undefined, null, { timeout: 10000 });
    await page.waitForTimeout(${captureDelayMs});
    await page.evaluate(count => {
      for (let index = 0; index < count; index += 1) {
        globalThis.__forgeaxBossLightning?.submitImpact?.();
      }
    }, ${mode === 'event-queue-cleared' ? 8 : 1});
    await page.waitForTimeout(100);
    return await page.evaluate(() => {
      const runtime = globalThis.__forgeaxBossLightning;
      if (runtime === undefined) return { booted: false };
      const diagnostics = runtime.status?.();
      const gpuRuntime = runtime.world.getResource('VfxGpuRuntime');
      const lastCommitted = gpuRuntime.lastCommitted(runtime.player);
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
        arcNovaEmitters: runtime.effectAsset?.program.emitters
          .map(item => item.id)
          .filter(id => ${JSON.stringify(['charge-arcane-dial','charge-hex-seal','charge-prismatic-crown','release-axis-lance','release-radial-blades','impact-violet-shock','impact-cross-crown','decay-ember-facets'])}.includes(id)),
        runtime: diagnostics,
        eventScenario: ${JSON.stringify(eventScenario)},
        gpuLocal: diagnostics?.gpuLocalEvents === true,
        eventCounters: diagnostics?.eventCounters,
        queueCleared: diagnostics?.eventQueueCleared === true,
        recursionDepth: diagnostics?.eventCounters?.recursionDepth ?? 0,
        lastCommitted: lastCommitted === undefined ? undefined : {
          tick: lastCommitted.tick,
          generation: lastCommitted.instanceGeneration,
          patchCount: lastCommitted.instancePatchCount,
          canonicalPayload: [...lastCommitted.canonicalPayload],
          replay: {
            seed: lastCommitted.replayInput.seed,
            tick: lastCommitted.replayInput.tick,
            generation: lastCommitted.replayInput.generation,
            sequence: lastCommitted.replayInput.sequence,
            payload: [...lastCommitted.replayInput.payload],
          },
        },
        validationErrors: (runtime.validationErrors ?? []).slice(-8),
        readinessTransitions: runtime.readinessTransitions ?? [],
        cameraReady: runtime.cameraReady ?? false,
        stageReadiness: diagnostics?.stageReadiness ?? [],
        stageOutput: diagnostics?.stageOutput ?? 'empty',
        stageDependencies: diagnostics?.stageDependencies ?? [],
        stageDispatch: diagnostics?.stageDispatch ?? [],
        lastKnownGoodStage: diagnostics?.lastKnownGoodStage,
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
  if (value.arcNovaEmitters?.length !== 8) {
    throw new Error(`Arc Nova emitters are not in the managed GPU program: ${JSON.stringify(value.arcNovaEmitters)}`);
  }
  if (
    value.lastCommitted === undefined ||
    value.lastCommitted.generation !== value.lastCommitted.replay.generation ||
    JSON.stringify(value.lastCommitted.canonicalPayload) !==
      JSON.stringify(value.lastCommitted.replay.payload)
  ) {
    throw new Error(`fixed-tick replay record is not canonical: ${JSON.stringify(value)}`);
  }
  if (!value.cameraReady || value.validationErrors.length !== 0) {
    throw new Error(`active camera or WebGPU validation contract failed: ${JSON.stringify(value)}`);
  }
  if (value.visualEvidence?.expectations.some(item => item.verdict !== 'pass')) {
    throw new Error(`visual evidence expectations failed: ${JSON.stringify(value.visualEvidence)}`);
  }
  if (value.runtime.dataInterfaceSnapshot?.result?.value?.readiness !== 'ready') {
    throw new Error(`Data Interface providers were not ready: ${JSON.stringify(value.runtime)}`);
  }
  if (
    value.stageOutput !== 'active' ||
    !value.stageReadiness.some(item => item.id === 'turbulence' && item.state === 'ready') ||
    value.stageDispatch.length === 0 ||
    value.stageDependencies.length === 0 ||
    value.lastKnownGoodStage === undefined
  ) {
    throw new Error(`managed turbulence stage did not produce readiness/dispatch evidence: ${JSON.stringify(value)}`);
  }
  if (
    value.eventCounters?.fanOut !== 2 ||
    value.eventCounters?.recursionDepth !== 1 ||
    value.eventCounters?.consumed < 1
  ) {
    throw new Error(`GPU event bounds were not observed: ${JSON.stringify(value.eventCounters)}`);
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
  if (
    mode === 'missing-depth' &&
    value.runtime?.dataInterfaceSnapshot?.result?.error?.code !== 'vfx-data-interface-missing'
  ) {
    throw new Error(`missing-depth falsifier did not expose a structured provider error: ${JSON.stringify(value.runtime)}`);
  }
  if (mode === 'event-queue-cleared') {
    if (!value.queueCleared || value.eventCounters?.dropped < 1 || value.eventCounters?.overflow < 1) {
      throw new Error(`event queue falsifier did not prove bounded drop and clear: ${JSON.stringify(value)}`);
    }
  }
  if (mode === 'recursion-depth') {
    if (value.recursionDepth < 1 || value.recursionDepth > 1 || value.eventCounters?.fanOut !== 2) {
      throw new Error(`recursion depth falsifier escaped the reflected bound: ${JSON.stringify(value)}`);
    }
  }
  if (mode === 'stage-cycle' || mode === 'stage-hazard' || mode === 'stage-budget') {
    if (
      value.stageOutput !== 'last-known-good' ||
      !value.stageReadiness.some(item => item.state === 'candidate-rejected' && item.retryable) ||
      value.lastKnownGoodStage === undefined
    ) {
      throw new Error(`stage falsifier did not retain generation-scoped LKG: ${JSON.stringify(value)}`);
    }
  }
  if (
    mode === 'billboard-fallback' &&
    value.visualEvidence?.expectations.find(item => item.id === 'advanced-renderers-visible')?.verdict === 'pass'
  ) {
    throw new Error('billboard fallback falsifier did not change the advanced topology oracle');
  }
  if (
    mode === 'freeze-generation' &&
    value.visualEvidence?.expectations.find(item => item.id === 'live-patch-continuity')?.verdict === 'pass'
  ) {
    throw new Error('frozen generation falsifier did not change the live patch oracle');
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
  const rawProbe = cli('--raw', 'run-code', probeCode());
  let value;
  try {
    value = JSON.parse(rawProbe);
  } catch (error) {
    throw new Error(`browser probe returned non-JSON: ${rawProbe}`, { cause: error });
  }
  const screenshot = process.env.BOSS_LIGHTNING_SCREENSHOT ?? `/tmp/batch-b-vfx-${process.pid}.png`;
  cli('screenshot', '--filename', screenshot);
  const topologyPixels = topologyPixelEvidence(screenshot);
  const rendererKinds = new Set(value.program?.emitters?.flatMap(item => item.renderers) ?? []);
  const advancedVisible =
    value.runtime?.renderFeatureEnabled !== false &&
    ['ribbon', 'trail', 'beam'].every(kind => rendererKinds.has(kind) && topologyPixels[kind] >= 20);
  value.visualEvidence = {
    target: 'batch-b-vfx-showcase',
    screenshot,
    expectations: visualExpectationIds.map(id => ({
      id,
      observed:
        id === 'advanced-renderers-visible'
          ? `renderers=${[...rendererKinds].join(',')} pixels=${JSON.stringify(topologyPixels)}`
          : id === 'live-patch-continuity'
            ? `generation=${value.lastCommitted?.generation ?? 'missing'} patchCount=${value.lastCommitted?.patchCount ?? 0}`
            : id === 'event-sub-emitter-visible'
              ? `consumed=${value.eventCounters?.consumed ?? 0} fanOut=${value.eventCounters?.fanOut ?? 0}`
              : `stage=${value.stageOutput ?? 'missing'} lkg=${value.lastKnownGoodStage !== undefined}`,
      verdict:
        id === 'advanced-renderers-visible'
          ? advancedVisible ? 'pass' : 'fail'
          : id === 'live-patch-continuity'
            ? value.lastCommitted?.generation > 0 ? 'pass' : 'fail'
            : id === 'event-sub-emitter-visible'
              ? value.eventCounters?.consumed > 0 ? 'pass' : 'fail'
              : value.lastKnownGoodStage !== undefined ? 'pass' : 'fail',
      confidence: 1,
    })),
  };
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
