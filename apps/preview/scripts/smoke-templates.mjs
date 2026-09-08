#!/usr/bin/env node
// The CI smoke owns the shortest real browser path for every engine template:
// Preview host -> template bootstrap -> WebGPU frame loop. Runtime browser
// errors are the oracle. game-default keeps its deeper gameplay projection
// assertions; every other template must at least load, start, size its canvas,
// and leave the renderer alive.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const TEMPLATES_ROOT = resolve(ROOT, 'templates');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_TEMPLATE_SMOKE_DIR ?? resolve(ROOT, '.forgeax-debug/templates'),
);
const PORT = Number.parseInt(process.env.FORGEAX_TEMPLATE_SMOKE_PORT ?? '5201', 10);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME_CHANNEL = process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome';
const SELECTED_TEMPLATE_SLUGS = (process.env.FORGEAX_TEMPLATE_SMOKE_SLUGS ?? '')
  .split(',')
  .map((slug) => slug.trim())
  .filter((slug) => slug.length > 0);

function discoverTemplates() {
  let entries = readdirSync(TEMPLATES_ROOT, { withFileTypes: true })
    .filter((entry) => (
      entry.isDirectory()
      && !entry.name.startsWith('.')
      && !entry.name.startsWith('_')
      && entry.name !== 'node_modules'
    ))
    // A stale package-local node_modules directory can survive a template
    // removal in a contributor checkout. It is not a template and must not
    // turn the discovery pass into a false missing-manifest failure.
    .filter((entry) => {
      const children = readdirSync(join(TEMPLATES_ROOT, entry.name), { withFileTypes: true });
      return !(children.length === 1 && children[0]?.name === 'node_modules');
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) throw new Error(`no engine templates found under ${TEMPLATES_ROOT}`);
  if (SELECTED_TEMPLATE_SLUGS.length > 0) {
    const selected = new Set(SELECTED_TEMPLATE_SLUGS);
    const available = new Set(entries.map((entry) => entry.name));
    const missing = [...selected].filter((slug) => !available.has(slug));
    if (missing.length > 0) throw new Error(`unknown engine templates: ${missing.join(', ')}`);
    entries = entries.filter((entry) => selected.has(entry.name));
  }

  return entries.map((entry) => {
    const root = join(TEMPLATES_ROOT, entry.name);
    const manifestPath = join(root, 'forge.json');
    if (!existsSync(manifestPath)) throw new Error(`${entry.name}: missing forge.json`);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`${entry.name}: invalid forge.json: ${String(error)}`);
    }
    if (
      manifest === null
      || typeof manifest !== 'object'
      || typeof manifest.id !== 'string'
      || typeof manifest.name !== 'string'
      || typeof manifest.entry !== 'string'
      || manifest.entry.length === 0
    ) {
      throw new Error(`${entry.name}: forge.json must declare string id, name, and entry`);
    }
    const entryPath = resolve(root, manifest.entry);
    const relativeEntry = relative(root, entryPath);
    if (
      relativeEntry.length === 0
      || relativeEntry === '..'
      || relativeEntry.startsWith(`..${sep}`)
      || isAbsolute(relativeEntry)
    ) {
      throw new Error(`${entry.name}: forge.json entry must stay inside the template`);
    }
    if (!existsSync(entryPath)) {
      throw new Error(`${entry.name}: missing forge.json entry ${manifest.entry}`);
    }
    return {
      slug: entry.name,
      id: manifest.id,
      name: manifest.name,
      entry: manifest.entry,
      manifest,
    };
  });
}

const templates = discoverTemplates();
mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn(
  'pnpm',
  [
    '--filter',
    '@forgeax/preview',
    'exec',
    'vite',
    '--host',
    '127.0.0.1',
    '--port',
    String(PORT),
    '--strictPort',
  ],
  { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

let browser;
let page;
let activeEvidence;
const templateEvidence = [];

function browserEvidence() {
  return { templates: templateEvidence, serverOutput };
}

function writeReport(status, extra = {}) {
  writeFileSync(
    resolve(ARTIFACT_DIR, 'report.json'),
    `${JSON.stringify({ status, ...extra, ...browserEvidence() }, null, 2)}\n`,
  );
}

function stopServer() {
  if (server.pid === undefined) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
}

function unexpectedConsoleErrors(template, evidence) {
  return evidence.consoleErrors.filter((message) => (
    !(template.manifest.defaultScene === undefined && message.includes('render-system-no-camera'))
  ));
}

async function waitForDefaultGame(page, evidence) {
  await page.waitForFunction(
    () => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-default.snapshot') ?? false,
    undefined,
    { timeout: 30_000, polling: 100 },
  );
  const deadline = Date.now() + 30_000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
    if (snapshot?.ok && snapshot.value.state?.phase === 'Play' && snapshot.value.state.fixedTicks > 0) break;
    await sleep(100);
  }
  if (!snapshot?.ok || snapshot.value.state?.phase !== 'Play' || snapshot.value.state.fixedTicks <= 0) {
    throw new Error(`game-default did not reach Play: ${JSON.stringify(snapshot)}`);
  }
  evidence.snapshot = snapshot;
  const renderer = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.renderer-contract'));
  evidence.renderer = renderer;
  if (!renderer?.ok) throw new Error(`game-default renderer projection failed: ${JSON.stringify(renderer)}`);
  const listed = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.list());
  if (listed.actions.length === 0 || listed.reads.length === 0) {
    throw new Error(`game-default inspection is empty: ${JSON.stringify(listed)}`);
  }
}

async function smokeTemplate(template, evidence) {
  await page.goto(`${ORIGIN}/?game=${encodeURIComponent(template.slug)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => {
      const inspection = globalThis.__forgeaxPreviewInspection;
      const canvas = document.querySelector('canvas');
      const state = inspection?.renderer.health()?.reason;
      return inspection !== undefined
        && state === 'alive'
        && (canvas?.width ?? 0) > 0
        && (canvas?.height ?? 0) > 0;
    },
    undefined,
    { timeout: 30_000, polling: 100 },
  );
  await page.evaluate(() => new Promise((done) => {
    let frames = 0;
    const tick = () => {
      frames += 1;
      if (frames >= 10) {
        done();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));

  const probe = await page.evaluate(() => {
    const inspection = globalThis.__forgeaxPreviewInspection;
    if (inspection === undefined) throw new Error('Preview inspection global is unavailable');
    return {
      listed: inspection.list(),
      state: inspection.renderer.health(),
      canvas: {
        width: document.querySelector('canvas')?.width ?? 0,
        height: document.querySelector('canvas')?.height ?? 0,
      },
    };
  });
  evidence.probe = probe;
  evidence.expectedConsoleErrors = evidence.consoleErrors.filter((message) => (
    template.manifest.defaultScene === undefined
    && message.includes('render-system-no-camera')
  ));
  if (probe.state.reason !== 'alive') throw new Error(`${template.slug} renderer is not alive: ${JSON.stringify(probe.state)}`);
  if (probe.canvas.width <= 0 || probe.canvas.height <= 0) {
    throw new Error(`${template.slug} canvas has no drawable size: ${JSON.stringify(probe.canvas)}`);
  }
  if (template.slug === 'game-default') await waitForDefaultGame(page, evidence);

  const unexpected = unexpectedConsoleErrors(template, evidence);
  if (evidence.pageErrors.length > 0) throw new Error(`${template.slug} page errors: ${evidence.pageErrors.join(' | ')}`);
  if (unexpected.length > 0) throw new Error(`${template.slug} console errors: ${unexpected.join(' | ')}`);
  if (evidence.badResponses.length > 0) throw new Error(`${template.slug} bad responses: ${evidence.badResponses.join(' | ')}`);
}

try {
  const serverDeadline = Date.now() + 30_000;
  while (Date.now() < serverDeadline) {
    try {
      const response = await fetch(`${ORIGIN}/`);
      if (response.ok) break;
    } catch {
      // Vite is still starting.
    }
    await sleep(250);
  }
  if (Date.now() >= serverDeadline) throw new Error(`Preview server did not start: ${serverOutput}`);

  browser = await chromium.launch({
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    channel: CHROME_CHANNEL,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader',
      '--disable-vulkan-surface',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => { activeEvidence?.pageErrors.push(error.message); });
  page.on('console', (message) => {
    if (message.type() === 'error') activeEvidence?.consoleErrors.push(`${message.text()} @ ${message.location().url}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) activeEvidence?.badResponses.push(`${response.status()} ${response.url()}`);
  });

  for (const template of templates) {
    const evidence = {
      slug: template.slug,
      id: template.id,
      name: template.name,
      pageErrors: [],
      consoleErrors: [],
      badResponses: [],
    };
    templateEvidence.push(evidence);
    activeEvidence = evidence;
    await smokeTemplate(template, evidence);
    evidence.status = 'passed';
    console.log(`[${template.slug}] PASS id=${template.id} name=${template.name}`);
  }

  writeReport('passed');
  console.log(`[templates] PASS count=${templates.length} artifacts=${ARTIFACT_DIR}`);
} catch (error) {
  writeReport('failed', { error: String(error) });
  throw new Error(`${String(error)}\nBrowser evidence: ${JSON.stringify(browserEvidence())}`);
} finally {
  await browser?.close();
  stopServer();
  await sleep(300);
}
