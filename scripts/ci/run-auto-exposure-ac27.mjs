#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const REVISION = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const RECEIVER_READY_TIMEOUT_MS = 30_000;
const RECEIVER_EXIT_TIMEOUT_MS = 10_000;

function option(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name) {
  const value = option(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function run(command, args, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolveResult();
      else reject(new Error(`${command} ${args.join(' ')} exited ${code ?? signal}`));
    });
  });
}

async function receiver(port, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      'scripts/ci/auto-exposure-ac27.mjs',
      'receiver',
      `--port=${port}`,
      `--output-dir=${outputDir}`,
    ],
    {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  await new Promise((resolveReady, rejectReady) => {
    let output = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectReady(
        new Error(`AC-27 receiver did not become ready within ${RECEIVER_READY_TIMEOUT_MS}ms`),
      );
    }, RECEIVER_READY_TIMEOUT_MS);
    const cleanup = () => clearTimeout(timeout);
    const onData = (chunk) => {
      output += chunk;
      if (output.includes('\n')) {
        child.stdout.off('data', onData);
        cleanup();
        resolveReady();
      }
    };
    child.stdout.on('data', onData);
    child.once('error', (error) => {
      cleanup();
      rejectReady(error);
    });
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        cleanup();
        rejectReady(new Error(`AC-27 receiver exited ${code}`));
      }
    });
  });
  return child;
}

function waitForExit(child) {
  return new Promise((resolveExit) => {
    let settled = false;
    let timeout;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveExit();
    };
    timeout = setTimeout(() => {
      child.kill('SIGKILL');
      settle();
    }, RECEIVER_EXIT_TIMEOUT_MS);
    child.once('exit', settle);
    if (child.exitCode !== null) settle();
  });
}

async function runLane({ lane, port, outputDir, head, build }) {
  const laneDir = resolve(outputDir, lane);
  mkdirSync(laneDir, { recursive: true });
  const receiverProcess = await receiver(port, laneDir);
  const common = {
    FORGEAX_AUTO_EXPOSURE_AC27_SCHEDULED: '1',
    FORGEAX_AUTO_EXPOSURE_AC27_TESTED_REVISION: head,
    FORGEAX_AUTO_EXPOSURE_AC27_WIDTH: '128',
    FORGEAX_AUTO_EXPOSURE_AC27_HEIGHT: '128',
    FORGEAX_AUTO_EXPOSURE_AC27_REFERENCE_LANE: lane,
  };
  try {
    await run(
      'pnpm',
      [
        'vitest',
        'run',
        '--project=dawn',
        'apps/parity/color-lighting/src/visual/__tests__/auto-exposure-three-r184.dawn.test.ts',
      ],
      {
        ...common,
        FORGEAX_AUTO_EXPOSURE_AC27_BACKEND: 'dawn',
        FORGEAX_AUTO_EXPOSURE_AC27_RUNNER_ID: `dawn-three-r184-${lane}`,
        FORGEAX_AUTO_EXPOSURE_AC27_OUTPUT: resolve(outputDir, `three-${lane}-dawn.json`),
      },
    );
    await run(
      'xvfb-run',
      [
        '-a',
        'pnpm',
        'vitest',
        'run',
        '--config',
        'config/vitest.browser.config.ts',
        '--project=browser',
        'apps/parity/color-lighting/src/visual/__tests__/auto-exposure-three-r184.browser.test.ts',
      ],
      {
        ...common,
        FORGEAX_CHROME_CHANNEL: 'chrome-beta',
        FORGEAX_BROWSER_HEADLESS: '0',
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_SCHEDULED: '1',
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_TESTED_REVISION: head,
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_WIDTH: '128',
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_HEIGHT: '128',
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_REFERENCE_LANE: lane,
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_BACKEND: 'browser-webgpu',
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_RUNNER_ID: `chrome-three-r184-${lane}`,
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_OUTPUT: resolve(laneDir, 'three-browser.json'),
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_OUTPUT_URL: `http://127.0.0.1:${port}/three`,
      },
    );
    renameSync(
      resolve(laneDir, 'three-browser.json'),
      resolve(outputDir, `three-${lane}-browser.json`),
    );
    await run(
      'pnpm',
      [
        'vitest',
        'run',
        '--project=dawn',
        'apps/parity/color-lighting/src/visual/__tests__/auto-exposure-forgeax.dawn.test.ts',
      ],
      {
        FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_SCHEDULED: '1',
        FORGEAX_AUTO_EXPOSURE_AC27_BACKEND: 'dawn',
        FORGEAX_AUTO_EXPOSURE_AC27_TESTED_REVISION: head,
        FORGEAX_AUTO_EXPOSURE_AC27_WIDTH: '128',
        FORGEAX_AUTO_EXPOSURE_AC27_HEIGHT: '128',
        FORGEAX_AUTO_EXPOSURE_AC27_REFERENCE_LANE: lane,
        FORGEAX_AUTO_EXPOSURE_AC27_RUNNER_ID: `dawn-forgeax-${lane}`,
        FORGEAX_AUTO_EXPOSURE_AC27_BUILD: build,
        FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_OUTPUT: resolve(outputDir, `forgeax-${lane}-dawn.json`),
      },
    );
    await run(
      'xvfb-run',
      [
        '-a',
        'pnpm',
        'vitest',
        'run',
        '--config',
        'config/vitest.browser.config.ts',
        '--project=browser',
        'apps/parity/color-lighting/src/visual/__tests__/auto-exposure-forgeax.browser.test.ts',
      ],
      {
        FORGEAX_CHROME_CHANNEL: 'chrome-beta',
        FORGEAX_BROWSER_HEADLESS: '0',
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_SCHEDULED: '1',
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_BACKEND: 'browser-webgpu',
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_TESTED_REVISION: head,
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_WIDTH: '128',
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_HEIGHT: '128',
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_REFERENCE_LANE: lane,
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_RUNNER_ID: `chrome-forgeax-${lane}`,
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_BUILD: build,
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_OUTPUT: resolve(laneDir, 'forgeax-browser.json'),
        VITE_FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_OUTPUT_URL: `http://127.0.0.1:${port}/forgeax`,
      },
    );
    renameSync(
      resolve(laneDir, 'forgeax-browser.json'),
      resolve(outputDir, `forgeax-${lane}-browser.json`),
    );
  } finally {
    receiverProcess.kill('SIGTERM');
    await waitForExit(receiverProcess);
  }
  await run(process.execPath, [
    'scripts/ci/auto-exposure-ac27.mjs',
    'join',
    `--three=${resolve(outputDir, `three-${lane}-browser.json`)}`,
    `--forgeax=${resolve(outputDir, `forgeax-${lane}-browser.json`)}`,
    `--output=${resolve(outputDir, `${lane}-browser-join.json`)}`,
  ]);
  await run(process.execPath, [
    'scripts/ci/auto-exposure-ac27.mjs',
    'join',
    `--three=${resolve(outputDir, `three-${lane}-dawn.json`)}`,
    `--forgeax=${resolve(outputDir, `forgeax-${lane}-dawn.json`)}`,
    `--output=${resolve(outputDir, `${lane}-dawn-join.json`)}`,
  ]);
}

const head = required('head');
if (!REVISION.test(head)) throw new Error('AC-27 --head must be an exact lowercase commit SHA');
const outputDir = resolve(required('output-dir'));
mkdirSync(outputDir, { recursive: true });
const build = execFileSync(
  process.execPath,
  ['scripts/ci/auto-exposure-ac27.mjs', 'digest', '--dist', 'apps/hello/taa/dist'],
  { cwd: ROOT, encoding: 'utf8' },
).trim();
await runLane({ lane: 'direct', port: Number(option('port', '39101')), outputDir, head, build });
await runLane({
  lane: 'clustered',
  port: Number(option('port-clustered', '39102')),
  outputDir,
  head,
  build,
});
