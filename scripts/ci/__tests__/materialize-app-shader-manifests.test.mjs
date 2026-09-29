import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const script = join(repoRoot, 'scripts', 'ci', 'materialize-app-shader-manifests.mjs');

test('repeated materialization parses the immutable shared catalog only once', () => {
  const root = mkdtempSync(join(tmpdir(), 'materialize-app-shaders-repeat-'));
  try {
    const shared = join(root, 'shared-app-inputs');
    mkdirSync(join(shared, 'shaders'), { recursive: true });
    const catalog = JSON.stringify({ entries: [], materialShaders: [], proof: 'shared-catalog' });
    writeFileSync(join(shared, 'shaders/manifest.json'), catalog);
    writeFileSync(
      join(shared, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        producer: 'shared-app-inputs',
        payload: { engineShaderManifest: 'shared-app-inputs/shaders/manifest.json' },
      }),
    );
    for (const name of ['alpha', 'beta', 'gamma']) {
      const app = join(root, 'apps', name);
      mkdirSync(app, { recursive: true });
      writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({ scripts: { build: 'vite build' } }),
      );
    }
    execFileSync(process.execPath, [script, '--root', root]);
    const counter = join(root, 'parse-counter.mjs');
    writeFileSync(
      counter,
      `
      import { writeFileSync } from 'node:fs';
      const parse = JSON.parse;
      let count = 0;
      JSON.parse = function (text, ...args) {
        if (typeof text === 'string' && text.includes('shared-catalog')) count++;
        return parse(text, ...args);
      };
      process.on('exit', () => writeFileSync(${JSON.stringify(join(root, 'parse-count'))}, String(count)));
    `,
    );
    const report = JSON.parse(
      execFileSync(process.execPath, ['--import', counter, script, '--root', root], {
        encoding: 'utf8',
      }),
    );
    assert.deepEqual(report.materialized, []);
    assert.deepEqual(report.merged, []);
    assert.equal(readFileSync(join(root, 'parse-count'), 'utf8'), '1');
    for (const name of ['alpha', 'beta', 'gamma']) {
      assert.equal(
        readFileSync(join(root, 'apps', name, 'dist/shaders/manifest.json'), 'utf8'),
        catalog,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
    assert.equal(
      statSync(join(root, 'apps/alpha/dist/shaders/manifest.json')).ino,
      statSync(source).ino,
      'missing manifests should reuse the immutable shared file by hardlink',
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

test('limits materialization to explicit smoke app roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'materialize-app-shaders-scope-'));
  try {
    const shared = join(root, 'shared-app-inputs');
    mkdirSync(join(shared, 'shaders'), { recursive: true });
    writeFileSync(join(shared, 'shaders', 'manifest.json'), '{"entries":[]}');
    writeFileSync(
      join(shared, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        producer: 'shared-app-inputs',
        payload: { engineShaderManifest: 'shared-app-inputs/shaders/manifest.json' },
      }),
    );
    for (const name of ['hello', 'bevy']) {
      const app = join(root, 'apps', name, 'demo');
      mkdirSync(join(app, 'dist'), { recursive: true });
      writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({ scripts: { build: 'vite build' } }),
      );
    }

    const output = execFileSync(
      process.execPath,
      [script, '--root', root, '--app-root', 'apps/hello'],
      { encoding: 'utf8' },
    );
    const report = JSON.parse(output);
    assert.deepEqual(report.materialized, [
      { app: 'demo', path: 'apps/hello/demo/dist/shaders/manifest.json' },
    ]);
    assert.equal(existsSync(join(root, 'apps/bevy/demo/dist/shaders/manifest.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materializes an explicitly selected app root package', () => {
  const root = mkdtempSync(join(tmpdir(), 'materialize-app-shaders-root-app-'));
  try {
    const shared = join(root, 'shared-app-inputs');
    mkdirSync(join(shared, 'shaders'), { recursive: true });
    writeFileSync(join(shared, 'shaders', 'manifest.json'), '{"entries":[]}');
    writeFileSync(
      join(shared, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        producer: 'shared-app-inputs',
        payload: { engineShaderManifest: 'shared-app-inputs/shaders/manifest.json' },
      }),
    );
    const appRoot = join(root, 'apps', 'collectathon');
    mkdirSync(join(appRoot, 'dist'), { recursive: true });
    writeFileSync(
      join(appRoot, 'package.json'),
      JSON.stringify({ scripts: { build: 'vite build' } }),
    );

    const output = execFileSync(
      process.execPath,
      [script, '--root', root, '--app-root', 'apps/collectathon'],
      { encoding: 'utf8' },
    );
    const report = JSON.parse(output);
    assert.deepEqual(report.materialized, [
      { app: 'collectathon', path: 'apps/collectathon/dist/shaders/manifest.json' },
    ]);
    assert.equal(
      readFileSync(join(appRoot, 'dist/shaders/manifest.json'), 'utf8'),
      '{"entries":[]}',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merges compact app shader deltas with the shared engine manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'materialize-app-shaders-delta-'));
  try {
    const shared = join(root, 'shared-app-inputs');
    mkdirSync(join(shared, 'shaders'), { recursive: true });
    writeFileSync(
      join(shared, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        producer: 'shared-app-inputs',
        payload: { engineShaderManifest: 'shared-app-inputs/shaders/manifest.json' },
      }),
    );
    writeFileSync(
      join(shared, 'shaders', 'manifest.json'),
      JSON.stringify({
        entries: [{ hash: 'engine', wgsl: 'engine', bindings: '{}', glsl: '' }],
        materialShaders: [
          {
            identifier: 'forgeax::default-standard-pbr',
            sourcePath: 'engine/default-standard-pbr.wgsl',
            composedWgsl: 'engine',
            paramSchema: '{}',
            variants: [],
          },
        ],
      }),
    );

    const appRoot = join(root, 'apps', 'delta');
    mkdirSync(join(appRoot, 'dist', 'shaders'), { recursive: true });
    writeFileSync(
      join(appRoot, 'package.json'),
      JSON.stringify({ scripts: { build: 'vite build' } }),
    );
    writeFileSync(
      join(appRoot, 'dist', 'shaders', 'manifest.json'),
      JSON.stringify({
        forgeaxTransport: 'forgeax-app-shader-manifest-delta-v1',
        entries: [{ hash: 'custom', wgsl: 'custom', bindings: '{}', glsl: '' }],
        materialShaders: [
          {
            identifier: 'demo::custom',
            sourcePath: 'apps/delta/custom.wgsl',
            composedWgsl: 'custom',
            paramSchema: '{}',
            variants: [],
          },
        ],
      }),
    );

    const output = execFileSync(process.execPath, [script, '--root', root], {
      encoding: 'utf8',
    });
    const report = JSON.parse(output);
    assert.deepEqual(report.materialized, []);
    assert.deepEqual(report.merged, [
      { app: 'delta', path: 'apps/delta/dist/shaders/manifest.json' },
    ]);
    const merged = JSON.parse(
      readFileSync(join(appRoot, 'dist', 'shaders', 'manifest.json'), 'utf8'),
    );
    assert.deepEqual(
      merged.entries.map((entry) => entry.hash),
      ['engine', 'custom'],
    );
    assert.deepEqual(
      merged.materialShaders.map((entry) => entry.identifier),
      ['forgeax::default-standard-pbr', 'demo::custom'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty deltas share one immutable runtime file without dropping normalized fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'materialize-empty-deltas-'));
  try {
    const shared = join(root, 'shared-app-inputs');
    mkdirSync(join(shared, 'shaders'), { recursive: true });
    // Legacy producer metadata still needs the materialShaders normalization.
    const original = {
      entries: [
        { hash: 'engine', wgsl: 'old' },
        { hash: 'engine', wgsl: 'shared shader' },
      ],
    };
    writeFileSync(join(shared, 'shaders/manifest.json'), JSON.stringify(original));
    writeFileSync(
      join(shared, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        producer: 'shared-app-inputs',
        payload: { engineShaderManifest: 'shared-app-inputs/shaders/manifest.json' },
      }),
    );
    const targets = ['alpha', 'beta'].map((name) => {
      const app = join(root, 'apps', name);
      mkdirSync(join(app, 'dist/shaders'), { recursive: true });
      writeFileSync(
        join(app, 'package.json'),
        JSON.stringify({ scripts: { build: 'vite build' } }),
      );
      const target = join(app, 'dist/shaders/manifest.json');
      writeFileSync(
        target,
        JSON.stringify({
          forgeaxTransport: 'forgeax-app-shader-manifest-delta-v1',
          entries: [],
          materialShaders: [],
        }),
      );
      return target;
    });
    execFileSync(process.execPath, [script, '--root', root]);
    for (const target of targets) {
      assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), {
        entries: [{ hash: 'engine', wgsl: 'shared shader' }],
        materialShaders: [],
      });
    }
    assert.equal(
      statSync(targets[0]).ino,
      statSync(targets[1]).ino,
      'empty deltas must not serialize and copy the whole shader catalog per app',
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(shared, 'shaders/manifest.json'), 'utf8')),
      original,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
