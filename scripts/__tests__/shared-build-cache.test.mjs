import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { cachePath, readReceipt } from '../build-task-cache.mjs';
import {
  recordSharedBuild,
  reusableSharedBuild,
  reusableSharedShader,
  sharedShaderInputFingerprint,
  sharedShaderReceipt,
} from '../lib/shared-build-cache.mjs';

test('shader reuse requires both current input identity and unchanged output bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-shared-cache-'));
  const output = join(root, 'shared');
  mkdirSync(output);
  const manifest = join(output, 'manifest.json');
  const shader = join(output, 'shader.wgsl');
  try {
    writeFileSync(manifest, '{}');
    writeFileSync(shader, 'aaa');
    assert.equal(reusableSharedBuild(root, output, 'compiler-A/profile-A'), false);
    recordSharedBuild(root, output, 'compiler-A/profile-A');
    assert.equal(reusableSharedBuild(root, output, 'compiler-A/profile-A'), true);
    assert.equal(reusableSharedBuild(root, output, 'compiler-B/profile-A'), false);
    assert.equal(reusableSharedBuild(root, output, 'compiler-A/profile-B'), false);
    writeFileSync(shader, 'bbb'); // same length must still invalidate the receipt
    assert.equal(reusableSharedBuild(root, output, 'compiler-A/profile-A'), false);
    writeFileSync(shader, 'aaa');
    writeFileSync(join(output, 'production-facts.json'), '{"engineShaderCompileCount":0}');
    assert.equal(reusableSharedBuild(root, output, 'compiler-A/profile-A'), true);
    rmSync(shader);
    assert.equal(reusableSharedBuild(root, output, 'compiler-A/profile-A'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transferred shaders bind source, compiler, WASM, lockfile, profile and exact output bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-shared-shader-'));
  const copy = mkdtempSync(join(tmpdir(), 'forgeax-shared-shader-copy-'));
  const inputs = [
    'package.json',
    'packages/vite-plugin-shader/package.json',
    'packages/compiler/package.json',
    'packages/compiler/dist/index.js',
    'packages/wgpu-wasm/pkg/compiler.wasm',
    'packages/shader/src/main.wgsl',
    'packages/vfx-render/src/shaders/main.wgsl',
    'pnpm-lock.yaml',
    'scripts/build-shared-inputs.mjs',
    'scripts/ci/build-shared-app-inputs.mjs',
    'scripts/lib/shared-build-cache.mjs',
    'scripts/build-task-cache.mjs',
  ];
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  try {
    const originals = new Map(
      inputs.map((input) => [input, input.endsWith('package.json') ? '{}' : 'original']),
    );
    originals.set(
      'packages/vite-plugin-shader/package.json',
      '{"name":"@forgeax/engine-vite-plugin-shader","dependencies":{"@fixture/compiler":"workspace:*"}}',
    );
    originals.set('packages/compiler/package.json', '{"name":"@fixture/compiler"}');
    for (const [input, contents] of originals) write(input, contents);
    const profile = { pointShadows: true, hdrpSsao: true };
    const fingerprint = () => sharedShaderInputFingerprint(root, profile);
    const expected = fingerprint();
    const shader = 'shared-app-inputs/shaders/manifest.json';
    write(shader, '{"entries":["original"]}');
    const manifestPath = join(root, 'shared-app-inputs/manifest.json');
    const manifest = {
      schemaVersion: 1,
      producer: 'shared-app-inputs',
      payload: { engineShaderManifest: shader },
      shaderBuild: sharedShaderReceipt(root, join(root, shader), expected),
    };
    const publish = (value) => writeFileSync(manifestPath, JSON.stringify(value));
    publish(manifest);
    assert.equal(reusableSharedShader(root, manifestPath, expected), join(root, shader));
    cpSync(root, copy, { recursive: true });
    assert.equal(sharedShaderInputFingerprint(copy, profile), expected);
    assert.equal(
      reusableSharedShader(copy, join(copy, 'shared-app-inputs/manifest.json'), expected),
      join(copy, shader),
    );
    for (const input of inputs) {
      write(input, input.endsWith('package.json') ? `${originals.get(input)} ` : 'modified');
      assert.notEqual(fingerprint(), expected, input);
      assert.equal(reusableSharedShader(root, manifestPath, fingerprint()), null, input);
      write(input, originals.get(input));
    }
    assert.equal(
      reusableSharedShader(
        root,
        manifestPath,
        sharedShaderInputFingerprint(root, { ...profile, pointShadows: false }),
      ),
      null,
    );
    write('packages/unrelated/package.json', '{"name":"@fixture/unrelated"}');
    write('packages/unrelated/dist/index.js', 'unrelated output');
    assert.equal(fingerprint(), expected, 'other package builds do not invalidate compiler inputs');
    for (const file of ['.gitignore', 'README.md', 'wgpu_wasm.d.ts', 'provenance.json']) {
      write(`packages/wgpu-wasm/pkg/${file}`, '*');
      assert.equal(
        fingerprint(),
        expected,
        `${file} is packaging metadata, not executable compiler input`,
      );
      rmSync(join(root, 'packages/wgpu-wasm/pkg', file));
      assert.equal(fingerprint(), expected, 'artifact omission preserves executable identity');
    }
    write('packages/compiler/pkg/runtime-only.wasm', 'not a shader compiler input');
    assert.equal(fingerprint(), expected);
    write('packages/vite-plugin-shader/dist/engine-inputs/point-ssao/manifest.json', 'generated');
    assert.equal(fingerprint(), expected, 'publishing output does not invalidate compiler inputs');
    write(shader, '{"entries":["modified"]}');
    assert.equal(reusableSharedShader(root, manifestPath, expected), null);
    rmSync(join(root, shader));
    assert.equal(reusableSharedShader(root, manifestPath, expected), null);
    publish({ ...manifest, shaderBuild: undefined });
    const misses = [];
    assert.equal(
      reusableSharedShader(root, manifestPath, expected, (reason) => misses.push(reason)),
      null,
    );
    assert.match(misses[0], /missing shaderBuild receipt/);
    publish({ ...manifest, payload: { engineShaderManifest: 'pnpm-lock.yaml' } });
    assert.equal(reusableSharedShader(root, manifestPath, expected), null);
    writeFileSync(manifestPath, '{');
    assert.equal(reusableSharedShader(root, manifestPath, expected), null);
    rmSync(manifestPath);
    assert.equal(reusableSharedShader(root, manifestPath, expected), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(copy, { recursive: true, force: true });
  }
});

test('shared receipts use a bounded basename and validate the full output key', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-shared-cache-'));
  const output = join(
    root,
    ...Array.from({ length: 4 }, (_, index) => `deep-${index}-${'x'.repeat(110)}`),
    'shared',
  );
  const otherOutput = join(root, 'other-shared');
  mkdirSync(output, { recursive: true });
  mkdirSync(otherOutput);
  try {
    for (const directory of [output, otherOutput])
      writeFileSync(join(directory, 'manifest.json'), '{}');
    writeFileSync(join(output, 'shader.wgsl'), 'aaa');
    writeFileSync(join(otherOutput, 'shader.wgsl'), 'aaa');
    recordSharedBuild(root, output, 'compiler-A/profile-A');
    assert.equal(reusableSharedBuild(root, output, 'compiler-A/profile-A'), true);
    const receiptPath = cachePath(root, 'receipts/shared', output);
    assert.equal(receiptPath.endsWith('.json'), true);
    assert.equal(receiptPath.split('/').at(-1)?.length, 69);
    assert.deepEqual(readReceipt(root, 'receipts/shared', output)?.cacheKey, {
      kind: 'receipts/shared',
      name: output,
    });
    // A copied receipt with the first output's full key cannot authorize a
    // different output even when both payloads have identical bytes.
    const otherReceiptPath = cachePath(root, 'receipts/shared', otherOutput);
    mkdirSync(join(otherReceiptPath, '..'), { recursive: true });
    writeFileSync(otherReceiptPath, JSON.stringify(readReceipt(root, 'receipts/shared', output)));
    assert.equal(readReceipt(root, 'receipts/shared', otherOutput), null);
    assert.equal(reusableSharedBuild(root, otherOutput, 'compiler-A/profile-A'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
