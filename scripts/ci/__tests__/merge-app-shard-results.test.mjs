import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const mergerPath = join(repoRoot, 'scripts', 'ci', 'merge-app-shard-results.mjs');

function paths(apps) {
  return apps.map((app) => `apps/${app}/dist/shaders/manifest.json`);
}

function fixture({ reports, inventories }) {
  const root = mkdtempSync(join(tmpdir(), 'merge-app-shards-'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  const allApps = ['alpha', 'beta', 'gamma'];
  for (const app of allApps) {
    const appDir = join(root, 'apps', app);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: app, scripts: { build: 'true' } }),
    );
  }
  const reportsDir = join(root, 'reports');
  mkdirSync(reportsDir);
  for (const [index, report] of reports.entries()) {
    writeFileSync(join(reportsDir, `coverage-${index}.json`), JSON.stringify(report));
    if (inventories[index] !== undefined) {
      writeFileSync(
        join(reportsDir, `artifact-inventory-${index}.json`),
        JSON.stringify(inventories[index]),
      );
    }
  }
  return { root, reportsDir };
}

function validReports() {
  return [
    { shardIndex: 0, result: 'success', apps: ['alpha'] },
    { shardIndex: 1, result: 'success', apps: ['beta'] },
    { shardIndex: 2, result: 'success', apps: ['gamma'] },
  ];
}

function run(root, reportsDir) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [mergerPath, '--root', root, '--reports-dir', reportsDir],
      {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return { exitCode: 0, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    return {
      exitCode: error.status ?? 1,
      stdout: error.stdout?.toString().trim() ?? '',
      stderr: error.stderr?.toString().trim() ?? '',
    };
  }
}

test('t13: merges three successful exact-once coverage reports', () => {
  const reports = validReports();
  const { root, reportsDir } = fixture({
    reports,
    inventories: reports.map((report) => paths(report.apps)),
  });
  try {
    const result = run(root, reportsDir);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).status, 'success');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t13: rejects failed, cancelled, skipped, duplicate, and missing app coverage', () => {
  const scenarios = [
    {
      reports: [{ shardIndex: 0, result: 'failure', apps: ['alpha'] }, ...validReports().slice(1)],
    },
    {
      reports: [
        { shardIndex: 0, result: 'cancelled', apps: ['alpha'] },
        ...validReports().slice(1),
      ],
    },
    {
      reports: [{ shardIndex: 0, result: 'skipped', apps: ['alpha'] }, ...validReports().slice(1)],
    },
    {
      reports: [
        { shardIndex: 0, result: 'success', apps: ['alpha', 'beta'] },
        ...validReports().slice(1),
      ],
    },
    {
      reports: [
        { shardIndex: 0, result: 'success', apps: ['alpha'] },
        { shardIndex: 1, result: 'success', apps: [] },
        validReports()[2],
      ],
    },
  ];
  for (const scenario of scenarios) {
    const { root, reportsDir } = fixture({
      reports: scenario.reports,
      inventories: scenario.reports.map((report) => paths(report.apps)),
    });
    try {
      const result = run(root, reportsDir);
      assert.notEqual(result.exitCode, 0);
      assert.match(JSON.parse(result.stdout).code, /^(?:ci-app-shard-|ci-shard-inventory-)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('t12c: validates complete disjoint repo-relative manifest inventories before coverage', () => {
  const reports = validReports();
  const { root, reportsDir } = fixture({
    reports,
    inventories: reports.map((report) => paths(report.apps)),
  });
  try {
    const pass = run(root, reportsDir);
    assert.equal(pass.exitCode, 0, pass.stderr || pass.stdout);

    writeFileSync(join(reportsDir, 'artifact-inventory-1.json'), JSON.stringify(['../escape']));
    const invalidPath = run(root, reportsDir);
    assert.notEqual(invalidPath.exitCode, 0);
    assert.equal(JSON.parse(invalidPath.stdout).code, 'ci-shard-inventory-invalid-path');

    writeFileSync(join(reportsDir, 'artifact-inventory-1.json'), JSON.stringify(paths(['alpha'])));
    const intersection = run(root, reportsDir);
    assert.notEqual(intersection.exitCode, 0);
    assert.equal(JSON.parse(intersection.stdout).code, 'ci-shard-inventory-path-intersection');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repair: permits build apps without Vite artifact output', () => {
  const reports = validReports();
  const { root, reportsDir } = fixture({
    reports,
    inventories: [paths(['alpha']), paths(['beta']), []],
  });
  try {
    const result = run(root, reportsDir);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('t12c: rejects a missing or invalid inventory', () => {
  const reports = validReports();
  const { root, reportsDir } = fixture({
    reports,
    inventories: [paths(['alpha']), paths(['beta'])],
  });
  try {
    const missing = run(root, reportsDir);
    assert.notEqual(missing.exitCode, 0);
    assert.equal(JSON.parse(missing.stdout).code, 'ci-shard-inventory-missing');
    writeFileSync(join(reportsDir, 'artifact-inventory-2.json'), '{');
    const invalid = run(root, reportsDir);
    assert.notEqual(invalid.exitCode, 0);
    assert.equal(JSON.parse(invalid.stdout).code, 'ci-shard-inventory-invalid');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('w17: rejects shared, cross-app, unknown, and incomplete shard inventories structurally', () => {
  const reports = validReports();
  const scenarios = [
    {
      inventory: ['shared-app-inputs/assets/catalog.json'],
      code: 'ci-shard-inventory-shared-payload',
    },
    {
      inventory: paths(['beta']),
      inventories: [paths(['beta']), [], paths(['gamma'])],
      code: 'ci-shard-inventory-cross-app-path',
    },
    {
      inventory: ['apps/missing/dist/shaders/manifest.json'],
      code: 'ci-shard-inventory-unknown-app',
    },
    { inventory: [], required: true, code: 'ci-shard-inventory-required-file-missing' },
  ];
  for (const { inventory, inventories, required, code } of scenarios) {
    const scenarioReports = structuredClone(reports);
    if (required) scenarioReports[0].requiredArtifactInventory = paths(['alpha']);
    const { root, reportsDir } = fixture({
      reports: scenarioReports,
      inventories: inventories ?? [inventory, paths(['beta']), paths(['gamma'])],
    });
    try {
      const result = run(root, reportsDir);
      assert.notEqual(result.exitCode, 0);
      const failure = JSON.parse(result.stdout);
      assert.equal(failure.code, code);
      assert.ok('expected' in failure);
      assert.ok('detail' in failure);
      assert.ok('hint' in failure);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
