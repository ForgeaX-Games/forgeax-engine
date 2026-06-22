/**
 * Smoke test for scripts/codemod/transforms/rename-imports.cjs.
 *
 * Verifies the three core invariants:
 *   1. `from '@forgeax/engine'`           → `from '@forgeax/engine-runtime'`
 *   2. `from '@forgeax/engine-math'`      stays put (substring R-3 protection)
 *   3. `require('@forgeax/core')`         → `require('@forgeax/engine-ecs')`
 *
 * Run with: node scripts/codemod/transforms/__tests__/rename-imports.test.cjs
 * Exits 0 on success, 1 on failure (suitable for ad-hoc CI).
 */
'use strict';

const path = require('node:path');
const jscodeshift = require('jscodeshift');
const transform = require(path.resolve(__dirname, '..', 'rename-imports.cjs'));

const MAP_PATH = path.resolve(__dirname, '..', '..', 'rename-map.json');

function run(source) {
  return transform(
    { source, path: '/virtual/file.ts' },
    {
      jscodeshift: jscodeshift.withParser('ts'),
      stats: () => undefined,
      report: () => undefined,
    },
    { map: MAP_PATH },
  );
}

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    console.error(`[FAIL] ${message}`);
    console.error(`expected:\n${expected}`);
    console.error(`actual:\n${actual}`);
    process.exit(1);
  }
  console.warn(`[OK] ${message}`);
}

// 1) bare engine import rewrites to engine-runtime
assertEq(
  run("import { Engine } from '@forgeax/engine';\n"),
  "import { Engine } from '@forgeax/engine-runtime';\n",
  'bare @forgeax/engine import → @forgeax/engine-runtime',
);

// 2) engine-math (already correct in canonical post-rename world) is untouched
const alreadyNew = "import type { Vec3 } from '@forgeax/engine-math';\n";
assertEq(
  run(alreadyNew) ?? alreadyNew,
  alreadyNew,
  '@forgeax/engine-math import is not double-rewritten',
);

// 3) require('@forgeax/core') → require('@forgeax/engine-ecs')
assertEq(
  run("const { World } = require('@forgeax/core');\n"),
  "const { World } = require('@forgeax/engine-ecs');\n",
  "require('@forgeax/core') → require('@forgeax/engine-ecs')",
);

// 4) export * from '@forgeax/ecs' → export * from '@forgeax/engine-ecs'
assertEq(
  run("export * from '@forgeax/ecs';\n"),
  "export * from '@forgeax/engine-ecs';\n",
  're-export rewrites',
);

// 5) dynamic import('@forgeax/wgpu-wasm') → '@forgeax/engine-wgpu-wasm'
assertEq(
  run("const mod = await import('@forgeax/wgpu-wasm');\n"),
  "const mod = await import('@forgeax/engine-wgpu-wasm');\n",
  'dynamic import() rewrites',
);

// 6) require.resolve('@forgeax/naga/...') prefix path: only the bare package
//    name is matched, so subpath resolutions are NOT rewritten (literal eq).
//    This is intentional — subpath strings stay untouched here; require.resolve
//    on the bare name is rewritten.
assertEq(
  run("const p = require.resolve('@forgeax/naga');\n"),
  "const p = require.resolve('@forgeax/engine-naga');\n",
  'require.resolve bare name rewrites',
);

// 7) The substring-collision worst case: a string that *contains* @forgeax/engine
//    inside another package name MUST NOT be rewritten by the bare-engine rule.
//    Since we use literal equality, the input below is *not* an import string,
//    but covers the substring concern explicitly.
const worstCase = "import { Probe } from '@forgeax/engine-shader';\n";
assertEq(
  run(worstCase) ?? worstCase,
  worstCase,
  'literal equality: @forgeax/engine-shader is never coerced to engine-runtime-shader',
);

console.warn('\nall rename-imports.cjs assertions passed');
