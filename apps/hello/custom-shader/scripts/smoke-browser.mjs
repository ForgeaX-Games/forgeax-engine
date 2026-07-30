#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const APP = '@forgeax/hello-custom-shader';
const ROOT = new URL('../../../..', import.meta.url).pathname;

function waitForServer(process) {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Local:\s+(https?:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    };
    process.stdout.on('data', onData);
    process.stderr.on('data', onData);
    process.once('exit', (code) => reject(new Error(`vite exited before ready: ${code}\n${output}`)));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function falsificationVariant() {
  if (process.env.FORGEAX_FALSIFY_MISSING_PARENT === '1') return 'missing-derived-parent';
  if (process.env.FORGEAX_FALSIFY_UV0_TRANSFORM === '1') return 'uv0-transform-loss';
  return undefined;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJson(entry)]),
    );
  }
  return value;
}

const vite = spawn('pnpm', ['-F', APP, 'dev', '--', '--host', '127.0.0.1'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  const url = await waitForServer(vite);
  browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const variant = falsificationVariant();
  const targetUrl = variant === undefined ? url : `${url}?falsify=${variant}`;
  await page.goto(targetUrl, { waitUntil: 'networkidle' });
  if (variant === 'missing-derived-parent') {
    const marker = `FALSIFY_EXPECTED_FAILURE:${variant}`;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !consoleErrors.some((entry) => entry.includes(marker))) {
      await delay(100);
    }
    assert(consoleErrors.some((entry) => entry.includes(marker)), 'missing-parent falsification was not attributed');
    throw new Error(marker);
  }
  if (variant === 'uv0-transform-loss') {
    await page.waitForFunction(() => globalThis.__forgeaxMaterialEvidence?.ready === true, null, {
      timeout: 5000,
    });
    const evidence = await page.evaluate(() => globalThis.__forgeaxMaterialEvidence);
    assert(
      JSON.stringify(stableJson(evidence.renderedSamplingInput)) !==
        JSON.stringify(stableJson(evidence.resolvedSamplingInput)),
      'UV0 falsification did not change the rendered sampling input',
    );
    throw new Error(`FALSIFY_EXPECTED_FAILURE:${variant}`);
  }
  await page.waitForFunction(() => globalThis.__forgeaxMaterialEvidence?.ready === true, null, {
    timeout: 30000,
  });
  const evidence = await page.evaluate(() => globalThis.__forgeaxMaterialEvidence);
  assert(evidence.browserPath === true, 'browser evidence did not use the Vite path');
  assert(evidence.webgpu === true, 'browser evidence did not reach WebGPU');
  assert(evidence.rootGuid !== evidence.derivedGuid, 'root and derived GUIDs must remain distinct');
  assert(evidence.rootArtifactDigest === evidence.derivedArtifactDigest, 'cooked artifacts diverged');
  assert(evidence.rootCookInputDigest === evidence.derivedCookInputDigest, 'specialization inputs diverged');
  assert(
    JSON.stringify(stableJson(evidence.values)) === JSON.stringify(stableJson(evidence.resolvedValues)),
    'browser values do not match the runtime-resolved record',
  );
  assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join('; ')}`);
  console.log(
    JSON.stringify({
      status: 'pass',
      browserPath: evidence.browserPath,
      rootArtifactDigest: evidence.rootArtifactDigest,
      derivedArtifactDigest: evidence.derivedArtifactDigest,
      rootCookInputDigest: evidence.rootCookInputDigest,
    }),
  );
} catch (error) {
  const variant = falsificationVariant();
  if (variant !== undefined) console.error(`FALSIFY_EXPECTED_FAILURE:${variant}`);
  console.error(`custom-shader browser smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  vite.kill('SIGTERM');
  await delay(100);
}
