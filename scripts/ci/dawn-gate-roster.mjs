import { DAWN_COMPACT_TEST_FILES } from './dawn-compact-roster.mjs';
import { DAWN_HEAVY_TEST_PARTITIONS } from './dawn-heavy-roster.mjs';

export const DIRECT_LIGHT_DAWN_TEST_FILE =
  'apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.dawn.test.ts';
export const VFX_DEPTH_DAWN_TEST_FILE =
  'packages/runtime/src/__tests__/vfx-depth-material.dawn.test.ts';

// Every file excluded from the ordinary Dawn project has one execution owner.
// Vitest configuration and local/PR/nightly execution derive from these groups.
export const DAWN_ISOLATED_GROUPS = [
  {
    id: 'renderer',
    files: [
      'packages/runtime/src/__tests__/point-light-shadow.dawn.test.ts',
      'packages/runtime/src/__tests__/dawn/instances-uniform-fallback.dawn.test.ts',
    ],
  },
  {
    id: 'material-publication',
    files: ['packages/runtime/src/__tests__/material-publication.dawn.test.ts'],
  },
  {
    id: 'feature-depth',
    files: ['packages/runtime/src/__tests__/feature-depth-material.dawn.test.ts'],
  },
  { id: 'vfx-depth', files: [VFX_DEPTH_DAWN_TEST_FILE] },
  {
    id: 'transmission',
    files: ['packages/render/src/transmission/__tests__/standard-transmission.dawn.test.ts'],
  },
  { id: 'vfx-mesh', files: ['packages/runtime/src/__tests__/vfx-mesh-lighting.dawn.test.ts'] },
  {
    id: 'timing-lifecycle',
    files: [
      'packages/render/bench/gpu-pass-timing/__tests__/gpu-pass-timing-lifecycle.dawn.test.ts',
    ],
  },
  {
    id: 'gpu-timing',
    files: ['packages/render/bench/gpu-pass-timing/__tests__/gpu-pass-timing.dawn.test.ts'],
  },
  ...DAWN_HEAVY_TEST_PARTITIONS.map((files, index) => ({
    id: `heavy-${index + 1}`,
    // Recovery sequences retain their module state within one test.
    files,
    isolate: false,
  })),
  {
    id: 'shadow-fields',
    files: ['packages/runtime/src/__tests__/shadow-fields-observable.dawn.test.ts'],
  },
];

export const DAWN_ISOLATED_TEST_FILES = DAWN_ISOLATED_GROUPS.flatMap(({ files }) => files);

export const DAWN_GATE_GROUPS = [
  // The ordinary project is discovered by Vitest, so its two halves use
  // Vitest's deterministic file shards; together they run every file once.
  { id: 'ordinary-1', files: [], env: {}, retryMode: 'vitest-dawn', vitestShard: '1/2' },
  { id: 'ordinary-2', files: [], env: {}, retryMode: 'vitest-dawn', vitestShard: '2/2' },
  { id: 'compact', files: DAWN_COMPACT_TEST_FILES, env: { FORGEAX_DAWN_COMPACT: '1' } },
  ...DAWN_ISOLATED_GROUPS.map((group) => ({ ...group, env: { FORGEAX_DAWN_ISOLATED: '1' } })),
  { id: 'direct-light', files: [DIRECT_LIGHT_DAWN_TEST_FILE], env: {} },
];

// Run 36123229770 measured these complete groups on the heavy pool (seconds):
// ordinary 625, direct-light 308, compact 273, shadow-fields 119,
// transmission 82, vfx-depth 81, feature-depth 56, vfx-mesh 52,
// material-publication 38, renderer 38, heavy-N 15-38, gpu-timing 20,
// timing-lifecycle 18. Three lanes took 15m00s, 12m46s and 9m09s because the
// ordinary project alone filled lane 1. Its Vitest hash shards carry about
// 56% and 44% of its per-file time, so the remaining groups are placed by
// longest processing time around them: four lanes of about 480-500s each.
// Groups stay whole, native execution stays serial, and every assertion owner
// is retained.
// Lanes list groups in roster order, which is also their execution order.
export const DAWN_GATE_SHARDS = Object.freeze([
  Object.freeze(['ordinary-1', 'vfx-depth', 'heavy-7', 'heavy-8']),
  Object.freeze([
    'ordinary-2',
    'material-publication',
    'feature-depth',
    'vfx-mesh',
    'heavy-4',
    'heavy-5',
  ]),
  Object.freeze(['transmission', 'heavy-1', 'heavy-2', 'heavy-3', 'heavy-9', 'direct-light']),
  Object.freeze([
    'compact',
    'renderer',
    'timing-lifecycle',
    'gpu-timing',
    'heavy-6',
    'shadow-fields',
  ]),
]);
