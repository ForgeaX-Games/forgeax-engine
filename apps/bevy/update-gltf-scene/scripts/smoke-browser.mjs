#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(scriptsDir);
const root = resolve(scriptsDir, '..', '..', '..', '..');
const packageName = '@forgeax/bevy-update-gltf-scene';
const remoteLive = resolve(root, 'skills/forgeax-engine-cli/scripts/remote-live.mjs');
const devLive = resolve(root, 'scripts/dev-live.mjs');
const cli = resolve(root, 'packages/rhi-debug/dist/cli.mjs');

if (process.env.UPDATE_GLTF_SCENE_PUBLIC === '1') {
  await verifyDemoCapture({
    pkg: packageName,
    label: 'bevy update_gltf_scene public captureFrame',
    mode: 'structural',
    capturePrepareHook: '__prepareUpdateGltfSceneCapture',
    appDir,
    assertTape: ({ tape }) => assertSceneTape({ events: tape.events, blobPool: tape.blobPool }),
  });
} else {
  const publicExit = await runPublicCaptureFrame();
  if (publicExit !== 0) process.exit(publicExit);
  await runTriggerAndRemoteLive();
}

function runPublicCaptureFrame() {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      env: { ...process.env, UPDATE_GLTF_SCENE_PUBLIC: '1' },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => resolveExit(code ?? 1));
  });
}

async function runTriggerAndRemoteLive() {
  const bridgePort = await findFreePort();
  const dev = spawn(process.execPath, [devLive, packageName], {
    cwd: root,
    env: {
      ...process.env,
      FORGEAX_ENGINE_BRIDGE_PORT: String(bridgePort),
      FORGEAX_ENGINE_RHI_DEBUG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let url;
  dev.stdout.on('data', (chunk) => {
    const text = String(chunk);
    output += text;
    process.stdout.write(`[dev-live] ${text}`);
    url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1];
  });
  dev.stderr.on('data', (chunk) => process.stderr.write(`[dev-live:err] ${String(chunk)}`));

  let browser;
  try {
    url = await waitForUrl(dev, () => url, output);
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
    });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(() => globalThis.__bevyUpdateGltfSceneReady === true, undefined, { timeout: 20_000 });
    const screenshotPath = resolve(appDir, 'artifacts', 'update-gltf-scene-rhi-debug.png');
    mkdirSync(resolve(appDir, 'artifacts'), { recursive: true });
    await page.screenshot({ path: screenshotPath });
    console.log(`[bevy update_gltf_scene] browser screenshot=${screenshotPath}`);
    const health = await waitForRemoteHealth(bridgePort);
    if (health.pageConnected !== true) throw new Error(`remote-live page did not connect: ${JSON.stringify(health)}`);

    const prep = await remoteEval(bridgePort, "(async () => { const updated = world.update(1 / 60); if (!updated.ok) throw updated.error; const drawn = renderer.draw([world], { owner: 0 }); if (!drawn.ok) throw drawn.error; return { updated: true, drawn: true }; })()");
    if (prep.updated !== true || prep.drawn !== true) throw new Error(`remote-live capture preparation failed: ${JSON.stringify(prep)}`);

    const triggered = runTrigger(url);
    await verifyCaptured('public trigger', triggered);

    const remoteCapture = await remoteEval(
      bridgePort,
      "(async () => { const prepare = globalThis.__prepareUpdateGltfSceneCapture; if (typeof prepare !== 'function') throw new Error('capture preparation hook is unavailable'); await prepare(); return await globalThis.__forgeax.captureFrame(1); })()",
    );
    await verifyCaptured('remote-live', remoteCapture);

    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    console.log('[bevy update_gltf_scene] public trigger + remote-live browser admission PASS');
    await page.close();
  } finally {
    await browser?.close();
    dev.kill('SIGTERM');
    await sleep(500);
  }
}

async function waitForUrl(child, readUrl, initialOutput) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = readUrl();
    if (value !== undefined) return value;
    if (child.exitCode !== null) throw new Error(`dev-live exited before Vite was ready: ${initialOutput}`);
    await sleep(100);
  }
  throw new Error(`dev-live did not publish a Vite URL: ${initialOutput}`);
}

async function waitForRemoteHealth(port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = spawnSync(process.execPath, [remoteLive, '--health'], {
      cwd: root,
      env: { ...process.env, FORGEAX_ENGINE_BRIDGE_PORT: String(port) },
      encoding: 'utf8',
    });
    if (result.status === 0) {
      const health = JSON.parse(result.stdout);
      if (health.pageConnected === true) return health;
    }
    await sleep(250);
  }
  throw new Error('remote-live bridge did not report pageConnected=true');
}

async function remoteEval(port, code) {
  const result = spawnSync(process.execPath, [remoteLive, code], {
    cwd: root,
    env: { ...process.env, FORGEAX_ENGINE_BRIDGE_PORT: String(port) },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`remote-live failed: ${result.stderr || result.stdout}`);
  const envelope = JSON.parse(result.stdout);
  if (!envelope.ok) throw new Error(`remote-live returned ${JSON.stringify(envelope.error)}`);
  return envelope.value;
}

function runTrigger(url) {
  const result = spawnSync(process.execPath, [cli, 'trigger-browser', '--frames=1', '--label=update-gltf-scene-public-trigger', `--dev-url=${url.replace(/\/$/, '')}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`forgeax-rhi-debug trigger-browser failed: ${result.stderr || result.stdout}`);
  const values = Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split(': ', 2)));
  if (typeof values.tapePath !== 'string' || typeof values.reportPath !== 'string' || typeof values.runId !== 'string') {
    throw new Error(`trigger-browser returned incomplete capture: ${result.stdout}`);
  }
  return values;
}

async function verifyCaptured(label, capture) {
  const tapePath = resolveCapturePath(capture.tapePath);
  const reportPath = resolveCapturePath(capture.reportPath);
  if (!existsSync(tapePath) || !existsSync(reportPath)) {
    throw new Error(`${label} capture artifacts are missing: ${JSON.stringify({ tapePath, reportPath })}`);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const tapeBytes = readFileSync(tapePath);
  const blobPool = new Map(
    report.header.blobEntries.map((entry) => [entry.hash, tapeBytes.subarray(entry.offset, entry.offset + entry.size)]),
  );
  const selected = assertSceneTape({ events: report.events, blobPool });
  const summary = JSON.parse(runCli(['summary', tapePath]));
  if (summary.meta?.totalDraws <= selected.drawOrdinal) throw new Error(`${label} summary omitted selected draw: ${JSON.stringify(summary.meta)}`);
  const inspected = JSON.parse(runCli(['inspect-offline', tapePath, String(selected.drawOrdinal), '--fields=bindings,drawCall,rt']));
  if (inspected.drawCall?.indexCount <= 0 || inspected.bindings?.length === 0 || typeof inspected.rt !== 'string') {
    throw new Error(`${label} selected draw replay inspect is incomplete: ${JSON.stringify(inspected)}`);
  }
  console.log(`[bevy update_gltf_scene] ${label} capture/replay/selected draw PASS runId=${capture.runId ?? 'remote'} drawOrdinal=${selected.drawOrdinal} indexCount=${inspected.drawCall.indexCount} bindings=${inspected.bindings.length} modelTranslation=${JSON.stringify(selected.modelTranslation)}`);
}

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`rhi-debug ${args[0]} failed: ${result.stderr || result.stdout}`);
  if (result.stdout.trim().length === 0) throw new Error(`rhi-debug ${args[0]} returned empty output`);
  return result.stdout;
}

function resolveCapturePath(path) {
  if (path.startsWith('/')) return path;
  const inApp = resolve(appDir, path);
  return existsSync(inApp) ? inApp : resolve(root, path);
}

function assertSceneTape({ events, blobPool }) {
  const { draws, groups, layouts, initialData } = collectDraws(events);
  const indexed = draws.filter(({ event }) => event.kind === 'drawIndexed');
  const scene = indexed.filter(
    (draw) =>
      draw.pass?.colorAttachmentViewHandleIds?.length === 1 &&
      typeof draw.pass.depthStencilViewHandleId === 'string' &&
      draw.vertexBuffer !== undefined &&
      draw.indexBuffer !== undefined &&
      hasPositionNormalUv(draw.pipeline),
  );
  if (scene.length !== 1) throw new Error(`expected one semantically selected glTF mesh draw, got ${scene.length} of ${indexed.length} indexed draws`);
  const selected = scene[0];
  if (selected.event.indexCount <= 0 || selected.event.instanceCount <= 0 || !['uint16', 'uint32'].includes(selected.indexBuffer.format)) {
    throw new Error(`selected glTF mesh draw is not a valid indexed draw: ${JSON.stringify(selected.event)}`);
  }
  assertNonEmptyBuffer(selected.vertexBuffer.bufferHandleId, initialData, blobPool, 'vertex');
  assertNonEmptyBuffer(selected.indexBuffer.bufferHandleId, initialData, blobPool, 'index');

  const materialSet = selected.bindGroups.get(1);
  const materialGroup = materialSet === undefined ? undefined : groups.get(materialSet.bindGroupHandleId);
  const materialLayout = materialGroup === undefined ? undefined : layouts.get(materialGroup.layoutHandleId);
  if (materialLayout?.desc?.label !== 'pbr-material-skylight-bgl') throw new Error('selected glTF mesh draw is missing the canonical PBR material bind group');
  const materialKinds = new Set(materialGroup.entries.map((entry) => entry.resourceKind));
  if (!materialKinds.has('buffer') || !materialKinds.has('sampler') || !materialKinds.has('textureView')) {
    throw new Error(`selected glTF material bind group lacks uniform/texture/sampler bindings: ${JSON.stringify([...materialKinds])}`);
  }
  const materialBuffer = materialGroup.resourceHandleIds[0];
  const materialWrite = latestWrite(events, materialBuffer);
  const materialFloats = materialWrite === undefined ? undefined : floatsFor(blobPool.get(materialWrite.dataHash));
  if (materialFloats === undefined || materialFloats.length < 4 || materialFloats.slice(0, 4).some((value) => !Number.isFinite(value)) || materialFloats[3] <= 0) {
    throw new Error('selected glTF material binding has no finite non-zero material uniform');
  }

  const meshSet = selected.bindGroups.get(2);
  const meshGroup = meshSet === undefined ? undefined : groups.get(meshSet.bindGroupHandleId);
  const meshLayout = meshGroup === undefined ? undefined : layouts.get(meshGroup.layoutHandleId);
  if (meshLayout?.desc?.label !== 'pbr-mesh-array-bgl') throw new Error('selected glTF mesh draw is missing the mesh/model storage binding');
  const modelBuffer = meshGroup.resourceHandleIds[0];
  const modelWrite = latestWrite(events, modelBuffer);
  const modelFloats = modelWrite === undefined ? undefined : floatsFor(blobPool.get(modelWrite.dataHash));
  if (modelFloats === undefined || modelFloats.length < 16 || modelFloats.slice(0, 16).some((value) => !Number.isFinite(value))) {
    throw new Error('selected glTF mesh draw has no finite model matrix');
  }
  const modelMatrix = modelFloats.slice(0, 16);
  const identityDelta = modelMatrix.reduce((sum, value, index) => sum + Math.abs(value - (index % 5 === 0 ? 1 : 0)), 0);
  if (identityDelta <= 0.001) throw new Error(`selected glTF model transform is identity: ${JSON.stringify(modelMatrix)}`);

  const drawOrdinal = draws.indexOf(selected);
  const modelTranslation = [modelMatrix[12], modelMatrix[13], modelMatrix[14]];
  console.log(`[bevy update_gltf_scene] semantic selector indexed=1 materialBindings=${materialKinds.size} modelTranslation=${JSON.stringify(modelTranslation)} drawOrdinal=${drawOrdinal}`);
  return { drawOrdinal, modelTranslation };
}

function collectDraws(events) {
  const groups = new Map();
  const layouts = new Map();
  const pipelines = new Map();
  const initialData = new Map();
  const draws = [];
  let pass;
  let pipeline;
  let bindGroups = new Map();
  let vertexBuffer;
  let indexBuffer;
  for (const event of events) {
    if (event.kind === 'createBindGroup') groups.set(event.handleId, event);
    else if (event.kind === 'createBindGroupLayout') layouts.set(event.handleId, event);
    else if (event.kind === 'createRenderPipeline') pipelines.set(event.handleId, event);
    else if (event.kind === 'initialData') initialData.set(event.handleId, event);
    else if (event.kind === 'beginRenderPass') {
      pass = event;
      bindGroups = new Map();
      pipeline = undefined;
      vertexBuffer = undefined;
      indexBuffer = undefined;
    } else if (event.kind === 'setPipeline') pipeline = pipelines.get(event.pipelineHandleId);
    else if (event.kind === 'setBindGroup') bindGroups.set(event.index, event);
    else if (event.kind === 'setVertexBuffer') vertexBuffer = event;
    else if (event.kind === 'setIndexBuffer') indexBuffer = event;
    else if (event.kind === 'draw' || event.kind === 'drawIndexed') {
      draws.push({ event, pass, pipeline, bindGroups: new Map(bindGroups), vertexBuffer, indexBuffer });
    }
  }
  return { draws, groups, layouts, initialData };
}

function hasPositionNormalUv(pipeline) {
  const attributes = pipeline?.desc?.vertex?.buffers?.flatMap((buffer) => buffer.attributes ?? []) ?? [];
  const locations = new Set(attributes.map((attribute) => attribute.shaderLocation));
  return locations.has(0) && locations.has(1) && locations.has(2) && pipeline?.desc?.fragment?.targets?.length === 1;
}

function latestWrite(events, handleId) {
  return [...events].reverse().find((event) => event.kind === 'writeBuffer' && event.handleId === handleId && event.size >= 16);
}

function floatsFor(blob) {
  if (blob === undefined || blob.byteLength < 4) return undefined;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : Uint8Array.from(bytes);
  return new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
}

function assertNonEmptyBuffer(handleId, initialData, blobPool, label) {
  const seed = initialData.get(handleId);
  const blob = seed === undefined ? undefined : blobPool.get(seed.dataHash);
  const bytes = blob === undefined ? undefined : blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes === undefined || bytes.byteLength === 0 || bytes.every((value) => value === 0)) throw new Error(`selected glTF ${label} buffer has no non-zero captured data`);
}

async function findFreePort() {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  server.close();
  if (port === undefined) throw new Error('could not allocate a remote-live bridge port');
  return port;
}
