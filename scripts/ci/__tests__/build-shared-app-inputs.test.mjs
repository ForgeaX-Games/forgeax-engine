import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'ci', 'build-shared-app-inputs.mjs');

test('shared inputs preserve both raw source paths and Vite-emitted asset paths', () => {
  const output = mkdtempSync(join(tmpdir(), 'forgeax-shared-inputs-'));
  const projection = `${output}-projection`;
  try {
    const result = spawnSync(
      process.execPath,
      [script, '--root', repoRoot, '--out', output, '--projection-out', projection],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const catalog = JSON.parse(readFileSync(join(output, 'assets', 'catalog.json'), 'utf8'));
    assert.equal(
      catalog.some((entry) => entry.sourcePath.endsWith('meshes/cube-mesh.stub')),
      false,
      'runtime-generated procedural mesh stubs are not shared Pack inputs',
    );
    const bleep = catalog.find((entry) => entry.sourcePath.endsWith('audio/bleep.mp3'));
    assert.ok(bleep, 'shared catalog includes the raw audio entry');
    const packagePath = bleep.packageUrl?.replace(/^\/+/, '');
    assert.ok(packagePath, 'shared catalog includes the cooked package URL');
    assert.ok(existsSync(join(output, 'assets', 'payload', packagePath)));
    assert.ok(existsSync(join(output, 'assets', 'payload', 'assets')));
    const projectedManifest = JSON.parse(readFileSync(join(projection, 'manifest.json'), 'utf8'));
    assert.deepEqual(projectedManifest.payload, {
      assetCatalog: 'shared-app-inputs/assets/catalog.json',
      engineShaderManifest: 'shared-app-inputs/shaders/manifest.json',
    });
    assert.equal(existsSync(join(projection, 'assets', 'payload')), false);
    assert.ok(existsSync(join(projection, 'assets', 'catalog.json')));
    assert.ok(existsSync(join(projection, 'shaders', 'manifest.json')));
  } finally {
    rmSync(output, { recursive: true, force: true });
    rmSync(projection, { recursive: true, force: true });
  }
});

test('catalog-only shared inputs do not stage or publish serialized payload bytes', () => {
  const output = mkdtempSync(join(tmpdir(), 'forgeax-shared-catalog-only-'));
  try {
    const result = spawnSync(
      process.execPath,
      [script, '--root', repoRoot, '--out', output, '--catalog-only'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    const facts = JSON.parse(readFileSync(join(output, 'production-facts.json'), 'utf8'));
    assert.deepEqual(manifest.payload, {
      assetCatalog: 'shared-app-inputs/assets/catalog.json',
      engineShaderManifest: 'shared-app-inputs/shaders/manifest.json',
    });
    assert.equal(facts.payloadMode, 'catalog-only');
    assert.equal(facts.payloadEmitCount, 0);
    assert.equal(existsSync(join(output, 'assets', 'payload')), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
