import { defineProject } from 'vitest/config';

// Per-package node project for @forgeax/preview. It owns no node unit tests --
// preview.browser.test.ts is owned by the root `browser` vitest project (K-3
// split). Exclude `*.browser.test.ts` so the per-package project's default
// include glob does NOT pick it up in node env (no document / no real WebGPU
// canvas), which would cascade-fail under `vitest run --project='@forgeax/*'`.
// Mirrors packages/app/vitest.config.ts policy.
export default defineProject({
  test: {
    environment: 'node',
    name: '@forgeax/preview',
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.browser.test.ts'],
  },
});
