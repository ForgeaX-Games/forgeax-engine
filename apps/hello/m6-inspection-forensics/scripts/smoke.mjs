#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { pixelDeltaAbsMean } from '@forgeax/engine-rhi-debug';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const here = resolve(new URL('.', import.meta.url).pathname);
const root = resolve(here, '..', '..', '..', '..');
const remoteLive = resolve(root, 'skills/forgeax-engine-cli/scripts/remote-live.mjs');
const childEnv = { ...process.env, INIT_CWD: root };

function run(label, args, extraEnv = {}) {
  const result = spawnSync('pnpm', args, {
    cwd: root,
    env: { ...childEnv, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status ?? 'unknown'}`);
  console.log(`[m6-forensics] ${label}: PASS`);
  return result.stdout ?? '';
}

function runNode(label, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...childEnv, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status ?? 'unknown'}`);
  return result.stdout ?? '';
}

function parseJsonOutput(output, label) {
  const trimmed = output.trim();
  const start = trimmed.startsWith('{') ? 0 : trimmed.indexOf('{');
  if (start < 0) throw new Error(`${label} did not emit JSON`);
  try {
    return JSON.parse(trimmed.slice(start));
  } catch (error) {
    throw new Error(`${label} emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForPage(url) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The dev server is still booting.
    }
    await sleep(250);
  }
  throw new Error(`page did not become ready: ${url}`);
}

async function waitForBridge(env) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = spawnSync(process.execPath, [remoteLive, '--health'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    if (result.status === 0) return parseJsonOutput(result.stdout, 'remote-live health');
    await sleep(250);
  }
  throw new Error('remote-live bridge did not connect to the browser');
}

function liveEval(env, script) {
  const result = spawnSync(process.execPath, [remoteLive, script], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`remote-live eval failed: ${result.stderr || result.stdout}`);
  }
  const envelope = parseJsonOutput(result.stdout, 'remote-live eval');
  if (!envelope.ok) throw new Error(`remote-live eval returned ${JSON.stringify(envelope.error)}`);
  return envelope.value;
}

async function runRemoteLiveBrowser() {
  const bridgePort = '5743';
  const env = { ...childEnv, FORGEAX_ENGINE_BRIDGE_PORT: bridgePort };
  const liveArtifactDir = mkdtempSync(resolve(tmpdir(), 'forgeax-m6-live-'));
  const dev = spawn(process.execPath, ['scripts/dev-live.mjs', '@forgeax/remote-demo'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  dev.stdout.on('data', (chunk) => process.stderr.write(`[dev-live] ${chunk}`));
  dev.stderr.on('data', (chunk) => process.stderr.write(`[dev-live.err] ${chunk}`));
  let browser;
  try {
    await waitForPage('http://127.0.0.1:5173');
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer', '--ignore-gpu-blocklist'],
    });
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle', timeout: 30_000 });
    const health = await waitForBridge(env);
    const entities = liveEval(
      env,
      "(async () => { const m = await _import('@forgeax/engine-ecs'); const r = []; const s = m.createQueryState({ with: [m.Entity] }); m.queryRun(s, world, b => { r.push(...Array.from(b.Entity.self)); }); return r; })()",
    );
    if (!Array.isArray(entities) || entities.length < 3) throw new Error(`unexpected live entities: ${JSON.stringify(entities)}`);
    const handle = entities[0];
    const before = liveEval(env, "(async () => { world.insertResource('m6Probe', { value: 1 }); return world.getResource('m6Probe').value; })()");
    liveEval(
      env,
      "(async () => { world.insertResource('m6Probe', { value: 7 }); return 'mutated'; })()",
    );
    const after = liveEval(env, "world.getResource('m6Probe').value");
    if (before !== 1 || after !== 7) {
      throw new Error(`live resource mutation did not read back: before=${before} after=${after}`);
    }
    const baselineCapture = liveEval(
      env,
    `(async () => { if (debugAdapter === undefined) return { available: false }; const m = await _import('@forgeax/engine-runtime'); const t = world.get(${JSON.stringify(handle)}, m.Transform); const capture = await debugAdapter.captureFrames(1, 'm6-live-scene-before'); return { available: true, probe: world.getResource('m6Probe').value, posX: t.ok ? t.value.pos[0] : null, capture }; })()`,
    );
    if (
      baselineCapture?.available !== true ||
      baselineCapture.probe !== 7 ||
      baselineCapture.posX !== 0 ||
      !Array.isArray(baselineCapture.capture?.tapes) ||
      baselineCapture.capture.tapes.length !== 1
    ) {
      throw new Error(`baseline live capture did not return one tape: ${JSON.stringify(baselineCapture)}`);
    }

    const moved = liveEval(
      env,
      `(async () => { const m = await _import('@forgeax/engine-runtime'); world.set(${JSON.stringify(handle)}, m.Transform, { pos: [1.25, 0, 0] }); const t = world.get(${JSON.stringify(handle)}, m.Transform); return t.ok ? t.value.pos[0] : null; })()`,
    );
    if (moved !== 1.25) {
      throw new Error(`visible Transform mutation did not read back: ${JSON.stringify(moved)}`);
    }

    const mutatedCapture = liveEval(
      env,
      `(async () => { const m = await _import('@forgeax/engine-runtime'); const t = world.get(${JSON.stringify(handle)}, m.Transform); const capture = await debugAdapter.captureFrames(1, 'm6-live-scene-after'); return { available: debugAdapter !== undefined, probe: world.getResource('m6Probe').value, posX: t.ok ? t.value.pos[0] : null, capture }; })()`,
    );
    if (
      mutatedCapture?.available !== true ||
      mutatedCapture.probe !== 7 ||
      mutatedCapture.posX !== 1.25 ||
      !Array.isArray(mutatedCapture.capture?.tapes) ||
      mutatedCapture.capture.tapes.length !== 1
    ) {
      throw new Error(`mutated live capture did not return one tape: ${JSON.stringify(mutatedCapture)}`);
    }

    function copyCapture(label, capture) {
      const [tape] = capture.capture.tapes;
      const sourceTape = [
        resolve(root, tape.tapePath),
        resolve(root, 'apps/remote-demo', tape.tapePath),
      ].find((candidate) => existsSync(candidate));
      const sourceReport = [
        resolve(root, tape.reportPath),
        resolve(root, 'apps/remote-demo', tape.reportPath),
      ].find((candidate) => existsSync(candidate));
      if (sourceTape === undefined || sourceReport === undefined) {
        throw new Error(`${label} live capture paths are missing: ${JSON.stringify(tape)}`);
      }
      const artifactDir = resolve(liveArtifactDir, label);
      mkdirSync(artifactDir, { recursive: true });
      const tapePath = resolve(artifactDir, 'frame-0.tape.bin');
      const reportPath = resolve(artifactDir, 'frame-0.report.json');
      copyFileSync(sourceTape, tapePath);
      copyFileSync(sourceReport, reportPath);
      return { tapePath, reportPath, runId: tape.runId };
    }

    const baseline = copyCapture('before', baselineCapture);
    const mutated = copyCapture('after', mutatedCapture);
    console.log(
      `[m6-forensics] same-scene live capture: PASS (before=${baseline.runId}, after=${mutated.runId}, probe=7)`,
    );
    console.log(
      `[m6-forensics] semantic live mutation: PASS (Transform.pos.x ${baselineCapture.posX} -> ${mutatedCapture.posX})`,
    );
    return {
      beforeTapePath: baseline.tapePath,
      afterTapePath: mutated.tapePath,
      beforeRunId: baseline.runId,
      afterRunId: mutated.runId,
      probe: mutatedCapture.probe,
      beforePosX: baselineCapture.posX,
      afterPosX: mutatedCapture.posX,
    };
  } finally {
    if (browser) await browser.close();
    dev.kill('SIGTERM');
    await sleep(500);
    if (dev.exitCode === null) dev.kill('SIGKILL');
  }
}

async function main() {
  try {
    const liveCapture = await runRemoteLiveBrowser();
    run('remote contracts', ['--filter', '@forgeax/remote-demo', 'e2e:motion']);
    run('remote contract syntax/error', ['--filter', '@forgeax/remote-demo', 'e2e:cli']);

    const fixtureDir = mkdtempSync(resolve(tmpdir(), 'forgeax-m6-rhi-'));
    try {
      runNode('RHI fixture', ['apps/rhi-debug-viewer/fixtures/generate-fixture.mjs', fixtureDir]);
      const tapePath = resolve(fixtureDir, 'frame-0.tape.bin');
      const cli = resolve(root, 'packages/rhi-debug/dist/cli.mjs');
      const summary = parseJsonOutput(runNode('RHI frame model', [cli, 'summary', tapePath]), 'RHI summary');
      if (!Array.isArray(summary.draws) || summary.draws.length < 1 || !Array.isArray(summary.commands) || summary.commands.length < 1) {
        throw new Error(`frame model lacks draw/command evidence: ${JSON.stringify(summary)}`);
      }
      console.log(`[m6-forensics] RHI frame model: PASS (draws=${summary.draws.length}, commands=${summary.commands.length})`);
      const inspected = parseJsonOutput(runNode('RHI offline inspect/replay', [cli, 'inspect-offline', tapePath, '0', '--fields=bindings,drawCall,rt']), 'RHI inspect');
      if (inspected.drawIdx !== 0 || inspected.rt === undefined || inspected.drawCall === undefined) {
        throw new Error(`offline inspect lacks replay evidence: ${JSON.stringify(inspected)}`);
      }
      console.log(`[m6-forensics] RHI offline inspect/replay: PASS (drawIdx=${inspected.drawIdx})`);

      const beforeSummary = parseJsonOutput(
        runNode('same-scene baseline RHI frame model', [cli, 'summary', liveCapture.beforeTapePath]),
        'same-scene baseline RHI summary',
      );
      const liveSummary = parseJsonOutput(
        runNode('same-scene mutated RHI frame model', [cli, 'summary', liveCapture.afterTapePath]),
        'same-scene mutated RHI summary',
      );
      if (
        !Array.isArray(beforeSummary.draws) ||
        beforeSummary.draws.length < 1 ||
        !Array.isArray(liveSummary.draws) ||
        liveSummary.draws.length < 1 ||
        !Array.isArray(liveSummary.commands) ||
        liveSummary.commands.length < 1 ||
        beforeSummary.draws.length !== liveSummary.draws.length
      ) {
        throw new Error(`same-scene before/after tapes lack stable draw evidence`);
      }
      console.log(
        `[m6-forensics] same-scene live RHI frame model: PASS (before=${liveCapture.beforeRunId}, after=${liveCapture.afterRunId}, draws=${liveSummary.draws.length}, commands=${liveSummary.commands.length})`,
      );
      const liveDrawIdx = liveSummary.draws.length - 1;
      const beforeInspected = parseJsonOutput(
        runNode('same-scene baseline RHI inspect/replay', [
          cli,
          'inspect-offline',
          liveCapture.beforeTapePath,
          String(liveDrawIdx),
          '--fields=bindings,drawCall,rt',
        ]),
        'same-scene baseline RHI inspect',
      );
      const liveInspected = parseJsonOutput(
        runNode('same-scene live RHI inspect/replay', [
          cli,
          'inspect-offline',
          liveCapture.afterTapePath,
          String(liveDrawIdx),
          '--fields=bindings,drawCall,rt',
        ]),
        'same-scene live RHI inspect',
      );
      if (
        beforeInspected.drawIdx !== liveDrawIdx ||
        beforeInspected.rt === undefined ||
        liveInspected.drawIdx !== liveDrawIdx ||
        liveInspected.rt === undefined ||
        liveInspected.drawCall === undefined
      ) {
        throw new Error(`same-scene live tape lacks replay evidence: ${JSON.stringify(liveInspected)}`);
      }
      console.log(
        `[m6-forensics] same-scene live RHI inspect/replay: PASS (drawIdx=${liveInspected.drawIdx})`,
      );
      const beforePixels = PNG.sync.read(readFileSync(beforeInspected.rt)).data;
      const afterPixels = PNG.sync.read(readFileSync(liveInspected.rt)).data;
      const pixelDelta = pixelDeltaAbsMean(beforePixels, afterPixels);
      if (pixelDelta <= 0.01) {
        throw new Error(`semantic Transform mutation did not produce a discriminative RT delta: ${pixelDelta}`);
      }
      console.log(
        `[m6-forensics] semantic-to-pixel correlation: PASS (Transform.pos.x ${liveCapture.beforePosX} -> ${liveCapture.afterPosX}, pixelDeltaAbsMean=${pixelDelta.toFixed(6)})`,
      );
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }

    run('RHI viewer', ['--filter', '@forgeax/rhi-debug-viewer', 'smoke:browser']);
    run('RHI falsifier', ['--filter', '@forgeax/rhi-debug-viewer', 'smoke:browser'], { FALSIFY_NO_SHADER_MODULE: '1' });
    console.log('[m6-forensics] PASS - M6 inspection/forensics gates GREEN');
    console.log('[m6-forensics] deferred: renderer device-loss recovery remains open.');
  } catch (error) {
    console.error(`[m6-forensics] FAIL - ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();
