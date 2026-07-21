#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}
function error(code, detail) {
  process.stdout.write(
    `${JSON.stringify({
      code,
      expected: detail.expected ?? 'declared app-dist inventory',
      detail: detail.detail ?? detail,
      hint: detail.hint ?? 'Rebuild the shard artifact and verify its declared inventory.',
      ...detail,
    })}\n`,
  );
  process.exit(1);
}
function readJson(path, code) {
  if (!existsSync(path)) error(code, { path });
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    error('ci-shard-inventory-invalid', { path });
  }
}

const root = resolve(arg('--root') ?? '.');
const reportsDir = resolve(arg('--reports-dir') ?? 'shard-reports');
const selectionPath = arg('--selection');
const selection = selectionPath
  ? readJson(resolve(selectionPath), 'ci-provenance-merged-missing')
  : null;
const expectedApps = (() => {
  const result = [];
  const walk = (relative = '') => {
    for (const entry of readdirSync(join(root, 'apps', relative), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      const manifestPath = join(root, 'apps', next, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.scripts?.build === 'string') result.push(next);
      } else walk(next);
    }
  };
  walk();
  return result.sort();
})();

function selectedAttempt(index) {
  const producer = `app-shard-${index}`;
  const attempt = selection?.producerAttempts?.[producer];
  if (attempt === undefined) return null;
  if (!Number.isInteger(attempt) || attempt < 1)
    error('ci-shard-selection-invalid', { producer, attempt });
  return attempt;
}
function latestReportPath(prefix, index, code) {
  const selected = selectedAttempt(index);
  if (selected !== null) return join(reportsDir, `${prefix}-${index}-a${selected}.json`);
  const legacy = join(reportsDir, `${prefix}-${index}.json`);
  if (existsSync(legacy)) return legacy;
  const matches = readdirSync(reportsDir)
    .map((name) => {
      const match = name.match(new RegExp(`^${prefix}-${index}-a(\\d+)\\.json$`));
      return match ? { name, attempt: Number(match[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.attempt - a.attempt);
  if (matches.length === 0) error(code, { shardIndex: index, reportsDir });
  return join(reportsDir, matches[0].name);
}

const reports = [0, 1, 2].map((index) =>
  readJson(
    latestReportPath('coverage', index, 'ci-app-shard-report-missing'),
    'ci-app-shard-report-missing',
  ),
);
const inventories = [0, 1, 2].map((index) =>
  readJson(
    latestReportPath('artifact-inventory', index, 'ci-shard-inventory-missing'),
    'ci-shard-inventory-missing',
  ),
);
const seenPaths = new Map();
for (const [index, inventory] of inventories.entries()) {
  if (!Array.isArray(inventory) || inventory.some((path) => typeof path !== 'string'))
    error('ci-shard-inventory-invalid', { shardIndex: index });
  for (const path of inventory) {
    if (path.startsWith('shared-app-inputs/'))
      error('ci-shard-inventory-shared-payload', {
        shardIndex: index,
        path,
        expected: 'app-dist paths only',
        hint: 'Do not include shared-app-inputs payloads in an app-shard inventory.',
      });
    if (
      !/^apps\/[^/]+(?:\/[^/]+)*\/dist\/shaders\/manifest\.json$/.test(path) ||
      path.includes('..')
    )
      error('ci-shard-inventory-invalid-path', { shardIndex: index, path });
    if (seenPaths.has(path))
      error('ci-shard-inventory-path-intersection', { path, shards: [seenPaths.get(path), index] });
    seenPaths.set(path, index);
  }
}
for (const [index, report] of reports.entries()) {
  const required = report.requiredArtifactInventory;
  if (required === undefined) continue;
  if (!Array.isArray(required) || required.some((path) => typeof path !== 'string'))
    error('ci-shard-inventory-required-invalid', { shardIndex: index, required });
  const actual = new Set(inventories[index]);
  const missing = required.find((path) => !actual.has(path));
  if (missing)
    error('ci-shard-inventory-required-file-missing', {
      shardIndex: index,
      expected: required,
      detail: { missing, actual: inventories[index] },
      hint: 'Upload every shard-required app-dist file before aggregation.',
    });
}
const plannedPaths = new Set(
  reports.flatMap((report) => report.apps.map((app) => `apps/${app}/dist/shaders/manifest.json`)),
);
for (const path of seenPaths.keys())
  if (!plannedPaths.has(path)) error('ci-shard-inventory-unknown-app', { path });
for (const [index, inventory] of inventories.entries())
  for (const path of inventory) {
    const app = path.match(/^apps\/(.+)\/dist\/shaders\/manifest\.json$/)?.[1];
    if (!reports[index].apps.includes(app))
      error('ci-shard-inventory-cross-app-path', {
        shardIndex: index,
        path,
        expected: reports[index].apps,
        hint: 'Keep each app-dist path in the shard that built that app.',
      });
  }

const apps = [];
for (const report of reports) {
  if (report.result !== 'success')
    error('ci-app-shard-terminal-failure', {
      shardIndex: report.shardIndex,
      result: report.result,
    });
  if (!Array.isArray(report.apps)) error('ci-app-shard-report-invalid', { report });
  apps.push(...report.apps);
}
const duplicate = apps.find((app, index) => apps.indexOf(app) !== index);
if (duplicate) error('ci-app-shard-duplicate-app', { app: duplicate });
const actual = new Set(apps);
const missing = expectedApps.find((app) => !actual.has(app));
if (missing) error('ci-app-shard-missing-app', { app: missing });
const unknown = apps.find((app) => !expectedApps.includes(app));
if (unknown) error('ci-app-shard-unknown-app', { app: unknown });
process.stdout.write(
  `${JSON.stringify({ status: 'success', shards: reports.map((report) => report.shardIndex), apps: expectedApps })}\n`,
);
