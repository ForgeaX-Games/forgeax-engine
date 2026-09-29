#!/usr/bin/env node
// Capture the four imported Standard Surface cells through the real Preview
// Pack/Catalog/cook/loadByGuid and ForgeaX WebGL2 renderer path.
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

async function findAvailablePort() {
  const probe = createNetServer();
  await new Promise((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = probe.address();
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  if (address === null || typeof address === 'string') throw new Error('surface-standard: dynamic port unavailable');
  return address.port;
}

export async function runSurfaceStandardSmoke(options = {}) {
  const configuredPort = options.port ?? (process.env.FORGEAX_SURFACE_PORT === undefined
    ? undefined
    : Number.parseInt(process.env.FORGEAX_SURFACE_PORT, 10));
  const port = configuredPort === undefined || configuredPort === 0 ? await findAvailablePort() : configuredPort;
  const outputDir = resolve(options.outputDir ?? process.env.FORGEAX_SURFACE_DIR ?? resolve(ROOT, '.forgeax-debug/surface-standard'));
  mkdirSync(outputDir, { recursive: true });
  const sourceSha = options.sourceSha ?? process.env.VITE_FORGEAX_EVIDENCE_SOURCE_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const buildId = options.buildId ?? process.env.VITE_FORGEAX_EVIDENCE_BUILD_ID ?? `preview-surface-${sourceSha.slice(0, 12)}`;
  const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FORGEAX_SURFACE_PROBE: '1',
      FORGEAX_SURFACE_ONLY: '1',
      VITE_FORGEAX_EVIDENCE_SOURCE_SHA: sourceSha,
      VITE_FORGEAX_EVIDENCE_BUILD_ID: buildId,
    },
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  let browser;
  try {
    // A clean workspace can spend more than 30s in Vite dependency
    // re-optimization before it opens its listener. This is startup allowance
    // only; the four-cell WebGL2 readback and error gates below are unchanged.
    const configuredReadinessMs = Number(process.env.FORGEAX_SURFACE_SERVER_READINESS_TIMEOUT_MS ?? 180_000);
    const readinessTimeoutMs = Number.isFinite(configuredReadinessMs) && configuredReadinessMs > 0
      ? configuredReadinessMs
      : 180_000;
    const deadline = Date.now() + readinessTimeoutMs;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
      } catch {}
      await sleep(250);
    }
    if (Date.now() >= deadline) throw new Error(`Preview server did not start: ${serverOutput}`);
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-features=WebGPU',
        '--disable-gpu',
        '--disable-gpu-driver-bug-workarounds',
        '--no-sandbox',
      ],
    });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    const configuredPageLoadMs = Number(process.env.FORGEAX_SURFACE_PAGE_LOAD_TIMEOUT_MS ?? 120_000);
    const pageLoadTimeoutMs = Number.isFinite(configuredPageLoadMs) && configuredPageLoadMs > 0
      ? configuredPageLoadMs
      : 120_000;
    await page.goto(`http://127.0.0.1:${port}/?game=game-default&surfaceEvidence=1`, {
      waitUntil: 'domcontentloaded',
      timeout: pageLoadTimeoutMs,
    });
    try {
      await page.waitForFunction(
        () => typeof globalThis.__forgeaxSurfaceStandardEvidence === 'function',
        undefined,
        {
          timeout: pageLoadTimeoutMs,
          polling: 100,
        },
      );
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        href: location.href,
        bodyText: document.body.innerText.slice(0, 2000),
        rendererBootstrap: globalThis.__forgeaxRendererBootstrap ?? null,
        inspection: typeof globalThis.__forgeaxPreviewInspection === 'object'
          ? globalThis.__forgeaxPreviewInspection?.list?.()
          : null,
        surfaceEvidenceType: typeof globalThis.__forgeaxSurfaceStandardEvidence,
      }));
      const report = { status: 'unavailable', blocker: { code: 'surface-preview-seam-timeout', detail: diagnostic }, pageErrors, consoleErrors, serverOutput, sourceSha, buildId };
      writeFileSync(resolve(outputDir, 'surface-standard-four-cell.json'), `${JSON.stringify(report, null, 2)}\n`);
      throw new Error(`Surface evidence seam unavailable: ${JSON.stringify({ error: error.message, report })}`);
    }
    const evidence = await page.evaluate(() => globalThis.__forgeaxSurfaceStandardEvidence());
    const report = { evidence, pageErrors, consoleErrors, serverOutput, sourceSha, buildId, port };
    writeFileSync(resolve(outputDir, 'surface-standard-four-cell.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (evidence?.status !== 'pass' || evidence?.cells?.length !== 4) throw new Error(`Surface evidence unavailable: ${JSON.stringify(report)}`);
    if (pageErrors.length > 0 || consoleErrors.length > 0) throw new Error(`Preview errors: ${JSON.stringify({ pageErrors, consoleErrors })}`);
    console.log(`[surface-standard] PASS backend=${evidence.backend} cells=${evidence.cells.length} artifacts=${outputDir}`);
    return report;
  } finally {
    if (browser !== undefined) await browser.close();
    if (server.pid !== undefined) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
    }
    await sleep(300);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runSurfaceStandardSmoke().catch((error) => {
    console.error(`[surface-standard] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
