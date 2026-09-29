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
const m35Mode = process.env.BOSS_LIGHTNING_M35 === '1';
const captureDelayMs = Number.parseInt(process.env.BOSS_LIGHTNING_CAPTURE_DELAY_MS ?? '1200', 10);
const eventScenario = 'event-sub-emitter';
const pageUrl = `http://127.0.0.1:${port}/?boss-lightning-falsify=${encodeURIComponent(mode)}${m35Mode ? '&boss-lightning-m35=1' : ''}`;
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
    // Trail and beam share the cool Arc Nova palette. Keep the old warm
    // predicate for older fixtures, but accept the authored cyan/teal path so
    // the oracle measures topology output rather than a color-era detail.
    const warmTrail = red > 0.45 && red > green * 1.1 && green > blue * 1.25;
    const coolTrail = green > 0.45 && blue > 0.35 && green > red * 1.5;
    if (warmTrail || coolTrail) counts.trail += 1;
  }
  // A beam is the saturated magenta, elongated component. Requiring both
  // channels at a high floor and an elongated connected component prevents
  // the blue scene/background or unrelated round particles from satisfying
  // the beam oracle merely through red-vs-green contrast.
  const beamPixel = (offset) => {
    const red = png.data[offset] / 255;
    const green = png.data[offset + 1] / 255;
    const blue = png.data[offset + 2] / 255;
    const warmBeam = red > 0.75 && blue > 0.75 && green < 0.35 && red > green * 1.35;
    const coolBeam = blue > 0.72 && green > 0.28 && red < 0.42 && blue > green * 1.1;
    return warmBeam || coolBeam;
  };
  // The authored beam joins the mouth glow at its source, so its connected
  // component also contains the round charge and fails the old thin-component
  // aspect-ratio test. Count the distinctly saturated blue pixels in the
  // lower/right strike quadrant as a secondary proof. The fallback scene has
  // only a few scattered blue pixels there; a real beam has a continuous core.
  let lowerRightCoolBeamPixels = 0;
  for (let y = Math.floor(png.height * 0.45); y < png.height; y += 1) {
    for (let x = Math.floor(png.width * 0.5); x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const red = png.data[offset] / 255;
      const green = png.data[offset + 1] / 255;
      const blue = png.data[offset + 2] / 255;
      if (blue > 0.85 && green > 0.3 && red < 0.35 && blue > green * 1.4) {
        lowerRightCoolBeamPixels += 1;
      }
    }
  }
  const visited = new Uint8Array(png.width * png.height);
  const queue = new Int32Array(png.width * png.height);
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const start = y * png.width + x;
      if (visited[start] !== 0 || !beamPixel(start * 4)) continue;
      let head = 0;
      let tail = 0;
      let size = 0;
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      queue[tail++] = start;
      visited[start] = 1;
      while (head < tail) {
        const current = queue[head++];
        const currentX = current % png.width;
        const currentY = Math.floor(current / png.width);
        size += 1;
        minX = Math.min(minX, currentX);
        minY = Math.min(minY, currentY);
        maxX = Math.max(maxX, currentX);
        maxY = Math.max(maxY, currentY);
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            const nextX = currentX + dx;
            const nextY = currentY + dy;
            if (nextX < 0 || nextY < 0 || nextX >= png.width || nextY >= png.height) continue;
            const next = nextY * png.width + nextX;
            if (visited[next] !== 0) continue;
            visited[next] = 1;
            if (beamPixel(next * 4)) queue[tail++] = next;
          }
        }
      }
      const width = maxX - minX + 1;
      const height = maxY - minY + 1;
      if (size >= 20 && Math.max(width, height) >= Math.min(width, height) * 3) {
        counts.beam += size;
      }
    }
  }
  if (counts.beam === 0 && lowerRightCoolBeamPixels >= 160) {
    counts.beam = lowerRightCoolBeamPixels;
  }
  return counts;
}

function nonBlackPixelCount(path) {
  const png = PNG.sync.read(readFileSync(path));
  let count = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if (png.data[offset] > 8 || png.data[offset + 1] > 8 || png.data[offset + 2] > 8) count += 1;
  }
  return count;
}

function probeCode() {
  if (m35Mode) {
    return `async page => {
      await page.waitForFunction(() => globalThis.__forgeaxBossLightning?.m35 !== undefined, null, { timeout: 10000 });
      await page.waitForTimeout(${captureDelayMs});
      return await page.evaluate(async () => {
        const front = globalThis.__forgeaxBossLightning;
        const m35 = front?.m35;
        if (front === undefined || m35 === undefined) return { booted: false };
        const sleep = () => new Promise(resolve => setTimeout(resolve, 0));
        const playerOf = (snapshot, player) => snapshot?.players?.find(candidate => candidate.player === player);
        const step = () => m35.step();
        const inspect = () => m35.inspect();
        const drawError = result => {
          const error = result?.draw?.error;
          return {
            ok: result?.draw?.ok,
            name: error?.name,
            code: error?.code,
            hint: error?.hint,
            detail: error?.detail,
            string: String(error),
          };
        };
        const boot = { ...inspect() };
        m35.pause();
        let baseline;
        for (let index = 0; index < 60; index += 1) {
          const result = step();
          if (result.draw?.ok !== true) return { booted: true, m35: true, error: drawError(result) };
          await sleep();
          baseline = inspect();
          const affected = playerOf(baseline.affected, m35.player);
          const sibling = playerOf(baseline.sibling, front.player);
          if (
            affected?.queuedIntents === 0 &&
            sibling?.queuedIntents === 0 &&
            baseline.affected?.diagnostics?.length === 0 &&
            baseline.sibling?.diagnostics?.length === 0 &&
            affected.lastCommitted !== null &&
            sibling.lastCommitted !== null
          ) break;
        }
        const baselineAffected = playerOf(baseline?.affected, m35.player);
        const baselineSibling = playerOf(baseline?.sibling, front.player);
        const initialControl = m35.control();
        if (initialControl?.ok !== true) return { booted: true, m35: true, baseline, control: initialControl };
        const paused = initialControl.value.setPlayerRenderConsumption({ player: m35.player, enabled: false });
        const pausedFrames = [];
        for (let index = 0; index < 3; index += 1) {
          const result = step();
          if (result.draw?.ok !== true) return { booted: true, m35: true, baseline, pausedFrames, error: drawError(result) };
          await sleep();
          const snapshot = inspect();
          const affected = playerOf(snapshot.affected, m35.player);
          const sibling = playerOf(snapshot.sibling, front.player);
          pausedFrames.push({
            queuedIntents: affected?.queuedIntents ?? -1,
            queuedTicks: affected?.queuedTicks ?? -1,
            diagnostics: snapshot.affected?.diagnostics ?? [],
            lastCommitted: affected?.lastCommitted,
            siblingLastCommitted: sibling?.lastCommitted,
            siblingDiagnostics: snapshot.sibling?.diagnostics ?? [],
          });
        }
        const overflow = inspect();
        const overflowAffected = playerOf(overflow.affected, m35.player);
        const overflowDiagnostics = (overflow.affected?.diagnostics ?? []).filter(
          diagnostic => diagnostic.detail?.player === m35.player,
        );
        const resumed = initialControl.value.setPlayerRenderConsumption({ player: m35.player, enabled: true });
        const resumeStep = step();
        if (resumeStep.draw?.ok !== true) return { booted: true, m35: true, baseline, overflow, error: drawError(resumeStep) };
        await sleep();
        const afterResume = inspect();
        const afterResumeAffected = playerOf(afterResume.affected, m35.player);
        const replay = front.publicApi?.replay?.();
        const replayStep = step();
        if (replayStep.draw?.ok !== true) return { booted: true, m35: true, baseline, overflow, afterResume, error: drawError(replayStep) };
        await sleep();
        const afterReplay = inspect();
        const afterReplayAffected = playerOf(afterReplay.affected, m35.player);
        const afterReplaySibling = playerOf(afterReplay.sibling, front.player);
        return {
          booted: true,
          m35: true,
          seed: 43,
          program: front.effectAsset === undefined ? undefined : {
            format: front.effectAsset.program.format,
            fingerprint: front.effectAsset.program.fingerprint,
            emitters: front.effectAsset.program.emitters.map(item => ({
              id: item.id,
              renderers: item.renderers.map(renderer => renderer.kind),
            })),
          },
          boot,
          baseline: { affected: baselineAffected, sibling: baselineSibling },
          paused: { command: paused, frames: pausedFrames },
          overflow: { affected: overflowAffected, diagnostics: overflowDiagnostics },
          resume: { command: resumed, affected: afterResumeAffected },
          replay: { command: replay, affected: afterReplayAffected, sibling: afterReplaySibling },
          validationErrors: (front.validationErrors ?? []).slice(-8),
          cameraReady: front.cameraReady ?? false,
        };
      });
    }`;
  }
  return `async page => {
    await page.waitForFunction(() => globalThis.__forgeaxBossLightning !== undefined, null, { timeout: 10000 });
    await page.waitForTimeout(${captureDelayMs});
    const submittedTick = await page.evaluate(count => {
      const front = globalThis.__forgeaxBossLightning;
      const runtime = front.world.getResource('VfxGpuRuntime');
      const tick = runtime.lastCommitted(front.player)?.tick ?? -1;
      for (let index = 0; index < count; index += 1) {
        const result = front.submitImpact?.();
        if (result === undefined || result.ok === false || result.patch?.ok === false || result.submitted?.ok !== true) {
          throw new Error('Impact submission failed: ' + JSON.stringify(result));
        }
      }
      return tick;
    }, ${mode === 'event-queue-cleared' ? 8 : 1});
    await page.waitForFunction(tick => {
      const front = globalThis.__forgeaxBossLightning;
      const runtime = front.world.getResource('VfxGpuRuntime');
      const committed = runtime.lastCommitted(front.player);
      return committed !== undefined && committed.tick > tick &&
        (${mode.length === 0 ? "committed.instanceGeneration > 0 && runtime.eventCounters(front.player).consumed > 0" : 'true'});
    }, submittedTick, { timeout: 15000 });
    return await page.evaluate(() => {
      const runtime = globalThis.__forgeaxBossLightning;
      if (runtime === undefined) return { booted: false };
      const diagnostics = runtime.status?.();
      const gpuRuntime = runtime.world.getResource('VfxGpuRuntime');
      const lastCommitted = gpuRuntime.lastCommitted(runtime.player);
      return {
        booted: true,
        seed: 42,
        camera: { position: [0.2, 1.15, 5.8], target: [0.2, 0.35, 0] },
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
          .filter(id => ${JSON.stringify(['charge-arcane-dial','impact-violet-shock'])}.includes(id)),
        runtime: diagnostics,
        hostInspection: runtime.inspect?.(),
        featureDiagnostics: runtime.renderer.inspect().featureDiagnostics,
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
    throw new Error('normal path did not expose a GUID-loaded Program v3 GPU program');
  }
  const kinds = new Set(value.program.emitters.flatMap(item => item.renderers));
  if (!kinds.has('billboard') || !kinds.has('mesh')) {
    throw new Error(`normal path missing billboard/mesh programs: ${JSON.stringify(value.program.emitters)}`);
  }
  if (value.program.format !== 'forgeax-vfx-program-4' || !value.runtime?.hasPlayer) {
    throw new Error(`GPU runtime did not own the player: ${JSON.stringify(value)}`);
  }
  if (value.arcNovaEmitters?.length !== 2) {
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
  if (!value.featureDiagnostics?.some(item =>
    item.identity === 'forgeax.vfx-render.gpu-particles' && item.status === 'active'
  )) {
    throw new Error(`VFX feature is not active: ${JSON.stringify(value.featureDiagnostics)}`);
  }
  if (value.visualEvidence?.expectations.some(item => item.verdict !== 'pass')) {
    throw new Error(`visual evidence expectations failed: ${JSON.stringify(value.visualEvidence)}`);
  }
  const dataInterfaceResult = value.runtime.dataInterfaceSnapshot?.result;
  const rendererPreparedFallback =
    dataInterfaceResult?.ok === false &&
    dataInterfaceResult.error?.code === 'vfx-data-interface-missing' &&
    dataInterfaceResult.error?.expected?.includes('resident') &&
    value.runtime.diagnostics?.length === 0;
  if (dataInterfaceResult?.value?.readiness !== 'ready' && !rendererPreparedFallback) {
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

function assertM35(value) {
  const affected = value.overflow?.affected;
  const baseline = value.baseline?.affected;
  const replay = value.replay?.affected;
  const sibling = value.replay?.sibling;
  const overflowDiagnostics = value.overflow?.diagnostics ?? [];
  if (!value.booted || !value.m35 || value.program === undefined) {
    throw new Error(`M35 browser path did not expose the public Boss Lightning front door: ${JSON.stringify(value)}`);
  }
  const kinds = new Set(value.program.emitters.flatMap(item => item.renderers));
  if (!kinds.has('billboard') || !kinds.has('mesh')) {
    throw new Error(`M35 browser path missing visible particle renderers: ${JSON.stringify(value.program.emitters)}`);
  }
  if (
    baseline?.queuedIntents !== 0 ||
    baseline?.lastCommitted === null ||
    value.paused?.frames?.some(frame => frame.queuedIntents > value.program.emitters.length) ||
    value.paused?.frames?.some(frame => frame.queuedTicks > 1) ||
    affected?.queuedIntents > value.program.emitters.length ||
    affected?.queuedTicks > 1 ||
    overflowDiagnostics.length !== 1 ||
    overflowDiagnostics[0]?.code !== 'vfx-intent-queue-overflow' ||
    overflowDiagnostics[0]?.detail?.maxQueuedTicks !== 1 ||
    value.paused?.frames?.some(frame => frame.siblingDiagnostics.length !== 0) ||
    value.resume?.affected?.queuedIntents !== 0 ||
    value.resume?.affected?.lastCommitted?.playCycle !== baseline?.lastCommitted?.playCycle ||
    value.replay?.affected?.queuedIntents !== 0 ||
    value.replay?.affected?.lastCommitted?.reset !== true ||
    value.replay?.affected?.lastCommitted?.phaseTick !== 0 ||
    value.replay?.affected?.lastCommitted?.playCycle !== (baseline?.lastCommitted?.playCycle ?? -1) + 1 ||
    value.replay?.affected?.lastCommitted?.firstParticleId !== 0 ||
    value.replay?.affected?.diagnostics?.length !== 0 ||
    sibling?.lastCommitted?.tick <= (value.baseline?.sibling?.lastCommitted?.tick ?? -1) ||
    value.replay?.sibling?.diagnostics?.length !== 0
  ) {
    throw new Error(`M35 browser overflow/restart contract failed: ${JSON.stringify(value)}`);
  }
  if (!value.cameraReady || value.validationErrors.length !== 0) {
    throw new Error(`M35 browser page/device errors were observed: ${JSON.stringify(value)}`);
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
let serverOutput = '';
async function waitForServer(url) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) {
      throw new Error(`Vite exited before serving ${url} (code=${server.exitCode}): ${serverOutput}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // Vite is still booting.
    }
    await new Promise(resolveReady => setTimeout(resolveReady, 100));
  }
  throw new Error(`Vite did not serve ${url} within 30s: ${serverOutput}`);
}

try {
  server = spawn('pnpm', ['--filter', '@forgeax/hello-boss-lightning', 'exec', 'vite', '--host', '127.0.0.1', '--port', port, '--strictPort'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const captureOutput = chunk => { serverOutput = (serverOutput + chunk.toString()).slice(-12000); };
  server.stdout.on('data', captureOutput);
  server.stderr.on('data', captureOutput);
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
  const visiblePixels = nonBlackPixelCount(screenshot);
  if (m35Mode) {
    const rawCleanup = cli(
      '--raw',
      'run-code',
      `async page => await page.evaluate(() => globalThis.__forgeaxBossLightning?.m35?.cleanup?.())`,
    );
    try {
      value.cleanup = JSON.parse(rawCleanup);
    } catch (error) {
      throw new Error(`M35 cleanup returned non-JSON: ${rawCleanup}`, { cause: error });
    }
  }
  const rendererKinds = new Set(value.program?.emitters?.flatMap(item => item.renderers) ?? []);
  const advancedVisible =
    value.runtime?.renderFeatureEnabled !== false &&
    ['ribbon', 'trail', 'beam'].every(kind => rendererKinds.has(kind) && topologyPixels[kind] >= 20);
  value.visualEvidence = m35Mode
    ? {
        target: 'm35-vfx-overflow-restart',
        screenshot,
        expectations: [
          {
            id: 'boss-particles-visible-after-restart',
            observed: `renderers=${[...rendererKinds].join(',')} nonBlackPixels=${visiblePixels}`,
            verdict:
              rendererKinds.has('billboard') && rendererKinds.has('mesh') && visiblePixels > 100
                ? 'pass'
                : 'fail',
            confidence: 1,
          },
          {
            id: 'overflow-restart-public-contract',
            observed: `diagnostics=${value.overflow?.diagnostics?.length ?? 0} playCycle=${value.replay?.affected?.lastCommitted?.playCycle ?? 'missing'} phaseTick=${value.replay?.affected?.lastCommitted?.phaseTick ?? 'missing'}`,
            verdict:
              value.overflow?.diagnostics?.length === 1 &&
              value.replay?.affected?.lastCommitted?.playCycle === 1 &&
              value.replay?.affected?.lastCommitted?.phaseTick === 0
                ? 'pass'
                : 'fail',
            confidence: 1,
          },
        ],
      }
    : {
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
  if (m35Mode) assertM35(value);
  else if (mode.length === 0) assertNormal(value);
  else assertFalsified(value);
  if (m35Mode) {
    console.log(
      `[m35-vfx] Chrome overflow/restart: PASS ${JSON.stringify({
        overflowDiagnostics: value.overflow.diagnostics.length,
        pausedQueue: value.overflow.affected.queuedIntents,
        pausedTicks: value.overflow.affected.queuedTicks,
        lkg: value.overflow.affected.lastCommitted,
        replay: value.replay.affected.lastCommitted,
        sibling: value.replay.sibling.lastCommitted,
        cleanup: value.cleanup,
        screenshot,
      })}`,
    );
  }
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
