import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classify,
  evaluatePixelOracle,
  readinessForDemo,
  readinessWaitBudget,
} from '../verify-webkit-learn-render.mjs';

const base = {
  vite: { ready: true },
  channel: { hasGpu: false, webgl2: true },
  logs: [],
  wasm: [{ magic: '0061736d' }],
  oracle: { passed: true },
  runtimeError: null,
};

test('classify preserves the first failure boundary in matrix evidence', () => {
  assert.deepEqual(classify({ ...base, vite: { ready: false, error: 'port unavailable' } }), {
    class: 'control-plane',
    detail: 'port unavailable',
  });
  assert.deepEqual(classify({ ...base, wasm: [{ magic: '3c21646f' }] }), {
    class: 'delivery',
    detail: 'a WASM response was not a WASM binary',
  });
  assert.deepEqual(classify({ ...base, runtimeError: 'page navigation timed out' }), {
    class: 'init',
    detail: 'page navigation timed out',
  });
  assert.deepEqual(classify({ ...base, logs: ['error: asset-not-imported'] }), {
    class: 'delivery',
    detail: 'error: asset-not-imported',
  });
  assert.deepEqual(
    classify({
      ...base,
      logs: [
        'error: bootstrap error: HdrpCapsInsufficientError: maxStorageBuffersPerShaderStage = 0',
      ],
      oracle: { passed: false },
    }),
    {
      class: 'capability',
      detail:
        'error: bootstrap error: HdrpCapsInsufficientError: maxStorageBuffersPerShaderStage = 0',
    },
  );
  assert.deepEqual(
    classify({
      ...base,
      logs: ['error: app.onError: webgpu-runtime-error inspect detail.error'],
      oracle: { passed: false },
    }),
    {
      class: 'init',
      detail: 'error: app.onError: webgpu-runtime-error inspect detail.error',
    },
  );
  assert.deepEqual(classify({ ...base, oracle: { passed: false } }), {
    class: 'visual',
    detail: 'canvas screenshot had no non-black sample',
  });
  assert.equal(classify(base), null);
});

test('pixel oracle keeps generic and family-specific evidence distinct', () => {
  assert.equal(
    evaluatePixelOracle(undefined, { sampled: 2, nonBlackSamples: 1, lumaRange: 0 }).passed,
    true,
  );
  assert.equal(
    evaluatePixelOracle(
      { kind: 'region-contrast', minLumaRange: 8, reason: 'background must vary' },
      { sampled: 10, nonBlackSamples: 10, lumaRange: 0 },
    ).passed,
    false,
  );
  assert.equal(
    evaluatePixelOracle(
      { kind: 'point-contrast', minLumaRange: 8, reason: 'grid must vary' },
      { sampled: 9, nonBlackSamples: 9, lumaRange: 12 },
    ).passed,
    true,
  );
});

test('readiness contracts wait for slow asset consumers without changing unconfigured demos', () => {
  const matrix = {
    readiness: {
      '3.model-loading/1.model-loading': {
        kind: 'window-flag',
        name: '__sponzaSceneReady',
        timeoutMs: 30_000,
      },
    },
  };
  assert.deepEqual(readinessForDemo(matrix, '3.model-loading/1.model-loading'), {
    kind: 'window-flag',
    name: '__sponzaSceneReady',
    timeoutMs: 30_000,
  });
  assert.equal(readinessForDemo(matrix, '1.getting-started/2.hello-triangle'), undefined);
  assert.equal(readinessWaitBudget(undefined, 30_000), 8_000);
  assert.equal(
    readinessWaitBudget(readinessForDemo(matrix, '3.model-loading/1.model-loading'), 30_000),
    30_000,
  );
  assert.deepEqual(
    classify({
      ...base,
      oracle: { passed: false },
      readiness: {
        declared: true,
        observed: false,
        name: '__sponzaSceneReady',
        timeoutMs: 30_000,
      },
    }),
    {
      class: 'init',
      detail: "readiness flag '__sponzaSceneReady' was not observed within 30000ms",
    },
  );
});
