#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const remoteLive = resolve(root, 'skills/forgeax-engine-cli/scripts/remote-live.mjs');
const devLive = resolve(root, 'scripts/dev-live.mjs');
const appPackage = '@forgeax/hello-m1-composition';
const bridgePort = process.env.FORGEAX_ENGINE_BRIDGE_PORT ?? '5733';

function log(message) {
  console.log(`[m1-live] ${message}`);
}

async function runRemote(args) {
  const result = await execFileAsync(process.execPath, [remoteLive, ...args], {
    cwd: root,
    env: { ...process.env, FORGEAX_ENGINE_BRIDGE_PORT: bridgePort },
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = result.stdout.trim();
  log(`remote ${args[0] === '--health' ? 'health' : 'eval'}: ${output.replaceAll('\n', ' ')}`);
  return JSON.parse(output);
}

async function runHeadlessSemanticGate() {
  const result = await execFileAsync('pnpm', ['--filter', appPackage, 'smoke'], {
    cwd: root,
    maxBuffer: 2 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

function startDevLive() {
  const child = spawn(process.execPath, [devLive, appPackage], {
    cwd: root,
    env: { ...process.env, FORGEAX_ENGINE_BRIDGE_PORT: bridgePort },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(`[dev-live] ${text}`);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(`[dev-live:err] ${text}`);
  });
  return { child, output: () => output };
}

async function waitForUrl(stack) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const match = stack.output().match(/Local:\s+(http:\/\/[^\s]+)/);
    if (match) return match[1];
    if (stack.child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`dev-live did not publish a Vite URL: ${stack.output()}`);
}

function assertEnvelope(envelope, label) {
  if (!envelope?.ok) throw new Error(`${label} failed: ${envelope?.error?.code ?? 'unknown'}`);
  return envelope.value;
}

const stack = startDevLive();
let browser;
try {
  await runHeadlessSemanticGate();
  const url = await waitForUrl(stack);
  log(`browser URL: ${url}`);
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('phase=play'), null, { timeout: 30000 });
  await page.waitForTimeout(500);

  assertEnvelope(await runRemote(['--health']), 'remote health');
  const baseline = assertEnvelope(
    await runRemote([
      "const phase=world.getResource('m1LivePhase'); const frames=world.getResource('m1LiveFrames'); const fixed=world.getResource('m1LiveFixedTicks'); const input=world.getResource('m1LiveInput'); const plugin=world.getResource('m1LivePluginBuilt'); const root=world.getResource('m1LiveRoot'); return {phase:phase.value,frames:frames.value,fixed:fixed.value,input:{...input},plugin:plugin.value,entities:world.inspect().entityCount,children:Array.from(world.iterDescendants(root)).length};",
    ]),
    'live baseline',
  );
  if (baseline.phase !== 'play' || baseline.entities < 4 || baseline.children !== 1 || baseline.plugin !== true) {
    throw new Error(`unexpected live baseline: ${JSON.stringify(baseline)}`);
  }

  await page.keyboard.press('Space');
  await page.waitForTimeout(100);
  const mutation = assertEnvelope(
    await runRemote([
      "const ecs=await _import('@forgeax/engine-ecs'); const position=world.getResource('m1LivePosition'); const before=position.x; world.insertResource('m1LivePosition',{...position,x:before+0.5}); const after=world.getResource('m1LivePosition'); return {setOk:true,before,after:after.x,input:{...world.getResource('m1LiveInput')},fixed:world.getResource('m1LiveFixedTicks').value,hasEntity:ecs.Entity !== undefined};",
    ]),
    'live mutation',
  );
  if (!mutation.setOk || mutation.after !== mutation.before + 0.5 || mutation.hasEntity !== true) {
    throw new Error(`live mutation did not read back: ${JSON.stringify(mutation)}`);
  }

  const recovery = assertEnvelope(
    await runRemote([
      "const invalid=world.update(-1); const phase=world.getResource('m1LivePhase'); const frames=world.getResource('m1LiveFrames'); return {error:invalid.ok?null:invalid.error.code,phase:phase.value,frames:frames.value,entities:world.inspect().entityCount};",
    ]),
    'live recovery',
  );
  if (!recovery.error || recovery.phase !== 'play' || recovery.entities !== baseline.entities) {
    throw new Error(`live recovery invariant failed: ${JSON.stringify(recovery)}`);
  }
  if (pageErrors.length > 0) throw new Error(`browser page errors: ${pageErrors.join(' | ')}`);
  log(`PASS - live baseline=${JSON.stringify(baseline)} mutation=${JSON.stringify(mutation)} recovery=${JSON.stringify(recovery)}`);
} finally {
  if (browser) await browser.close();
  if (stack.child.exitCode === null) stack.child.kill('SIGTERM');
}
