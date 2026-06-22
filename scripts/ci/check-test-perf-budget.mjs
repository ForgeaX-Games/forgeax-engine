#!/usr/bin/env node
// check-test-perf-budget.mjs — CI regression guard for vitest per-file timing.
// Reads vitest `--reporter=json` output (single JSON object or ndjson) from
// stdin. Computes ms/it per file from `testResults[].duration` and
// `assertionResults.length`. Fails when ms/it > 200 && it < 3 — a single
// slow test in a near-empty file signals a merge candidate.
// To falsify: add a `.only` on a slow-case-rich describe in a new test file.
// Exempt via `// @perf-budget-skip` comment in the file.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const THRESHOLD_MS_PER_IT = 200;
const MIN_IT_FOR_EXEMPTION = 3;

/** Check if a file path contains `// @perf-budget-skip` in its first 20 lines. */
function hasSkipComment(fileName) {
  const absPath = resolve(fileName);
  try {
    const head = readFileSync(absPath, 'utf-8').split('\n').slice(0, 20).join('\n');
    return head.includes('@perf-budget-skip');
  } catch {
    return false;
  }
}

/** Parse ndjson or single JSON from stdin. Returns array of vitest report objects. */
function parseInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Try single JSON object (vitest --reporter=json produces one object).
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return [obj];
    }
  } catch {
    // Not single JSON, fall through to ndjson.
  }

  // Try ndjson: one JSON object per line.
  const reports = [];
  for (const line of trimmed.split('\n')) {
    const lt = line.trim();
    if (!lt) continue;
    try {
      reports.push(JSON.parse(lt));
    } catch (err) {
      process.stderr.write(`[parse-error] Failed to parse JSON line: ${err.message}\n`);
      process.exit(2);
    }
  }
  return reports;
}

/** Extract per-file metrics from vitest reports. */
function extractFiles(reports) {
  const files = [];
  for (const report of reports) {
    const testResults = report?.testResults;
    if (!Array.isArray(testResults)) continue;
    for (const tr of testResults) {
      const name = tr.name;
      const duration = typeof tr.duration === 'number' ? tr.duration : 0;
      const assertionResults = tr.assertionResults;
      const itCount = Array.isArray(assertionResults)
        ? assertionResults.filter((a) => a.status !== 'todo').length
        : 0;
      files.push({ name, duration, itCount });
    }
  }
  return files;
}

function main() {
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf-8');
    let reports;
    try {
      reports = parseInput(raw);
    } catch (err) {
      process.stderr.write(`[parse-error] ${err.message}\n`);
      process.exit(2);
    }

    const files = extractFiles(reports);

    for (const file of files) {
      if (!file.name) continue;

      // @perf-budget-skip exemption.
      if (hasSkipComment(file.name)) continue;

      const itCount = file.itCount;
      const ms = file.duration;

      if (itCount === 0) continue;

      const msPerIt = ms / itCount;

      // Exemption: >= 3 tests in the file (large file, not a merge candidate).
      if (itCount >= MIN_IT_FOR_EXEMPTION) continue;

      // Threshold check.
      if (msPerIt > THRESHOLD_MS_PER_IT) {
        const result = {
          code: 'ci-perf-regression-guard',
          expected: 'ms/it <= 200 || it >= 3',
          actual: `${file.name} ${ms.toFixed(0)}ms / ${itCount} it = ${msPerIt.toFixed(0)} ms/it`,
          hint: '\u5408\u5E76\u5230\u540C\u529F\u80FD\u57DF\u6587\u4EF6\uFF08\u53C2\u8003 bind-group-cache-{keying,binding,frame}\uFF09\u6216\u62C6 fixture\uFF08merge into same-domain files like bind-group-cache-{keying,binding,frame} or split fixtures\uFF09',
        };
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exit(1);
      }
    }

    process.exit(0);
  });

  // Handle no stdin.
  process.stdin.on('close', () => {
    process.exit(0);
  });
}

main();
