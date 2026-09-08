import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  SDK_MANIFEST_VERSION,
  SDK_RESOURCE_ALLOWLIST,
  SDK_SOURCE_EXCLUDED_PATHS,
  SDK_SOURCE_FORMAT,
  SDK_SOURCE_ROOT,
  SDK_SOURCE_WASM,
  SDK_TEMPLATE_RESOURCE_ALLOWLIST,
  SDK_TEMPLATES,
  sdkResourceManifest,
  sdkTemplateResourceManifest,
} from '../forgeax/sdk-lib.mjs';

test('SDK source contract keeps the source root and prebuilt WASM closure explicit', () => {
  assert.equal(SDK_MANIFEST_VERSION, '1.6.0');
  assert.equal(SDK_SOURCE_FORMAT, 'git-archive-public-snapshot');
  assert.deepEqual(SDK_SOURCE_EXCLUDED_PATHS, ['.gitmodules', 'forgeax-engine-assets']);
  assert.equal(SDK_SOURCE_ROOT, 'source/engine');
  assert.deepEqual(SDK_TEMPLATES, [
    { id: 'empty', sourceRoot: 'templates/game-empty', default: true },
    { id: 'game-3d', sourceRoot: 'templates/game-3d', default: false },
  ]);
  assert.deepEqual(
    SDK_SOURCE_WASM.map(({ package: packageName }) => packageName),
    ['@forgeax/engine-wgpu-wasm', '@forgeax/engine-fbx', '@forgeax/engine-codec'],
  );
  assert.equal(
    SDK_SOURCE_WASM.find(
      ({ package: packageName }) => packageName === '@forgeax/engine-wgpu-wasm',
    )?.files.includes('provenance.json'),
    true,
  );
  for (const entry of SDK_SOURCE_WASM) {
    assert.equal(new Set(entry.files).size, entry.files.length);
    assert.equal(
      entry.files.every((file) => !file.startsWith('/')),
      true,
    );
  }
});

test('SDK resource closure is an explicit public allowlist', () => {
  assert.deepEqual(SDK_RESOURCE_ALLOWLIST, [
    {
      id: 'preview-canonical-kit',
      package: '@forgeax/engine-preview',
      sourceRoot: 'packages/preview/assets/canonical-kit',
      packageRoot: 'assets/canonical-kit',
      files: ['cook-receipt.json', 'sky.hdr', 'sky.hdr.meta.json'],
    },
  ]);
  assert.deepEqual(sdkResourceManifest(), SDK_RESOURCE_ALLOWLIST);
  for (const resource of SDK_RESOURCE_ALLOWLIST) {
    assert.equal(new Set(resource.files).size, resource.files.length);
    assert.equal(resource.sourceRoot.startsWith('/'), false);
    assert.equal(resource.packageRoot.startsWith('/'), false);
    assert.equal(resource.sourceRoot.includes('forgeax-engine-assets'), false);
    assert.equal(resource.packageRoot.includes('forgeax-engine-assets'), false);
    assert.equal(
      resource.files.every((file) => !file.startsWith('/')),
      true,
    );
  }
});

test('SDK templates need no contributor-only resource closure', () => {
  assert.deepEqual(SDK_TEMPLATE_RESOURCE_ALLOWLIST, []);
  assert.deepEqual(sdkTemplateResourceManifest(), []);
});

test('SDK manifest admits a pack-only template set with no copied resources', async () => {
  const schema = JSON.parse(
    await readFile(new URL('../../sdk-manifest.schema.json', import.meta.url), 'utf8'),
  );
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile({
    ...schema.properties.templateResources,
    $defs: schema.$defs,
  });
  assert.equal(validate([]), true, JSON.stringify(validate.errors));
  assert.equal(
    validate([{ id: 'generated-assets', root: 'templates/game-3d/assets/', files: [] }]),
    false,
  );
});
