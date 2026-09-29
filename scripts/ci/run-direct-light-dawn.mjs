#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIRECT_LIGHT_DAWN_TEST_FILE } from './dawn-gate-roster.mjs';
import { runBrowserCommand } from './run-browser-gate-with-retry.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(scriptDirectory, '../..');
export { DIRECT_LIGHT_DAWN_TEST_FILE };

export const DIRECT_LIGHT_DAWN_TEST_NAMES = Object.freeze([
  'captures one fixed spot-shadow scene through paired URP and HDRP Dawn producers',
  'reports HDRP spot-shadow falsifier pixels for an external baseline comparison',
  ...['urp/base', 'urp/clearcoat', 'hdrp/base', 'hdrp/clearcoat'].map(
    (pair) => `keeps no-caster and no-shadow-allocation as real-pixel falsifiers (${pair})`,
  ),
  'changes a fog-disabled surface for the same SpotLight projector in shadowed and projector-only paths',
  'loads the required light, import, pipeline, and finite budget fields',
  'does not promote a final-only Dawn readback to paired parity evidence',
  'keeps light metadata and readback status in the case report',
  'requires a real Dawn adapter before evidence can be recorded',
  ...['directional', 'point', 'spot', 'khr-spot'].map(
    (kind) => `captures independent HDRP producer evidence (${kind})`,
  ),
  'projects a live HDRP capture into an explicit artifact',
]);

export const DIRECT_LIGHT_DAWN_PARTITIONS = Object.freeze([
  Object.freeze({
    id: 'paired-producers',
    tests: Object.freeze([DIRECT_LIGHT_DAWN_TEST_NAMES[0]]),
  }),
  Object.freeze({
    id: 'contracts-and-artifact',
    // The optional metrics assertion returns before GPU work unless its
    // dedicated producer enables it. Keep it with the contract assertions so
    // the complete PR gate does not pay for an otherwise empty native process.
    tests: Object.freeze([
      DIRECT_LIGHT_DAWN_TEST_NAMES[1],
      ...DIRECT_LIGHT_DAWN_TEST_NAMES.slice(7, 11),
      DIRECT_LIGHT_DAWN_TEST_NAMES[15],
    ]),
  }),
  ...DIRECT_LIGHT_DAWN_TEST_NAMES.slice(2, 6).map((name, index) =>
    Object.freeze({
      id: `real-pixel-falsifiers-${index + 1}`,
      tests: Object.freeze([name]),
    }),
  ),
  Object.freeze({
    id: 'projector-surface',
    tests: Object.freeze([DIRECT_LIGHT_DAWN_TEST_NAMES[6]]),
  }),
  ...[DIRECT_LIGHT_DAWN_TEST_NAMES.slice(11, 13), DIRECT_LIGHT_DAWN_TEST_NAMES.slice(13, 15)].map(
    (tests, index) =>
      Object.freeze({
        id: `hdrp-producers-${index + 1}`,
        tests: Object.freeze(tests),
      }),
  ),
]);

// The complete roster is the vitest-dawn gate. The color-lighting metrics
// producer only needs the HDRP captures that it joins with the browser URP
// artifacts; rerunning the falsifiers and contract-only assertions there was
// a second, redundant native-GPU workload. Keep that reduced scope explicit
// and fail closed for any unknown value.
export const DIRECT_LIGHT_DAWN_SCOPES = Object.freeze({
  complete: DIRECT_LIGHT_DAWN_PARTITIONS,
  producer: Object.freeze(
    DIRECT_LIGHT_DAWN_PARTITIONS.filter((partition) => partition.id.startsWith('hdrp-producers-')),
  ),
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function testNamePattern(testNames) {
  if (!Array.isArray(testNames) || testNames.length === 0) {
    throw new Error('direct-light Dawn partition must contain at least one test');
  }
  return `(?:${testNames.map(escapeRegExp).join('|')})$`;
}

function allAssertionResults(report) {
  if (report?.success !== true) {
    throw new Error('Vitest JSON report did not declare success');
  }
  if (!Array.isArray(report?.testResults)) {
    throw new Error('Vitest JSON report is missing testResults');
  }
  const results = report.testResults.flatMap((suite) => suite?.assertionResults ?? []);
  if (results.length !== DIRECT_LIGHT_DAWN_TEST_NAMES.length) {
    throw new Error(
      `direct-light Dawn roster changed: expected ${DIRECT_LIGHT_DAWN_TEST_NAMES.length} tests, got ${results.length}`,
    );
  }
  return results;
}

export function validatePartitionReport(report, partition) {
  const roster = new Set(DIRECT_LIGHT_DAWN_TEST_NAMES);
  const expected = new Set(partition.tests);
  if (expected.size !== partition.tests.length) {
    throw new Error(`direct-light Dawn partition ${partition.id} contains a duplicate test`);
  }
  for (const testName of expected) {
    if (!roster.has(testName)) {
      throw new Error(
        `direct-light Dawn partition ${partition.id} contains an unknown test: ${testName}`,
      );
    }
  }

  const results = allAssertionResults(report);
  const seen = new Set();
  const selected = [];
  for (const result of results) {
    if (!roster.has(result?.title)) {
      throw new Error(
        `direct-light Dawn report contains an unknown test: ${result?.title ?? '<missing>'}`,
      );
    }
    if (seen.has(result.title)) {
      throw new Error(`direct-light Dawn report contains a duplicate test: ${result.title}`);
    }
    seen.add(result.title);
    if (expected.has(result.title)) {
      if (result.status !== 'passed') {
        throw new Error(
          `direct-light Dawn partition ${partition.id} did not pass ${result.title}: ${result.status}`,
        );
      }
      selected.push(result.title);
    } else if (result.status !== 'skipped') {
      throw new Error(
        `direct-light Dawn partition ${partition.id} unexpectedly ran ${result.title}: ${result.status}`,
      );
    }
  }
  if (selected.length !== expected.size || selected.some((testName) => !expected.has(testName))) {
    throw new Error(
      `direct-light Dawn partition ${partition.id} did not select its exact test set`,
    );
  }
  if (seen.size !== roster.size) {
    throw new Error(`direct-light Dawn report did not contain the complete test roster`);
  }
  return selected;
}

function boundedDiagnosticText(value) {
  if (typeof value === 'string') return value.slice(0, 1000);
  try {
    return JSON.stringify(value).slice(0, 1000);
  } catch {
    return String(value).slice(0, 1000);
  }
}

/**
 * Keep a failed native run attributable even when Vitest exits before the
 * normal summary. The JSON reporter intentionally omits unhandled errors, so
 * this bounded projection is printed alongside the default reporter output;
 * it never changes the fail-closed exit or roster validation below.
 */
export function summarizePartitionReport(report) {
  const suites = Array.isArray(report?.testResults) ? report.testResults : [];
  const assertions = suites.flatMap((suite) => suite?.assertionResults ?? []);
  return {
    success: report?.success ?? null,
    assertions: assertions
      .filter((result) => result?.status !== 'passed' && result?.status !== 'skipped')
      .map((result) => ({
        title: result?.title ?? '<missing>',
        status: result?.status ?? '<missing>',
        failureMessages: Array.isArray(result?.failureMessages)
          ? result.failureMessages.map(boundedDiagnosticText).slice(0, 3)
          : [],
      }))
      .slice(0, 20),
    suites: suites
      .flatMap((suite) => [
        ...(suite?.message === undefined || suite.message === '' ? [] : [suite.message]),
        ...(Array.isArray(suite?.failureMessages) ? suite.failureMessages : []),
      ])
      .map(boundedDiagnosticText)
      .slice(0, 20),
    unhandledErrors: Array.isArray(report?.unhandledErrors)
      ? report.unhandledErrors.map(boundedDiagnosticText).slice(0, 20)
      : [],
  };
}

function resolveVitestCli() {
  const candidates = [
    resolve(ROOT, 'node_modules/vitest/vitest.mjs'),
    resolve(ROOT, 'node_modules/vitest/dist/cli.js'),
  ];
  const cliPath = candidates.find((candidate) => {
    try {
      readFileSync(candidate);
      return true;
    } catch {
      return false;
    }
  });
  if (cliPath === undefined) throw new Error('cannot resolve the workspace Vitest CLI');
  return cliPath;
}

async function runPartition({ cliPath, partition, reportPath, env }) {
  const args = [
    cliPath,
    'run',
    '--project=dawn',
    '--passWithNoTests=false',
    DIRECT_LIGHT_DAWN_TEST_FILE,
    '--testNamePattern',
    testNamePattern(partition.tests),
    '--maxWorkers=1',
    '--retry=0',
    '--bail=1',
    '--no-file-parallelism',
    '--reporter=default',
    '--reporter=json',
    '--outputFile',
    reportPath,
  ];
  process.stdout.write(`[direct-light-dawn] ${partition.id}: ${partition.tests.join(' | ')}\n`);
  const result = await runBrowserCommand([process.execPath, ...args], {
    cwd: ROOT,
    env: { ...env, FORGEAX_DAWN_PARTITION: partition.id },
    label: `Dawn direct-light ${partition.id}`,
    // Preserve the existing ten-minute full-frame test budget, with one
    // minute for startup and teardown before reclaiming a stuck native tree.
    timeoutMs: 11 * 60_000,
  });
  return { code: result.status, signal: result.signal };
}

export async function runDirectLightDawn({ env = process.env } = {}) {
  const scope = env.FORGEAX_DAWN_PARTITION_SCOPE ?? 'complete';
  const partitions = DIRECT_LIGHT_DAWN_SCOPES[scope];
  if (partitions === undefined) {
    throw new Error(
      `unknown direct-light Dawn partition scope ${scope}; expected one of ${Object.keys(DIRECT_LIGHT_DAWN_SCOPES).join(', ')}`,
    );
  }
  const covered = new Set();
  for (const partition of partitions) {
    for (const testName of partition.tests) {
      if (covered.has(testName)) {
        throw new Error(`direct-light Dawn partition overlap: ${testName}`);
      }
      covered.add(testName);
    }
  }
  if (scope === 'complete' && covered.size !== DIRECT_LIGHT_DAWN_TEST_NAMES.length) {
    throw new Error(
      `direct-light Dawn partition roster is incomplete: ${covered.size}/${DIRECT_LIGHT_DAWN_TEST_NAMES.length}`,
    );
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-direct-light-dawn-'));
  try {
    const cliPath = resolveVitestCli();
    for (const [index, partition] of partitions.entries()) {
      const reportPath = join(tempRoot, `${index + 1}-${partition.id}.json`);
      const result = await runPartition({ cliPath, partition, reportPath, env });
      let report;
      try {
        report = JSON.parse(readFileSync(reportPath, 'utf8'));
      } catch (error) {
        if (result.code !== 0 || result.signal !== null) {
          process.stderr.write(
            `[direct-light-dawn] ${partition.id}: no JSON diagnostics (${error instanceof Error ? error.message : error})\n`,
          );
        } else {
          throw new Error(
            `direct-light Dawn partition ${partition.id} did not produce a readable JSON report: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
      if (result.code !== 0 || result.signal !== null) {
        if (report !== undefined) {
          process.stderr.write(
            `[direct-light-dawn] ${partition.id}: diagnostics ${JSON.stringify(summarizePartitionReport(report))}\n`,
          );
        }
        throw new Error(
          `direct-light Dawn partition ${partition.id} failed: ${
            result.signal === null ? `exit-${result.code}` : `signal-${result.signal}`
          }`,
        );
      }
      const selected = validatePartitionReport(report, partition);
      process.stdout.write(
        `[direct-light-dawn] ${partition.id}: passed ${selected.length}/${partition.tests.length}\n`,
      );
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  process.stdout.write(
    `[direct-light-dawn] PASS scope=${scope} partitions=${partitions.length} tests=${covered.size}\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDirectLightDawn().catch((error) => {
    console.error(`[direct-light-dawn] FAIL ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
