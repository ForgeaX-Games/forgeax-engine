#!/usr/bin/env node
// Real Chromium evidence probe for the focused carrier.
//
// It captures compositor PNGs and the renderer inspection from both frozen
// URLs. This is intentionally independent from the Vitest browser shard.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.env.POINTS_LINES_PORT ?? 5187);
const BASE_URL = process.env.POINTS_LINES_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const OUTPUT_DIR = process.env.POINTS_LINES_EVIDENCE_DIR ?? mkdtempSync(join(tmpdir(), 'forgeax-points-lines-'));
const CASES = [
  { name: 'webgpu', query: '?evidenceLane=webgpu' },
  { name: 'wgpu-webgl2', query: '?evidenceLane=wgpu-webgl2' },
];
const FALSIFIERS = [
  'point-square',
  'line-width',
  'dpr',
  'resize',
  'depth-sort',
  'alpha',
  'sort',
  'frustum',
  'lane',
];

function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveReady, reject) => {
    const probe = async () => {
      try {
        const response = await fetch(url);
        if (response.ok) return resolveReady();
      } catch {
        // The child server may still be starting.
      }
      if (Date.now() >= deadline) return reject(new Error(`server did not start: ${url}`));
      setTimeout(probe, 100);
    };
    void probe();
  });
}

function launchServer() {
  if (process.env.POINTS_LINES_BASE_URL !== undefined) return undefined;
  const server = spawn('pnpm', ['--filter', '@forgeax/hello-topology', 'dev', '--host', '127.0.0.1', '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.output = [];
  server.stdout.on('data', (chunk) => server.output.push(String(chunk)));
  server.stderr.on('data', (chunk) => server.output.push(String(chunk)));
  return server;
}

function stopServer(server) {
  if (server === undefined) return;
  server.kill('SIGTERM');
}

const server = launchServer();
let browser;
try {
  await waitForServer(`${BASE_URL}/`);
  browser = await chromium.launch({
    channel: process.env.POINTS_LINES_CHROME_CHANNEL ?? 'chrome',
    headless: process.env.POINTS_LINES_HEADLESS !== '0',
    args: ['--enable-unsafe-webgpu'],
  });
  const results = [];
  for (const testCase of CASES) {
    const context = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${BASE_URL}/${testCase.query}`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForFunction(() => window.__pointsLinesEvidence !== undefined, undefined, { timeout: 10000 });
    const evidence = await page.evaluate(() => ({
      inspection: window.__pointsLinesEvidence.inspect(),
      evidenceLane: window.__pointsLinesEvidence.evidenceLane,
      backend: window.__pointsLinesEvidence.backendKind,
      validationErrors: window.__pointsLinesEvidence.validationErrors,
      authoring: window.__pointsLinesEvidence.authoring,
    }));
    const inspection = evidence.inspection;
    const screenshotPath = join(OUTPUT_DIR, `${testCase.name}-640x360-dpr1.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    const screenshotBytes = readFileSync(screenshotPath).byteLength;
    const point = inspection.find((entry) => entry.component === 'Points');
    const line = inspection.find((entry) => entry.component === 'Lines');
    const runtimeReady = inspection.length === 2 && inspection.every(
      (entry) => entry.lane !== 'pending' && entry.lane !== 'refused' && entry.drawCount > 0 && entry.sourceBytes > 0,
    ) && point?.style?.kind === 'points' && point.style.sizePx === 16 && point.style.shape === 'circle'
      && line?.style?.kind === 'lines' && line.style.widthPx === 4;
    const laneMatches = evidence.validationErrors === 0
      && evidence.evidenceLane === testCase.name
      && evidence.backend === testCase.name
      && inspection.every((entry) => testCase.name === 'webgpu' ? entry.lane === 'direct' : entry.lane === 'cpu-webgl2');
    const entry = {
      expectation: { evidenceLane: testCase.name, screenshotBytes: '> 0', validationErrors: 0 },
      observed: {
        evidenceLane: evidence.evidenceLane,
        backend: evidence.backend,
        authoring: evidence.authoring,
        inspection,
        screenshotBytes,
        validationErrors: errors.length + evidence.validationErrors,
      },
      verdict: screenshotBytes > 0 && errors.length === 0 && runtimeReady && laneMatches ? 'pass' : 'blocked',
      confidence: screenshotBytes > 0 && errors.length === 0 && runtimeReady && laneMatches ? 'medium' : 'low',
      artifact: screenshotPath,
    };
    results.push(entry);
    await context.close();
  }
  const falsifiers = [];
  for (const name of FALSIFIERS) {
    const lane = name === 'lane' ? 'wgpu-webgl2' : 'webgpu';
    const context = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: name === 'dpr' ? 2 : 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${BASE_URL}/?evidenceLane=${lane}&falsify=${name}`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForFunction(() => window.__pointsLinesEvidence !== undefined, undefined, { timeout: 10000 });
    if (name === 'resize') {
      await page.setViewportSize({ width: 800, height: 450 });
      await page.waitForTimeout(100);
    }
    const evidence = await page.evaluate(() => ({
      inspection: window.__pointsLinesEvidence.inspect(),
      backend: window.__pointsLinesEvidence.backendKind,
      validationErrors: window.__pointsLinesEvidence.validationErrors,
      authoring: window.__pointsLinesEvidence.authoring,
      viewport: window.__pointsLinesEvidence.viewport,
    }));
    const point = evidence.inspection.find((entry) => entry.component === 'Points');
    const line = evidence.inspection.find((entry) => entry.component === 'Lines');
    const falsified = name === 'point-square'
      ? point?.style?.shape === 'square'
      : name === 'line-width'
        ? line?.style?.widthPx === 1
        : name === 'dpr'
          ? evidence.viewport?.dpr === 2
          : name === 'resize'
            ? evidence.viewport?.width === 800 && evidence.viewport?.height === 450
        : name === 'depth-sort'
          ? evidence.authoring.depthWriteEnabled === false
          : name === 'alpha'
            ? evidence.authoring.alpha === 0.4
            : name === 'sort'
              ? evidence.authoring.sortQueue === 3001
              : name === 'frustum'
                ? evidence.authoring.frustumMarginPx === 8
                : evidence.backend === 'wgpu-webgl2';
    falsifiers.push({
      name,
      status: falsified && errors.length === 0 ? 'pass' : 'blocked',
      observed: { backend: evidence.backend, authoring: evidence.authoring, validationErrors: errors.length },
    });
    await context.close();
  }
  const output = { cases: results, falsifiers };
  const reportPath = join(OUTPUT_DIR, 'browser-readback.json');
  writeFileSync(reportPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ ...output, reportPath }));
  if (results.some((entry) => entry.verdict !== 'pass') || falsifiers.some((entry) => entry.status !== 'pass')) {
    process.exitCode = 1;
  }
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  const output = server?.output?.join('') ?? '';
  console.error(`[smoke-browser] BLOCKED: ${detail}${output === '' ? '' : `\n${output}`}`);
  process.exitCode = 2;
} finally {
  await browser?.close();
  stopServer(server);
}
