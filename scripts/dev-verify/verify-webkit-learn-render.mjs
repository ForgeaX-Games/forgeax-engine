// Exercise Learn Render consumers through WebKit's WebGL2 fallback. Each demo
// gets one fresh Vite process and one fresh browser process; its result.json is
// the matrix evidence SSOT, not a console transcript reconstructed afterward.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';
import { detectWasmCrash } from './retry-until-pass.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEARN_RENDER = join(ROOT, 'apps', 'learn-render');
const MATRIX_PATH = join(import.meta.dirname, 'learn-render-webkit-matrix.json');
const MATRIX = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
const args = process.argv.slice(2);
const tier = argumentValue('--tier') ?? 'core';
const demoArg = argumentValue('--demo');
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 30_000);
const artifactRoot = resolve(
  argumentValue('--artifacts') ?? join('/tmp', `forgeax-webkit-learn-render-${Date.now()}`),
);
const execution = {
  command: ['node', relative(ROOT, fileURLToPath(import.meta.url)), ...args],
  commit: git('rev-parse', 'HEAD'),
  matrix: { path: relative(ROOT, MATRIX_PATH), sha256: sha256(readFileSync(MATRIX_PATH)) },
  webkit: null,
};

if (args.includes('--help')) {
  process.stdout.write(
    `Usage: node scripts/dev-verify/verify-webkit-learn-render.mjs [--tier=core|full] [--demo=<relative-demo>] [--artifacts=<dir>]\n`,
  );
  process.exit(0);
}

function argumentValue(name) {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function git(...gitArgs) {
  try {
    return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function artifactPath(demo) {
  return join(artifactRoot, demo.replaceAll('/', '--'));
}

function fail(message) {
  process.stderr.write(`[webkit-learn-render] ${message}\n`);
  process.exitCode = 1;
}

async function findDemos(dir = LEARN_RENDER) {
  const entries = await readdir(dir, { withFileTypes: true });
  const demos = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (existsSync(join(path, 'package.json'))) demos.push(relative(LEARN_RENDER, path));
    else demos.push(...(await findDemos(path)));
  }
  return demos.sort();
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('failed to allocate a local TCP port');
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

function stripAnsi(value) {
  return value.replace(new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

async function startVite(demo) {
  const cwd = join(LEARN_RENDER, demo);
  if (!existsSync(join(cwd, 'package.json')))
    throw new Error(`demo package does not exist: ${demo}`);
  const port = await freePort();
  const child = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  const url = new Promise((resolveUrl, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(
      () => settle(reject, new Error(`vite readiness timed out: ${output.slice(-1000)}`)),
      60_000,
    );
    const append = (chunk) => {
      output += String(chunk);
      const match = stripAnsi(output).match(/Local:\s+(http:\/\/[^\s]+)/);
      if (match) settle(resolveUrl, match[1]);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => settle(reject, error));
    child.once('exit', (code) =>
      settle(reject, new Error(`vite exited (${code}): ${output.slice(-1000)}`)),
    );
  });
  return { child, url, port, output: () => output };
}

async function stop(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await Promise.race([new Promise((resolveExit) => child.once('exit', resolveExit)), sleep(5_000)]);
}

export function evaluatePixelOracle(contract, stats) {
  if (contract === undefined) {
    return {
      passed: stats.nonBlackSamples > 0,
      sampled: stats.sampled,
      nonBlackSamples: stats.nonBlackSamples,
      lumaRange: stats.lumaRange,
    };
  }
  const passed =
    stats.sampled > 0 &&
    stats.lumaRange >= (contract.minLumaRange ?? 0) &&
    stats.nonBlackSamples >= (contract.minNonBlackSamples ?? 0);
  return {
    passed,
    kind: contract.kind,
    sampled: stats.sampled,
    nonBlackSamples: stats.nonBlackSamples,
    lumaRange: stats.lumaRange,
    reason: passed ? undefined : contract.reason,
  };
}

export function readinessForDemo(matrix, demo) {
  const contract = matrix.readiness?.[demo];
  if (contract === undefined) return undefined;
  if (
    contract.kind !== 'window-flag' ||
    typeof contract.name !== 'string' ||
    contract.name.length === 0 ||
    !Number.isFinite(contract.timeoutMs) ||
    contract.timeoutMs <= 0
  ) {
    throw new Error(`invalid readiness contract for ${demo}`);
  }
  return {
    kind: 'window-flag',
    name: contract.name,
    timeoutMs: contract.timeoutMs,
  };
}

export function readinessWaitBudget(readiness, timeoutMs) {
  return Math.min(timeoutMs, readiness?.timeoutMs ?? 8_000);
}

async function screenshotOracle(page, path, contract) {
  await page.screenshot({ path, type: 'png' });
  const stats = await page.evaluate(
    async ({ base64, oracle }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      const rect = document.querySelector('canvas')?.getBoundingClientRect();
      if (!context || !rect || rect.width < 1 || rect.height < 1)
        return { sampled: 0, nonBlackSamples: 0, lumaRange: 0 };
      context.drawImage(image, 0, 0);
      const region = oracle?.region ?? { x: 0, y: 0, width: 1, height: 1 };
      const x0 = Math.max(0, Math.floor(rect.left + region.x * rect.width));
      const y0 = Math.max(0, Math.floor(rect.top + region.y * rect.height));
      const x1 = Math.min(image.width, Math.ceil(x0 + region.width * rect.width));
      const y1 = Math.min(image.height, Math.ceil(y0 + region.height * rect.height));
      const points =
        oracle?.kind === 'point-contrast'
          ? oracle.points.map(([x, y]) => [
              Math.floor(rect.left + x * rect.width),
              Math.floor(rect.top + y * rect.height),
            ])
          : null;
      const step = oracle?.sampleStep ?? 16;
      const samples =
        points ??
        (() => {
          const result = [];
          for (let y = y0; y < y1; y += step) {
            for (let x = x0; x < x1; x += step) result.push([x, y]);
          }
          return result;
        })();
      let minLuma = Number.POSITIVE_INFINITY;
      let maxLuma = Number.NEGATIVE_INFINITY;
      let nonBlackSamples = 0;
      for (const [x, y] of samples) {
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
        const [r, g, b] = context.getImageData(x, y, 1, 1).data;
        const luma = (r + g + b) / 3;
        minLuma = Math.min(minLuma, luma);
        maxLuma = Math.max(maxLuma, luma);
        if (luma > 16) nonBlackSamples += 1;
      }
      return {
        sampled: samples.length,
        nonBlackSamples,
        lumaRange: Number.isFinite(minLuma) ? maxLuma - minLuma : 0,
      };
    },
    { base64: readFileSync(path).toString('base64'), oracle: contract },
  );
  return evaluatePixelOracle(contract, stats);
}

export function classify({ vite, channel, logs, wasm, oracle, runtimeError, readiness }) {
  if (!vite.ready)
    return { class: 'control-plane', detail: vite.error ?? 'Vite did not become ready' };
  if (runtimeError) return { class: 'init', detail: runtimeError };
  if (wasm.some((response) => response.magic !== '0061736d'))
    return { class: 'delivery', detail: 'a WASM response was not a WASM binary' };
  const assetDelivery = logs.find((text) =>
    /asset-not-imported|loadByGuid failed|HTTP 404/i.test(text),
  );
  if (assetDelivery) return { class: 'delivery', detail: assetDelivery };
  const crash = detectWasmCrash(logs.map((text) => ({ text })));
  const fatal = logs.find((text) =>
    /Validation Error|EngineEnvironmentError|webgpu-runtime-error|rhi-not-available|createApp failed|WebAssembly\.Module doesn't parse/i.test(
      text,
    ),
  );
  const capability = logs.find((text) =>
    /(?:Hdrp)?CapsInsufficientError|caps insufficient/i.test(text),
  );
  if (capability && channel?.webgl2 && !channel?.hasGpu)
    return { class: 'capability', detail: capability };
  if (crash || fatal || !channel?.webgl2 || channel?.hasGpu)
    return { class: 'init', detail: crash ?? fatal ?? 'fallback channel was not WebKit WebGL2' };
  if (readiness?.declared && !readiness.observed)
    return {
      class: 'init',
      detail: `readiness flag '${readiness.name}' was not observed within ${readiness.timeoutMs}ms`,
    };
  if (!oracle?.passed)
    return {
      class: 'visual',
      detail:
        oracle?.reason ??
        (oracle?.kind === undefined
          ? 'canvas screenshot had no non-black sample'
          : 'canvas screenshot oracle failed'),
    };
  return null;
}

async function verifyDemo(demo) {
  const dir = artifactPath(demo);
  const resultPath = join(dir, 'attempt-1.json');
  const screenshotPath = join(dir, 'screenshot.png');
  const result = {
    schemaVersion: 1,
    demo,
    attempt: 1,
    execution,
    fresh: { vite: null, webkit: null },
    channel: null,
    wasm: [],
    readiness: null,
    logs: [],
    runtimeError: null,
    oracle: null,
    firstDecisiveFailure: null,
    passed: false,
  };
  let vite;
  try {
    vite = await startVite(demo);
    const url = await vite.url;
    result.fresh.vite = { ready: true, url, port: vite.port, pid: vite.child.pid };
    const browser = await webkit.launch({ headless: true });
    try {
      execution.webkit ??= browser.version();
      result.fresh.webkit = { freshProcess: true, version: browser.version() };
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      page.on('console', (message) => result.logs.push(`${message.type()}: ${message.text()}`));
      page.on('pageerror', (error) => result.logs.push(`pageerror: ${error.message}`));
      const wasmReads = [];
      page.on('response', (response) => {
        if (!new URL(response.url()).pathname.endsWith('.wasm')) return;
        wasmReads.push(
          response
            .body()
            .then((body) => ({
              url: response.url(),
              status: response.status(),
              contentType: response.headers()['content-type'] ?? null,
              magic: body.subarray(0, 4).toString('hex'),
            }))
            .catch((error) => ({
              url: response.url(),
              status: response.status(),
              contentType: response.headers()['content-type'] ?? null,
              magic: null,
              readError: String(error),
            })),
        );
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForFunction(() => document.querySelector('canvas')?.width > 0, undefined, {
        timeout: timeoutMs,
      });
      const readinessContract = readinessForDemo(MATRIX, demo);
      const waitMs = readinessWaitBudget(readinessContract, timeoutMs);
      const startedAt = Date.now();
      if (readinessContract === undefined) {
        await page.waitForTimeout(waitMs);
        result.readiness = { declared: false, observed: null, timeoutMs: waitMs };
      } else {
        let observed = false;
        try {
          await page.waitForFunction((name) => globalThis[name] === true, readinessContract.name, {
            timeout: waitMs,
          });
          observed = true;
        } catch {
          // Keep the screenshot and raw logs. classify() reports the readiness
          // boundary instead of turning a slow import into a visual claim.
        }
        result.readiness = {
          declared: true,
          kind: readinessContract.kind,
          name: readinessContract.name,
          observed,
          timeoutMs: waitMs,
          waitMs: Date.now() - startedAt,
        };
      }
      result.channel = await page.evaluate(() => ({
        hasGpu: !!navigator.gpu,
        webgl2: !!document.createElement('canvas').getContext('webgl2'),
      }));
      result.oracle = await screenshotOracle(page, screenshotPath, MATRIX.oracles?.[demo]);
      result.wasm = await Promise.all(wasmReads);
    } finally {
      await browser.close();
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (result.fresh.vite) result.runtimeError = detail;
    else result.fresh.vite = { ready: false, error: detail };
  } finally {
    if (vite) await stop(vite.child);
  }
  result.firstDecisiveFailure = classify({
    vite: result.fresh.vite ?? { ready: false },
    channel: result.channel,
    logs: result.logs,
    wasm: result.wasm,
    oracle: result.oracle,
    runtimeError: result.runtimeError,
    readiness: result.readiness,
  });
  result.passed = result.firstDecisiveFailure === null;
  writeJson(resultPath, result);
  process.stdout.write(
    `[webkit-learn-render] ${result.passed ? 'PASS' : 'FAIL'} ${demo} evidence=${resultPath}\n`,
  );
  return result;
}

async function main() {
  const demos = demoArg
    ? [demoArg]
    : tier === 'core'
      ? MATRIX.core
      : tier === 'full'
        ? await findDemos()
        : null;
  if (!demos) {
    fail(`unknown tier '${tier}'; use --tier=core, --tier=full, or --demo=<relative-demo-path>`);
  } else {
    process.stdout.write(
      `[webkit-learn-render] tier=${tier} demos=${demos.length} artifacts=${artifactRoot}\n`,
    );
    const results = [];
    for (const demo of demos) results.push(await verifyDemo(demo));
    writeJson(join(artifactRoot, 'summary.json'), {
      schemaVersion: 1,
      execution,
      tier,
      demos: results.map((result) => ({
        demo: result.demo,
        passed: result.passed,
        firstDecisiveFailure: result.firstDecisiveFailure,
      })),
    });
    if (results.some((result) => !result.passed)) process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}
