import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'ci', 'materialize-app-shader-manifests.mjs');

test('materializes only missing app shader manifests from the shared producer', () => {
  const root = mkdtempSync(join(tmpdir(), 'materialize-app-shaders-'));
  try {
    const shared = join(root, 'shared-app-inputs');
    const source = join(shared, 'shaders', 'manifest.json');
    mkdirSync(join(shared, 'shaders'), { recursive: true });
    writeFileSync(source, '{"entries":[]}');
    writeFileSync(
      join(shared, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        producer: 'shared-app-inputs',
        payload: { engineShaderManifest: 'shared-app-inputs/shaders/manifest.json' },
      }),
    );

    const missingDist = join(root, 'apps', 'alpha', 'dist', 'pack-index.json');
    mkdirSync(join(missingDist, '..'), { recursive: true });
    writeFileSync(missingDist, '[]');
    const existingManifest = join(root, 'apps', 'beta', 'dist', 'shaders', 'manifest.json');
    mkdirSync(join(existingManifest, '..'), { recursive: true });
    writeFileSync(existingManifest, '{"entries":["custom"]}');
    mkdirSync(join(root, 'apps', 'gamma'), { recursive: true });
    writeFileSync(
      join(root, 'apps', 'gamma', 'package.json'),
      JSON.stringify({ scripts: { build: 'vite build' } }),
    );
    mkdirSync(join(root, 'apps', 'alpha'), { recursive: true });
    writeFileSync(
      join(root, 'apps', 'alpha', 'package.json'),
      JSON.stringify({ scripts: { build: 'vite build' } }),
    );
    mkdirSync(join(root, 'apps', 'beta'), { recursive: true });
    writeFileSync(
      join(root, 'apps', 'beta', 'package.json'),
      JSON.stringify({ scripts: { build: 'vite build' } }),
    );

    const output = execFileSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
    const report = JSON.parse(output);
    assert.deepEqual(report.materialized, [
      { app: 'alpha', path: 'apps/alpha/dist/shaders/manifest.json' },
      { app: 'gamma', path: 'apps/gamma/dist/shaders/manifest.json' },
    ]);
    assert.equal(
      readFileSync(join(root, 'apps/alpha/dist/shaders/manifest.json'), 'utf8'),
      '{"entries":[]}',
    );
    assert.equal(readFileSync(existingManifest, 'utf8'), '{"entries":["custom"]}');
    assert.equal(
      readFileSync(join(root, 'apps/gamma/dist/shaders/manifest.json'), 'utf8'),
      '{"entries":[]}',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts the flat extraction layout used by smoke consumers', () => {
  const root = mkdtempSync(join(tmpdir(), 'materialize-app-shaders-flat-'));
  try {
    const source = join(root, 'shaders', 'manifest.json');
    mkdirSync(join(root, 'shaders'), { recursive: true });
    writeFileSync(source, '{"entries":[]}');
    writeFileSync(
      join(root, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        producer: 'shared-app-inputs',
        payload: { engineShaderManifest: 'shared-app-inputs/shaders/manifest.json' },
      }),
    );

    const appRoot = join(root, 'apps', 'alpha');
    mkdirSync(join(appRoot, 'dist'), { recursive: true });
    writeFileSync(
      join(appRoot, 'package.json'),
      JSON.stringify({ scripts: { build: 'vite build' } }),
    );

    const output = execFileSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
    const report = JSON.parse(output);
    assert.deepEqual(report.materialized, [
      { app: 'alpha', path: 'apps/alpha/dist/shaders/manifest.json' },
    ]);
    assert.equal(
      readFileSync(join(appRoot, 'dist/shaders/manifest.json'), 'utf8'),
      '{"entries":[]}',
    );
    assert.equal(
      readFileSync(join(root, 'shared-app-inputs/shaders/manifest.json'), 'utf8'),
      '{"entries":[]}',
    );
    assert.equal(existsSync(join(root, 'manifest.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
