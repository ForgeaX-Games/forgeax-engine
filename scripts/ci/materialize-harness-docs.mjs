#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const REQUIRED_HARNESS_DOCS = Object.freeze([
  'docs/material-asset-migration.md',
  'docs/vfx-particle-runtime-design.md',
  'docs/reports/2026-08-03-black-screen-diagnosis-review.md',
]);

// A floating harness main can be briefly incomplete while an external
// publication is being repaired. Keep this bounded so a genuinely missing
// contract still produces a red gate with useful evidence.
export const RETRY_DELAYS_MS = Object.freeze([0, 10_000, 30_000]);

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function runHarnessSync(rootDir, env) {
  return spawnSync(process.execPath, [resolve(rootDir, 'scripts/sync-harness.mjs')], {
    cwd: rootDir,
    env,
    stdio: 'inherit',
  });
}

export function missingHarnessDocs(rootDir, requiredDocs = REQUIRED_HARNESS_DOCS) {
  return requiredDocs.filter(
    (document) => !existsSync(resolve(rootDir, '.forgeax-harness', document)),
  );
}

export async function materializeHarnessDocs({
  rootDir = ROOT,
  requiredDocs = REQUIRED_HARNESS_DOCS,
  retryDelaysMs = RETRY_DELAYS_MS,
  sync = runHarnessSync,
  sleepFn = sleep,
  env = process.env,
  log = (message) => process.stderr.write(message),
} = {}) {
  let missing = requiredDocs;

  for (const [index, delay] of retryDelaysMs.entries()) {
    if (delay > 0) {
      log(
        `[harness:docs] retrying harness materialization in ${delay / 1000}s ` +
          `(attempt ${index + 1}/${retryDelaysMs.length})\n`,
      );
      await sleepFn(delay);
    }

    let syncResult;
    try {
      syncResult = sync(rootDir, env);
    } catch (error) {
      log(
        `[harness:docs] harness sync invocation failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return { ok: false, attempts: index + 1, missing, syncStatus: null };
    }

    if (syncResult?.status !== 0) {
      const syncStatus = syncResult?.status ?? null;
      log(`[harness:docs] harness sync failed with status ${syncStatus}\n`);
      return { ok: false, attempts: index + 1, missing, syncStatus };
    }

    missing = missingHarnessDocs(rootDir, requiredDocs);
    if (missing.length === 0) {
      return { ok: true, attempts: index + 1, missing: [], syncStatus: 0 };
    }

    if (index + 1 < retryDelaysMs.length) {
      log(
        `[harness:docs] attempt ${index + 1}/${retryDelaysMs.length} is missing: ` +
          `${missing.join(', ')}\n`,
      );
    }
  }

  log(
    `[harness:docs] required harness documentation is still missing after ` +
      `${retryDelaysMs.length} attempt(s): ${missing.join(', ')}\n`,
  );
  return {
    ok: false,
    attempts: retryDelaysMs.length,
    missing,
    syncStatus: 0,
  };
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const result = await materializeHarnessDocs();
  if (!result.ok) process.exitCode = 1;
}
