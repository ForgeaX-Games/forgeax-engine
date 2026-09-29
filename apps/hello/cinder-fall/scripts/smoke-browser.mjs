#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import UPNG from 'upng-js';

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
const harnessRoot = process.env.FORGEAX_HARNESS_ROOT ?? findHarnessRoot(repoRoot);
if (harnessRoot === undefined) throw new Error('cinder-fall: forgeax-harness checkout not found');
const wrapper = resolve(harnessRoot, wrapperPath);
const port = process.env.CINDER_FALL_PORT ?? '5188';
const url = `http://127.0.0.1:${port}/`;
const session = `cinder-fall-${process.pid}`;
let server;
function cli(...args) {
  const result = spawnSync('python3', [wrapper, `-s=${session}`, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`playwright-cli failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function particleEvidence(path) {
  const bytes = readFileSync(path);
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const decoded = UPNG.decode(input);
  const rgba = new Uint8Array(UPNG.toRGBA8(decoded)[0]);
  const left = Math.floor(decoded.width * 0.12);
  const right = Math.ceil(decoded.width * 0.88);
  const top = Math.floor(decoded.height * 0.04);
  // The platform occupies the lower third of the frame. Keeping the region
  // above its top edge makes a colored platform unable to satisfy the oracle.
  // The impact and burn footprint intentionally resolve on the lower platform
  // band. Keep the oracle wide enough to cover the authored landing point
  // without admitting the empty lower page margin.
  const bottom = Math.floor(decoded.height * 0.90);
  let colored = 0;
  let orange = 0;
  let minX = right;
  let minY = bottom;
  let maxX = left;
  let maxY = top;
  let sumX = 0;
  let sumY = 0;
  let signature = 2166136261;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * decoded.width + x) * 4;
      const red = rgba[offset];
      const green = rgba[offset + 1];
      const blue = rgba[offset + 2];
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const chroma = maximum - minimum;
      // White/near-white canvas pixels have no chroma. Quantization keeps the
      // phase signature stable across browser readback while retaining motion.
      if (chroma > 22 && maximum < 250) {
        colored += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        sumX += x;
        sumY += y;
        if (red > 150 && green > 20 && green < red && blue < green * 0.9) orange += 1;
      }
      if ((x & 3) === 0 && (y & 3) === 0) {
        signature ^= ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
        signature = Math.imul(signature, 16777619) >>> 0;
      }
    }
  }
  return {
    width: decoded.width,
    height: decoded.height,
    region: { left, right, top, bottom },
    colored,
    orange,
    centroid: colored === 0 ? undefined : [sumX / colored, sumY / colored],
    bounds: colored === 0 ? undefined : { left: minX, right: maxX, top: minY, bottom: maxY },
    signature: signature.toString(16),
  };
}
async function waitForServer() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`Vite exited (${server.exitCode})`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('cinder-fall: Vite did not start within 30s');
}
try {
  server = spawn('pnpm', ['--filter', '@forgeax/hello-cinder-fall', 'exec', 'vite', '--host', '127.0.0.1', '--port', port, '--strictPort'], {
    cwd: repoRoot,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  await waitForServer();
  cli('open', url);
  const checkpointPrefix = `/tmp/cinder-fall-${process.pid}-checkpoint`;
  const raw = cli('--raw', 'run-code', `async page => {
    await page.waitForFunction(() => globalThis.__forgeaxCinderFall !== undefined, null, { timeout: 15000 });
    const prefix = ${JSON.stringify(checkpointPrefix)};
    const checkpoints = [
      { id: 'release', frames: 1 },
      { id: 'mid-travel', frames: 45 },
      { id: 'impact', frames: 92 },
      { id: 'impact-plus-0.35', frames: 112 },
      { id: 'burn-plus-2', frames: 212 },
    ];
    await page.evaluate(() => globalThis.__forgeaxCinderFall?.app?.pause?.());
    const observations = [];
    for (const checkpoint of checkpoints) {
      const replay = await page.evaluate(() => globalThis.__forgeaxCinderFall?.replay?.());
      if (replay?.ok !== true) return { booted: true, replayError: replay, observations };
      // Replay queues a generation reset. Give the renderer one task turn to
      // retire the previous graph before sampling the first release frame.
      await page.waitForTimeout(100);
      const stepped = await page.evaluate(frames => globalThis.__forgeaxCinderFall?.step?.(frames), checkpoint.frames);
      if (stepped?.ok !== true) return { booted: true, stepError: stepped, observations };
      // Allow first-use WebGPU pipelines to finish before sampling the
      // release frame; later checkpoints are already warm.
      await page.waitForTimeout(100);
      const screenshot = prefix + '-' + checkpoint.id + '.png';
      await page.locator('canvas').screenshot({ path: screenshot });
      const status = await page.evaluate(() => globalThis.__forgeaxCinderFall?.status?.());
      observations.push({ id: checkpoint.id, frames: checkpoint.frames, screenshot, status });
    }
    const deterministicReplay = await page.evaluate(() => globalThis.__forgeaxCinderFall?.replay?.());
    const deterministicStep = await page.evaluate(() => globalThis.__forgeaxCinderFall?.step?.(1));
    await page.waitForTimeout(30);
    const deterministicScreenshot = prefix + '-release-replay.png';
    await page.locator('canvas').screenshot({ path: deterministicScreenshot });
    const deterministicStatus = await page.evaluate(() => globalThis.__forgeaxCinderFall?.status?.());
    const patch = await page.evaluate(() => globalThis.__forgeaxCinderFall?.patchParameters?.({ intensity: 2.5 }));
    const patchedStep = await page.evaluate(() => globalThis.__forgeaxCinderFall?.step?.(45));
    await page.waitForTimeout(30);
    const patched = await page.evaluate(() => globalThis.__forgeaxCinderFall?.status?.());
    const customSort = await page.evaluate(() => globalThis.__forgeaxCinderFall?.effectAsset?.program?.emitters?.flatMap(emitter =>
      emitter.renderers.filter(renderer => renderer.kind === 'billboard' && renderer.attributes?.sort?.source === 'custom')
        .map(renderer => renderer.sorting),
    ) ?? []);
    const dataInterfaces = await page.evaluate(() => globalThis.__forgeaxCinderFall?.effectAsset?.program?.emitters?.map(emitter =>
      emitter.reflection?.dataInterfaces?.map(requirement => requirement.token) ?? [],
    ) ?? []);
    const replayAgain = await page.evaluate(() => globalThis.__forgeaxCinderFall?.replay?.());
    const replayStep = await page.evaluate(() => globalThis.__forgeaxCinderFall?.step?.(1));
    await page.waitForTimeout(30);
    const secondRun = await page.evaluate(() => globalThis.__forgeaxCinderFall?.status?.());
    const canvas = await page.evaluate(() => {
      const node = document.querySelector('canvas');
      return node === null ? undefined : { width: node.width, height: node.height, rect: node.getBoundingClientRect().toJSON() };
    });
    const renderer = await page.evaluate(() => globalThis.__forgeaxCinderFall?.renderer?.inspect?.());
    return {
      booted: true,
      canvas,
      observations,
      deterministicReplay,
      deterministicStep,
      deterministicScreenshot,
      deterministicStatus,
      patch,
      patchedStep,
      patched,
      customSort,
      dataInterfaces,
      replayAgain,
      replayStep,
      secondRun,
      rendererState: renderer?.state,
      rendererFeatures: renderer?.featureDiagnostics?.map(feature => ({
        identity: feature.identity,
        status: feature.status,
        latestError: feature.latestError?.code,
      })),
    };
  }`);
  const value = JSON.parse(raw);
  if (!value.booted || value.canvas?.width !== 1280 || value.canvas?.height !== 720) {
    throw new Error(`cinder-fall browser consumer did not expose its canvas/runtime: ${raw}`);
  }
  if (value.rendererState !== 'alive' || value.secondRun?.inspect === undefined) {
    throw new Error(`cinder-fall browser Engine did not remain alive after replay: ${raw}`);
  }
  const failedFeatures = (value.rendererFeatures ?? []).filter((feature) => feature.status === 'failed');
  if (failedFeatures.length > 0) {
    throw new Error(`cinder-fall browser feature diagnostics reported failure: ${JSON.stringify(failedFeatures)}`);
  }
  if (value.observations?.length !== 5) throw new Error(`cinder-fall browser did not capture five checkpoints: ${raw}`);
  const evidence = value.observations.map((checkpoint) => ({
    id: checkpoint.id,
    frames: checkpoint.frames,
    phase: checkpoint.status?.snapshot?.phase,
    pixels: particleEvidence(checkpoint.screenshot),
  }));
  const expectedPhases = ['release', 'mid-travel', 'impact', 'burn', 'burn'];
  if (evidence.some((checkpoint, index) => checkpoint.phase !== expectedPhases[index])) {
    throw new Error(`cinder-fall browser phase timeline failed: ${JSON.stringify({ evidence, raw: value })}`);
  }
  if (evidence.some((checkpoint) => checkpoint.pixels.colored < 8 || checkpoint.pixels.orange < 1)) {
    throw new Error(`cinder-fall browser particle-region pixel oracle failed: ${JSON.stringify({ evidence, raw: value })}`);
  }
  const uniqueSignatures = new Set(evidence.map((checkpoint) => checkpoint.pixels.signature));
  const impact = evidence.find((checkpoint) => checkpoint.id === 'impact');
  const impactAfter = evidence.find((checkpoint) => checkpoint.id === 'impact-plus-0.35');
  if (impact === undefined || impactAfter === undefined || impact.pixels.signature === impactAfter.pixels.signature) {
    throw new Error(`cinder-fall browser impact phase did not change particle-region pixels: ${JSON.stringify({ evidence, raw: value })}`);
  }
  if (uniqueSignatures.size < 4) {
    throw new Error(`cinder-fall browser checkpoints lack phase deltas: ${JSON.stringify({ evidence, raw: value })}`);
  }
  if (!value.customSort?.includes('custom-ascending') || !value.customSort?.includes('custom-descending')) {
    throw new Error(`cinder-fall browser custom sort evidence missing: ${raw}`);
  }
  if (value.dataInterfaces?.some((tokens) => tokens.length !== 3)) {
    throw new Error(`cinder-fall browser DI reflection evidence missing: ${raw}`);
  }
  const releaseEmitter = value.observations[0]?.status?.inspect?.players?.[0]?.emitters?.find((emitter) => emitter.id === 'cinder.travel');
  if ((releaseEmitter?.spawnCount ?? 0) < 8) {
    throw new Error(`cinder-fall browser did not spawn multiple release particles: ${raw}`);
  }
  const finalInspect = value.observations.at(-1)?.status?.inspect;
  const player = finalInspect?.players?.[0];
  if ((value.patch?.ok !== true) || (value.patched?.inspect?.players?.[0]?.values?.generation ?? 0) < 1) {
    throw new Error(`cinder-fall browser public parameter patch did not commit: ${raw}`);
  }
  if ((player?.channels?.consumed ?? 0) < 1) {
    throw new Error(`cinder-fall browser impact channel/event was not consumed: ${raw}`);
  }
  const releaseReplayEvidence = particleEvidence(value.observations[0].screenshot);
  const replayEvidence = particleEvidence(value.deterministicScreenshot);
  if (releaseReplayEvidence.signature !== replayEvidence.signature) {
    throw new Error(`cinder-fall browser replay was not deterministic: ${JSON.stringify({ releaseReplayEvidence, replayEvidence })}`);
  }
  const screenshot = process.env.CINDER_FALL_SCREENSHOT ?? value.observations.at(-1).screenshot;
  if (screenshot !== value.observations.at(-1).screenshot) {
    cli('screenshot', '--filename', screenshot);
  }
  const cleanup = cli('--raw', 'run-code', 'async page => { const front = globalThis.__forgeaxCinderFall; await front?.dispose?.(); return { detached: front?.status?.()?.inspect === undefined }; }');
  console.log(`[cinder-fall-browser] PASS - canvas=${value.canvas.width}x${value.canvas.height}, renderer=${value.rendererState}, replay=${value.deterministicReplay?.ok === true && value.replayAgain?.ok === true}, checkpoints=${JSON.stringify(evidence)}, patch=${JSON.stringify(value.patched?.inspect?.players?.[0]?.values)}, cleanup=${cleanup}`);
} finally {
  try { cli('close'); } catch { /* wrapper cleanup is best-effort after a failed assertion */ }
  if (server !== undefined) {
    server.kill('SIGTERM');
    if (process.platform !== 'win32' && server.pid !== undefined) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already exited */ }
    }
  }
}
