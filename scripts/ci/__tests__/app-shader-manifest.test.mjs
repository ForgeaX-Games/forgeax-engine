import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  APP_SHADER_MANIFEST_DELTA,
  mergeAppShaderManifest,
  projectAppShaderManifest,
} from '../app-shader-manifest.mjs';

const sharedEntry = { hash: 'engine-hash', wgsl: 'engine', bindings: '{}', glsl: '' };
const customEntry = { hash: 'custom-hash', wgsl: 'custom', bindings: '{}', glsl: '' };
const sharedMaterial = {
  identifier: 'forgeax::default-standard-pbr',
  sourcePath: 'engine/default-standard-pbr.wgsl',
  composedWgsl: 'engine',
  paramSchema: '{}',
  variants: [],
};
const customMaterial = {
  identifier: 'demo::custom',
  sourcePath: 'apps/demo/src/custom.wgsl',
  composedWgsl: 'custom',
  paramSchema: '{}',
  variants: [],
};

test('projects only app-owned shader rows for shard transport', () => {
  const delta = projectAppShaderManifest(
    {
      entries: [sharedEntry, customEntry],
      materialShaders: [sharedMaterial, customMaterial],
    },
    { entries: [sharedEntry], materialShaders: [sharedMaterial] },
  );

  assert.equal(delta.forgeaxTransport, APP_SHADER_MANIFEST_DELTA);
  assert.deepEqual(delta.entries, [customEntry]);
  assert.deepEqual(delta.materialShaders, [customMaterial]);
});

test('projecting an app-owned delta again is idempotent', () => {
  const shared = { entries: [sharedEntry], materialShaders: [sharedMaterial] };
  const delta = projectAppShaderManifest(
    {
      entries: [sharedEntry, customEntry],
      materialShaders: [sharedMaterial, customMaterial],
    },
    shared,
  );

  assert.deepEqual(projectAppShaderManifest(delta, shared), delta);
});

test('merges an app delta back into one runtime manifest', () => {
  const merged = mergeAppShaderManifest(
    { schemaVersion: '1.0.0', entries: [sharedEntry], materialShaders: [sharedMaterial] },
    {
      forgeaxTransport: APP_SHADER_MANIFEST_DELTA,
      entries: [customEntry],
      materialShaders: [customMaterial],
    },
  );

  assert.equal(merged.schemaVersion, '1.0.0');
  assert.deepEqual(merged.entries, [sharedEntry, customEntry]);
  assert.deepEqual(merged.materialShaders, [sharedMaterial, customMaterial]);
});

test('app-owned rows replace a same-identity shared material row', () => {
  const replacement = { ...sharedMaterial, composedWgsl: 'replacement' };
  const merged = mergeAppShaderManifest(
    { entries: [sharedEntry], materialShaders: [sharedMaterial] },
    {
      forgeaxTransport: APP_SHADER_MANIFEST_DELTA,
      entries: [],
      materialShaders: [replacement],
    },
  );

  assert.deepEqual(merged.materialShaders, [replacement]);
});

test('compact app delta retains custom shader sources through materialization', () => {
  const sharedSource = 'fn shared() {}\n';
  const customSource = `${sharedSource}fn custom() {}\n`;
  const digest = (source) => createHash('sha256').update(source).digest('hex');
  const sharedDigest = digest(sharedSource);
  const customDigest = digest(customSource);
  const engine = {
    schemaVersion: '2.0.0',
    fragments: [sharedSource],
    sources: { [sharedDigest]: [0] },
    entries: [{ hash: 'engine', bindings: '{}', glsl: '', sourceDigest: sharedDigest }],
    materialShaders: [],
  };
  const app = {
    schemaVersion: '2.0.0',
    fragments: [sharedSource, 'fn custom() {}\n'],
    sources: { [sharedDigest]: [0], [customDigest]: [0, 1] },
    entries: [
      ...engine.entries,
      { hash: 'custom', bindings: '{}', glsl: '', sourceDigest: customDigest },
    ],
    materialShaders: [
      {
        identifier: 'demo::custom',
        sourcePath: 'apps/demo/custom.wgsl',
        paramSchema: '{}',
        sourceDigest: customDigest,
        variants: [{ defines: {}, definesKey: '', sourceDigest: customDigest }],
      },
    ],
  };

  const delta = projectAppShaderManifest(app, engine);
  const merged = mergeAppShaderManifest(engine, delta);
  assert.equal(merged.schemaVersion, '2.0.0');
  assert.deepEqual(
    merged.entries.map((row) => row.hash),
    ['engine', 'custom'],
  );
  assert.deepEqual(Object.keys(merged.sources).sort(), [sharedDigest, customDigest].sort());
  for (const [hash, indices] of Object.entries(merged.sources)) {
    assert.equal(digest(indices.map((index) => merged.fragments[index]).join('')), hash);
  }
});
