#!/usr/bin/env node
// game-default production UI proof: Pack v2 -> GUID -> UiAsset -> ShadowRoot.

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import {
  REAL_UI_ASSETS,
  REAL_UI_SCENARIOS,
  REAL_UI_SETTINGS_DEFAULTS,
  REAL_UI_VIEWPORTS,
} from './ui-real-scenario-matrix.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_UI_PRODUCTION_DIR ?? resolve(ROOT, '.forgeax-debug/ui-production'),
);
const MATRIX_REPEATS = 2;
const MATRIX_ARTIFACT_DIR = resolve(ARTIFACT_DIR, 'matrix');
mkdirSync(ARTIFACT_DIR, { recursive: true });
mkdirSync(MATRIX_ARTIFACT_DIR, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

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

function pageQuery(page, expression, args) {
  return page.evaluate(expression, args);
}

async function loadPack(origin) {
  const response = await fetch(`${origin}/pack-index.json`);
  if (!response.ok) throw new Error(`pack-index status=${response.status}`);
  const index = await response.json();
  const entries = Array.isArray(index)
    ? index
    : Array.isArray(index.entries)
      ? index.entries
      : Object.values(index.entries ?? index);
  const rows = {};
  for (const [key, expected] of Object.entries(REAL_UI_ASSETS)) {
    const row = entries.find((entry) => entry.guid === expected.guid && entry.kind === 'ui');
    if (!row) throw new Error(`${key} UI row missing from production pack-index`);
    if (row.name !== expected.name || row.lifecycle !== 'current') {
      throw new Error(`${key} row identity drifted: ${JSON.stringify(row)}`);
    }
    const packageResponse = await fetch(new URL(row.packageUrl, origin));
    if (!packageResponse.ok) throw new Error(`${key} package status=${packageResponse.status}`);
    const packageJson = await packageResponse.json();
    const asset = (packageJson.assets ?? []).find((entry) => entry.guid === expected.guid);
    if (!asset?.payload || asset.kind !== 'ui') throw new Error(`${key} Pack v2 payload is not a UiAsset`);
    if (!asset.payload.html.includes(expected.marker) || typeof asset.payload.css !== 'string') {
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
}

async function boot(page, origin, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(`${origin}/?game=game-default`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    ({ hudGuid, settingsGuid }) => {
      const inspection = globalThis.__forgeaxPreviewInspection;
      const listed = inspection?.list();
      const root = document.querySelector('[data-forgeax-ui-root]');
      const hosts = root ? [...root.querySelectorAll('[data-ui-asset]')] : [];
      const ids = new Set(hosts.map((host) => host.getAttribute('data-ui-asset')));
      const canvas = document.querySelector('#app');
      return inspection !== undefined
        && listed?.actions.some((entry) => entry.id === 'game-default.trigger-score') === true
        && listed?.reads.some((entry) => entry.id === 'game-default.snapshot') === true
        && hosts.length === 2
        && ids.has(hudGuid)
        && ids.has(settingsGuid)
        && hosts.every((host) => host.shadowRoot !== null)
        && canvas instanceof HTMLCanvasElement
        && document.fonts.status === 'loaded';
    },
    { hudGuid: REAL_UI_ASSETS.hud.guid, settingsGuid: REAL_UI_ASSETS.settings.guid },
    { timeout: 30_000 },
  );
}

async function readUi(page) {
  return pageQuery(page, ({ hudGuid, settingsGuid }) => {
    const root = document.querySelector('[data-forgeax-ui-root]');
    const hud = root?.querySelector(`[data-ui-asset="${hudGuid}"]`);
    const settings = root?.querySelector(`[data-ui-asset="${settingsGuid}"]`);
    const hudShadow = hud?.shadowRoot;
    const settingsShadow = settings?.shadowRoot;
    const dialog = settingsShadow?.querySelector('[role="dialog"]');
    const panel = settingsShadow?.querySelector('[role="document"]');
    const music = settingsShadow?.querySelector('[data-ui-setting="music"]');
    const musicMuted = settingsShadow?.querySelector('[data-ui-setting="music-muted"]');
    const highContrast = settingsShadow?.querySelector('[data-ui-setting="high-contrast"]');
    const antialias = settingsShadow?.querySelector('[data-ui-setting="antialias"]');
    const bloom = settingsShadow?.querySelector('[data-ui-setting="bloom"]');
    const depthOfField = settingsShadow?.querySelector('[data-ui-setting="depth-of-field"]');
    const clearColor = settingsShadow?.querySelector('[data-ui-setting="clear-color"]');
    const canvas = document.querySelector('#app');
    if (!(root instanceof HTMLElement) || !hudShadow || !settingsShadow || !dialog || !panel) {
      throw new Error('production UI matrix roots or controls are missing');
    }
    return {
      hosts: root.querySelectorAll('[data-ui-asset]').length,
      shadowRoots: [hudShadow, settingsShadow].filter(Boolean).length,
      fonts: document.fonts.status,
      canvas: canvas instanceof HTMLCanvasElement
        ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight }
        : null,
      hud: {
        score: hudShadow.querySelector('[data-ui-slot="score"]')?.textContent ?? '',
        mission: hudShadow.querySelector('[data-ui-slot="mission"]')?.textContent ?? '',
        targetStatus: hudShadow.querySelector('[data-ui-slot="target-status"]')?.textContent ?? '',
        targetState: hudShadow.querySelector('[data-ui-slot="target-status"]')?.getAttribute('data-state') ?? null,
      },
      settings: {
        hidden: dialog.hidden,
        panelRole: panel.getAttribute('role'),
        activeElementRole: settingsShadow.activeElement?.getAttribute('role') ?? null,
        music: music instanceof HTMLInputElement ? Number(music.value) : null,
        musicMuted: musicMuted instanceof HTMLInputElement ? musicMuted.checked : null,
        highContrast: highContrast instanceof HTMLInputElement ? highContrast.checked : null,
        antialias: antialias instanceof HTMLSelectElement ? antialias.value : null,
        bloom: bloom instanceof HTMLInputElement ? bloom.checked : null,
        depthOfField: depthOfField instanceof HTMLInputElement ? depthOfField.checked : null,
        clearColor: clearColor instanceof HTMLSelectElement ? clearColor.value : null,
      },
    };
  }, { hudGuid: REAL_UI_ASSETS.hud.guid, settingsGuid: REAL_UI_ASSETS.settings.guid });
}

async function readInspection(page) {
  const result = await pageQuery(page, async () => {
    const inspection = globalThis.__forgeaxPreviewInspection;
    if (inspection === undefined) throw new Error('Preview inspection is missing');
    const snapshot = await inspection.read('game-default.snapshot');
    const capture = await inspection.captureFrame(1);
    if (!snapshot.ok) throw new Error(`game snapshot failed: ${JSON.stringify(snapshot)}`);
    return {
      snapshot: {
        phase: snapshot.value?.state?.phase ?? null,
        targetCurrent: snapshot.value?.targetHealth?.totalCurrent ?? null,
        targetMax: snapshot.value?.targetHealth?.totalMax ?? null,
        disabledCount: snapshot.value?.targetDisabling?.disabledCount ?? null,
      },
      capture: capture.ok ? { ok: true } : { ok: false, code: capture.error.code },
    };
  });
  assert(result.snapshot.phase === 'Play', `game-default did not reach Play: ${JSON.stringify(result)}`);
  assert(result.capture.ok === false && result.capture.code === 'rhi-debug-unavailable', `capture boundary drifted: ${JSON.stringify(result.capture)}`);
  return result;
}

async function runScoreActions(page, count) {
  return pageQuery(page, async (actionCount) => {
    const inspection = globalThis.__forgeaxPreviewInspection;
    if (inspection === undefined) throw new Error('Preview inspection is missing');
    const points = [];
    for (let index = 0; index < actionCount; index += 1) {
      const result = await inspection.run('game-default.trigger-score');
      if (!result.ok) throw new Error(`score action failed: ${JSON.stringify(result)}`);
      points.push(result.value?.points ?? null);
    }
    return points;
  }, count);
}

async function waitForProjection(page, expectedScore, expectedMission) {
  await page.waitForFunction(
    ({ hudGuid, expectedScore: score, expectedMission: mission }) => {
      const root = document.querySelector('[data-forgeax-ui-root]');
      const hud = root?.querySelector(`[data-ui-asset="${hudGuid}"]`);
      const shadow = hud?.shadowRoot;
      return shadow?.querySelector('[data-ui-slot="score"]')?.textContent === `Score  ${score}`
        && shadow.querySelector('[data-ui-slot="mission"]')?.textContent?.startsWith(mission) === true;
    },
    { hudGuid: REAL_UI_ASSETS.hud.guid, expectedScore, expectedMission },
    { timeout: 10_000 },
  );
}

async function openModal(page) {
  return pageQuery(page, ({ hudGuid, settingsGuid }) => {
    const root = document.querySelector('[data-forgeax-ui-root]');
    const hud = root?.querySelector(`[data-ui-asset="${hudGuid}"]`);
    const settings = root?.querySelector(`[data-ui-asset="${settingsGuid}"]`);
    const hudShadow = hud?.shadowRoot;
    const settingsShadow = settings?.shadowRoot;
    const canvas = document.querySelector('#app');
    const open = hudShadow?.querySelector('[data-ui-action="open-settings"]');
    const dialog = settingsShadow?.querySelector('[role="dialog"]');
    const panel = settingsShadow?.querySelector('[role="document"]');
    const highContrast = settingsShadow?.querySelector('[data-ui-setting="high-contrast"]');
    if (!(canvas instanceof HTMLCanvasElement) || !(hud instanceof HTMLElement) || !(settings instanceof HTMLElement) || !hudShadow || !settingsShadow || !open || !dialog || !panel || !(highContrast instanceof HTMLInputElement)) {
      throw new Error('modal-focus controls are missing');
    }
    canvas.focus();
    const focusBefore = document.activeElement === canvas;
    open.click();
    const opened = !dialog.hidden;
    const panelFocused = settingsShadow.activeElement === panel;
    const hudInert = hud.inert;
    highContrast.click();
    return { focusBefore, opened, panelFocused, hudInert, contrastChanged: highContrast.checked };
  }, { hudGuid: REAL_UI_ASSETS.hud.guid, settingsGuid: REAL_UI_ASSETS.settings.guid });
}

async function closeModal(page) {
  return pageQuery(page, ({ hudGuid, settingsGuid }) => {
    const root = document.querySelector('[data-forgeax-ui-root]');
    const settings = root?.querySelector(`[data-ui-asset="${settingsGuid}"]`);
    const shadow = settings?.shadowRoot;
    const dialog = shadow?.querySelector('[role="dialog"]');
    const close = shadow?.querySelector('[data-ui-action="close-settings"]');
    const canvas = document.querySelector('#app');
    if (!dialog || !close || !(canvas instanceof HTMLCanvasElement)) throw new Error('modal close action is missing');
    close.click();
    return {
      closed: dialog.hidden,
      restoredFocus: document.activeElement === canvas,
      hudInert: root?.querySelector(`[data-ui-asset="${hudGuid}"]`)?.inert ?? null,
    };
  }, { hudGuid: REAL_UI_ASSETS.hud.guid, settingsGuid: REAL_UI_ASSETS.settings.guid });
}

async function disposePreview(page) {
  await page.evaluate(() => window.postMessage({ type: 'VAG_PREVIEW_DISPOSE' }, '*'));
  await page.waitForFunction(
    () => globalThis.__forgeaxPreviewInspection === undefined && document.querySelector('[data-forgeax-ui-root]') === null,
    null,
    { timeout: 10_000 },
  );
  return page.evaluate(() => ({
    inspection: globalThis.__forgeaxPreviewInspection === undefined,
    uiRoot: document.querySelector('[data-forgeax-ui-root]') === null,
    uiHosts: document.querySelectorAll('[data-ui-asset]').length,
  }));
}

function deterministicEvidence({ viewport, scenario, readiness, projection, ui, initialUi, modal }) {
  return {
    viewport: viewport.id,
    scenario: scenario.id,
    readiness,
    phase: projection.snapshot.phase,
    capture: projection.capture,
    score: ui.hud.score,
    mission: ui.hud.mission,
    targetStatus: ui.hud.targetStatus,
    points: modal === undefined ? projection.points ?? [] : [],
    settings: initialUi.settings,
    modal: modal ?? null,
  };
}

async function executeScenario(page, origin, viewport, scenario, repeat) {
  await boot(page, origin, viewport);
  let disposed = false;
  try {
    const listed = await page.evaluate(() => {
      const list = globalThis.__forgeaxPreviewInspection?.list();
      return {
        actions: list?.actions.map((entry) => entry.id) ?? [],
        reads: list?.reads.map((entry) => entry.id) ?? [],
      };
    });
    const initialUi = await readUi(page);
    const readiness = {
      actions: listed.actions,
      reads: listed.reads,
      hosts: initialUi.hosts,
      shadowRoots: initialUi.shadowRoots,
      fonts: initialUi.fonts,
      canvas: initialUi.canvas,
    };
    assert(initialUi.hosts === 2 && initialUi.shadowRoots === 2, `UI readiness drifted: ${JSON.stringify(readiness)}`);
    assert(initialUi.settings.hidden, 'Settings dialog is not initially hidden');
    assert(initialUi.settings.panelRole === 'document', 'Settings document region is missing');
    for (const [name, expected] of Object.entries(REAL_UI_SETTINGS_DEFAULTS)) {
      assert(initialUi.settings[name] === expected, `Settings default ${name} projection drifted`);
    }

    const points = await runScoreActions(page, scenario.scoreActions);
    const score = points.reduce((total, value) => total + (typeof value === 'number' ? value : 0), 0);
    assert(score === scenario.expectedScore, `${scenario.id} score projection drifted: ${JSON.stringify(points)}`);
    await waitForProjection(page, score, scenario.expectedMission);

    const projection = await readInspection(page);
    projection.points = points;
    const projectedUi = await readUi(page);
    assert(projectedUi.hud.score === `Score  ${score}`, `${scenario.id} HUD score projection failed: ${projectedUi.hud.score}`);
    assert(projectedUi.hud.mission.startsWith(scenario.expectedMission), `${scenario.id} mission projection failed: ${projectedUi.hud.mission}`);

    let modal;
    const screenshotPath = resolve(MATRIX_ARTIFACT_DIR, `${repeat}-${viewport.id}-${scenario.id}.png`);
    if (scenario.id === 'modal-focus') {
      const opened = await openModal(page);
      assert(opened.focusBefore && opened.opened && opened.panelFocused && opened.hudInert && opened.contrastChanged, `modal ownership failed: ${JSON.stringify(opened)}`);
      await page.screenshot({ path: screenshotPath });
      const closed = await closeModal(page);
      assert(closed.closed && closed.restoredFocus && closed.hudInert === false, `modal cleanup failed: ${JSON.stringify(closed)}`);
      modal = { opened, closed };
    } else {
      await page.screenshot({ path: screenshotPath });
    }

    const cleanup = await disposePreview(page);
    disposed = true;
    assert(cleanup.inspection && cleanup.uiRoot && cleanup.uiHosts === 0, `UI cleanup failed: ${JSON.stringify(cleanup)}`);
    return {
      repeat,
      viewport: viewport.id,
      scenario: scenario.id,
      readiness,
      initialUi,
      ui: projectedUi,
      projection,
      modal: modal ?? null,
      screenshot: screenshotPath,
      cleanup,
      deterministic: deterministicEvidence({ viewport, scenario, readiness, projection, ui: projectedUi, initialUi, modal }),
    };
  } finally {
    if (!disposed) {
      try {
        await disposePreview(page);
      } catch {
        // Preserve the original scenario failure; the next browser session is fresh.
      }
    }
  }
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
const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
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
  const pack = await loadPack(origin);
  const cases = [];
  const fingerprints = new Map();
  for (let repeat = 0; repeat < MATRIX_REPEATS; repeat += 1) {
    for (const viewport of REAL_UI_VIEWPORTS) {
      for (const scenario of REAL_UI_SCENARIOS) {
        const result = await executeScenario(page, origin, viewport, scenario, repeat);
        const key = `${viewport.id}:${scenario.id}`;
        const fingerprint = JSON.stringify(result.deterministic);
        const prior = fingerprints.get(key);
        if (prior !== undefined) assert(prior === fingerprint, `non-deterministic UI scenario: ${key}`);
        fingerprints.set(key, fingerprint);
        cases.push(result);
      }
    }
  }

  const report = {
    mode: 'production',
    pack,
    matrix: {
      repeats: MATRIX_REPEATS,
      viewports: REAL_UI_VIEWPORTS,
      scenarios: REAL_UI_SCENARIOS,
      settingsDefaults: REAL_UI_SETTINGS_DEFAULTS,
    },
    cases,
    deterministic: true,
    pageErrors,
    consoleErrors,
    badResponses,
    serverOutput,
  };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (badResponses.length > 0) throw new Error(`bad responses: ${badResponses.join(' | ')}`);
  const actionableConsoleErrors = consoleErrors.filter((line) => !line.includes('favicon') && !line.includes('Failed to load resource'));
  if (actionableConsoleErrors.length > 0) throw new Error(`console errors: ${actionableConsoleErrors.join(' | ')}`);
  assert(cases.length === MATRIX_REPEATS * REAL_UI_VIEWPORTS.length * REAL_UI_SCENARIOS.length, 'matrix case count is incomplete');
  assert(cases.every((entry) => entry.cleanup.uiHosts === 0), 'matrix cleanup evidence is incomplete');
  console.log(`[ui-production] PASS rows=${Object.keys(pack).length} viewports=${REAL_UI_VIEWPORTS.length} scenarios=${REAL_UI_SCENARIOS.length} repeats=${MATRIX_REPEATS} cases=${cases.length} cleared=true pageErrors=${pageErrors.length}`);
  console.log(`[ui-production] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  await stopServer(server);
}
