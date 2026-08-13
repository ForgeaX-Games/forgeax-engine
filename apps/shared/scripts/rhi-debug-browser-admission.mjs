// @forgeax/apps-shared/scripts/rhi-debug-browser-admission -- shared browser
// admission path for public, trigger, and remote-live RHI-debug captures.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const REMOTE_LIVE = resolve(REPO_ROOT, 'skills/forgeax-engine-cli/scripts/remote-live.mjs');
const DEV_LIVE = resolve(REPO_ROOT, 'scripts/dev-live.mjs');
const CLI = resolve(REPO_ROOT, 'packages/rhi-debug/dist/cli.mjs');

/**
 * @typedef {Object} BrowserAdmissionOptions
 * @property {string} pkg
 * @property {string} label
 * @property {string} readyHook
 * @property {string} capturePrepareHook
 * @property {string} screenshotPath
 * @property {string} triggerLabel
 * @property {(input: {events: object[], blobPool: Map<string, Uint8Array>}) => object} assertTape
 * @property {(input: {label: string, capture: object, selected: object, inspected: object}) => string} formatCapture
 */

/** @param {BrowserAdmissionOptions} options */
export async function runRhiDebugBrowserAdmission(options) {
  const { pkg, label, readyHook, capturePrepareHook, screenshotPath, triggerLabel, assertTape, formatCapture } = options;
  const bridgePort = await findFreePort();
  const dev = spawn(process.execPath, [DEV_LIVE, pkg], {
    cwd: REPO_ROOT,
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
    await page.waitForFunction((hook) => globalThis[hook] === true, readyHook, { timeout: 20_000 });
    mkdirSync(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath });
    console.log(`[${label}] browser screenshot=${screenshotPath}`);

    const health = await waitForRemoteHealth(bridgePort);
    if (health.pageConnected !== true) throw new Error(`remote-live page did not connect: ${JSON.stringify(health)}`);
    const prep = await remoteEval(
      bridgePort,
      '(async () => { const updated = world.update(1 / 60); if (!updated.ok) throw updated.error; const drawn = renderer.draw([world], { owner: 0 }); if (!drawn.ok) throw drawn.error; return { updated: true, drawn: true }; })()',
    );
    if (prep.updated !== true || prep.drawn !== true) throw new Error(`remote-live capture preparation failed: ${JSON.stringify(prep)}`);

    const triggered = runTrigger(url, triggerLabel);
    await verifyCaptured({ label, captureLabel: 'public trigger', capture: triggered, screenshotPath, assertTape, formatCapture });
    const remoteCapture = await remoteEval(
      bridgePort,
      `(async () => { const prepare = globalThis.${capturePrepareHook}; if (typeof prepare !== 'function') throw new Error('capture preparation hook is unavailable'); await prepare(); return await globalThis.__forgeax.captureFrame(1); })()`,
    );
    await verifyCaptured({ label, captureLabel: 'remote-live', capture: remoteCapture, screenshotPath, assertTape, formatCapture });

    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    console.log(`[${label}] public trigger + remote-live browser admission PASS`);
    await page.close();
  } finally {
    await browser?.close();
    dev.kill('SIGTERM');
    await sleep(500);
  }
}

export function collectRhiDebugDraws(events) {
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
    const result = spawnSync(process.execPath, [REMOTE_LIVE, '--health'], {
      cwd: REPO_ROOT,
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
  const result = spawnSync(process.execPath, [REMOTE_LIVE, code], {
    cwd: REPO_ROOT,
    env: { ...process.env, FORGEAX_ENGINE_BRIDGE_PORT: String(port) },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`remote-live failed: ${result.stderr || result.stdout}`);
  const envelope = JSON.parse(result.stdout);
  if (!envelope.ok) throw new Error(`remote-live returned ${JSON.stringify(envelope.error)}`);
  return envelope.value;
}

function runTrigger(url, triggerLabel) {
  const result = spawnSync(
    process.execPath,
    [CLI, 'trigger-browser', '--frames=1', `--label=${triggerLabel}`, `--dev-url=${url.replace(/\/$/, '')}`],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`forgeax-rhi-debug trigger-browser failed: ${result.stderr || result.stdout}`);
  const values = Object.fromEntries(result.stdout.trim().split('\n').map((line) => line.split(': ', 2)));
  if (typeof values.tapePath !== 'string' || typeof values.reportPath !== 'string' || typeof values.runId !== 'string') {
    throw new Error(`trigger-browser returned incomplete capture: ${result.stdout}`);
  }
  return values;
}

async function verifyCaptured({ label, captureLabel, capture, screenshotPath, assertTape, formatCapture }) {
  if (typeof capture?.tapePath !== 'string' || typeof capture.reportPath !== 'string') {
    throw new Error(`${captureLabel} capture returned incomplete artifact paths: ${JSON.stringify(capture)}`);
  }
  const tapePath = resolveCapturePath(capture.tapePath, screenshotPath);
  const reportPath = resolveCapturePath(capture.reportPath, screenshotPath);
  if (!existsSync(tapePath) || !existsSync(reportPath)) {
    throw new Error(`${captureLabel} capture artifacts are missing: ${JSON.stringify({ tapePath, reportPath })}`);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const tapeBytes = readFileSync(tapePath);
  const blobPool = new Map(
    report.header.blobEntries.map((entry) => [entry.hash, tapeBytes.subarray(entry.offset, entry.offset + entry.size)]),
  );
  const selected = assertTape({ events: report.events, blobPool });
  const summary = JSON.parse(runCli(['summary', tapePath]));
  if (summary.meta?.totalDraws <= selected.drawOrdinal) throw new Error(`${captureLabel} summary omitted selected draw: ${JSON.stringify(summary.meta)}`);
  const inspected = JSON.parse(runCli(['inspect-offline', tapePath, String(selected.drawOrdinal), '--fields=bindings,drawCall,rt']));
  if (inspected.drawCall?.indexCount <= 0 || inspected.bindings?.length === 0 || typeof inspected.rt !== 'string') {
    throw new Error(`${captureLabel} selected draw replay inspect is incomplete: ${JSON.stringify(inspected)}`);
  }
  const details = formatCapture({ label: captureLabel, capture, selected, inspected, screenshotPath });
  console.log(`[${label}] ${captureLabel} capture/replay/selected draw PASS ${details}`);
}

function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`rhi-debug ${args[0]} failed: ${result.stderr || result.stdout}`);
  if (result.stdout.trim().length === 0) throw new Error(`rhi-debug ${args[0]} returned empty output`);
  return result.stdout;
}

function resolveCapturePath(path, screenshotPath) {
  if (path.startsWith('/')) return path;
  const inApp = resolve(dirname(screenshotPath), '..', path);
  return existsSync(inApp) ? inApp : resolve(REPO_ROOT, path);
}

async function findFreePort() {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveServer);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  server.close();
  if (port === undefined) throw new Error('could not allocate a remote-live bridge port');
  return port;
}
