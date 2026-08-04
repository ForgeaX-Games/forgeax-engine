#!/usr/bin/env node
// game-default production UI proof: Pack v2 -> GUID -> UiAsset -> ShadowRoot.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_UI_PRODUCTION_DIR ?? resolve(ROOT, '.forgeax-debug/ui-production'),
);
const UI = {
  hud: { guid: '019f8354-6386-4386-849d-f2ab4b96229c', name: 'hud.pack.json', marker: 'data-ui-slot="score"' },
  settings: { guid: '019f8354-6386-4387-849d-f2ab4b9622a0', name: 'settings.pack.json', marker: 'data-ui-setting="music"' },
};
const CYCLES = 3;
mkdirSync(ARTIFACT_DIR, { recursive: true });

async function availablePort() {
  const probe = createNetServer();
  await new Promise((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('could not allocate a TCP port');
  const port = address.port;
  await new Promise((resolvePromise, reject) => probe.close((error) => (error ? reject(error) : resolvePromise())));
  return port;
}

async function stopServer(server) {
  if (server?.pid === undefined) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
  await sleep(300);
}

async function waitForPreview(origin, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/`);
      if (response.ok) return;
    } catch {
      // Vite Preview is still starting.
    }
    await sleep(250);
  }
  throw new Error(`production Preview did not start: ${output}`);
}

const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn(
  'pnpm',
  ['--filter', '@forgeax/preview', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
    badResponses.push(`${response.status()} ${response.url()}`);
  }
});

try {
  await waitForPreview(origin, serverOutput);
  const pack = await (async () => {
    const response = await fetch(`${origin}/pack-index.json`);
    if (!response.ok) throw new Error(`pack-index status=${response.status}`);
    const index = await response.json();
    const entries = Array.isArray(index)
      ? index
      : Array.isArray(index.entries)
        ? index.entries
        : Object.values(index.entries ?? index);
    const rows = {};
    for (const [key, value] of Object.entries(UI)) {
      const row = entries.find((entry) => entry.guid === value.guid && entry.kind === 'ui');
      if (!row) throw new Error(`${key} UI row missing from production pack-index`);
      if (row.name !== value.name || row.lifecycle !== 'current') {
        throw new Error(`${key} row identity drifted: ${JSON.stringify(row)}`);
      }
      const packageResponse = await fetch(new URL(row.packageUrl, origin));
      if (!packageResponse.ok) throw new Error(`${key} package status=${packageResponse.status}`);
      const packageJson = await packageResponse.json();
      const asset = (packageJson.assets ?? []).find((entry) => entry.guid === value.guid);
      if (!asset?.payload || asset.kind !== 'ui') throw new Error(`${key} Pack v2 payload is not a UiAsset`);
      if (!asset.payload.html.includes(value.marker) || typeof asset.payload.css !== 'string') {
        throw new Error(`${key} payload marker/style is missing`);
      }
      rows[key] = {
        guid: row.guid,
        kind: row.kind,
        name: row.name,
        packageUrl: row.packageUrl,
        htmlBytes: asset.payload.html.length,
        cssBytes: asset.payload.css.length,
      };
    }
    return rows;
  })();

  const cycles = [];
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    await page.goto(`${origin}/?game=game-default`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => {
      const listed = globalThis.__forgeaxPreviewInspection?.list();
      const root = document.querySelector('[data-forgeax-ui-root]');
      const hosts = root ? [...root.querySelectorAll('[data-ui-asset]')] : [];
      return (listed?.actions.length ?? 0) === 4 && (listed?.reads.length ?? 0) === 2 && hosts.length === 2 && hosts.every((host) => host.shadowRoot !== null);
    }, null, { timeout: 30_000 });

    const interaction = await page.evaluate(() => {
      const root = document.querySelector('[data-forgeax-ui-root]');
      if (!(root instanceof HTMLElement)) throw new Error('production UI root is missing');
      const hud = root.querySelector('[data-ui-asset="019f8354-6386-4386-849d-f2ab4b96229c"]');
      const settings = root.querySelector('[data-ui-asset="019f8354-6386-4387-849d-f2ab4b9622a0"]');
      const hudShadow = hud?.shadowRoot;
      const settingsShadow = settings?.shadowRoot;
      if (!hudShadow || !settingsShadow) throw new Error('production UI ShadowRoot is missing');
      const open = hudShadow.querySelector('[data-ui-action="open-settings"]');
      const dialog = settingsShadow.querySelector('[role="dialog"]');
      const highContrast = settingsShadow.querySelector('[data-ui-setting="high-contrast"]');
      const close = settingsShadow.querySelector('[data-ui-action="close-settings"]');
      if (!open || !dialog || !highContrast || !close) throw new Error('production UI controls are missing');
      const initiallyHidden = dialog.hidden;
      open.click();
      const opened = !dialog.hidden && settingsShadow.activeElement === settingsShadow.querySelector('[role="document"]');
      highContrast.click();
      const contrastChanged = highContrast.checked;
      close.click();
      const closed = dialog.hidden;
      return {
        hosts: root.querySelectorAll('[data-ui-asset]').length,
        hudScore: hudShadow.querySelector('[data-ui-slot="score"]')?.textContent ?? '',
        initiallyHidden,
        opened,
        contrastChanged,
        closed,
      };
    });
    if (!interaction.initiallyHidden || !interaction.opened || !interaction.contrastChanged || !interaction.closed) {
      throw new Error(`production UI interaction failed: ${JSON.stringify(interaction)}`);
    }
    const inspection = await page.evaluate(async () => ({
      snapshot: await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'),
      capture: await globalThis.__forgeaxPreviewInspection?.captureFrame(1),
    }));
    if (!inspection.snapshot?.ok || inspection.snapshot.value.state.phase !== 'Play') {
      throw new Error(`production game did not reach Play: ${JSON.stringify(inspection.snapshot)}`);
    }
    if (inspection.capture?.ok !== false || inspection.capture.error?.code !== 'rhi-debug-unavailable') {
      throw new Error(`production capture boundary drifted: ${JSON.stringify(inspection.capture)}`);
    }
    await page.screenshot({ path: resolve(ARTIFACT_DIR, `cycle-${cycle}.png`) });
    await page.evaluate(() => window.postMessage({ type: 'VAG_PREVIEW_DISPOSE' }, '*'));
    await page.waitForFunction(() => globalThis.__forgeaxPreviewInspection === undefined && document.querySelector('[data-forgeax-ui-root]') === null, null, { timeout: 10_000 });
    cycles.push({ cycle, interaction, inspection, cleared: true });
  }

  const report = { mode: 'production', pack, cycles, pageErrors, consoleErrors, badResponses, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (badResponses.length > 0) throw new Error(`bad responses: ${badResponses.join(' | ')}`);
  const actionableConsoleErrors = consoleErrors.filter((line) => !line.includes('favicon') && !line.includes('Failed to load resource'));
  if (actionableConsoleErrors.length > 0) throw new Error(`console errors: ${actionableConsoleErrors.join(' | ')}`);
  console.log(`[ui-production] PASS rows=${Object.keys(pack).length} cycles=${cycles.length} cleared=${cycles.every((entry) => entry.cleared)} pageErrors=${pageErrors.length}`);
  console.log(`[ui-production] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  await stopServer(server);
}
